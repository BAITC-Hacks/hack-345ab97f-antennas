"""REST + WebSocket contract of frontend/src/api/realApi.ts, with FakeProvider (no real API calls)."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.router.llm_router import LLMRouter
from app.router.providers import FakeProvider

CATALOG = Path(__file__).parents[2] / "data" / "scenarios.json"


def answer(scenario, decision="route", additional=(), language="ru"):
    return {
        "scenario_id": scenario, "decision": decision, "alternatives": [],
        "additional_intents": [{"scenario_id": s} for s in additional], "slots": [],
        "language": language, "topic_switch": False, "emotion": "neutral", "reason": "Причина по смыслу",
    }


def client_with(responses, tmp_path):
    router = LLMRouter(FakeProvider(responses), CATALOG)
    return TestClient(create_app(router=router, var_dir=tmp_path))


def turn(client, call_id, text):
    with client.websocket_connect(f"/ws?callId={call_id}") as socket:
        response = client.post(f"/calls/{call_id}/turns", json={"text": text})
        events = []
        while not events or events[-1]["type"] != "dialog":
            events.append(socket.receive_json())
    return response, events


def test_call_flow_events_reply_and_history(tmp_path):
    responses = [answer("payment_issue", additional=["change_delivery_address"]),
                 answer("payment_issue", decision="continue")]
    with client_with(responses, tmp_path) as client:
        scenarios = client.get("/scenarios").json()
        assert {"id", "name", "description", "boundaries", "examplesRu", "examplesKk"} <= set(scenarios[0])

        call_id = client.post("/calls").json()["callId"]
        response, events = turn(client, call_id, "Деньги списались, полис не пришёл. И адрес доставки поменять")
        assert response.status_code == 200
        assert [e["type"] for e in events] == ["status", "transcript", "route", "status", "reply", "status", "dialog"]
        dialog = events[-1]["dialog"]
        assert dialog == response.json()
        assert dialog["route"]["scenarioId"] == "payment_issue"
        assert dialog["route"]["additionalIntents"] == [{"scenarioId": "change_delivery_address", "confidence": None}]
        assert dialog["reply"].startswith("Проверю ваш платёж.") and "Изменение адреса доставки" in dialog["reply"]
        assert set(dialog["timings"]) == {"route", "exec", "total"}  # unmeasured stages are absent, not 0

        _, events = turn(client, call_id, "Вчера вечером")
        assert events[-1]["dialog"]["route"]["decision"] == "continue"
        assert events[-1]["dialog"]["reply"] == "Спасибо, записал."

        history = client.get("/dialogs").json()
        assert [d["transcript"]["text"] for d in history] == ["Вчера вечером", "Деньги списались, полис не пришёл. И адрес доставки поменять"]
        assert client.get(f"/dialogs/{history[0]['id']}").json() == history[0]
        assert client.get("/dialogs/missing").status_code == 404
        assert client.post(f"/calls/{call_id}/end").status_code == 204
        assert client.post(f"/calls/{call_id}/turns", json={"text": "ещё"}).status_code == 404


def test_catalog_editor_changes_routing_without_restart(tmp_path):
    with client_with([answer("travel_delay")], tmp_path) as client:
        new = {"id": "travel_delay", "name": "Задержка рейса", "description": "Клиент застрял в поездке из-за задержки рейса.",
               "boundaries": ["report_claim: Случай уже произошёл и нужен вызов — это report_claim.", "Без багажа"],
               "examplesRu": ["Рейс задержали на сутки"], "examplesKk": []}
        assert client.put("/scenarios/travel_delay", json=new).json() == new
        assert any(item["id"] == "travel_delay" for item in client.get("/scenarios").json())
        assert (tmp_path / "scenarios.json").exists() and not CATALOG.read_text(encoding="utf-8").count("travel_delay")

        call_id = client.post("/calls").json()["callId"]
        response, _ = turn(client, call_id, "Рейс задержали, что делать?")
        assert response.json()["route"]["scenarioId"] == "travel_delay"  # new id is in the router enum


def test_bad_requests(tmp_path):
    with client_with([], tmp_path) as client:
        bad = {"id": "Bad Id", "name": "x", "description": "y"}
        assert client.put("/scenarios/Bad Id", json=bad).status_code == 422
        assert client.post("/calls/unknown/turns", json={"text": "привет"}).status_code == 404
        call_id = client.post("/calls").json()["callId"]
        assert client.post(f"/calls/{call_id}/turns", json={"text": ""}).status_code == 422
        # FakeProvider has no answers left: the router fails, the API reports it instead of hanging
        assert client.post(f"/calls/{call_id}/turns", json={"text": "привет"}).status_code == 502
