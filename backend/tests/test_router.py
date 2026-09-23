from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path

import pytest

from app.router.catalog import load_catalog, scenario_ids
from app.router.confidence import calculate_confidence
from app.router.llm_router import LLMRouter
from app.router.policy import apply
from app.router.prompt import INSTRUCTIONS, PROMPT_VERSION
from app.router.providers import FakeProvider, LLMChunk, TokenLogprob
from app.router.schema import DialogState, Utterance, build_router_decision_model

CATALOG = Path(__file__).parents[2] / "data" / "scenarios.json"


def test_prompt_routing_rules_are_semantic_and_supervisor_text_is_russian():
    assert PROMPT_VERSION == "router-v1.3"
    assert "supplies exactly what the robot's latest question requested" in INSTRUCTIONS
    assert "return to a topic in topic_stack" in INSTRUCTIONS
    assert "too vague to select a catalog scenario" in INSTRUCTIONS
    assert "Missing parameters (policy number, date, address) are not vagueness" in INSTRUCTIONS
    assert "reason and every why_not in Russian" in INSTRUCTIONS
    assert "language is the language of the client's latest utterance" in INSTRUCTIONS


def answer(scenario="payment_issue", decision="route", alternatives=None, additional=None, topic_switch=False):
    return {
        "scenario_id": scenario,
        "decision": decision,
        "alternatives": alternatives or [],
        "additional_intents": additional or [],
        "slots": [],
        "language": "ru",
        "topic_switch": topic_switch,
        "emotion": "neutral",
        "reason": "Подходящий сценарий по смыслу",
    }


def test_dynamic_enum_follows_catalog(tmp_path):
    source = load_catalog(CATALOG)
    source["scenarios"].append({"id": "new_runtime_scenario", "name": "Новый", "purpose": "Новый сценарий"})
    path = tmp_path / "scenarios.json"
    path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    model = build_router_decision_model(scenario_ids(load_catalog(path)))
    parsed = model.model_validate(answer("new_runtime_scenario"))
    assert parsed.scenario_id == "new_runtime_scenario"
    with pytest.raises(ValueError):
        model.model_validate(answer("unknown"))


def test_multi_intent_and_early_commit():
    async def run():
        payload = answer(additional=[{"scenario_id": "change_delivery_address"}])
        commits = []
        router = LLMRouter(FakeProvider([payload]), CATALOG)
        result = await router.route(
            DialogState(),
            Utterance(text="Я вчера оплатил, деньги списались, а заказ не подтвердился… а, и ещё адрес доставки поменять надо"),
            commits.append,
        )
        assert result.decision.scenario_id == "payment_issue"
        assert result.decision.additional_intents[0].scenario_id == "change_delivery_address"
        assert commits == [{"scenario_id": "payment_issue", "decision": "route"}]
        assert result.timings_ms["commit"] <= result.timings_ms["full"]
    asyncio.run(run())


def test_policy_topic_stack_and_intent_queue():
    model = build_router_decision_model(scenario_ids(load_catalog(CATALOG)))
    decision = model.model_validate(answer(
        topic_switch=True,
        additional=[{"scenario_id": "change_delivery_address"}],
    ))
    from app.router.llm_router import RouteResult
    result = RouteResult(
        decision=decision, confidence=.82, margin=.37, final_action="route", model="fake",
        timings_ms={"commit": 1, "full": 2},
    )
    updated = apply(DialogState(active_scenario="report_claim"), result)
    assert updated.topic_stack == ["report_claim"]
    assert updated.pending_intents == ["change_delivery_address"]
    assert updated.active_scenario == "payment_issue"
    completed = result.model_copy(update={"final_action": "complete"})
    resumed = apply(updated, completed)
    assert resumed.active_scenario == "change_delivery_address"


TWO_ALTERNATIVES = [
    {"scenario_id": "policy_status", "why_not": "Неясен статус"},
    {"scenario_id": "renew_policy", "why_not": "Неясно продление"},
]


def route_once(payload, state=None, text="Проблема со страховкой"):
    router = LLMRouter(FakeProvider([payload]), CATALOG)
    return asyncio.run(router.route(state or DialogState(), Utterance(text=text)))


def test_third_clarification_goes_to_handoff():
    result = route_once(answer(decision="clarify", alternatives=TWO_ALTERNATIVES), DialogState(clarify_count=2))
    assert result.final_action == "handoff"
    assert result.handoff_card["attempts"] == 2


