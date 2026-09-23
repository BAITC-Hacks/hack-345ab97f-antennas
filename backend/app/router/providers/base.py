"""Provider adapter contract."""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class TokenLogprob:
    """One generated token, its log-probability and the top alternatives at that position."""
    token: str
    logprob: float
    top: list[tuple[str, float]] = field(default_factory=list)


@dataclass(slots=True)
class LLMChunk:
    text: str
    tokens: list[TokenLogprob] = field(default_factory=list)


@dataclass(slots=True)
class LLMResponse:
    text: str
    model: str
    tokens: list[TokenLogprob] = field(default_factory=list)


class LLMProvider(ABC):
    model: str

    @abstractmethod
    async def request(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> LLMResponse:
        """Return one structured response."""

    @abstractmethod
    def stream(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> AsyncIterator[LLMChunk]:
        """Stream JSON fragments in order."""

    async def warm_up(self) -> None:
        """Initialize reusable transports without consuming a completion by default."""
