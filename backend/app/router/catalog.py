"""Scenario catalog loading and prompt rendering."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DEFAULT_CATALOG_PATH = Path(__file__).parents[3] / "data" / "scenarios.json"


def load_catalog(path: str | Path = DEFAULT_CATALOG_PATH) -> dict[str, Any]:
    """Read and validate the catalog on every call so editor changes are immediate."""
    source = Path(path)
    data = json.loads(source.read_text(encoding="utf-8"))
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("Catalog must contain a non-empty scenarios array")
    ids = [item.get("id") for item in scenarios]
    if any(not isinstance(item, str) or not item for item in ids):
        raise ValueError("Every scenario must have a non-empty string id")
    if len(ids) != len(set(ids)):
        raise ValueError("Scenario ids must be unique")
    return data


def scenario_ids(catalog: dict[str, Any]) -> list[str]:
    return [scenario["id"] for scenario in catalog["scenarios"]]


def render_catalog(catalog: dict[str, Any]) -> str:
    """Render only catalog-owned descriptions, boundaries, and 2–3 examples/language."""
    blocks: list[str] = []
    for scenario in catalog["scenarios"]:
        lines = [f"### {scenario['id']} — {scenario.get('name', '')}", f"Назначение: {scenario.get('purpose', '')}"]
        for boundary in scenario.get("boundaries", []):
            if boundary.get("neighbor"):
                lines.append(f"Граница с {boundary['neighbor']}: {boundary['rule']}")
            else:  # a rule added in the catalog editor without a neighbor scenario
                lines.append(f"Граница: {boundary['rule']}")
        for language in ("ru", "kk"):
            examples = scenario.get("examples", {}).get(language, [])[:3]
            if examples:
                lines.append(f"Примеры ({language}): " + "; ".join(f"«{value}»" for value in examples))
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)
