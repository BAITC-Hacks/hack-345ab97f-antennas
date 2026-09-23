from eval.check_leakage import normalize


def test_leakage_normalization_removes_case_punctuation_and_extra_spaces():
    assert normalize("  Полис, ЕЩЁ действует?! ") == "полис ещё действует"
