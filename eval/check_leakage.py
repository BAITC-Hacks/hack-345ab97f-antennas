#!/usr/bin/env python3
"""Ensure evaluation utterances are not embedded in the router's static prompt."""
from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.router.catalog import load_catalog
from app.router.prompt import build_static_prompt

ROOT = Path(__file__).resolve().parents[1]


def normalize(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE).split())


def utterances(path: Path) -> list[tuple[str, str]]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    rows = payload if isinstance(payload, list) else payload.get("utterances", [])
    return [(str(row.get("id", "?")), row["text"]) for row in rows if isinstance(row, dict) and isinstance(row.get("text"), str)]


def catalog_examples(catalog: dict[str, Any]) -> list[str]:
    return [
        text
        for scenario in catalog["scenarios"]
        for values in scenario.get("examples", {}).values()
        for text in values
    ]


def main() -> None:
    catalog = load_catalog(ROOT / "data/scenarios.json")
    normalized_prompt = normalize(build_static_prompt(catalog))
    sources = [ROOT / "data/dev_utterances.json", *sorted((ROOT / "eval/datasets").glob("*.json"))]
    examples = [(text, normalize(text)) for text in catalog_examples(catalog)]
    leaked: list[str] = []
    warnings: list[str] = []
    for path in sources:
        for row_id, text in utterances(path):
            normalized = normalize(text)
            if normalized and normalized in normalized_prompt:
                leaked.append(f"{path.relative_to(ROOT)}:{row_id}")
            for example, normalized_example in examples:
                ratio = SequenceMatcher(None, normalized, normalized_example).ratio()
                if ratio >= .6 and normalized != normalized_example:
                    warnings.append(
                        f"WARNING {path.relative_to(ROOT)}:{row_id} похожа на пример каталога "
                        f"({ratio:.2f}): {example!r}"
                    )
    for warning in warnings:
        print(warning)
    if leaked:
        print("ERROR: фразы eval обнаружены в static prompt:")
        for item in leaked:
            print(f"- {item}")
        raise SystemExit(1)
    print(f"leakage check passed: {sum(len(utterances(path)) for path in sources)} phrases")


if __name__ == "__main__":
    main()
