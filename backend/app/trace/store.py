"""Small SQLite store for completed turns."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


class DialogStore:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS dialogs ("
                "id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)"
            )

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def save(self, dialog: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO dialogs (id, created_at, payload) VALUES (?, ?, ?)",
                (dialog["id"], dialog["createdAt"], json.dumps(dialog, ensure_ascii=False)),
            )

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT payload FROM dialogs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def get(self, dialog_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM dialogs WHERE id = ?", (dialog_id,)).fetchone()
        return json.loads(row["payload"]) if row else None
