# CLAUDE.md — ANVIL: Autonomous Hardware Architect

> Build brief + persistent project guidance for Claude Code.
> Codename **Anvil** (rename freely). One line: *Anvil turns robotic-system requirements into a verified hardware design spec by running a self-correcting loop — it selects parts, checks them against machine-readable constraints, and fixes its own failures until the spec passes.*

**Read this whole file before writing code. It is the goal and the rubric.**

---

## 0. What this is and is NOT

- This is **an autonomous agent with a verification loop**. The web UI is the *window into that loop*, not the product.
- It is **NOT a dashboard**. Build-day rules disqualify "any project where a dashboard is the main feature." The hero artifact is a self-correction event: a constraint fails → the agent investigates → swaps a component → the constraint passes. Make that visible and central.
- Design principle (non-negotiable): **simplicity is the result of profound thought.** Minimal files, thin glue, one place where the real IP lives (the loop + verifier). No frameworks we don't need.

---

## 1. The brief (problem / user / done)

**Problem.** Specifying hardware for a robot or embedded system means reconciling dozens of interacting constraints — power budget, voltage rails, thermal range, mass, size, compute throughput, sensing, comms, actuation, connectors, endurance. Doing it by hand is slow and error-prone, and errors surface late.

**User.** A hardware engineer or systems architect who has *requirements* but not yet a *bill of materials*.

**Done looks like.** The user enters requirements. Those requirements become a **machine-checkable rubric**. The agent produces a complete hardware spec (BOM by subsystem), runs the rubric against it, and *iterates on its own* until every hard constraint passes — narrating its selection and verification in a live web interface. The user can re-run with a different requirement set, or the same requirements under a different model, and watch the loop close.

---

## 2. The core architecture (deliberately minimal)

Two engines, cleanly separated:

- **Proposer (LLM).** Selects and revises components. Uses the selected Claude model + web search. Outputs a structured BOM. *Never* judges its own pass/fail.
- **Verifier (deterministic Python, no LLM).** Takes `(BOM, Rubric)` → returns per-constraint `{status, reason, observed, required}`. Fast, repeatable, the source of truth.

The loop is: **Proposer proposes → Verifier checks → failures fed back → Proposer revises → repeat** until all hard constraints pass or max iterations. This is the Stage-1 (hard-constraint compliance, auto-verifiable) / Stage-2 (ranking quality) split applied to hardware. Stage 1 *gates* the loop; Stage 2 *scores* candidates for ranking.

```
anvil/
  backend/
    server.py            # FastAPI: requirement intake, SSE stream of loop events, /run
    loop.py              # the self-correction loop (orchestrator)
    proposer.py          # LLM calls (model-selectable), web_search tool wired in
    verifier.py          # deterministic constraint engine — THE source of truth
    schema.py            # Requirement, Rubric, Constraint, Component, BOM, SpecResult
    memory.py            # read/write distilled rules + failure log
  kb/
    compute.json         # seed component library, per subsystem (real fields)
    power.json
    sensing.json
    comms_antennas.json
    actuation.json
    mechanical.json
    connectors.json
  memory/                # persistent, file-based (the OUTER loop)
    rules.md             # distilled general rules ("for IP67, prefer ... ")
    failures.jsonl       # every failure the loop hit + how it was resolved
  frontend/              # single-page app (Vite + React + Tailwind)
    src/App.jsx          # rubric checklist, BOM tree, activity stream, model selector
  tests/
    test_verifier.py     # unit tests for every constraint
    golden_run.py        # /goal: a sample requirement set must converge all-green ≤ N iters
  Makefile               # make dev / make verify / make test
  README.md
```

Keep each file small. If `loop.py` or `verifier.py` grows past a few hundred lines, you are probably leaking responsibility across the boundary — stop and refactor.

---

## 3. Data contracts (define these first, in schema.py)

**Requirement → Rubric.** The user's free-form requirements are parsed (by the Proposer, once, up front) into a list of **Constraints**. Each constraint is the rubric. Capture at least these requirement dimensions: power, endurance/runtime, functionality (workload), response time / latency, environment (temp, IP, vibration), actuation, mass, size/enclosure, thermal, sensing, comms.

