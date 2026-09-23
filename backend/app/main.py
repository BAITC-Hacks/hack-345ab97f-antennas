"""FastAPI entry point for text and PCM16 voice calls."""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator

from app.api.catalog import ScenarioCatalog, ScenarioInput
from app.router.catalog import DEFAULT_CATALOG_PATH, load_catalog
from app.router.llm_router import LLMRouter, RouteResult
from app.router.policy import apply
from app.router.schema import DialogState, HistoryTurn, Utterance
from app.speech.adapters import OpenAISTT, OpenAITTS, STT, TTS, pcm16_to_wav
from app.trace.store import DialogStore

MAX_AUDIO_BYTES = 30 * 16000 * 2
log = logging.getLogger(__name__)


class TurnInput(BaseModel):
    text: str = Field(min_length=1, max_length=4000)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Text must not be blank")
        return value


@dataclass
class CallSession:
    id: str
    state: DialogState = field(default_factory=DialogState)
    socket: WebSocket | None = None
    audio: bytearray = field(default_factory=bytearray)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _configured_speech() -> tuple[STT | None, TTS | None]:
    key = os.getenv("SPEECH_API_KEY") or os.getenv("LLM_API_KEY", "")
    stt_provider = os.getenv("STT_PROVIDER", "none").lower()
    tts_provider = os.getenv("TTS_PROVIDER", "none").lower()
    if stt_provider not in {"none", "openai"} or tts_provider not in {"none", "openai"}:
        raise ValueError("STT_PROVIDER and TTS_PROVIDER must be 'none' or 'openai'")
    if (stt_provider == "openai" or tts_provider == "openai") and not key:
        raise ValueError("SPEECH_API_KEY or LLM_API_KEY is required for speech")
    stt = OpenAISTT(key, os.getenv("STT_MODEL", "gpt-4o-mini-transcribe")) if stt_provider == "openai" else None
    tts = OpenAITTS(key, os.getenv("TTS_MODEL", "gpt-4o-mini-tts"), os.getenv("TTS_VOICE", "alloy")) if tts_provider == "openai" else None
    return stt, tts


def _reply(result: RouteResult, catalog: dict[str, Any]) -> str:
    decision = result.decision
    lang = "kk" if decision.language == "kk" else "ru"
    if result.final_action == "clarify":
        return result.clarify_question or "Уточните, пожалуйста, ваш вопрос."
    if result.final_action == "handoff":
        return "Сізді операторға қосамын." if lang == "kk" else "Соединяю вас с оператором."
    if result.final_action == "out_of_scope":
        return "Бұл сұрақ бойынша оператор көмектеседі." if lang == "kk" else "С этим вопросом поможет оператор."
    item = next((s for s in catalog["scenarios"] if s["id"] == decision.scenario_id), None)
    if not item:
        return "Уточните, пожалуйста, ваш вопрос."
    example = item.get("response_example", {}).get(lang)
    if example:
        return example
    return (f"{item['name']}. Мәліметтерді нақтылаңызшы." if lang == "kk"
            else f"{item['name']}. Уточните, пожалуйста, детали.")


def _public_route(result: RouteResult, turn_id: str) -> dict[str, Any]:
    decision = result.decision
    return {
        "turnId": turn_id,
        "scenarioId": decision.scenario_id,
        "decision": result.final_action,
        "confidence": result.confidence,
        "path": result.path,
        "reason": decision.reason,
        "topicSwitch": decision.topic_switch,
        "additionalIntents": [
            {"scenarioId": item.scenario_id, "confidence": result.confidence}
            for item in decision.additional_intents
        ],
        "alternatives": [
            {"scenarioId": item.scenario_id, "confidence": 0, "whyNot": item.why_not}
            for item in decision.alternatives
        ],
    }


