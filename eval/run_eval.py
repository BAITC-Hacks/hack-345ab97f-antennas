"""Evaluate the real configured LLM on tune only; holdout cannot be selected."""
from __future__ import annotations
import argparse
import asyncio
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from app.router.llm_router import LLMRouter
from app.router.schema import DialogState, Utterance

ROOT = Path(__file__).parents[1]


def percentile(values, q):
    if not values: return 0.0
    ordered = sorted(values)
    return ordered[round((len(ordered) - 1) * q)]


def judge(row, result) -> tuple[bool, bool]:
    """(ok, scenario_ok). ok also requires the final action: a needless clarify is a miss."""
    expected, expected_action = row.get("expected"), row.get("expected_decision", "route")
    if expected_action in {"clarify", "handoff"}:
        ok = result.final_action == expected_action
        return ok, ok
    scenario_ok = result.decision.scenario_id == expected
    return scenario_ok and result.final_action == expected_action, scenario_ok


def accuracy_by(rows: list[dict], field: str) -> dict[str, dict[str, float | int]]:
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(str(row.get(field) or "unknown"), []).append(row)
    return {
        name: {
            "correct": sum(bool(row["correct"]) for row in values),
            "total": len(values),
            "accuracy": sum(bool(row["correct"]) for row in values) / len(values),
        }
        for name, values in sorted(grouped.items())
    }


async def main(limit: int | None = None) -> None:
    dataset = ROOT / "eval/datasets/tune.json"
    rows = json.loads(dataset.read_text(encoding="utf-8"))
    if limit is not None:
        if limit < 1:
            raise ValueError("--limit must be at least 1")
        rows = rows[:limit]
    router = LLMRouter()
    await router.warm_up()
    results, latencies, commits, confusions = [], [], [], Counter()
    multi_found = multi_total = 0
    print(f"model: {router.provider.model} | rows: {len(rows)}\n")
    for row in rows:
        state_data = dict(row.get("context") or {})
        if "last_assistant_message" in state_data:
            state_data["last_bot_question"] = state_data.pop("last_assistant_message")
        expected_label = row.get("expected") or row.get("expected_decision")
        try:
            # No lang hint: the label is the answer we measure, and real STT never says "mixed".
            result = await router.route(DialogState(**state_data), Utterance(text=row["text"]))
        except Exception as error:  # a broken answer is a router miss, not a crash of the whole run
            print(f"✗ {row['id']:4} ERROR {type(error).__name__}: {str(error)[:200]}")
            results.append({"id": row["id"], "type": row.get("type"), "lang": row.get("lang"),
                            "correct": False, "scenario_correct": False, "error": str(error)})
            confusions[(expected_label, "error")] += 1
            continue
        ok, scenario_ok = judge(row, result)
        actual = result.decision.scenario_id
        if not ok: confusions[(expected_label, f"{actual}/{result.final_action}")] += 1
        if row.get("expected_additional"):
            multi_total += 1
            multi_found += set(row["expected_additional"]) <= {i.scenario_id for i in result.decision.additional_intents}
        latencies.append(result.timings_ms["full"])
        commits.append(result.timings_ms["commit"])
        print(f"{'✓' if ok else '✗'} {row['id']:4} {row['type']:12} expected {str(expected_label):24} "
              f"got {str(actual):24} [{result.final_action}, conf {result.confidence:.2f}, margin {result.margin:.2f}] "
              f"{result.timings_ms['full']:5.0f} ms")
        if not ok: print(f"        reason: {result.decision.reason}")
        language_ok = result.decision.language == row.get("lang")
        if not language_ok: print(f"        language: expected {row.get('lang')}, got {result.decision.language}")
        results.append({"id": row["id"], "type": row.get("type"), "lang": row.get("lang"), "language_correct": language_ok,
                        "correct": ok, "scenario_correct": scenario_ok, **result.model_dump(mode="json")})
    by_type = accuracy_by(results, "type")
    by_language = accuracy_by(results, "lang")
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(), "dataset": "tune", "model": router.provider.model,
        "accuracy": sum(r["correct"] for r in results) / len(results),
        "scenario_accuracy": sum(r["scenario_correct"] for r in results) / len(results),
        "language_detection": sum(r.get("language_correct", False) for r in results) / len(results),
        "multi_intent_found": f"{multi_found}/{multi_total}",
        "latency_p50_ms": percentile(latencies, .5), "latency_p95_ms": percentile(latencies, .95),
        "commit_p50_ms": percentile(commits, .5),
        "accuracy_by_type": by_type, "accuracy_by_language": by_language,
        "top_confusions": [{"expected": a, "actual": b, "count": n} for (a,b),n in confusions.most_common(5)],
        "results": results,
    }
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    target = ROOT / f"eval/reports/tune-{stamp}-{router.provider.model.replace('/', '-')}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = ("accuracy", "scenario_accuracy", "language_detection", "accuracy_by_type", "accuracy_by_language", "multi_intent_found",
               "latency_p50_ms", "latency_p95_ms", "commit_p50_ms", "top_confusions")
    print("\n" + json.dumps({key: report[key] for key in summary}, ensure_ascii=False, indent=2))
    print(f"report: {target.relative_to(ROOT)}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, help="evaluate only the first N tune rows")
    arguments = parser.parse_args()
    asyncio.run(main(arguments.limit))
