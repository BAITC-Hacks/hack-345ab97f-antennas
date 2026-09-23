# Router evaluation

`python eval/split_dev.py` делает один детерминированный stratified split с seed `34597`.
Результат: `eval/datasets/tune.json` (70% внутри сценарных групп с округлением для малых групп)
и закрытый `eval/datasets/holdout.json`. Настройка и `eval/run_eval.py` используют **только tune**.

```bash
PYTHONPATH=backend python eval/run_eval.py
```

Команда требует заполненные `LLM_API_KEY` и `LLM_MODEL`. JSON-отчёт содержит accuracy,
p50/p95 полной задержки и top-5 пар expected→actual. Holdout намеренно не поддерживается CLI.

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

## Команды без Make

Подходят в том числе для Windows PowerShell после установки `PYTHONPATH=backend` в окружении:

```bash
PYTHONPATH=backend pytest backend/tests -q
PYTHONPATH=backend python eval/run_eval.py
PYTHONPATH=backend python eval/run_eval.py --limit 30
PYTHONPATH=backend python eval/check_leakage.py
python eval/check_duplicates.py
```

`check_leakage.py` ищет фразы из eval в собранном промпте роутера. `check_duplicates.py` ищет
почти-дубликаты (сходство > 0.9) между eval-наборами и примерами каталога, а также между
синтетикой и tune/holdout.