def create_app(
    *,
    router: LLMRouter | None = None,
    stt: STT | None = None,
    tts: TTS | None = None,
    catalog_path: str | Path | None = None,
    db_path: str | Path | None = None,
) -> FastAPI:
    load_dotenv()
    catalog = ScenarioCatalog(catalog_path or getattr(router, "catalog_path", None) or
                              os.getenv("ROUTER_CATALOG_PATH", DEFAULT_CATALOG_PATH))
    store = DialogStore(db_path or os.getenv("DIALOG_DB_PATH", "backend/dialogs.sqlite3"))
    calls: dict[str, CallSession] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.router is not None or (os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL")):
            try:
                app.state.router = app.state.router or LLMRouter(catalog_path=catalog.path)
                await asyncio.wait_for(app.state.router.warm_up(), timeout=10)
            except Exception:
                log.exception("LLM warm-up failed; the server will remain available")
        yield

    app = FastAPI(title="Tyńda Voice Router", version="0.1.0", lifespan=lifespan)
    origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])
    app.state.router = router
    app.state.stt = stt
    app.state.tts = tts

    def get_router() -> LLMRouter:
        if app.state.router is None:
            try:
                app.state.router = LLMRouter(catalog_path=catalog.path)
            except ValueError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error
        return app.state.router

    def get_speech() -> tuple[STT | None, TTS | None]:
        if not hasattr(app.state, "speech_configured"):
            if app.state.stt is None and app.state.tts is None:
                app.state.stt, app.state.tts = _configured_speech()
            app.state.speech_configured = True
        return app.state.stt, app.state.tts

    async def emit(call: CallSession, event: dict[str, Any]) -> None:
        if call.socket is not None:
            try:
                await call.socket.send_json(event)
            except (RuntimeError, WebSocketDisconnect):
                call.socket = None

    async def process_turn(call: CallSession, text: str, stt_ms: float | None = None) -> dict[str, Any]:
        async with call.lock:
            started = time.perf_counter()
            turn_id = str(uuid4())
            await emit(call, {"type": "status", "status": "thinking"})
            try:
                result = await get_router().route(call.state, Utterance(text=text))
            except HTTPException:
                raise
            except Exception as error:
                raise HTTPException(status_code=502, detail=f"LLM routing failed: {error}") from error
            route_ms = (time.perf_counter() - started) * 1000
            transcript = {"turnId": turn_id, "text": text, "lang": result.decision.language, "isFinal": True}
            await emit(call, {"type": "transcript", "transcript": transcript})
            public_route = _public_route(result, turn_id)
            await emit(call, {"type": "route", "route": public_route})
            await emit(call, {"type": "route_decision", "result": result.model_dump(mode="json")})
            exec_started = time.perf_counter()
            reply = _reply(result, load_catalog(catalog.path))
            next_state = apply(call.state, result)
            next_state.filled_slots.update({slot.name: slot.value for slot in result.decision.slots})
            next_state.history = (call.state.history + [HistoryTurn(role="user", text=text),
                                                       HistoryTurn(role="assistant", text=reply)])[-4:]
            next_state.last_bot_question = reply if reply.endswith("?") else None
            call.state = next_state
            exec_ms = (time.perf_counter() - exec_started) * 1000
            await emit(call, {"type": "status", "status": "speaking"})
            await emit(call, {"type": "reply", "text": reply})
            timings: dict[str, float] = {"route": round(route_ms, 3), "exec": round(exec_ms, 3)}
            if stt_ms is not None:
                timings["stt"] = round(stt_ms, 3)
            try:
                _, speech_tts = get_speech()
                if speech_tts is not None:
                    audio_started = time.perf_counter()
                    audio = await speech_tts.synthesize(reply)
                    timings["firstAudio"] = round((time.perf_counter() - audio_started) * 1000, 3)
                    await emit(call, {"type": "tts_audio", "format": "wav", "chunk": base64.b64encode(audio).decode("ascii")})
            except Exception as error:
                await emit(call, {"type": "error", "message": f"TTS: {error}"})
            timings["total"] = round((time.perf_counter() - started) * 1000 + (stt_ms or 0), 3)
            dialog = {
                "id": turn_id,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "status": "handoff" if result.final_action == "handoff" else "completed",
                "transcript": transcript,
                "route": public_route,
                "routerResult": result.model_dump(mode="json"),
                "timings": timings,
                "reply": reply,
            }
            if result.handoff_card:
                dialog["handoffReason"] = result.decision.reason
                dialog["handoffCard"] = result.handoff_card
            store.save(dialog)
            await emit(call, {"type": "trace", "turn_id": turn_id, "timings_ms": timings})
            await emit(call, {"type": "status", "status": "completed"})
            await emit(call, {"type": "dialog", "dialog": dialog})
            return dialog

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "llmConfigured": bool(router or (os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL")))}

    @app.get("/scenarios")
    def list_scenarios() -> list[dict[str, Any]]:
        return catalog.list()

    @app.put("/scenarios/{scenario_id}")
    def save_scenario(scenario_id: str, body: ScenarioInput) -> dict[str, Any]:
        if scenario_id != body.id:
            raise HTTPException(status_code=422, detail="Scenario ID in URL and body must match")
        return catalog.save(body)

    @app.get("/dialogs")
    def list_dialogs() -> list[dict[str, Any]]:
        return store.list()

    @app.get("/dialogs/{dialog_id}")
    def get_dialog(dialog_id: str) -> dict[str, Any]:
        result = store.get(dialog_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Dialog not found")
        return result

    @app.post("/calls", status_code=201)
    def start_call() -> dict[str, str]:
        call = CallSession(id=str(uuid4()))
        calls[call.id] = call
        return {"callId": call.id}

    @app.post("/calls/{call_id}/turns")
    async def text_turn(call_id: str, body: TurnInput) -> dict[str, Any]:
        call = calls.get(call_id)
        if call is None:
            raise HTTPException(status_code=404, detail="Call not found")
        return await process_turn(call, body.text.strip())

    @app.post("/calls/{call_id}/end")
    async def end_call(call_id: str) -> dict[str, str]:
        call = calls.pop(call_id, None)
        if call is None:
            raise HTTPException(status_code=404, detail="Call not found")
        if call.socket is not None:
            await call.socket.close()
        return {"status": "ended"}

    @app.websocket("/ws")
    async def call_socket(socket: WebSocket) -> None:
        call = calls.get(socket.query_params.get("callId", ""))
        if call is None:
            await socket.close(code=4404)
            return
        await socket.accept()
        call.socket = socket
        await emit(call, {"type": "status", "status": "listening"})
        try:
            while True:
                message = await socket.receive_json()
                kind = message.get("type")
                try:
                    if kind == "text_input":
                        text = TurnInput(text=message.get("text", "")).text.strip()
                        await process_turn(call, text)
                    elif kind == "audio_chunk":
                        if message.get("sample_rate", 16000) != 16000:
                            raise ValueError("Only 16 kHz PCM16 mono is supported")
                        chunk = base64.b64decode(message.get("pcm16", ""), validate=True)
                        if len(chunk) % 2 or len(call.audio) + len(chunk) > MAX_AUDIO_BYTES:
                            raise ValueError("Audio must be PCM16 and at most 30 seconds")
                        call.audio.extend(chunk)
                    elif kind == "speech_end":
                        speech_stt, _ = get_speech()
                        if speech_stt is None:
                            raise ValueError("STT_PROVIDER is not configured")
                        if not call.audio:
                            raise ValueError("No audio received")
                        pcm = bytes(call.audio)
                        call.audio.clear()
                        await emit(call, {"type": "status", "status": "recognizing"})
                        started = time.perf_counter()
                        text = await speech_stt.transcribe(pcm16_to_wav(pcm))
                        if not text:
                            raise ValueError("Speech was not recognized")
                        await process_turn(call, text, (time.perf_counter() - started) * 1000)
                    else:
                        raise ValueError("Unknown WebSocket event type")
                except Exception as error:
                    await emit(call, {"type": "error", "message": str(error)})
        except WebSocketDisconnect:
            pass
        finally:
            if call.socket is socket:
                call.socket = None

    return app


app = create_app()
