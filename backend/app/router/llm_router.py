"""Async LLM-only router with validated JSON and streaming early commit."""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .catalog import DEFAULT_CATALOG_PATH, load_catalog, scenario_ids
from .confidence import calculate_confidence
from .prompt import PROMPT_VERSION, build_messages, build_static_prompt
from .providers import LLMProvider, OpenAIProvider, TokenLogprob
from .schema import DialogState, Utterance, build_router_decision_model

CommitCallback = Callable[[dict[str, Any]], None | Awaitable[None]]


class RouteResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    decision: Any
    confidence: float = Field(ge=0, le=1)
    margin: float = Field(ge=0, le=1)
    final_action: str
    clarify_question: str | None = None
    handoff_card: dict[str, Any] | None = None
    path: str = "llm"
    model: str
    prompt_version: str = PROMPT_VERSION
    timings_ms: dict[str, float]


class LLMRouter:
    def __init__(self, provider: LLMProvider | None = None, catalog_path: str | Path | None = None) -> None:
        _load_dotenv()
        self.catalog_path = Path(catalog_path or os.getenv("ROUTER_CATALOG_PATH", DEFAULT_CATALOG_PATH))
        self.provider = provider or _provider_from_env()
        self.route_threshold = float(os.getenv("ROUTER_ROUTE_THRESHOLD", "0.75"))
        self.margin_threshold = float(os.getenv("ROUTER_MARGIN_THRESHOLD", "0.20"))
        self.handoff_threshold = float(os.getenv("ROUTER_HANDOFF_THRESHOLD", "0.45"))

    async def warm_up(self) -> None:
        await self.provider.warm_up()

    async def route(
        self, state: DialogState, utterance: Utterance, on_commit: CommitCallback | None = None
    ) -> RouteResult:
        started = time.perf_counter()
        # Reload each request: catalog-editor changes require no server restart.
        catalog = load_catalog(self.catalog_path)
        decision_model = build_router_decision_model(scenario_ids(catalog))
        schema = decision_model.model_json_schema()
        messages = build_messages(build_static_prompt(catalog), state, utterance)

        # Language runs in parallel with routing: no extra latency on the critical path.
        language_task = asyncio.create_task(self.provider.detect_language(utterance.text))
        try:
            raw, tokens, commit_ms = await self._stream_once(messages, schema, started, on_commit)
            try:
                decision = decision_model.model_validate_json(raw)
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                # Exactly one repair attempt, with the error as feedback. Free text is never executed.
                repair = messages + [
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": f"Invalid JSON: {_error_summary(error)}. Return the corrected JSON only."},
                ]
                response = await self.provider.request(repair, schema)
                raw, tokens = response.text, response.tokens
                decision = decision_model.model_validate_json(raw)
            decision = await _with_language(decision, language_task)
        finally:
            language_task.cancel()  # no-op when finished; stops it if routing failed

        confidence, margin, measured = calculate_confidence(raw, tokens, len(decision.alternatives))
        final_action = _final_action(decision, confidence, margin, measured, state.clarify_count, self)
        if final_action != decision.decision and final_action in {"clarify", "handoff"}:
            decision = decision.model_copy(update={"decision": final_action})
        clarify_question = _clarify_question(decision, catalog) if final_action == "clarify" else None
        handoff_card = _handoff_card(state, utterance, decision, final_action) if final_action == "handoff" else None
        full_ms = (time.perf_counter() - started) * 1000
        return RouteResult(
            decision=decision,
            confidence=confidence,
            margin=margin,
            final_action=final_action,
            clarify_question=clarify_question,
            handoff_card=handoff_card,
            model=self.provider.model,
            timings_ms={"commit": round(commit_ms or full_ms, 3), "full": round(full_ms, 3)},
        )

    async def _stream_once(
        self,
        messages: list[dict[str, str]],
        schema: dict[str, Any],
        started: float,
        callback: CommitCallback | None,
    ) -> tuple[str, list[TokenLogprob], float | None]:
        raw = ""
        tokens: list[TokenLogprob] = []
        commit_ms: float | None = None
        committed = False
        async for chunk in self.provider.stream(messages, schema):
            raw += chunk.text
            tokens.extend(chunk.tokens)
            fields = _early_fields(raw)
            if fields and not committed:
                committed = True
                commit_ms = (time.perf_counter() - started) * 1000
                if callback:
                    returned = callback(fields)
                    if inspect.isawaitable(returned):
                        await returned
        return raw, tokens, commit_ms


