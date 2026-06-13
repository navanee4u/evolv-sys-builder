# Anvil — Autonomous Hardware Architect

> Anvil turns robotic-system requirements into a verified hardware design spec by
> running a self-correcting loop: it selects parts, checks them against
> machine-readable constraints, and fixes its own failures until the spec passes.

**The product is the loop, not a dashboard.** The hero artifact is a
self-correction event you can watch live: a hard constraint goes **red**, the
agent investigates, swaps a component, and the constraint goes **green**.

```
Proposer proposes  →  Verifier checks  →  failures fed back  →  Proposer revises  →  repeat
   (LLM, never           (deterministic                                until coverage == 100%
    judges itself)        Python — the                                  or MAX_ITERS
                          source of truth)
```

## Architecture (deliberately minimal)

Two engines, cleanly separated:

| Engine | File | Role |
| --- | --- | --- |
| **Proposer** | `anvil/backend/proposer.py` (deterministic) · `proposer_llm.py` (LLM, model-selectable, web search) | Selects/revises the BOM. **Never** decides pass/fail. |
| **Verifier** | `anvil/backend/verifier.py` | Pure deterministic checks over `(BOM, Rubric)`. The single source of truth. |
| **Loop** | `anvil/backend/loop.py` | Orchestrates propose → verify → feed back → revise; emits SSE events. |
| **Memory** | `anvil/backend/memory.py` | Persistent `rules.md` + `failures.jsonl` — the outer loop. |
| **Schema** | `anvil/backend/schema.py` | The data contracts everything shares. |
| **KB** | `anvil/kb/*.json` | Seed component library (real parts, honest specs). |
| **UI** | `anvil/frontend/src/App.jsx` | The window into the loop: rubric checklist, BOM tree, activity stream, coverage. |

## Quickstart

```bash
make install          # venv + backend deps + frontend npm install
export ANTHROPIC_API_KEY=sk-...   # optional; without it the LLM proposer
                                  # falls back to the deterministic one
make verify           # run all tests + the golden run
make dev              # build the UI and serve everything at http://localhost:8090
```

On Windows PowerShell (no `make`):

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r anvil\backend\requirements.txt
cd anvil\frontend; npm install; npm run build; cd ..\..
.venv\Scripts\python.exe -m pytest anvil\tests -q
.venv\Scripts\python.exe -m anvil.tests.golden_run
.venv\Scripts\python.exe -m uvicorn anvil.backend.server:app --port 8090
```

Then open <http://localhost:8090>, pick a model, and hit **Run loop**.

## The self-verification (the build's own /goal)

`make verify` runs:

1. `tests/test_verifier.py` — a passing **and** failing case for every constraint
   (34 tests). The verifier must be trustworthy before the loop is worth running.
2. `tests/golden_run.py` — a fixed requirement set (an outdoor inspection drone
   payload) must converge to **coverage == 100%** within `MAX_ITERS`, and must
   exhibit the self-correction event (a constraint goes red then green).

The drone payload starts over-budget on power (an 18 W Jetson Orin NX → 21.4 W
draw against a 12 W budget), the loop investigates, swaps to a 7 W Orin Nano 8GB
that still clears the 21 TOPS workload, and re-verifies to 100% on iteration 2 —
then distills the rule *"Tight power budget: pick the lowest-power compute module
that still clears the TOPS workload."*

## Constraints the verifier enforces (hard = gates the loop)

power budget · peak power per rail · voltage rails · endurance · thermal · mass ·
size/packing · compute (TOPS/RAM) · sensing (resolution/fps/CSI lanes) ·
comms (band + antenna match + chains) · actuation (torque/driver current) ·
connectors (mating pairs) · environment (IP rating). Soft (scored for ranking):
cost · power margin · lead time.

## Model selection & Model Bench

The UI dropdown sets the model per run (`claude-fable-5`, `claude-opus-4-8`,
`claude-sonnet-4-6`, or the deterministic proposer). **Model Bench** runs the same
requirement across models and shows final coverage side by side — the loop closing
(or not) is the comparison.

## Conversational intake

Instead of guessing numbers, describe the system in plain English in the
**Describe it** tab. `POST /api/intake` runs an LLM interviewer that asks concise
clarifying questions, infers sensible engineering defaults, explains every value
it chose, and emits a structured Requirement that loads straight into the form.

## Data & learning (everything accumulates on disk)

Each run is one **hardware build**, persisted under `anvil/data/`:

```
data/
  builds/<build_id>/
    build.json        manifest: requirement, model, coverage, timing, final BOM
    events.jsonl      every loop event that streamed to the UI
    api_calls.jsonl   every Anthropic call — full request, response, usage, latency
  kb_learned.json     web-discovered components, deduped — the KB grows here
  builds_index.jsonl  one line per build, for the history panel
```

- **API-call logging** — every background LLM call is written in full (prompt,
  raw response, token usage, latency, errors) to that build's `api_calls.jsonl`.
- **Build history** — the left panel lists past builds; click one to reload its
  requirement. `GET /api/builds`, `GET /api/builds/{id}`, `GET /api/builds/{id}/api_calls`.
- **A growing library** — when the proposer introduces a real part via web search
  (`source:"web"`), it's harvested into `kb_learned.json` and merged into the live
  KB, so later runs can reuse it. The system gets more capable the more it's used.

## API

`POST /api/run` `{requirement, model}` → `text/event-stream` of loop events ·
`POST /api/bench` · `POST /api/intake` `{messages, model}` ·
`GET /api/builds` · `GET /api/builds/{id}` · `GET /api/builds/{id}/api_calls` ·
`GET /api/kb` · `GET /api/memory` · `GET /api/models`.
