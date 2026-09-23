"""Dialog Manager for one call: router -> policy -> executor -> frontend events.

Text-only path. STT/TTS plug in around handle_turn(): transcript in, reply text out.
"""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..router import policy
from ..router.catalog import load_catalog
from ..router.llm_router import LLMRouter, RouteResult
from ..router.schema import DialogState, HistoryTurn, Utterance

Emit = Callable[[dict[str, Any]], Awaitable[None]]

# Fixed replies for decisions without a scenario. Kazakh texts: to be checked by a native speaker.
REPLIES = {
    "handoff": {"ru": "Соединяю вас с оператором.", "kk": "Сізді операторға қосып жатырмын."},
    "out_of_scope": {
        "ru": "К сожалению, с этим вопросом я не помогу. Могу помочь с полисами, оплатой и выплатами.",
        "kk": "Кешіріңіз, бұл сұрақ бойынша көмектесе алмаймын. Полис, төлем және өтемақы бойынша көмектесемін.",
    },
    "continue": {"ru": "Спасибо, записал.", "kk": "Рахмет, жазып алдым."},
    "next": {"ru": "После этого помогу: {names}.", "kk": "Одан кейін мына сұрақ бойынша көмектесемін: {names}."},
}


class CallSession:
    def __init__(self, call_id: str, router: LLMRouter) -> None:
        self.call_id = call_id
        self.router = router
        self.state = DialogState()

    async def handle_turn(self, text: str, emit: Emit) -> dict[str, Any]:
        started = time.perf_counter()
        turn_id = f"turn-{uuid.uuid4().hex[:10]}"
        await emit({"type": "status", "status": "thinking"})

        result = await self.router.route(self.state, Utterance(text=text))
        exec_started = time.perf_counter()
        catalog = load_catalog(self.router.catalog_path)
        reply = executor_reply(result, catalog)
        self._remember(result, text, reply)
        exec_ms = (time.perf_counter() - exec_started) * 1000

        lang = result.decision.language
        transcript = {"turnId": turn_id, "text": text, "lang": lang, "isFinal": True}
        route = route_decision(result, turn_id)
        await emit({"type": "transcript", "transcript": transcript})
        await emit({"type": "route", "route": route})
        await emit({"type": "status", "status": "speaking"})
        await emit({"type": "reply", "text": reply})
        await emit({"type": "status", "status": "completed"})

        dialog = {
            "id": turn_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "status": "handoff" if result.final_action == "handoff" else "completed",
            "transcript": transcript,
            "route": route,
            # Only measured stages: no STT/TTS yet, so those stay absent ("нет данных"), never 0.
            "timings": {
                "route": round(result.timings_ms["full"]),
                "exec": round(exec_ms),
                "total": round((time.perf_counter() - started) * 1000),
            },
            "reply": reply,
        }
        if result.final_action == "handoff":
            dialog["handoffReason"] = result.decision.reason
        return dialog

    def _remember(self, result: RouteResult, text: str, reply: str) -> None:
        state = policy.apply(self.state, result)
        state.last_bot_question = reply
        state.history = (state.history + [HistoryTurn(role="user", text=text),
                                          HistoryTurn(role="assistant", text=reply)])[-4:]
        self.state = state


def executor_reply(result: RouteResult, catalog: dict[str, Any]) -> str:
    """Mock executor: answers with the scenario's response_example; performs no real action."""
    decision, action = result.decision, result.final_action
    lang = "kk" if decision.language == "kk" else "ru"
    if action == "clarify":
        return result.clarify_question or ""
    if action in {"handoff", "out_of_scope", "continue"}:
        return REPLIES[action][lang]
    scenarios = {item["id"]: item for item in catalog["scenarios"]}
    scenario = scenarios.get(decision.scenario_id, {})
    examples = scenario.get("response_example", {})
    reply = examples.get(lang) or examples.get("ru") or f"Помогу: {scenario.get('name', decision.scenario_id)}."
    queued = [scenarios[i.scenario_id].get("name", i.scenario_id) for i in decision.additional_intents
              if i.scenario_id in scenarios]
    if queued:
        reply += " " + REPLIES["next"][lang].format(names=", ".join(queued))
    return reply


def route_decision(result: RouteResult, turn_id: str) -> dict[str, Any]:
    """RouteResult -> frontend RouteDecision. Per-alternative confidence is not measured: null."""
    decision = result.decision
    return {
        "turnId": turn_id,
        "scenarioId": decision.scenario_id,
        "decision": result.final_action,
        "confidence": result.confidence,
        "path": result.path,
        "reason": decision.reason,
        "topicSwitch": decision.topic_switch,
        "additionalIntents": [{"scenarioId": i.scenario_id, "confidence": None} for i in decision.additional_intents],
        "alternatives": [{"scenarioId": a.scenario_id, "confidence": None, "whyNot": a.why_not}
                         for a in decision.alternatives],
    }
