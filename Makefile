.PHONY: run test eval eval-quick leakage

run:
	PYTHONPATH=backend uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

test:
	PYTHONPATH=backend pytest backend/tests -q

eval:
	PYTHONPATH=backend python eval/run_eval.py

eval-quick:
	PYTHONPATH=backend python eval/run_eval.py --limit 30

leakage:
	PYTHONPATH=backend python eval/check_leakage.py
	python eval/check_duplicates.py
