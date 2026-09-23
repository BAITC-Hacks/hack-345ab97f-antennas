"""
prompt.py — собирает промпт для роутера.

Промпт состоит из двух частей:
- system: правила + каталог сценариев. НЕ меняется между запросами,
  поэтому провайдер может его закэшировать (prompt caching) -> быстрее и дешевле.
- user: состояние диалога + новая реплика. Меняется каждый раз.

Правила пишем на английском: модели следуют им стабильнее.
Каталог и примеры — на русском и казахском, как в данных.
"""
import json
from pathlib import Path

RULES = """You are the routing layer of a voice assistant for {company}, an insurance company in Kazakhstan.
Your only job: decide which scenario must handle the client's LATEST utterance. You never answer the client yourself.

How to decide:
1. The text comes from speech recognition. Expect recognition errors, missing punctuation and Russian-Kazakh mixing inside one sentence. Understand the meaning; do not translate.
2. Read the dialog state first. If the client answers the assistant's last question (a date, a number, an address, yes/no), decision = "continue" and scenario_id = the active scenario.
3. If the client raises a new topic while a scenario is active, decision = "route" and topic_switch = true.
4. If the client asks to return to a topic from topic_stack, decision = "route" with that scenario.
5. If one utterance contains several requests, scenario_id = the one to solve first (usually the first mentioned or the most urgent). Put the others in additional_intents.
6. Use the boundaries of each scenario to separate neighbors. Boundaries matter more than similar wording.
7. If two scenarios fit about equally, or the request is too vague to choose, decision = "clarify" and scenario_id = your best guess. Never guess silently.
8. If the client asks for a human operator, decision = "handoff" and scenario_id = null. If the request is outside all scenarios, decision = "out_of_scope".
9. confidence = probability that scenario_id is correct, from 0 to 1. Be honest: 0.5 means a coin flip.
10. alternatives: up to 2 other plausible scenarios, why_not in Russian, max 12 words.
11. slots: only parameters the client actually said. Never invent values.
12. reason: in Russian, max 20 words.
13. language: language of the latest utterance: "ru", "kk" or "mixed".
14. emotion: the client's emotional tone.

Output JSON only. Format:
{{"scenario_id": "...", "decision": "route", "confidence": 0.0, "additional_intents": [{{"scenario_id": "...", "confidence": 0.0}}], "alternatives": [{{"scenario_id": "...", "confidence": 0.0, "why_not": "..."}}], "slots": [{{"name": "...", "value": "..."}}], "language": "ru", "topic_switch": false, "emotion": "neutral", "reason": "..."}}

<catalog>
{catalog}
</catalog>"""


def load_catalog(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def render_catalog(catalog: dict) -> str:
    """Превращает JSON-каталог в компактный текст: меньше токенов -> быстрее ответ."""
    blocks = []
    for s in catalog["scenarios"]:
        lines = [f"### {s['id']} — {s['name']}", f"Назначение: {s['purpose']}"]
        for b in s.get("boundaries", []):
            lines.append(f"Граница с {b['neighbor']}: {b['rule']}")
        params = ", ".join(
            p["name"] + (" (обяз.)" if p.get("required") else "") for p in s.get("params", [])
        )
        if params:
            lines.append(f"Параметры: {params}")
        for lang, examples in s.get("examples", {}).items():
            lines.append(f"Примеры ({lang}): " + "; ".join(f"«{e}»" for e in examples))
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def build_system_prompt(catalog: dict) -> str:
    return RULES.format(company=catalog.get("company", "the company"), catalog=render_catalog(catalog))


def render_state(state: dict | None) -> str:
    """Состояние диалога -> короткий текст для модели."""
    if not state:
        return "active_scenario: none (start of the call)"
    lines = [f"active_scenario: {state.get('active_scenario') or 'none'}"]
    if state.get("last_assistant_message"):
        lines.append(f"last_assistant_message: \"{state['last_assistant_message']}\"")
    lines.append(f"topic_stack: {state.get('topic_stack', [])}")
    for turn in state.get("recent_turns", [])[-4:]:  # только последние 4 реплики
        lines.append(f"{turn['role']}: {turn['text']}")
    return "\n".join(lines)


def build_messages(system_prompt: str, utterance: str, state: dict | None = None) -> list[dict]:
    user = (
        f"<dialog_state>\n{render_state(state)}\n</dialog_state>\n"
        f"<utterance>\n{utterance}\n</utterance>"
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user},
    ]