async def _with_language(decision: Any, task: asyncio.Task) -> Any:
    """Use the separate detector's language when it answered; routing never fails because of it."""
    try:
        language = await task
    except Exception:
        return decision
    if language in {"ru", "kk", "mixed"} and language != decision.language:
        return decision.model_copy(update={"language": language})
    return decision


def _early_fields(raw: str) -> dict[str, Any] | None:
    """Read only the first two closed JSON fields; never execute unvalidated free text."""
    match = re.match(
        r'^\s*\{\s*"scenario_id"\s*:\s*(null|"(?:[^"\\]|\\.)*")\s*,\s*"decision"\s*:\s*"([^"\\]+)"',
        raw,
    )
    if not match or match.group(2) not in {"route", "continue", "clarify", "handoff", "out_of_scope"}:
        return None
    scenario = None if match.group(1) == "null" else json.loads(match.group(1))
    return {"scenario_id": scenario, "decision": match.group(2)}


def _final_action(
    decision: Any, confidence: float, margin: float, measured: bool, clarify_count: int, router: LLMRouter
) -> str:
    if decision.decision in {"handoff", "out_of_scope", "continue"}:
        return decision.decision
    action = decision.decision
    if action == "route" and decision.scenario_id is None:
        action = "clarify"  # nothing to execute
    elif action == "route" and measured:
        # Thresholds apply only to measured confidence; the no-logprobs heuristic never overrides the LLM.
        if confidence < router.handoff_threshold:
            action = "handoff"
        elif confidence < router.route_threshold or margin < router.margin_threshold:
            action = "clarify"
    if action == "clarify" and clarify_count >= 2:
        return "handoff"  # a third clarification in a row goes to a human
    return action


def _clarify_question(decision: Any, catalog: dict[str, Any]) -> str:
    names = {item["id"]: item.get("name", item["id"]) for item in catalog["scenarios"]}
    candidates = [decision.scenario_id] + [item.scenario_id for item in decision.alternatives]
    labels = [names[item] for item in candidates if item in names][:2]
    if not labels:  # no candidate at all: ask an open question instead of "X or Y"
        if decision.language == "kk":
            return "Нақтылаңызшы, қандай мәселе бойынша хабарласып тұрсыз?"
        return "Уточните, пожалуйста, с каким вопросом вы обращаетесь?"
    if len(labels) < 2:
        labels.append("другой вопрос" if decision.language != "kk" else "басқа мәселе")
    if decision.language == "kk":
        return f"Нақтылаңыз: сізге {labels[0]} әлде {labels[1]} керек пе?"
    return f"Уточните: вы хотите {labels[0]} или {labels[1]}?"


def _handoff_card(state: DialogState, utterance: Utterance, decision: Any, reason: str) -> dict[str, Any]:
    return {
        "summary": utterance.text,
        "candidates": [item for item in [decision.scenario_id, *[a.scenario_id for a in decision.alternatives]] if item],
        "slots": [slot.model_dump() for slot in decision.slots],
        "attempts": state.clarify_count,
        "reason": reason if reason != "handoff" else decision.reason,
        "language": decision.language,
        "emotion": decision.emotion,
    }


def _provider_from_env() -> LLMProvider:
    provider = os.getenv("LLM_PROVIDER", "openai").lower()
    if provider != "openai":
        raise ValueError(f"Unsupported LLM_PROVIDER: {provider}")
    return OpenAIProvider(
        api_key=os.getenv("LLM_API_KEY", ""),
        model=os.getenv("LLM_MODEL", ""),
        base_url=os.getenv("LLM_BASE_URL") or None,
        structured_output=os.getenv("LLM_STRUCTURED_OUTPUT", "true").lower() == "true",
        logprobs=os.getenv("LLM_LOGPROBS", "true").lower() == "true",
    )


def _error_summary(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return "; ".join(f"{'.'.join(map(str, item['loc']))}: {item['msg']}" for item in error.errors()[:5])
    return str(error)[:300]


def _load_dotenv(path: str | Path = ".env") -> None:
    """Load simple KEY=VALUE entries without making imports depend on optional packages."""
    source = Path(path)
    if not source.exists():
        return
    for raw_line in source.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
