"""SQLite store for finished turns ("dialogs" in the frontend contract)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


class DialogStore:
    def __init__(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            "create table if not exists dialogs ("
            " id text primary key, call_id text not null, created_at text not null, payload text not null)"
        )
        self._db.execute("create index if not exists dialogs_created on dialogs(created_at)")
        self._db.commit()

    def save(self, call_id: str, dialog: dict[str, Any]) -> None:
        self._db.execute(
            "insert or replace into dialogs (id, call_id, created_at, payload) values (?, ?, ?, ?)",
            (dialog["id"], call_id, dialog["createdAt"], json.dumps(dialog, ensure_ascii=False)),
        )
        self._db.commit()

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self._db.execute("select payload from dialogs order by created_at desc limit ?", (limit,))
        return [json.loads(payload) for (payload,) in rows]

    def get(self, dialog_id: str) -> dict[str, Any] | None:
        row = self._db.execute("select payload from dialogs where id = ?", (dialog_id,)).fetchone()
        return json.loads(row[0]) if row else None
