#!/usr/bin/env python3
"""Apply human CSV decisions while preserving machine-only metadata from raw JSON."""
from __future__ import annotations

import csv
import json
from pathlib import Path

from generate_synthetic import ROOT, catalog, validate

RAW = ROOT / "eval/datasets/synthetic_raw.json"
REVIEW = ROOT / "eval/datasets/synthetic_review.csv"
TARGET = ROOT / "eval/datasets/synthetic.json"


def main() -> None:
    raw = {row["id"]: row for row in json.loads(RAW.read_text(encoding="utf-8"))}
    accepted = []
    with REVIEW.open(encoding="utf-8-sig", newline="") as source:
        for reviewed in csv.DictReader(source):
            if reviewed["id"] not in raw:
                raise ValueError(f"unknown review id: {reviewed['id']}")
            if reviewed["ok"].strip().lower() in {"0", "no", "false", "нет"}:
                continue
            row = dict(raw[reviewed["id"]])
            if reviewed["fix_expected"].strip():
                row["expected"] = reviewed["fix_expected"].strip()
            if reviewed["fix_text"].strip():
                row["text"] = reviewed["fix_text"].strip()
            accepted.append(row)
    # A review may intentionally remove rows, so only validate row-level invariants here.
    ids = {item["id"] for item in catalog()}
    if any(row["expected"] not in ids for row in accepted):
        raise ValueError("review contains an unknown fixed expected scenario")
    if len({row["id"] for row in accepted}) != len(accepted):
        raise ValueError("review contains duplicate ids")
    TARGET.write_text(json.dumps(accepted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"imported {len(accepted)} accepted rows to {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
