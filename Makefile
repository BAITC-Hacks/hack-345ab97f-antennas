.PHONY: run gateway web test test-node eval eval-quick eval-3 leakage

# Python LLM router (decisions). Start first; port 8000 belongs to the Node gateway.
run:
	python -m uvicorn app.main:app --app-dir backend --port 8001

# Node gateway (voice, UI, handoff queue) using the Python router: http://127.0.0.1:8000
gateway:
	cd voice-router-backend && ROUTER_MODE=python PYTHON_ROUTER_URL=http://127.0.0.1:8001 node src/server.mjs

# React frontend against the Python server directly (frontend/.env: VITE_API_URL=http://localhost:8001)
web:
	cd frontend && npm run dev

test:
	PYTHONPATH=backend python -m pytest backend/tests eval/tests -q

test-node:
	node --test

eval:
	python eval/run_eval.py

eval-quick:
	python eval/run_eval.py --limit 30

eval-3:
	python eval/run_eval.py --runs 3

leakage:
	PYTHONPATH=backend python eval/check_leakage.py
	python eval/check_duplicates.py
