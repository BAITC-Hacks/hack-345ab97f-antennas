#!/usr/bin/env python3
"""Generate a reviewed-later synthetic routing dataset with an OpenAI-compatible LLM."""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "eval/datasets/synthetic_raw.json"
FIELDS = ("id", "text", "lang", "type", "state", "expected", "expected_decision", "expected_additional", "confuser")
TYPES = ("simple", "topic_switch", "boundary", "mixed", "simple")


def load_env(path: Path = ROOT / ".env") -> None:
    """Load missing variables from .env without overriding the process environment."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def catalog() -> list[dict[str, Any]]:
    payload = json.loads((ROOT / "data/scenarios.json").read_text(encoding="utf-8"))
    return payload["scenarios"] if isinstance(payload, dict) else payload


def normalize(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE).split())


def slot_specs(scenarios: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Pre-assign quotas, leaving the LLM only the linguistic generation task."""
    total = len(scenarios) * 5
    kk_target = (total + 3) // 4
    multi_target = min(15, max(10, round(total * .24))) if total >= 10 else 0
    special_target = min(10, max(5, round(total * .14))) if total >= 5 else 0
    flat: list[dict[str, Any]] = []
    for scenario_index, scenario in enumerate(scenarios):
        neighbors = [item["neighbor"] for item in scenario.get("boundaries", [])]
        fallback = scenarios[(scenario_index + 1) % len(scenarios)]["id"]
        for offset, kind in enumerate(TYPES):
            index = len(flat)
            lang = "mixed" if kind == "mixed" else ("kk" if index % 4 == 0 else "ru")
            flat.append({
                "type": kind,
                "lang": lang,
                "confuser": (neighbors[0] if neighbors else fallback) if kind == "boundary" else None,
                "additional": fallback if index < multi_target else None,
                "decision": "handoff" if index < special_target and index % 2 else ("clarify" if index < special_target else "route"),
            })
    # Keep the pure-Kazakh quota separate from the mixed-language quota.
    current = sum(item["lang"] == "kk" for item in flat)
    for item in flat:
        if current >= kk_target:
            break
        if item["lang"] == "ru" and item["type"] != "topic_switch":
            item["lang"] = "kk"
            current += 1
    return [flat[i:i + 5] for i in range(0, total, 5)]


def request_rows(model: str, api_key: str, base_url: str, scenario: dict[str, Any], specs: list[dict[str, Any]], all_ids: list[str]) -> list[dict[str, Any]]:
    prompt = f"""Ты создаёшь синтетические реплики для теста голосового роутера страховой компании.
Сценарий: {json.dumps(scenario, ensure_ascii=False)}
Допустимые scenario id: {all_ids}
Создай ровно 5 НОВЫХ реплик по спецификациям: {json.dumps(specs, ensure_ascii=False)}
Не копируй examples. Живая телефонная речь: разная длина, разговорность, иногда нет пунктуации,
ASR-ошибки. lang=kk — казахский, mixed — естественная смесь ru+kk. Для topic_switch state
обязан содержать active_scenario (не текущий) и last_assistant_message. Для boundary используй
указанный confuser. additional означает вторую явную просьбу. clarify — намерение действительно
неоднозначно, handoff — явная просьба соединить с оператором.
Верни только JSON object {{"rows": [...]}}. У каждой строки ровно поля text, lang, type, state,
expected, expected_decision, expected_additional, confuser. expected всегда "{scenario['id']}";
expected_additional — [] или список из additional; отсутствующие state/confuser — null."""
    body = json.dumps({
        "model": model,
        "temperature": 0.9,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions", data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            answer = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:1000]
        raise RuntimeError(f"generation API returned HTTP {error.code}: {detail}") from error
    content = answer["choices"][0]["message"]["content"]
    return json.loads(content)["rows"]


def validate(rows: list[dict[str, Any]], scenarios: list[dict[str, Any]], *, full: bool) -> None:
    ids = {item["id"] for item in scenarios}
    seen: set[str] = set()
    counts = Counter()
    for row in rows:
        missing = set(FIELDS) - row.keys()
        if missing:
            raise ValueError(f"{row.get('id', '?')}: missing fields {sorted(missing)}")
        if row["expected"] not in ids:
            raise ValueError(f"{row['id']}: unknown expected {row['expected']!r}")
        key = normalize(row["text"])
        if not key or key in seen:
            raise ValueError(f"{row['id']}: empty or duplicate normalized text")
        seen.add(key)
        counts[row["expected"]] += 1
        if row["type"] == "topic_switch" and not {"active_scenario", "last_assistant_message"} <= set(row["state"] or {}):
            raise ValueError(f"{row['id']}: topic_switch needs complete state")
        if row["type"] == "boundary" and row["confuser"] not in ids:
            raise ValueError(f"{row['id']}: boundary needs a valid confuser")
    if set(counts) != ids or any(value != 5 for value in counts.values()):
        raise ValueError(f"expected exactly five rows per selected scenario, got {dict(counts)}")
    if full:
        total = len(rows)
        if sum(row["lang"] == "kk" for row in rows) < total * .25:
            raise ValueError("Kazakh quota (<25%) was not met")
        if sum(row["lang"] == "mixed" for row in rows) < total * .10:
            raise ValueError("mixed ru+kk quota (<10%) was not met")
        multi = sum(bool(row["expected_additional"]) for row in rows)
        special = sum(row["expected_decision"] in {"clarify", "handoff"} for row in rows)
        if not 10 <= multi <= 15 or not 5 <= special <= 10:
            raise ValueError(f"quota mismatch: multi={multi}, clarify/handoff={special}")


def statistics(rows: list[dict[str, Any]]) -> dict[str, dict[str, int] | int]:
    return {
        "total": len(rows),
        "scenarios": dict(sorted(Counter(row["expected"] for row in rows).items())),
        "languages": dict(sorted(Counter(row["lang"] for row in rows).items())),
        "types": dict(sorted(Counter(row["type"] for row in rows).items())),
        "decisions": dict(sorted(Counter(row["expected_decision"] for row in rows).items())),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, help="generate only the first N scenarios for a smoke run")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    load_env()
    model = os.getenv("GEN_MODEL")
    api_key = os.getenv("GEN_API_KEY") or os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("GEN_BASE_URL") or os.getenv("LLM_BASE_URL") or "https://api.openai.com/v1"
    if not model or not api_key:
        raise SystemExit("Set GEN_MODEL and GEN_API_KEY (or LLM_API_KEY/OPENAI_API_KEY) in .env")
    all_scenarios = catalog()
    selected = all_scenarios[:args.limit] if args.limit else all_scenarios
    specs = slot_specs(selected)
    ids = [item["id"] for item in all_scenarios]
    rows: list[dict[str, Any]] = []
    for scenario_index, (scenario, scenario_specs) in enumerate(zip(selected, specs)):
        generated = request_rows(model, api_key, base_url, scenario, scenario_specs, ids)
        for offset, (row, spec) in enumerate(zip(generated, scenario_specs), 1):
            row = {field: row.get(field) for field in FIELDS if field != "id"}
            row["id"] = f"syn-{scenario_index + 1:03d}-{offset}"
            row["expected"] = scenario["id"]
            row["lang"], row["type"], row["expected_decision"] = spec["lang"], spec["type"], spec["decision"]
            row["expected_additional"] = [spec["additional"]] if spec["additional"] else []
            row["confuser"] = spec["confuser"]
            rows.append({field: row.get(field) for field in FIELDS})
    validate(rows, selected, full=args.limit is None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(statistics(rows), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