```python
Constraint = {
  "id": "power_budget",
  "dimension": "power",          # power|mass|size|thermal|compute|sensing|comms|actuation|connector|endurance|environment
  "kind": "hard" | "soft",       # hard gates the loop; soft is scored for ranking
  "predicate": "sum_active_power_W <= 12.0",
  "required": {"max_W": 12.0},
  "weight": 1.0                  # soft only
}

Component = {
  "id": "...", "subsystem": "compute|power|sensing|comms|actuation|mechanical|connector",
  "name": "...", "vendor": "...", "part_number": "...",
  # fields the verifier needs — populate honestly:
  "active_power_W": 7.5, "peak_power_W": 11.0,
  "input_voltage_V": [5.0], "rails_provided": null,    # PMIC/regulators set rails_provided
  "rail_current_A": null,
  "mass_g": 18.0, "dims_mm": [40, 40, 5],
  "temp_op_C": [-40, 85],
  "interfaces": ["MIPI-CSI x2", "USB3", "PCIe x1"],
  "compute_TOPS": 21, "ram_GB": 8,
  "radio_bands": ["2.4GHz", "5GHz", "UWB"], "radio_chains": 2,
  "antenna_bands": null, "antenna_count": null,
  "torque_Nm": null, "driver_current_A": null,
  "connector_mates": ["JST-GH-4"],   # mate keys
  "ip_rating": "IP67",
  "source": "kb" | "web"            # provenance — show this in UI
}

BOM = { "subsystems": { "compute": [Component, ...], "power": [...], ... } }

SpecResult = {
  "bom": BOM,
  "checks": [ {constraint_id, status: pass|fail, observed, required, reason} ],
  "coverage": 0.0..1.0,     # fraction of hard constraints passing — the headline metric
  "iteration": int
}
```

---

## 4. The verifier (verifier.py) — the source of truth

Pure deterministic functions over `(BOM, Rubric)`. No LLM. Each returns `{status, observed, required, reason}`. Implement at minimum these **hard** constraints (they gate the loop). These are real hardware checks — get the engineering right:

- **Power budget**: `sum(active_power_W) ≤ power_budget_W`.
- **Peak power**: `sum(peak_power_W on a rail) ≤ regulator rail_current_A * rail_V`.
- **Voltage rails**: every component's `input_voltage_V` is provided by some `rails_provided` from the PMIC/regulator set; regulator current rating ≥ sum of loads on that rail.
- **Endurance**: `battery_Wh / avg_system_power_W ≥ required_runtime_h`.
- **Thermal**: every component `temp_op_C` range fully covers `environment.temp_C` range.
- **Mass**: `sum(mass_g) ≤ mass_budget_g`.
- **Size**: each component bounding box fits enclosure; `sum(board footprint) ≤ enclosure internal footprint` (simplified packing).
- **Compute**: `accelerator/SoM TOPS ≥ workload_TOPS`; `ram_GB ≥ model_footprint_GB`.
- **Sensing**: camera/sensor meets resolution/FPS/FoV; required interface lanes ≤ SoM available lanes (e.g. MIPI-CSI count).
- **Comms**: every required protocol present in some radio; **antenna band matches its radio band**; `antenna_count ≥ radio_chains`.
- **Actuation**: `motor torque_Nm ≥ required`; `driver_current_A ≥ motor continuous (and ideally stall) current`; supply can source actuator power.
- **Connectors/cables**: every inter-component link has a defined, **mating** connector pair (mate keys match); flag missing links.
- **Environment**: `ip_rating ≥ required`; vibration/shock/humidity flagged.

**Soft** constraints (scored, drive Stage-2 ranking, not the gate): cost, margin headroom (e.g. power/thermal slack %), part availability/lead time, vendor consolidation, derating quality.

Write `tests/test_verifier.py` with a passing and failing case for **every** constraint. The verifier must be trustworthy before the loop is worth running.

---

## 5. The self-correction loop (loop.py) — the goal

```
goal: produce a SpecResult where every HARD constraint passes (coverage == 1.0),
      ranked by SOFT score, within MAX_ITERS.

1. parse requirements -> Rubric (Proposer, once)
2. consult memory/rules.md and memory/failures.jsonl  -> inject relevant rules into Proposer context
3. iteration loop (until coverage==1.0 or MAX_ITERS):
     a. Proposer proposes/revises BOM (KB first; web_search for parts not in KB)
     b. Verifier checks BOM vs Rubric  -> SpecResult
     c. emit SpecResult to UI (SSE)    -> live checklist + BOM update
     d. if all hard pass: rank by soft score, break
     e. else: feed the specific failing checks back to Proposer with reasons
              (Proposer must INVESTIGATE the named failure, not reshuffle blindly)
4. distill: write any new general rule learned this run to memory/rules.md;
            append the failure->fix to memory/failures.jsonl
5. return final SpecResult + the per-iteration history (for the demo timeline)
```

Emit a structured **loop event** for every meaningful step (parse, consult, propose, check, fail, investigate, swap, distill) over SSE. These events ARE the demo.

---

## 6. Memory (the outer loop) — fail → investigate → verify → distill → consult

File-based and persistent across runs. This is what makes Anvil improve and what judges want to see.

- **fail**: a hard constraint fails → append to `memory/failures.jsonl` with `{rubric_dim, failing_part, reason, fix_applied}`.
- **investigate**: before re-selecting, the Proposer must state *why* it failed (which budget, by how much).
- **verify**: a fix is only "done" when the Verifier confirms it (don't trust the LLM's claim).
- **distill**: turn a confirmed fix into a general rule in `memory/rules.md` (e.g. "Outdoor/IP67 + (-20..60°C) → restrict to industrial-temp parts up front").
- **consult**: at the start of every run, load `rules.md` into the Proposer's context so it stops re-deriving solved problems.

Show the rules list growing in the UI across runs.

---

