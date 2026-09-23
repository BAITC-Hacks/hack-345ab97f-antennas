"""Convert the router catalog to the frontend editor contract."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any

from pydantic import BaseModel, Field

from app.router.catalog import load_catalog


class ScenarioInput(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,63}$")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    boundaries: list[str] = Field(default_factory=list)
    examplesRu: list[str] = Field(default_factory=list)
    examplesKk: list[str] = Field(default_factory=list)


def public_scenario(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "name": item.get("name", ""),
        "description": item.get("purpose", ""),
        "boundaries": [part["rule"] for part in item.get("boundaries", [])],
        "examplesRu": item.get("examples", {}).get("ru", []),
        "examplesKk": item.get("examples", {}).get("kk", []),
    }


class ScenarioCatalog:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.lock = Lock()

    def list(self) -> list[dict[str, Any]]:
        return [public_scenario(item) for item in load_catalog(self.path)["scenarios"]]

    def save(self, scenario: ScenarioInput) -> dict[str, Any]:
        with self.lock:
            catalog = load_catalog(self.path)
            items = catalog["scenarios"]
            current = next((item for item in items if item["id"] == scenario.id), None)
            updated = dict(current or {})
            old_boundaries = {part["rule"]: part for part in updated.get("boundaries", [])}
            updated.update({
                "id": scenario.id,
                "name": scenario.name,
                "purpose": scenario.description,
                "boundaries": [old_boundaries.get(rule, {"neighbor": "other", "rule": rule})
                               for rule in scenario.boundaries],
                "examples": {"ru": scenario.examplesRu, "kk": scenario.examplesKk},
            })
            if current is None:
                updated.update(params=[], actions=[], irreversible=False)
                items.append(updated)
            else:
                items[items.index(current)] = updated
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix=".scenarios-", suffix=".json", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(catalog, stream, ensure_ascii=False, indent=2)
                    stream.write("\n")
                os.replace(temp_path, self.path)
            finally:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
            return public_scenario(updated)
