"""POST /gateway/route: the Node gateway's catalog + session in, a decision its validateDecision() accepts out."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.router.llm_router import LLMRouter
from app.router.providers import FakeProvider

ROOT = Path(__file__).parents[2]
GATEWAY_CATALOG = json.loads((ROOT / "voice-router-backend" / "catalog.seed.json").read_text(encoding="utf-8"))
IDS = {s["id"] for s in GATEWAY_CATALOG}


def answer(scenario, decision="route", additional=(), alternatives=(), language="ru"):
    return {
        "scenario_id": scenario, "decision": decision,
        "alternatives": [{"scenario_id": s, "why_not": "Клиент не просит этого"} for s in alternatives],
        "additional_intents": [{"scenario_id": s} for s in additional], "slots": [],
        "language": language, "topic_switch": False, "emotion": "neutral", "reason": "Причина по смыслу",
    }


def assert_gateway_valid(d):
    """Same rules as voice-router-backend/src/validation.mjs validateDecision()."""
    assert d["decision"] in {"route", "clarify", "handoff"}
    assert d["scenario_id"] is None or d["scenario_id"] in IDS
    assert (d["decision"] == "route") == (d["scenario_id"] is not None)
    assert 0 <= d["confidence"] <= 1
    assert d["language"] in {"ru", "kk", "mixed", "unknown"}
    assert d["reason"].strip() and d["response_text"].strip()
    for field in ("additional_intents", "alternatives"):
        ids = [item["scenario_id"] for item in d[field]]
        assert len(ids) <= 4 and len(set(ids)) == len(ids) and d["scenario_id"] not in ids and set(ids) <= IDS
        assert all(0 <= item["confidence"] <= 1 for item in d[field])


def route(responses, text, session=None, tmp_path=None):
    router = LLMRouter(FakeProvider(responses), ROOT / "data" / "scenarios.json")
    with TestClient(create_app(router=router, var_dir=tmp_path)) as client:
        body = {"text": text, "catalog": GATEWAY_CATALOG, "session": session or {}}
        return client.post("/gateway/route", json=body)


def test_route_uses_gateway_catalog_and_passes_its_validation(tmp_path):
    payload = answer("payment_not_confirmed", additional=["change_delivery_address"],
                     alternatives=["refund_request", "change_delivery_address"])
    d = route([payload], "Деньги списали, а заказ не появился. И адрес поменять", tmp_path=tmp_path).json()
    assert_gateway_valid(d)
    assert d["scenario_id"] == "payment_not_confirmed" and d["decision"] == "route"
    assert d["additional_intents"][0]["scenario_id"] == "change_delivery_address"
    assert [a["scenario_id"] for a in d["alternatives"]] == ["refund_request"]  # queued intent is not repeated
    assert "Проблема с подтверждением оплаты" in d["response_text"]  # no response_example in this catalog


def test_continue_becomes_route_on_active_scenario(tmp_path):
    session = {"history": [{"role": "user", "content": "Продлите мой полис"},
                           {"role": "assistant", "content": "Назовите номер полиса"}],
               "active_scenario": "policy_renewal", "pending_intents": [], "clarify_count": 0}
    d = route([answer("policy_renewal", decision="continue")], "KZ-12345", session, tmp_path).json()
    assert_gateway_valid(d)
    assert (d["decision"], d["scenario_id"]) == ("route", "policy_renewal")


def test_out_of_scope_goes_to_handoff_and_clarify_has_no_scenario(tmp_path):
    d = route([answer(None, decision="out_of_scope", language="kk")], "Ауа райы қандай?", tmp_path=tmp_path).json()
    assert_gateway_valid(d)
    assert (d["decision"], d["scenario_id"], d["language"]) == ("handoff", None, "kk")
    assert d["reason"].startswith("Вне каталога")

    d = route([answer(None, decision="clarify", alternatives=["payment_cancel", "refund_request"])],
              "Хочу отменить", tmp_path=tmp_path).json()
    assert_gateway_valid(d)
    assert d["decision"] == "clarify" and d["scenario_id"] is None and d["response_text"].endswith("?")


def test_broken_catalog_is_rejected(tmp_path):
    router = LLMRouter(FakeProvider([]), ROOT / "data" / "scenarios.json")
    with TestClient(create_app(router=router, var_dir=tmp_path)) as client:
        duplicate = [GATEWAY_CATALOG[0], GATEWAY_CATALOG[0]]
        assert client.post("/gateway/route", json={"text": "x", "catalog": duplicate}).status_code == 422
        assert client.post("/gateway/route", json={"text": "x", "catalog": []}).status_code == 422
