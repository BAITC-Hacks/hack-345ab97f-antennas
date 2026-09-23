"""
run_eval.py — замер качества роутера на тестовом наборе.

  python run_eval.py                  # весь набор
  python run_eval.py --type mixed     # только один тип фраз
  python run_eval.py --limit 5        # первые 5 фраз (быстрая проверка)

После каждого запуска отчёт сохраняется в reports/ — так видно прогресс
от итерации к итерации (и это готовые цифры для README).
"""
import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from router import LLMRouter

HERE = Path(__file__).parent


def percentile(values: list[float], q: float) -> float:
    """p50 = медиана (q=0.5), p95 = 95% значений меньше этого числа (q=0.95)."""
    if not values:
        return 0.0
    s = sorted(values)
    return s[round((len(s) - 1) * q)]


def is_correct(test: dict, d) -> bool:
    """Правильно ли выбран сценарий. Для clarify/handoff проверяем само решение."""
    expected_decision = test.get("expected_decision", "route")
    if expected_decision in ("clarify", "handoff"):
        return d.decision == expected_decision
    return d.scenario_id == test["expected"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tests", default=str(HERE / "tests.json"))
    parser.add_argument("--type", help="simple / boundary / mixed / multi / topic_switch / clarify / handoff")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    tests = json.loads(Path(args.tests).read_text(encoding="utf-8"))
    if args.type:
        tests = [t for t in tests if t["type"] == args.type]
    if args.limit:
        tests = tests[: args.limit]

    router = LLMRouter()
    results = []
    by_type, by_lang = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])  # [верно, всего]
    confusions = Counter()
    latencies = []
    multi_found = multi_total = 0

    print(f"Модель: {router.model} | фраз: {len(tests)}\n")
    for t in tests:
        try:
            d, ms = router.route(t["text"], t.get("context"))
        except Exception as e:  # сломанный ответ модели = ошибка роутера, считаем как промах
            print(f"✗ {t['id']:4} {t['type']:12} ОШИБКА: {e}")
            results.append({"id": t["id"], "error": str(e), "correct": False})
            by_type[t["type"]][1] += 1
            by_lang[t["lang"]][1] += 1
            continue

        ok = is_correct(t, d)
        latencies.append(ms)
        by_type[t["type"]][0] += ok
        by_type[t["type"]][1] += 1
        by_lang[t["lang"]][0] += ok
        by_lang[t["lang"]][1] += 1
        if not ok:
            expected = t["expected"] or t.get("expected_decision")
            got = d.scenario_id if t["expected"] else d.decision
            confusions[(expected, got)] += 1

        if t.get("expected_additional"):
            multi_total += 1
            found = {i.scenario_id for i in d.additional_intents}
            multi_found += set(t["expected_additional"]) <= found

        mark = "✓" if ok else "✗"
        print(f"{mark} {t['id']:4} {t['type']:12} {t['lang']:5} "
              f"ждали {str(t['expected'] or t.get('expected_decision')):24} "
              f"получили {str(d.scenario_id):24} [{d.decision}, {d.confidence:.2f}] {ms:5.0f} мс")
        if not ok:
            print(f"        причина модели: {d.reason}")
        results.append({"id": t["id"], "correct": ok, "latency_ms": round(ms), **d.model_dump()})

    correct = sum(r["correct"] for r in results)
    print(f"\n=== Итог ===")
    print(f"Точность (top-1): {correct}/{len(results)} = {100 * correct / max(len(results), 1):.1f}%")
    print("По типам:  " + ", ".join(f"{k} {v[0]}/{v[1]}" for k, v in by_type.items()))
    print("По языкам: " + ", ".join(f"{k} {v[0]}/{v[1]}" for k, v in by_lang.items()))
    if multi_total:
        print(f"Мульти-интент: второе намерение найдено {multi_found}/{multi_total}")
    print(f"Задержка роутера: p50 = {percentile(latencies, 0.5):.0f} мс, p95 = {percentile(latencies, 0.95):.0f} мс")
    if confusions:
        print("Путаницы (ждали -> получили):")
        for (exp, got), n in confusions.most_common(5):
            print(f"  {exp} -> {got}: {n}")

    report = {
        "date": datetime.now().isoformat(timespec="seconds"),
        "model": router.model,
        "accuracy": correct / max(len(results), 1),
        "latency_p50_ms": percentile(latencies, 0.5),
        "latency_p95_ms": percentile(latencies, 0.95),
        "results": results,
    }
    out = HERE / "reports" / f"{datetime.now():%Y-%m-%d_%H%M}_{router.model.replace('/', '-') or 'model'}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nОтчёт сохранён: {out.relative_to(HERE)}")


if __name__ == "__main__":
    main()
