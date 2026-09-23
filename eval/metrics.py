"""Evaluation only: these functions never influence router decisions."""
from __future__ import annotations

from collections import defaultdict
from statistics import mean, pstdev


METRICS = {
    "top1": "scenario_correct",
    "decision": "decision_correct",
    "action": "action_correct",
    "topic_switch": "topic_switch_correct",
    "joint": "joint_correct",
    "additional_intents": "additional_correct",
    "language": "language_correct",
}


def score(row: dict, decision: dict | None, final_action: str | None = None) -> dict:
    """Top-1 is literal scenario equality, including null, for EVERY action.

    Decision checks the action plus topic_switch only when explicitly labelled.
    A failed request is a miss, including on rows whose expected scenario is null.
    """
    present = decision is not None
    actual = decision or {}
    scenario_ok = present and actual.get("scenario_id") == row["expected"]
    action = final_action if final_action is not None else actual.get("decision")
    action_ok = present and action == row.get("expected_decision", "route")
    topic_ok = None
    if "expected_topic_switch" in row:
        topic_ok = present and actual.get("topic_switch") == row["expected_topic_switch"]
    decision_ok = action_ok and topic_ok is not False
    additional_ok = None
    if row.get("expected_additional"):
        found = {item["scenario_id"] for item in actual.get("additional_intents", [])}
        additional_ok = present and set(row["expected_additional"]) <= found
    # The router never receives the label: this measures its own language detection.
    language_ok = None
    if "lang" in row:
        language_ok = present and actual.get("language") == row["lang"]
    return {
        "correct": scenario_ok,
        "scenario_correct": scenario_ok,
        "decision_correct": decision_ok,
        "action_correct": action_ok,
        "topic_switch_correct": topic_ok,
        "joint_correct": scenario_ok and decision_ok,
        "additional_correct": additional_ok,
        "language_correct": language_ok,
    }


def summarize(results: list[dict]) -> dict:
    output = {}
    for name, key in METRICS.items():
        values = [row[key] for row in results if row[key] is not None]
        output[name] = {
            "correct": sum(values), "total": len(values),
            "accuracy": sum(values) / len(values) if values else None,
        }
    output["errors"] = sum("error" in row for row in results)
    return output


def grouped(results: list[dict], field: str) -> dict:
    groups = defaultdict(list)
    for row in results:
        groups[row[field]].append(row)
    return {key: summarize(rows) for key, rows in sorted(groups.items())}


def across_runs(summaries: list[dict]) -> dict:
    output = {}
    for name in METRICS:
        values = [summary[name]["accuracy"] for summary in summaries]
        measured = [value for value in values if value is not None]
        output[name] = {
            "runs": values,
            "mean": mean(measured) if measured else None,
            "min": min(measured) if measured else None,
            "max": max(measured) if measured else None,
            "range_pp": 100 * (max(measured) - min(measured)) if measured else None,
            "stddev_pp": 100 * pstdev(measured) if measured else None,
            "correct": sum(summary[name]["correct"] for summary in summaries),
            "total": sum(summary[name]["total"] for summary in summaries),
        }
    return output
