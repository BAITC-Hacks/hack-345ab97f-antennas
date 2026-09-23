"""
schema.py — формат ответа роутера.

Здесь две вещи, и обе про одно и то же — «какой JSON должна вернуть LLM»:

1. build_json_schema() — JSON Schema для провайдера (structured output).
   Провайдер сам заставляет модель отвечать строго по этой схеме.
   Поле scenario_id — это enum из id каталога: модель физически
   не может выдумать сценарий, которого нет.

2. RouterDecision — Pydantic-модель. Проверяет ответ уже у нас в Python.
   Зачем дважды? Не все провайдеры поддерживают structured output.
   Двойная проверка = кривой ответ никогда не уйдёт дальше роутера.
"""
from typing import Literal, Optional, get_args

from pydantic import BaseModel, Field

Decision = Literal["route", "continue", "clarify", "handoff", "out_of_scope"]
Language = Literal["ru", "kk", "mixed"]
Emotion = Literal["neutral", "irritated", "anxious", "positive"]


class ExtraIntent(BaseModel):
    """Второе (третье...) намерение в одной фразе: «...и ещё адрес поменять»."""
    scenario_id: str
    confidence: float = Field(ge=0, le=1)


class Alternative(BaseModel):
    """Сценарий, который тоже подходил, и почему его НЕ выбрали."""
    scenario_id: str
    confidence: float = Field(ge=0, le=1)
    why_not: str


class Slot(BaseModel):
    """Параметр, который клиент назвал сам: дата, номер полиса, адрес."""
    name: str
    value: str


class RouterDecision(BaseModel):
    # Порядок полей важен: scenario_id первым -> потом сделаем early commit
    scenario_id: Optional[str]
    decision: Decision
    confidence: float = Field(ge=0, le=1)
    additional_intents: list[ExtraIntent] = []
    alternatives: list[Alternative] = []
    slots: list[Slot] = []
    language: Language
    topic_switch: bool
    emotion: Emotion
    reason: str

    def unknown_ids(self, valid_ids: set[str]) -> list[str]:
        """Возвращает id, которых нет в каталоге (должен быть пустой список)."""
        ids = [self.scenario_id]
        ids += [i.scenario_id for i in self.additional_intents]
        ids += [a.scenario_id for a in self.alternatives]
        return [sid for sid in ids if sid is not None and sid not in valid_ids]


def build_json_schema(scenario_ids: list[str]) -> dict:
    """
    JSON Schema в формате OpenAI-совместимого response_format.
    strict=True требует: все поля перечислены в required
    и additionalProperties=False (никаких лишних полей).
    """
    sid_enum = {"type": "string", "enum": scenario_ids}

    def obj(properties: dict) -> dict:
        return {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": list(properties.keys()),
        }

    schema = obj({
        # anyOf с null: scenario_id может быть пустым (например, при handoff)
        "scenario_id": {"anyOf": [sid_enum, {"type": "null"}]},
        "decision": {"type": "string", "enum": list(get_args(Decision))},
        "confidence": {"type": "number"},
        "additional_intents": {
            "type": "array",
            "items": obj({"scenario_id": sid_enum, "confidence": {"type": "number"}}),
        },
        "alternatives": {
            "type": "array",
            "items": obj({
                "scenario_id": sid_enum,
                "confidence": {"type": "number"},
                "why_not": {"type": "string"},
            }),
        },
        "slots": {
            "type": "array",
            "items": obj({"name": {"type": "string"}, "value": {"type": "string"}}),
        },
        "language": {"type": "string", "enum": list(get_args(Language))},
        "topic_switch": {"type": "boolean"},
        "emotion": {"type": "string", "enum": list(get_args(Emotion))},
        "reason": {"type": "string"},
    })

    return {"name": "router_decision", "strict": True, "schema": schema}
