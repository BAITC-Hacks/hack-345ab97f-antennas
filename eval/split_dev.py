"""Deterministic stratified dev split; holdout is written but never evaluated here."""
from __future__ import annotations
import json
import random
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parents[1]
SEED = 34597


def main() -> None:
    rows = json.loads((ROOT / "data/dev_utterances.json").read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for row in rows:
        groups[row.get("expected") or row.get("expected_decision", "unknown")].append(row)
    rng = random.Random(SEED)
    tune, holdout = [], []
    for key in sorted(groups):
        values = groups[key]
        rng.shuffle(values)
        cut = max(1, round(len(values) * .7)) if len(values) > 1 else 1
        tune.extend(values[:cut]); holdout.extend(values[cut:])
    out = ROOT / "eval/datasets"
    out.mkdir(parents=True, exist_ok=True)
    (out / "tune.json").write_text(json.dumps(tune, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "holdout.json").write_text(json.dumps(holdout, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"tune={len(tune)} holdout={len(holdout)} seed={SEED}")

if __name__ == "__main__":
    main()
