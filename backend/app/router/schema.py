"""Pydantic v2 request and dynamic structured-output models."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model, field_validator

Decision = Literal["route", "continue", "clarify", "handoff", "out_of_scope"]
Language = Literal["ru", "kk", "mixed"]
Emotion = Literal["neutral", "irritated", "anxious", "positive"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HistoryTurn(StrictModel):
    role: Literal["user", "assistant"]
    text: str


class DialogState(StrictModel):
    active_scenario: str | None = None
    filled_slots: dict[str, Any] = Field(default_factory=dict)
    topic_stack: list[str] = Field(default_factory=list)
    pending_intents: list[str] = Field(default_factory=list)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=4)
    clarify_count: int = Field(default=0, ge=0)
    last_bot_question: str | None = None

    @field_validator("history", mode="before")
    @classmethod
    def keep_last_four(cls, value: Any) -> Any:
        return value[-4:] if isinstance(value, list) else value


class Utterance(StrictModel):
    text: str = Field(min_length=1)
    lang: Language | None = None
    n_best: list[str] = Field(default_factory=list)


class Slot(StrictModel):
    name: str
    value: str  # OpenAI strict mode rejects properties without a type


def _literal(ids: list[str]) -> Any:
    if not ids:
        raise ValueError("At least one scenario id is required")
    return Literal.__getitem__(tuple(ids))


def build_router_decision_model(ids: list[str]) -> type[BaseModel]:
    """Build RouterDecision so a newly loaded catalog id enters its enum automatically."""
    scenario_id_type = _literal(ids)
    Alternative = create_model(
        "Alternative",
        __base__=StrictModel,
        scenario_id=(scenario_id_type, ...),
        why_not=(str, ...),
    )
    AdditionalIntent = create_model(
        "AdditionalIntent",
        __base__=StrictModel,
        scenario_id=(scenario_id_type, ...),
    )
    def validate_reason(value: str) -> str:
        if len(value.split()) > 20:
            raise ValueError("reason must contain at most 20 words")
        return value

    # Every field is required (no defaults): OpenAI strict mode demands all properties in "required".
    RouterDecision = create_model(
        "RouterDecision",
        __base__=StrictModel,
        scenario_id=(scenario_id_type | None, ...),
        decision=(Decision, ...),
        alternatives=(list[Alternative], Field(max_length=2)),
        additional_intents=(list[AdditionalIntent], ...),
        slots=(list[Slot], ...),
        language=(Language, ...),
        topic_switch=(bool, ...),
        emotion=(Emotion, ...),
        reason=(str, ...),
        __validators__={"reason_words": field_validator("reason")(validate_reason)},
    )
    return RouterDecision
