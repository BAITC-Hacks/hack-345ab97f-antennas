# Router evaluation

Разделение зафиксировано: 16 фраз tune, 8 holdout. Его сделал `split_dev.py` (seed `34597`,
по сценарным группам с округлением, это 66,7%/33,3%; баланс по типам и языкам неполный).
Не запускайте split повторно во время цикла анализа: перемешивание уже просмотренных примеров
испортит сравнение. Настройка и `eval/run_eval.py` используют **только tune**; CLI не позволяет
выбрать holdout.

Все 8 ID holdout встречаются в историческом полном отчёте прототипа
`router_prototype/reports/2026-09-23_1403_gpt-4.1-mini.json`, поэтому этот holdout нельзя считать
ранее не проверявшимся набором. После стартового кита делаем новый split и новый holdout.

## Запуск

Нужны `LLM_API_KEY` и `LLM_MODEL` в корневом `.env`. Работает с `backend/app/router/`.

```bash
make eval          # один прогон tune
make eval-3        # три прогона подряд + сводка с разбросом
make eval-quick    # первые 30 фраз перед мержем
make test          # тесты без вызова модели
make leakage       # проверки утечек
```

Без Make (в том числе Windows PowerShell):

```bash
python eval/run_eval.py [--runs 3] [--limit 30]
PYTHONPATH=backend python -m pytest backend/tests eval/tests -q
PYTHONPATH=backend python eval/check_leakage.py
python eval/check_duplicates.py
```

## Метрики (`metric_version: 2`)

Отдельный JSON на каждый прогон и сводные JSON/Markdown сохраняются в `eval/reports/`:

- `accuracy` / `scenario_accuracy` / `metrics.top1`: только совпадение `scenario_id` с `expected`,
  в том числе `null`. Действие не подменяет эту метрику.
- `decision_accuracy`: совпадение итогового действия с `expected_decision` (по умолчанию `route`)
  **и** `topic_switch` с `expected_topic_switch`, если поле явно задано.
- `action`: только действие; `topic_switch`: только строки с явной разметкой. Отсутствие разметки
  обозначается `null`, а не 100%.
- `joint_accuracy`: одновременно верны top-1 и decision.
- `additional_intents`: все ожидаемые дополнительные намерения найдены.
- `language_accuracy`: `decision.language` совпал с меткой `lang`. Роутер метку **не получает**:
  в реальном звонке язык не подсказывает никто, а STT никогда не выдаёт `mixed`.

API-ошибки и невалидные ответы остаются в знаменателях как промахи. Каждая строка отчёта хранит
вход, ожидания, результат, reason и отдельные признаки правильности. Есть разбивка по типам и
языкам, среднее, минимум/максимум, размах и стандартное отклонение в процентных пунктах.
Сохраняются настройки и SHA-256 кода, каталога и tune; при их изменении серия прерывается.
Незаконченные отчёты помечены `complete: false`.

Отчёты `tune-2026-09-23_1507…1629-gpt-4.1-mini.json` сделаны старой версией `run_eval.py`:
там `accuracy` — сценарий **и** действие одновременно. С `metric_version: 2` их напрямую
не сравнивать.

## Цикл анализа

Сначала базовые прогоны и таблица ошибок (`eval/reports/error-analysis-*.md`), потом правки.
Допускаются только смысловые правки описаний, границ и промпта; тестовые фразы и проверки
ключевых слов запрещены. После каждой правки — прогон tune. Смотрим отдельные фразы, а не только
общий процент: новая ошибка на ранее проходившей фразе означает откат этой правки.

## Synthetic dataset

Генератор читает модель и ключ только из `.env`: `GEN_MODEL` и `GEN_API_KEY` (также
принимаются `LLM_API_KEY`/`OPENAI_API_KEY`). Для OpenAI-compatible endpoint можно задать
`GEN_BASE_URL`. Smoke-прогон не перезаписывает полный набор:

```bash
python eval/generate_synthetic.py --limit 3 --output /tmp/synthetic-3.json
python eval/generate_synthetic.py
python eval/export_review.py
# заполнить ok/fix_* в eval/datasets/synthetic_review.csv
python eval/import_review.py
make leakage
```

`synthetic_raw.json` — результат генерации, `synthetic_review.csv` — таблица ручной
проверки, `synthetic.json` — принятые и исправленные строки. Значение `ok=0` удаляет
строку; `fix_expected` и `fix_text` заменяют соответствующие поля.

## Проверки утечек

`check_leakage.py` ищет фразы из eval в собранном промпте роутера (совпадение — ошибка,
сходство ≥ 0.6 с примером каталога — предупреждение). `check_duplicates.py` ищет почти-дубликаты
(сходство > 0.9) между eval-наборами и примерами каталога, а также между синтетикой и tune/holdout.
