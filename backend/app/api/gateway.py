"""Bridge for the Node gateway (voice-router-backend, ROUTER_MODE=python): Python decides, Node does the rest.

The gateway owns the catalog, the session, voice and the handoff queue; it sends a snapshot of each
with every turn. The answer must pass voice-router-backend/src/validation.mjs validateDecision().
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..dialog.manager import executor_reply
from ..router.catalog import validate_catalog
from ..router.llm_router import LLMRouter, RouteResult
from ..router.schema import DialogState, HistoryTurn, Utterance

GENERIC_CLARIFY = {"ru": "Уточните, пожалуйста, с каким вопросом вы обращаетесь?",
                   "kk": "Нақтылаңызшы, қандай мәселе бойынша хабарласып тұрсыз?"}


class GatewayScenario(BaseModel):
    id: str
    title: str
    purpose: str
    boundary: str = ""
    ru: str = ""
    kk: str = ""


class GatewayTurn(BaseModel):
    role: str
    content: str


class GatewayIntent(BaseModel):
    scenario_id: str


class GatewaySession(BaseModel):
    history: list[GatewayTurn] = []
    active_scenario: str | None = None
    pending_intents: list[GatewayIntent] = []
    clarify_count: int = Field(default=0, ge=0)


class GatewayRouteIn(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    catalog: list[GatewayScenario] = Field(min_length=1)
    session: GatewaySession = GatewaySession()


async def gateway_route(router: LLMRouter, request: GatewayRouteIn) -> dict[str, Any]:
    catalog = to_router_catalog(request.catalog)
    state = to_state(request.session, {s.id for s in request.catalog})
    result = await router.route(state, Utterance(text=request.text.strip()), catalog=catalog)
    return to_gateway_decision(result, catalog, state)


def to_router_catalog(scenarios: list[GatewayScenario]) -> dict[str, Any]:
    return validate_catalog({"scenarios": [
        {
            "id": s.id,
            "name": s.title,
            "purpose": s.purpose,
            "boundaries": [{"neighbor": "", "rule": s.boundary}] if s.boundary.strip() else [],
            "examples": {"ru": [s.ru] if s.ru.strip() else [], "kk": [s.kk] if s.kk.strip() else []},
        }
        for s in scenarios
    ]})


def to_state(session: GatewaySession, ids: set[str]) -> DialogState:
    turns = [t for t in session.history if t.role in ("user", "assistant")]
    return DialogState(
        active_scenario=session.active_scenario if session.active_scenario in ids else None,
        pending_intents=[i.scenario_id for i in session.pending_intents if i.scenario_id in ids],
        history=[HistoryTurn(role=t.role, text=t.content) for t in turns[-4:]],
        clarify_count=session.clarify_count,
        last_bot_question=next((t.content for t in reversed(turns) if t.role == "assistant"), None),
    )


def to_gateway_decision(result: RouteResult, catalog: dict[str, Any], state: DialogState) -> dict[str, Any]:
    """Our five actions -> the gateway's three: continue is a route, out_of_scope is a handoff."""
    decision = result.decision
    lang = "kk" if decision.language == "kk" else "ru"
    action, scenario_id, reason = result.final_action, decision.scenario_id, decision.reason
    reply = executor_reply(result, catalog)
    if action == "continue":
        scenario_id = scenario_id or state.active_scenario
        if not scenario_id:
            action, reply = "clarify", GENERIC_CLARIFY[lang]
        else:
            action = "route"
    if action == "out_of_scope":
        action, reason = "handoff", f"Вне каталога: {reason}"  # the gateway's own prompt does the same
    if action != "route":
        scenario_id = None

    # Only the primary choice has a measured confidence. Secondary numbers are estimates:
    # alternatives get the runner-up estimate (confidence - margin), queued intents the turn confidence.
    confidence = float(result.confidence)
    runner_up = round(max(0.0, confidence - result.margin), 4)
    queued = _distinct((i.scenario_id for i in decision.additional_intents), scenario_id)
    return {
        "scenario_id": scenario_id,
        "decision": action,
        "confidence": confidence,
        "language": decision.language,
        "reason": (reason or "—")[:1200],
        "response_text": (reply or GENERIC_CLARIFY[lang])[:1200],
        "additional_intents": [{"scenario_id": sid, "confidence": confidence} for sid in queued],
        # A queued intent is not a rejected alternative: showing it twice would confuse the supervisor.
        "alternatives": [{"scenario_id": a.scenario_id, "confidence": runner_up, "why_not": a.why_not[:600]}
                         for a in _distinct_alternatives(decision.alternatives, scenario_id)
                         if a.scenario_id not in queued],
        "router": {"final_action": result.final_action, "margin": result.margin, "model": result.model,
                   "prompt_version": result.prompt_version, "timings_ms": result.timings_ms},
    }


def _distinct(ids, primary: str | None) -> list[str]:
    seen: list[str] = []
    for sid in ids:
        if sid != primary and sid not in seen:
            seen.append(sid)
    return seen[:4]


def _distinct_alternatives(alternatives, primary: str | None) -> list[Any]:
    keep = set(_distinct((a.scenario_id for a in alternatives), primary))
    out, seen = [], set()
    for a in alternatives:
        if a.scenario_id in keep and a.scenario_id not in seen:
            out.append(a)
            seen.add(a.scenario_id)
    return out