## 7. Model selection (web-selectable at runtime)

A dropdown in the UI sets the model for the run. Pass the choice to the backend; `proposer.py` uses it directly. Valid strings:

- `claude-fable-5` — Fable 5 (default; completes the verify/distill progression most reliably)
- `claude-opus-4-8` — Opus 4.8
- `claude-sonnet-4-6` — Sonnet 4.6

`proposer.py` sketch (real backend, Anthropic SDK — keep it thin):

```python
from anthropic import Anthropic
client = Anthropic()

def propose(model, system, messages):
    return client.messages.create(
        model=model,                       # the selected string above
        max_tokens=4096,
        system=system,
        messages=messages,
        tools=[{"type": "web_search_20250305", "name": "web_search"}],
    )
```

**High-impact demo feature — "Model Bench" mode (build this if time allows):** run the *same* requirement set across all three models and show their final `coverage` side by side. Expect Fable 5 to close the loop and distill rules where lighter models exit early with constraints still failing. This directly echoes the build-day material on self-correction and verification coverage — it shows you understood *why* the loop matters, not just that it runs.

---

## 8. Web interface (frontend/) — the window into the loop

Single-page, clean, fast. Four regions, all driven by the SSE loop events:

1. **Requirement intake** → on submit, show the parsed **Rubric as a live checklist** (each constraint a row, grey → red → green).
2. **BOM tree** by subsystem; each component shows key fields and a `kb`/`web` provenance badge; parts that change during a fix should visibly swap.
3. **Activity stream** — the agent's narration: "Power budget exceeded by 3.2 W → investigating compute subsystem → swapping SoM X (7.5 W) for Y (4.1 W) → re-verifying." This is the self-correction story.
4. **Header**: model selector, iteration counter, and the **coverage %** as the hero metric; a small panel for distilled memory rules.

Aesthetic: instrument-panel / engineering feel, monospace for part numbers and numbers, generous contrast, smooth state transitions on red→green. Use the `frontend-design` skill for styling direction. Keep it one screen; no routing.

---

## 9. Build sequence for Claude Code (working slice first)

Do these in order. After each phase, run `make verify` and only proceed when green.

1. **Schema + KB.** `schema.py` and a small but *real* seed KB (5–10 honest parts per subsystem with correct fields). Real parts beat fake completeness.
2. **Verifier + tests.** Implement all hard constraints; write `tests/test_verifier.py`; `make test` passes. *Trust nothing downstream until this is solid.*
3. **Loop, KB-only.** Wire `loop.py` with a deterministic stub proposer (KB only, no LLM) so you can prove the loop converges. Write `tests/golden_run.py`: a fixed requirement set must reach `coverage==1.0` within `MAX_ITERS`. This is your `/goal` for the build itself — wire it into `make verify`.
4. **Real proposer.** Swap in the LLM proposer with model selection + web search.
5. **Server + SSE.** Emit loop events.
6. **Frontend.** Render the four regions from the event stream.
7. **Memory.** Persist failures + distilled rules; consult on run start.
8. **Model Bench** (if time).

### Self-verification for YOUR build (wire CI in)
`make verify` must run `make test` + `golden_run.py`. Treat a failing `golden_run` as a real failure: investigate the specific constraint, fix, re-run — the same loop you're building. Save working orchestration as `make` targets so they're rerunnable and visible to judges.

---

## 10. Demo script (mapped to judging)

Judges want: how you directed Claude, and how it verified its own work — including a failure it caught and fixed. Hit these in ~3 minutes:

1. Show this `CLAUDE.md` for two seconds — "here's the brief and the rubric."
2. Enter a real robot requirement set (e.g. outdoor inspection drone: ≤12 W, ≥45 min runtime, -20..60 °C, IP67, 21 TOPS, 4K30 camera, UWB + 5 GHz, ≤450 g). Watch the rubric populate.
3. Hit run. Let a hard constraint go **red** (power budget). Narrate the agent investigating, swapping the SoM, and the row going **green**. *This is the moment that wins.*
4. Show coverage hit 100% and a new rule appear in memory.
5. Switch the model to Sonnet 4.6, re-run the same input, and show it exits with constraints still failing — then Fable closing it. (Model Bench, if built.)
6. Note the repo is public and the loop is the product.

---

## 11. Tech stack + commands

- Backend: Python 3.11+, FastAPI, `anthropic` SDK, SSE.
- Frontend: Vite + React + Tailwind, single page.
- KB/memory: JSON / JSONL / Markdown files. No database.
- `make dev` (run backend + frontend), `make test` (unit), `make verify` (test + golden_run).

## 12. Guardrails — what NOT to do

- Don't let the LLM decide pass/fail. The **Verifier** decides. Always.
- Don't add auth, multi-tenant, accounts, or a database. Out of scope.
- Don't invent component specs. Use real parts (KB or web_search); mark provenance.
- Don't bloat files or add frameworks. Simplicity is the result of profound thought.
- Don't frame or demo this as a dashboard. The autonomous, self-correcting loop is the product.
