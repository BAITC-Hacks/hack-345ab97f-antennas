from types import SimpleNamespace

import pytest

from eval.metrics import across_runs, grouped, score, summarize
from eval.run_eval import aggregate, run_once


@pytest.mark.parametrize("action", ["route", "continue", "clarify", "handoff"])
def test_top1_does_not_depend_on_action(action):
    result = score({"expected": "alpha"}, {"scenario_id": "alpha", "decision": action})
    assert result["scenario_correct"] is True
    assert result["decision_correct"] is (action == "route")


@pytest.mark.parametrize("action", ["clarify", "handoff"])
def test_null_expected_is_still_literal_scenario_equality(action):
    row = {"expected": None, "expected_decision": action}
    result = score(row, {"scenario_id": "alpha", "decision": action})
    assert result["scenario_correct"] is False
    assert result["decision_correct"] is True
    assert score(row, {"scenario_id": None, "decision": "route"})["scenario_correct"] is True
    assert score(row, None)["scenario_correct"] is False


@pytest.mark.parametrize("expected", [True, False])
def test_topic_switch_checked_only_when_explicit(expected):
    row = {"expected": "alpha", "expected_topic_switch": expected}
    decision = {"scenario_id": "alpha", "decision": "route", "topic_switch": not expected}
    assert score(row, decision)["decision_correct"] is False
    assert score(row, decision)["scenario_correct"] is True
    decision["topic_switch"] = expected
    assert score(row, decision)["decision_correct"] is True
    del row["expected_topic_switch"]
    assert score(row, decision)["topic_switch_correct"] is None


def test_final_action_and_explicit_continue_are_scored():
    row = {"expected": "alpha", "expected_decision": "continue"}
    decision = {"scenario_id": "alpha", "decision": "continue"}
    assert score(row, decision)["decision_correct"] is True
    assert score(row, decision, "handoff")["decision_correct"] is False


def test_failed_calls_stay_in_every_relevant_denominator():
    row = {"expected": "alpha", "type": "boundary", "lang": "mixed",
           "expected_topic_switch": False, "expected_additional": ["beta"]}
    records = [{**row, **score(row, None), "error": "failed"},
               {**row, **score(row, {"scenario_id": "alpha", "decision": "route", "topic_switch": False,
                                    "additional_intents": [{"scenario_id": "beta"}]})}]
    summary = summarize(records)
    for name in ("top1", "decision", "topic_switch", "additional_intents"):
        assert summary[name] == {"correct": 1, "total": 2, "accuracy": .5}
    assert grouped(records, "lang")["mixed"] == summary
    assert grouped(records, "type")["boundary"] == summary


def test_language_is_scored_against_the_label_only_when_labelled():
    row = {"expected": "alpha", "lang": "kk"}
    assert score(row, {"scenario_id": "alpha", "decision": "route", "language": "kk"})["language_correct"] is True
    assert score(row, {"scenario_id": "alpha", "decision": "route", "language": "ru"})["language_correct"] is False
    assert score(row, None)["language_correct"] is False
    assert score({"expected": "alpha"}, {"scenario_id": "alpha", "language": "ru"})["language_correct"] is None


def test_unlabelled_topic_is_not_reported_as_perfect():
    summary = summarize([score({"expected": "alpha"}, None)])
    assert summary["topic_switch"] == {"correct": 0, "total": 0, "accuracy": None}
    assert across_runs([summary] * 3)["topic_switch"]["mean"] is None


def test_run_variation_is_in_percentage_points():
    row = {"expected": "alpha"}
    good = score(row, {"scenario_id": "alpha", "decision": "route"})
    bad = score(row, None)
    values = across_runs([summarize([good, good]), summarize([good, bad]), summarize([bad, bad])])
    assert values["top1"]["mean"] == .5
    assert values["top1"]["range_pp"] == 100


@pytest.mark.asyncio
async def test_runner_preserves_errors_context_and_group_denominators(tmp_path):
    class FailedRouter:
        provider = SimpleNamespace(model="fake")

        async def route(self, state, utterance):
            raise ValueError("test validation error")

    rows = [{"id": "unit-1", "text": "unit fixture", "type": "simple", "lang": "ru",
             "expected": None, "expected_decision": "clarify", "context": {}}]
    report = await run_once(FailedRouter(), rows, 1, {"model": "fake", "source_sha256": {}}, tmp_path / "run.json")
    assert report["complete"] is True
    assert report["accuracy"] == 0
    assert report["decision_accuracy"] == 0
    assert report["results"][0]["text"] == "unit fixture"
    assert report["by_lang"]["ru"]["top1"]["total"] == 1
    changed = {**report, "source_sha256": {"catalog": "changed"}}
    with pytest.raises(ValueError, match="different code"):
        aggregate([report, changed])
