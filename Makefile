# Anvil — Autonomous Hardware Architect
# Simplicity is the result of profound thought: thin targets over the real IP.

PY ?= .venv/Scripts/python.exe   # on macOS/Linux: make PY=.venv/bin/python <target>
PORT ?= 8090

.PHONY: install dev backend frontend test verify build clean

install:        ## set up backend venv + frontend deps
	python -m venv .venv
	$(PY) -m pip install -r anvil/backend/requirements.txt
	cd anvil/frontend && npm install

backend:        ## run the FastAPI + SSE server
	$(PY) -m uvicorn anvil.backend.server:app --host 127.0.0.1 --port $(PORT) --reload

frontend:       ## run the Vite dev server (proxies /api -> backend)
	cd anvil/frontend && npm run dev

build:          ## build the frontend (server then serves it at /)
	cd anvil/frontend && npm run build

dev: build backend  ## build the UI then run the single server

test:           ## unit tests for every verifier constraint
	$(PY) -m pytest anvil/tests/test_verifier.py -q

verify: test    ## tests + the golden run (the build's own /goal)
	$(PY) -m pytest anvil/tests -q
	$(PY) -m anvil.tests.golden_run

clean:
	rm -rf anvil/frontend/dist anvil/frontend/node_modules .venv
