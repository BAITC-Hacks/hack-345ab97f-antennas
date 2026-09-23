"""Application-owned confidence calculation."""
from __future__ import annotations

import math
import re

from .providers import TokenLogprob

# The scenario_id value, quotes included: the opening quote token decides "null vs a scenario".
_SCENARIO_VALUE = re.compile(r'^\s*\{\s*"scenario_id"\s*:\s*(null|"(?:[^"\\]|\\.)*")')


def calculate_confidence(raw: str, tokens: list[TokenLogprob], alternative_count: int) -> tuple[float, float, bool]:
    """Return (confidence, margin, measured).

    measured=True: confidence is the probability of the whole scenario_id value, margin is the
    smallest gap between the chosen token and its best alternative inside that value.
    measured=False: the provider gave no logprobs, numbers are a rough rank-gap heuristic
    and must not override the LLM decision.
    """
    picked = _scenario_tokens(raw, tokens)
    if not picked:
        confidence = (0.82, 0.68, 0.52)[min(alternative_count, 2)]
        runner_up = (0.45, 0.55, 0.47)[min(alternative_count, 2)]
        return confidence, round(confidence - runner_up, 4), False

    confidence = math.exp(sum(token.logprob for token in picked))
    margin = min(_gap(token) for token in picked)
    return round(confidence, 4), round(max(0.0, margin), 4), True


def _scenario_tokens(raw: str, tokens: list[TokenLogprob]) -> list[TokenLogprob]:
    match = _SCENARIO_VALUE.match(raw)
    if not match or not tokens:
        return []
    start, end = match.span(1)
    if not "".join(token.token for token in tokens).startswith(raw[:end]):
        return []  # tokens do not line up with the text: do not guess
    picked, offset = [], 0
    for token in tokens:
        token_end = offset + len(token.token)
        if token_end > start and offset < end:
            picked.append(token)
        if token_end >= end:
            break
        offset = token_end
    return picked


def _gap(token: TokenLogprob) -> float:
    chosen = math.exp(token.logprob)
    runner_up = max((math.exp(lp) for text, lp in token.top if text != token.token), default=0.0)
    return chosen - runner_up
