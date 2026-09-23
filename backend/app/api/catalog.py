"""Catalog <-> frontend Scenario shape. Editing keeps router-only fields (params, actions, replies)."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..router.catalog import load_catalog

SCENARIO_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


class ScenarioIn(BaseModel):
    id: str
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    boundaries: list[str] = []
    examplesRu: list[str] = []
    examplesKk: list[str] = []


def to_frontend(scenario: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": scenario["id"],
        "name": scenario.get("name", scenario["id"]),
        "description": scenario.get("purpose", ""),
        "boundaries": [
            f"{b['neighbor']}: {b['rule']}" if b.get("neighbor") else b["rule"]
            for b in scenario.get("boundaries", [])
        ],
        "examplesRu": scenario.get("examples", {}).get("ru", []),
        "examplesKk": scenario.get("examples", {}).get("kk", []),
    }


def list_scenarios(path: Path) -> list[dict[str, Any]]:
    return [to_frontend(item) for item in load_catalog(path)["scenarios"]]


def save_scenario(path: Path, incoming: ScenarioIn) -> dict[str, Any]:
    if not SCENARIO_ID.match(incoming.id):
        raise ValueError("id: латиница в нижнем регистре, цифры и _, начинается с буквы")
    catalog = load_catalog(path)
    ids = {item["id"] for item in catalog["scenarios"]}
    existing = next((item for item in catalog["scenarios"] if item["id"] == incoming.id), None)
    scenario = {
        **(existing or {"params": [], "actions": [], "irreversible": False}),
        "id": incoming.id,
        "name": incoming.name.strip(),
        "purpose": incoming.description.strip(),
        "boundaries": [_boundary(text, ids) for text in incoming.boundaries if text.strip()],
        "examples": {"ru": _clean(incoming.examplesRu), "kk": _clean(incoming.examplesKk)},
    }
    if existing:
        catalog["scenarios"][catalog["scenarios"].index(existing)] = scenario
    else:
        catalog["scenarios"].append(scenario)
    _write_atomic(path, catalog)
    return to_frontend(scenario)


def _boundary(text: str, ids: set[str]) -> dict[str, str]:
    """"neighbor_id: rule" keeps the neighbor link; any other text is a standalone rule."""
    neighbor, _, rule = text.partition(":")
    if rule.strip() and neighbor.strip() in ids:
        return {"neighbor": neighbor.strip(), "rule": rule.strip()}
    return {"neighbor": "", "rule": text.strip()}


def _clean(values: list[str]) -> list[str]:
    return [value.strip() for value in values if value.strip()]


def _write_atomic(path: Path, catalog: dict[str, Any]) -> None:
    # The router re-reads the catalog on every turn: never let it see a half-written file.
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    load_catalog(tmp)  # validates ids before replacing the live file
    os.replace(tmp, path)
