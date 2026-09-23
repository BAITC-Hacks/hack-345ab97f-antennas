from __future__ import annotations

import base64
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.router.llm_router import LLMRouter
from app.router.providers import FakeProvider


SOURCE = Path(__file__).parents[2] / "data" / "scenarios.json"


def answer(scenario: str = "payment_issue", *, language: str = "ru") -> dict:
    return {
        "scenario_id": scenario,
        "decision": "route",
        "alternatives": [],
        "additional_intents": [],
        "slots": [],
        "language": language,
        "topic_switch": False,
        "emotion": "neutral",
        "reason": "Подходящий сценарий по смыслу",
    }


def client(tmp_path: Path, responses: list[dict], *, stt=None, tts=None) -> TestClient:
    catalog = tmp_path / "scenarios.json"
    catalog.write_bytes(SOURCE.read_bytes())
    router = LLMRouter(FakeProvider(responses), catalog)
    return TestClient(create_app(router=router, stt=stt, tts=tts,
                                 catalog_path=catalog, db_path=tmp_path / "dialogs.sqlite3"))


def test_rest_turn_persists_measured_dialog_and_catalog(tmp_path: Path):
    api = client(tmp_path, [answer()])
    assert len(api.get("/scenarios").json()) == 10
    call_id = api.post("/calls").json()["callId"]
    result = api.post(f"/calls/{call_id}/turns", json={"text": "Оплата списалась, полис не пришёл"})
    assert result.status_code == 200
    dialog = result.json()
    assert dialog["route"]["scenarioId"] == "payment_issue"
    assert dialog["route"]["path"] == "llm"
    assert dialog["reply"] == "Проверю ваш платёж. Подскажите, когда вы оплачивали?"
    assert dialog["timings"]["route"] >= 0
    assert dialog["timings"]["total"] >= dialog["timings"]["route"]
    assert api.get("/dialogs").json()[0] == dialog
    assert api.get(f"/dialogs/{dialog['id']}").json() == dialog
    assert api.post(f"/calls/{call_id}/end").status_code == 200
    assert api.post(f"/calls/{call_id}/turns", json={"text": "Еще вопрос"}).status_code == 404


def test_catalog_edit_available_to_router_without_restart(tmp_path: Path):
    api = client(tmp_path, [answer("new_scenario")])
    scenario = {
        "id": "new_scenario", "name": "Новый случай", "description": "Клиент хочет новый сценарий",
        "boundaries": ["Не выполнять действия без оператора"],
        "examplesRu": ["Тестовое описание"], "examplesKk": [],
    }
    assert api.put("/scenarios/wrong", json=scenario).status_code == 422
    saved = api.put("/scenarios/new_scenario", json=scenario)
    assert saved.status_code == 200
    assert saved.json() == scenario
    assert api.get("/scenarios").json()[-1] == scenario
    call_id = api.post("/calls").json()["callId"]
    dialog = api.post(f"/calls/{call_id}/turns", json={"text": "Новый запрос"}).json()
    assert dialog["route"]["scenarioId"] == "new_scenario"
    assert json.loads((tmp_path / "scenarios.json").read_text(encoding="utf-8"))["scenarios"][-1]["actions"] == []


class FakeSTT:
    async def transcribe(self, wav: bytes) -> str:
        assert wav[:4] == b"RIFF"
        return "Менің полисім қайда?"


class FakeTTS:
    async def synthesize(self, text: str) -> bytes:
        assert text
        return b"RIFFfake"


def test_websocket_voice_pipeline_and_events(tmp_path: Path):
    api = client(tmp_path, [answer("policy_status", language="kk")], stt=FakeSTT(), tts=FakeTTS())
    call_id = api.post("/calls").json()["callId"]
    with api.websocket_connect(f"/ws?callId={call_id}") as ws:
        assert ws.receive_json()["status"] == "listening"
        ws.send_json({"type": "audio_chunk", "pcm16": base64.b64encode(b"\x00\x00" * 160).decode(), "sample_rate": 16000})
        ws.send_json({"type": "speech_end"})
        events = []
        while True:
            event = ws.receive_json()
            events.append(event)
            if event["type"] == "dialog":
                break
    names = [event["type"] for event in events]
    assert {"transcript", "route", "route_decision", "reply", "tts_audio", "trace", "dialog"} <= set(names)
    dialog = events[-1]["dialog"]
    assert dialog["transcript"]["lang"] == "kk"
    assert "stt" in dialog["timings"] and "firstAudio" in dialog["timings"]
    assert next(event["chunk"] for event in events if event["type"] == "tts_audio") == base64.b64encode(b"RIFFfake").decode()


def test_voice_rejects_oversized_audio(tmp_path: Path):
    api = client(tmp_path, [])
    call_id = api.post("/calls").json()["callId"]
    with api.websocket_connect(f"/ws?callId={call_id}") as ws:
        ws.receive_json()
        ws.send_json({"type": "audio_chunk", "pcm16": base64.b64encode(b"\x00" * (30 * 16000 * 2 + 2)).decode()})
        error = ws.receive_json()
        assert error["type"] == "error"
        assert "30 seconds" in error["message"]


def test_second_turn_receives_history_slots_and_pending_intent(tmp_path: Path):
    class RecordingProvider(FakeProvider):
        seen: list[list[dict[str, str]]]

        async def stream(self, messages, schema):
            self.seen.append(messages)
            async for chunk in super().stream(messages, schema):
                yield chunk

    first = answer()
    first["slots"] = [{"name": "policy_number", "value": "12345"}]
    first["additional_intents"] = [{"scenario_id": "claim_status"}]
    provider = RecordingProvider([first, answer("claim_status")])
    provider.seen = []
    catalog = tmp_path / "scenarios.json"
    catalog.write_bytes(SOURCE.read_bytes())
    api = TestClient(create_app(router=LLMRouter(provider, catalog), catalog_path=catalog,
                                db_path=tmp_path / "dialogs.sqlite3"))
    call_id = api.post("/calls").json()["callId"]
    api.post(f"/calls/{call_id}/turns", json={"text": "Оплата списалась"})
    api.post(f"/calls/{call_id}/turns", json={"text": "И где моя выплата?"})
    state = json.loads(provider.seen[1][-1]["content"])["dialog_state"]
    assert state["active_scenario"] == "payment_issue"
    assert state["filled_slots"]["policy_number"] == "12345"
    assert state["pending_intents"] == ["claim_status"]
    assert [turn["role"] for turn in state["history"]] == ["user", "assistant"]


def test_startup_warms_router_without_external_api(tmp_path: Path):
    catalog = tmp_path / "scenarios.json"
    catalog.write_bytes(SOURCE.read_bytes())
    provider = FakeProvider([])
    api = TestClient(create_app(router=LLMRouter(provider, catalog), catalog_path=catalog,
                                db_path=tmp_path / "dialogs.sqlite3"))
    with api:
        assert api.get("/health").json()["status"] == "ok"
    assert provider.warmed
