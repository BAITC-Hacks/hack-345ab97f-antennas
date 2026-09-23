#!/usr/bin/env python3
"""Export raw synthetic rows to a spreadsheet-friendly review CSV."""
from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "eval/datasets/synthetic_raw.json"
TARGET = ROOT / "eval/datasets/synthetic_review.csv"
FIELDS = ("id", "text", "lang", "type", "expected", "ok", "fix_expected", "fix_text", "comment")


def main() -> None:
    rows = json.loads(SOURCE.read_text(encoding="utf-8"))
    with TARGET.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({**{field: row.get(field, "") for field in FIELDS}, "ok": "", "fix_expected": "", "fix_text": "", "comment": ""})
    print(f"exported {len(rows)} rows to {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
