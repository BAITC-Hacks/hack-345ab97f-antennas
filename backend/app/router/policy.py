"""Deterministic dialog bookkeeping after the LLM decision."""
from __future__ import annotations

from .llm_router import RouteResult
from .schema import DialogState


def apply(state: DialogState, result: RouteResult) -> DialogState:
    updated = state.model_copy(deep=True)
    selected = result.decision.scenario_id
    if result.decision.topic_switch and state.active_scenario and state.active_scenario != selected:
        if state.active_scenario not in updated.topic_stack:
            updated.topic_stack.append(state.active_scenario)
    for intent in result.decision.additional_intents:
        if intent.scenario_id not in updated.pending_intents:
            updated.pending_intents.append(intent.scenario_id)
    if result.final_action == "complete":
        if updated.pending_intents:
            updated.active_scenario = updated.pending_intents.pop(0)
        elif updated.topic_stack:
            updated.active_scenario = updated.topic_stack.pop()
        else:
            updated.active_scenario = None
    elif selected and result.final_action in {"route", "continue"}:
        updated.active_scenario = selected
    updated.clarify_count = state.clarify_count + 1 if result.final_action == "clarify" else 0
    return updated
