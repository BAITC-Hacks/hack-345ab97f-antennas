#!/usr/bin/env python3
"""Reject exact and near-duplicate evaluation phrases."""
from __future__ import annotations

import csv
import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[1]
DATASETS = ROOT / "eval/datasets"


def normalize(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE).split())


def strings(value: object, *, all_strings: bool = False) -> Iterator[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"text", "utterance"} and isinstance(item, str):
                yield item
            elif key == "examples":
                yield from strings(item, all_strings=True)
            elif isinstance(item, (dict, list)):
                yield from strings(item, all_strings=all_strings)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item, all_strings=all_strings)
    elif all_strings and isinstance(value, str):
        yield value


def read_phrases(path: Path) -> list[str]:
    if path.suffix == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as source:
            return [row["text"] for row in csv.DictReader(source) if row.get("text")]
    return list(strings(json.loads(path.read_text(encoding="utf-8"))))


def near_duplicates(left: list[tuple[str, str]], right: list[tuple[str, str]]) -> list[str]:
    failures = []
    for left_source, left_text in left:
        normalized_left = normalize(left_text)
        if not normalized_left:
            continue
        for right_source, right_text in right:
            normalized_right = normalize(right_text)
            ratio = SequenceMatcher(None, normalized_left, normalized_right).ratio()
            if ratio > .9:
                failures.append(f"{left_source} ↔ {right_source} ({ratio:.3f}): {left_text!r} / {right_text!r}")
    return failures


def main() -> None:
    dataset_files = sorted((*DATASETS.glob("*.json"), *DATASETS.glob("*.csv")))
    evaluation = [(str(path.relative_to(ROOT)), phrase) for path in dataset_files for phrase in read_phrases(path)]
    scenario_payload = json.loads((ROOT / "data/scenarios.json").read_text(encoding="utf-8"))
    examples = [("data/scenarios.json", phrase) for scenario in scenario_payload["scenarios"] for phrase in strings(scenario.get("examples", {}), all_strings=True)]
    mock_files = sorted((ROOT / "data/mock").rglob("*.json")) if (ROOT / "data/mock").exists() else []
    examples += [(str(path.relative_to(ROOT)), phrase) for path in mock_files for phrase in read_phrases(path)]
    failures = near_duplicates(evaluation, examples)

    synthetic_files = [path for path in dataset_files if path.stem.startswith("synthetic") and path.suffix != ".csv"]
    reference_files = [DATASETS / name for name in ("tune.json", "holdout.json") if (DATASETS / name).exists()]
    synthetic = [(str(path.relative_to(ROOT)), phrase) for path in synthetic_files for phrase in read_phrases(path)]
    references = [(str(path.relative_to(ROOT)), phrase) for path in reference_files for phrase in read_phrases(path)]
    failures += near_duplicates(synthetic, references)
    if failures:
        raise SystemExit("Leakage detected:\n" + "\n".join(failures))
    print(f"leakage check passed: {len(evaluation)} dataset phrases, {len(examples)} forbidden examples")


if __name__ == "__main__":
    main()
