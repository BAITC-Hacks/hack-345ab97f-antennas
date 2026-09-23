.PHONY: test eval eval-quick eval-3 leakage

test:
	PYTHONPATH=backend python -m pytest backend/tests eval/tests -q

eval:
	python eval/run_eval.py

eval-quick:
	python eval/run_eval.py --limit 30

eval-3:
	python eval/run_eval.py --runs 3

leakage:
	PYTHONPATH=backend python eval/check_leakage.py
	python eval/check_duplicates.py
