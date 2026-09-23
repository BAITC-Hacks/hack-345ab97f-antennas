.PHONY: test eval eval-quick leakage

test:
	PYTHONPATH=backend pytest backend/tests -q

eval:
	PYTHONPATH=backend python eval/run_eval.py

eval-quick:
	PYTHONPATH=backend python eval/run_eval.py --limit 30

leakage:
	PYTHONPATH=backend python eval/check_leakage.py
	python eval/check_duplicates.py
