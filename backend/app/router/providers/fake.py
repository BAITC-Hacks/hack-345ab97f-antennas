"""Deterministic provider for tests; never calls an external API."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from .base import LLMChunk, LLMProvider, LLMResponse


class FakeProvider(LLMProvider):
    def __init__(self, responses: list[dict[str, Any] | str], model: str = "fake-router") -> None:
        self.responses = list(responses)
        self.model = model
        self.calls = 0
        self.warmed = False

    def _next(self) -> str:
        if self.calls >= len(self.responses):
            raise RuntimeError("FakeProvider has no response configured")
        value = self.responses[self.calls]
        self.calls += 1
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

    async def request(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> LLMResponse:
        return LLMResponse(self._next(), self.model)

    async def stream(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> AsyncIterator[LLMChunk]:
        text = self._next()
        for start in range(0, len(text), 16):
            yield LLMChunk(text[start : start + 16])

    async def warm_up(self) -> None:
        self.warmed = True
