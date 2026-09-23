"""OpenAI provider using one reusable async keep-alive client."""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from .base import LLMChunk, LLMProvider, LLMResponse, TokenLogprob

TOP_LOGPROBS = 3  # alternatives per token: enough to see the runner-up scenario


class OpenAIProvider(LLMProvider):
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str | None = None,
        structured_output: bool = True,
        logprobs: bool = True,
    ) -> None:
        if not api_key or not model:
            raise ValueError("LLM_API_KEY and LLM_MODEL are required")
        from openai import AsyncOpenAI

        self.model = model
        self.structured_output = structured_output
        self.logprobs = logprobs
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    def _options(self, schema: dict[str, Any]) -> dict[str, Any]:
        if self.structured_output:
            response_format = {"type": "json_schema", "json_schema": {"name": "router_decision", "strict": True, "schema": schema}}
        else:
            response_format = {"type": "json_object"}
        options: dict[str, Any] = {"model": self.model, "response_format": response_format, "temperature": 0}
        if self.logprobs:
            # Not every OpenAI-compatible provider supports logprobs: turn off with LLM_LOGPROBS=false.
            options.update(logprobs=True, top_logprobs=TOP_LOGPROBS)
        return options

    async def request(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> LLMResponse:
        response = await self.client.chat.completions.create(messages=messages, **self._options(schema))
        choice = response.choices[0]
        return LLMResponse(choice.message.content or "", response.model, _extract_tokens(choice))

    async def stream(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> AsyncIterator[LLMChunk]:
        stream = await self.client.chat.completions.create(messages=messages, stream=True, **self._options(schema))
        async for event in stream:
            choice = event.choices[0] if event.choices else None
            if choice and choice.delta.content:
                yield LLMChunk(choice.delta.content, _extract_tokens(choice))

    async def warm_up(self) -> None:
        """Make the requested small startup call through the reusable client."""
        await self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": "Return an empty JSON object."}],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=8,
        )


def _extract_tokens(choice: Any) -> list[TokenLogprob]:
    content = getattr(getattr(choice, "logprobs", None), "content", None) or []
    return [
        TokenLogprob(item.token, item.logprob, [(top.token, top.logprob) for top in item.top_logprobs or []])
        for item in content
        if getattr(item, "logprob", None) is not None
    ]
