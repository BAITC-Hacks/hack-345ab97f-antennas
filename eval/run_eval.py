"""Evaluate the configured backend on tune only, with independent metrics."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

from app.router.llm_router import LLMRouter
from app.router.schema import DialogState, Utterance
from eval.metrics import across_runs, grouped, score, summarize


def percentile(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[round((len(ordered) - 1) * q)]


def judge(row, result) -> tuple[bool, bool]:
    """(decision correctness, top-1 correctness); neither metric replaces the other."""
    scores = score(row, result.decision.model_dump(), result.final_action)
    return scores["decision_correct"], scores["scenario_correct"]


def fingerprints(catalog_path: Path) -> dict:
    sources = [ROOT / "eval/datasets/tune.json", ROOT / "eval/metrics.py",
               Path(__file__).resolve(), catalog_path.resolve()]
    sources += sorted((ROOT / "backend/app/router").rglob("*.py"))
    return {
        path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sources
    }


def save(path: Path, report: dict) -> None:
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def run_once(router, rows, run_number, metadata, target):
    results, latencies, commits, confusions = [], [], [], Counter()
    print(f"\nRun {run_number} | model: {router.provider.model} | tune rows: {len(rows)}", flush=True)
    for row in rows:
        record = {key: row[key] for key in ("id", "text", "type", "lang", "expected")}
        record["expected_decision"] = row.get("expected_decision", "route")
        for key in ("context", "expected_topic_switch", "expected_additional"):
            if key in row:
                record[key] = row[key]
        state_data = dict(row.get("context") or {})
        if "last_assistant_message" in state_data:
            state_data["last_bot_question"] = state_data.pop("last_assistant_message")
        try:
            # No lang hint: the label is the answer we measure, and real STT never says "mixed".
            result = await router.route(DialogState(**state_data), Utterance(text=row["text"]))
        except Exception as error:
            record.update(score(row, None))
            record.update(error=str(error), error_type=type(error).__name__)
            print(f"{row['id']}: ERROR {type(error).__name__}: {str(error)[:200]}", flush=True)
        else:
            record.update(result.model_dump(mode="json"))
            record.update(score(row, record["decision"], result.final_action))
            latencies.append(result.timings_ms["full"])
            commits.append(result.timings_ms["commit"])
            if not record["scenario_correct"]:
                confusions[(row["expected"], result.decision.scenario_id)] += 1
            print(f"{row['id']}: top1={record['scenario_correct']} decision={record['decision_correct']} "
                  f"language={record['language_correct']} got={result.decision.scenario_id}/{result.final_action}/"
                  f"{result.decision.language}", flush=True)
            if not (record["scenario_correct"] and record["decision_correct"]):
                print(f"    reason: {result.decision.reason}", flush=True)
        results.append(record)
        # An interrupted series retains its partial results, never labelled a complete run.
        save(target, {**metadata, "run": run_number, "complete": False, "results": results})
    metrics = summarize(results)
    report = {
        **metadata, "run": run_number, "complete": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "accuracy": metrics["top1"]["accuracy"],
        "scenario_accuracy": metrics["top1"]["accuracy"],
        "decision_accuracy": metrics["decision"]["accuracy"],
        "joint_accuracy": metrics["joint"]["accuracy"],
        "language_accuracy": metrics["language"]["accuracy"],
        "metrics": metrics, "by_type": grouped(results, "type"), "by_lang": grouped(results, "lang"),
        "multi_intent_found": f"{metrics['additional_intents']['correct']}/{metrics['additional_intents']['total']}",
        "latency_p50_ms": percentile(latencies, .5), "latency_p95_ms": percentile(latencies, .95),
        "commit_p50_ms": percentile(commits, .5),
        "top_confusions": [{"expected": a, "actual": b, "count": n} for (a, b), n in confusions.most_common(5)],
        "results": results,
    }
    save(target, report)
    print(json.dumps(metrics, ensure_ascii=False), flush=True)
    return report


def aggregate(reports: list[dict]) -> dict:
    if not reports or not all(report["complete"] for report in reports):
        raise ValueError("Only complete runs can be aggregated")
    for report in reports[1:]:
        if report["source_sha256"] != reports[0]["source_sha256"]:
            raise ValueError("Cannot compare runs with different code, catalog or tune")
        if [row["id"] for row in report["results"]] != [row["id"] for row in reports[0]["results"]]:
            raise ValueError("Cannot compare runs with different cases/order")
    result = {"dataset": "tune", "model": reports[0]["model"], "run_count": len(reports),
              "source_sha256": reports[0]["source_sha256"],
              "overall": across_runs([r["metrics"] for r in reports])}
    for field in ("by_type", "by_lang"):
        result[field] = {
            group: across_runs([r[field][group] for r in reports])
            for group in reports[0][field]
        }
    unstable = []
    for i, row in enumerate(reports[0]["results"]):
        outcomes = []
        for report in reports:
            record = report["results"][i]
            decision = record.get("decision", {})
            outcomes.append({"scenario_id": decision.get("scenario_id"),
                             "decision": record.get("final_action"),
                             "topic_switch": decision.get("topic_switch"),
                             "error_type": record.get("error_type")})
        if len({json.dumps(outcome, sort_keys=True) for outcome in outcomes}) > 1:
            unstable.append({"id": row["id"], "outcomes": outcomes})
    result["unstable_cases"] = unstable
    return result


def summary_markdown(summary, paths):
    def percent(value):
        return "не измеряется" if value is None else f"{100 * value:.2f}%"

    lines = ["# Базовый замер tune", "", f"Модель: `{summary['model']}`. Прогонов: {summary['run_count']}.",
             "Holdout не запускался. Промпт, каталог и пороги между прогонами не менялись.", "",
             "Top-1 — только равенство scenario_id (включая null). Decision — равенство действия и,",
             "если размечен expected_topic_switch, флага смены темы. Joint — одновременно top-1 и decision.",
             "Ошибки API/валидации считаются промахами. Неразмеченный topic_switch не оценивается.", ""]
    for title, groups in (("Все фразы", {"all": summary["overall"]}),
                          ("По типам", summary["by_type"]), ("По языкам", summary["by_lang"])):
        lines += [f"## {title}", "", "| Группа | Метрика | Прогоны | Среднее | Мин–макс | Размах, п.п. | σ, п.п. |",
                  "|---|---|---|---|---|---|---|"]
        for group, metrics in groups.items():
            for name, values in metrics.items():
                spread = "—" if values["range_pp"] is None else f"{values['range_pp']:.2f}"
                stddev = "—" if values["stddev_pp"] is None else f"{values['stddev_pp']:.2f}"
                lines.append(f"| {group} | {name} | {', '.join(percent(v) for v in values['runs'])} | "
                             f"{percent(values['mean'])} | {percent(values['min'])}–{percent(values['max'])} | {spread} | {stddev} |")
        lines.append("")
    lines += ["## Нестабильные ответы", "", ", ".join(row["id"] for row in summary["unstable_cases"]) or "Нет.",
              "", "## Исходные отчёты", ""]
    lines += [f"- [{path.name}]({path.name})" for path in paths]
    return "\n".join(lines) + "\n"


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=1, help="consecutive full tune runs")
    parser.add_argument("--limit", type=int, help="only the first N tune rows (quick check before a merge)")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    rows = json.loads((ROOT / "eval/datasets/tune.json").read_text(encoding="utf-8"))[:args.limit]
    if not rows or len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Tune must be nonempty with unique IDs")
    for row in rows:
        for key in ("id", "text", "type", "lang", "expected"):
            if key not in row:
                raise ValueError(f"Missing {key} in tune row")
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    router = LLMRouter()
    if not router.catalog_path.is_absolute():
        router.catalog_path = ROOT / router.catalog_path
    hashes = fingerprints(router.catalog_path)
    metadata = {
        "dataset": "tune", "model": router.provider.model, "metric_version": 2,
        "source_sha256": hashes,
        "config": {"temperature": 0, "structured_output": router.provider.structured_output,
                   "logprobs": router.provider.logprobs, "route_threshold": router.route_threshold,
                   "margin_threshold": router.margin_threshold, "handoff_threshold": router.handoff_threshold},
        "packages": {name: version(name) for name in ("openai", "pydantic")},
        "python": sys.version.split()[0],
    }
    output = ROOT / "eval/reports"
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S_%fZ")
    stem = f"tune-{stamp}"
    reports, paths = [], []
    for number in range(1, args.runs + 1):
        if fingerprints(router.catalog_path) != hashes:
            raise RuntimeError("Inputs changed during evaluation; do not combine these runs")
        target = output / f"{stem}-run{number}.json"
        reports.append(await run_once(router, rows, number, metadata, target))
        paths.append(target)
    if fingerprints(router.catalog_path) != hashes:
        raise RuntimeError("Inputs changed during evaluation; do not combine these runs")
    summary = aggregate(reports)
    summary["reports"] = [path.name for path in paths]
    save(output / f"{stem}-summary.json", summary)
    (output / f"{stem}-summary.md").write_text(summary_markdown(summary, paths), encoding="utf-8")
    print(f"\nSummary: eval/reports/{stem}-summary.md", flush=True)


if __name__ == "__main__":
    asyncio.run(main())

