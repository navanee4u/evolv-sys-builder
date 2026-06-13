# Anvil — Build Session Log

> **Note:** This is a curated, chronological reconstruction of the Claude Code
> session that built Anvil, written from the assistant's conversation context —
> not the verbatim `/export` transcript. For the byte-for-byte log, run
> `/export` in your own Claude Code window.

Repo: <https://github.com/navanee4u/evolv-sys-builder> · PR: [#1](https://github.com/navanee4u/evolv-sys-builder/pull/1)

---

## 1. Build the app from the brief
**Ask:** "Read claude.md and start."

Built **Anvil** — an autonomous hardware architect with a self-correcting loop —
following the `CLAUDE.md` build sequence:

- **Schema** (`schema.py`) — Requirement, Constraint, Component, BOM, Check, SpecResult.
- **Knowledge base** (`kb/*.json`) — real seed components per subsystem, with both
  an over-powered default and a lower-power alternative so the loop has something
  real to swap between.
- **Verifier** (`verifier.py`) — pure deterministic constraint engine, the single
  source of truth (power budget, peak power per rail, voltage rails, endurance,
  thermal, mass, packing, compute, sensing, comms, actuation, connectors,
  environment + soft scoring).
- **Tests** — `test_verifier.py` (a pass + fail case per constraint, 34 tests) and
  `golden_run.py` (a fixed drone payload must converge to 100%).
- **Loop** (`loop.py`) — propose → verify → feed failures back → revise; emits SSE events.
- **Memory** (`memory.py`) — distilled rules + failure log (the outer loop).
- **Proposers** — deterministic stub (`proposer.py`) + model-selectable LLM
  (`proposer_llm.py`) with web search and graceful fallback.
- **Server** (`server.py`) — FastAPI + SSE; serves the built SPA.
- **Frontend** (`frontend/`) — Vite + React + Tailwind SPA: rubric checklist,
  BOM tree, activity stream, coverage ring, Model Bench.

**Result:** golden run converges to 100% in 2 iterations (Orin NX 18 W → Orin Nano
8 GB 7 W on a 12 W budget). **37/37 tests pass.**

## 2. Run the app
**Ask:** "How do I stop and start the server inside Claude Code and outside?"

Documented preview-tool vs. background-process control, and PowerShell start/stop.
Server runs on **port 8090** (8000 was occupied by another app on the machine).

## 3. Wire up the API key
**Ask:** "I have my Anthropic API Key… how do I use it?" → set `ANTHROPIC_API_KEY`.

- `setx` only affects *new* processes; pulled the key from the registry to launch.
- Discovered **Fable 5 returns 404** on this key ("use Opus 4.8"); **Opus 4.8 and
  Sonnet 4.6 work**, as does the web-search tool.
- Made the default model Opus 4.8, surfaced fallback reasons honestly, hardened
  JSON extraction.
- **Opus converges to 100% in 3 iterations** — and a genuine self-correction: it
  tried an under-spec camera, the verifier rejected it, and it corrected to a real
  true-4K module.

## 4. About page + self-improvement callout
**Asks:** "Write a good-looking About section" → then "highlight the self-improving
nature."

Added an on-brand **About the App** overlay (loop diagram, two-engine explanation,
constraint chips) and a callout — *"It improves in two directions at once"* — telling
the true story that the loop **caught a bug in its own rubric**: 4K UHD is 8.29 MP,
not the 8.3 that had been specified, so honest 4K sensors were failing by 0.01 MP.

## 5. Four major improvements
**Ask:** persistence + logging + growing data + conversational input.

1. **API-call logging** — every Anthropic call written in full (prompt, response,
   usage, latency) to `data/builds/<id>/api_calls.jsonl`.
2. **Every run = a build** — `store.py` persists each run with manifest + event log
   + API log; a **Build history** panel lists them.
3. **Growing learned KB** — web-discovered parts harvested into `kb_learned.json`
   and merged into the live KB.
4. **Conversational intake** — a **Describe it** chat (`/api/intake`) that interviews
   the user, infers sensible defaults, and emits a structured requirement.

## 6. Rapidflare re-theme
**Ask:** "Change the look and feel to align with rapidflare.ai."

Pulled the real design tokens from rapidflare.ai's CSS and applied them: **light
theme**, **sky-blue** primary `#0284c7` + **violet** secondary `#6048f0`, neutral
zinc scale, **Geist / Geist Mono**, and the `[ BRACKETED EYEBROW ]` motif. Wordmark
shows **ANVIL** with a violet **by rapidflare** chip.

## 7. Ship to GitHub
**Asks:** check in → include build records/API logs/learned KB → include rules/failures.

- Initialized the repo, scanned for secrets (none — the API key never touches disk),
  excluded local settings, and pushed the code.
- Then **intentionally versioned** the runtime history: `data/` (build records, API
  logs, learned KB) and `memory/` (distilled rules, failure log) — the app's
  self-improving trail, fitting the `evolv-sys-builder` name.

## 8. Cloud deploy
**Ask:** "Run this in the cloud — very very simple."

Added **`render.yaml`** (one-click Render Blueprint) and committed the built frontend,
so the cloud deploy is pure Python: `pip install` + `uvicorn`. Documented the 4-click
Render flow and the free-tier caveats (idle sleep, ephemeral disk).

## 9. Fixes & housekeeping
- Fixed `start-anvil.ps1` — rewrote in pure ASCII after PowerShell 5.1 mis-parsed
  non-ASCII dashes/arrows in a BOM-less UTF-8 file.
- Opened **PR #1** (`main` → a `baseline` branch at the repo's initial commit) so the
  entire session's work is reviewable in one diff, since everything had already been
  pushed to `main`.

---

## How to run

```powershell
# local
.\start-anvil.ps1                      # -> http://localhost:8090

# tests
.\.venv\Scripts\python.exe -m pytest anvil\tests -q
.\.venv\Scripts\python.exe -m anvil.tests.golden_run
```

Cloud: Render → New + → Blueprint → this repo → set `ANTHROPIC_API_KEY` → Deploy.

## Guiding principle
The product is the **loop**, not a dashboard. The **verifier — never the LLM —
decides pass/fail.** Simplicity is the result of profound thought.