def test_confident_route_after_two_clarifications_is_not_handed_off():
    result = route_once(answer("renew_policy"), DialogState(clarify_count=2), "Хочу продлить полис")
    assert result.final_action == "route"


def test_heuristic_confidence_never_overrides_llm_route():
    # FakeProvider gives no logprobs: alternatives alone must not turn a route into a clarify.
    result = route_once(answer(alternatives=TWO_ALTERNATIVES))
    assert result.final_action == "route"


def test_route_without_scenario_becomes_clarify():
    assert route_once(answer(scenario=None)).final_action == "clarify"


def tokens_for(raw, probabilities):
    """Split raw JSON into tokens; tokens listed in `probabilities` get that chance, others ~1."""
    pieces = ['{"', "scenario", "_id", '":"', "change", "_delivery", "_address", '","', raw[len('{"scenario_id":"change_delivery_address","'):]]
    assert "".join(pieces) == raw
    out = []
    for piece in pieces:
        p, runner_up = probabilities.get(piece, (1.0, 0.0))
        top = [(piece, math.log(p))] + ([("other", math.log(runner_up))] if runner_up else [])
        out.append(TokenLogprob(piece, math.log(p), top))
    return out


def test_measured_confidence_uses_scenario_tokens_only():
    raw = json.dumps(answer("change_delivery_address"), ensure_ascii=False, separators=(",", ":"))
    confident = tokens_for(raw, {"_delivery": (0.97, 0.03)})
    conf, margin, measured = calculate_confidence(raw, confident, 0)
    assert measured and conf == pytest.approx(0.97, abs=1e-3) and margin == pytest.approx(0.94, abs=1e-3)

    torn = tokens_for(raw, {"_delivery": (0.55, 0.44)})  # personal data vs delivery address
    conf, margin, measured = calculate_confidence(raw, torn, 0)
    assert measured and conf == pytest.approx(0.55, abs=1e-3) and margin == pytest.approx(0.11, abs=1e-3)


def test_low_measured_margin_turns_route_into_clarify():
    raw = json.dumps(answer("change_delivery_address"), ensure_ascii=False, separators=(",", ":"))

    class LogprobProvider(FakeProvider):
        async def stream(self, messages, schema):
            yield LLMChunk(self._next(), tokens_for(raw, {"_delivery": (0.55, 0.44)}))

    router = LLMRouter(LogprobProvider([raw]), CATALOG)
    result = asyncio.run(router.route(DialogState(), Utterance(text="Поменяйте адрес")))
    assert result.final_action == "clarify"
    assert result.clarify_question


class LanguageProvider(FakeProvider):
    def __init__(self, responses, language=None, fail=False):
        super().__init__(responses)
        self.language, self.fail = language, fail

    async def detect_language(self, text):
        if self.fail:
            raise RuntimeError("language call failed")
        return self.language


def test_separate_language_detection_overrides_router_language():
    # The routing call says "ru" for a Kazakh request; the dedicated call says "kk" and wins.
    payload = answer(decision="clarify", alternatives=TWO_ALTERNATIVES)
    router = LLMRouter(LanguageProvider([payload], language="kk"), CATALOG)
    result = asyncio.run(router.route(DialogState(), Utterance(text="Сақтандыруға байланысты сұрағым бар")))
    assert result.decision.language == "kk"
    assert result.clarify_question.startswith("Нақтылаңыз")


def test_failed_language_detection_keeps_routing_result():
    router = LLMRouter(LanguageProvider([answer("renew_policy")], fail=True), CATALOG)
    result = asyncio.run(router.route(DialogState(), Utterance(text="Хочу продлить полис")))
    assert result.final_action == "route" and result.decision.language == "ru"


def test_schema_meets_openai_strict_mode():
    schema = build_router_decision_model(scenario_ids(load_catalog(CATALOG))).model_json_schema()

    def check(node):
        if isinstance(node, dict):
            if "properties" in node:
                assert set(node["required"]) == set(node["properties"]), node.get("title")
                assert node.get("additionalProperties") is False, node.get("title")
                for name, prop in node["properties"].items():
                    assert {"type", "$ref", "anyOf", "enum"} & set(prop), name
            for value in node.values():
                check(value)
        elif isinstance(node, list):
            for value in node:
                check(value)

    check(schema)
