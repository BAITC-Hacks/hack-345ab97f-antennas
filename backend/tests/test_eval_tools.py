from eval.check_leakage import normalize
from eval.run_eval import accuracy_by


def test_accuracy_breakdown_counts_each_group():
    rows = [
        {"lang": "ru", "correct": True},
        {"lang": "ru", "correct": False},
        {"lang": "kk", "correct": True},
    ]

    assert accuracy_by(rows, "lang") == {
        "kk": {"correct": 1, "total": 1, "accuracy": 1.0},
        "ru": {"correct": 1, "total": 2, "accuracy": 0.5},
    }


def test_leakage_normalization_removes_case_punctuation_and_extra_spaces():
    assert normalize("  Полис, ЕЩЁ действует?! ") == "полис ещё действует"
