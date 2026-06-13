"""FastAPI server: requirement intake + Server-Sent-Events stream of the loop.

The loop is a synchronous generator of event dicts; we serialize each as one SSE
`data:` frame. The frontend reads this stream and renders the rubric going
red -> green in real time. The loop's events ARE the product.

Endpoints
  GET  /api/health
  GET  /api/kb           catalogue grouped by subsystem
  GET  /api/memory       distilled rules + failure log
  GET  /api/models       selectable models (+ whether the LLM is wired)
  POST /api/run          {requirement, model} -> text/event-stream of loop events
  POST /api/bench        {requirement} -> run all models, stream tagged events
"""

from __future__ import annotations

import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from . import memory, store
from .loop import run, MAX_ITERS
from .proposer import load_kb, StubProposer
from .proposer_llm import make_proposer, VALID_MODELS, LLMProposer, converse_intake
from .schema import Requirement, bom_to_dict

app = FastAPI(title="Anvil — Autonomous Hardware Architect")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# Live KB = seed library + everything learned from past runs (grows over time).
_KB = load_kb()
_LEARNED_AT_BOOT = store.merge_learned_into(_KB)


class RunBody(BaseModel):
    requirement: dict
    model: str = "claude-opus-4-8"


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


@app.get("/api/health")
def health():
    return {"ok": True, "max_iters": MAX_ITERS}


@app.get("/api/models")
def models():
    llm_ready = bool(os.environ.get("ANTHROPIC_API_KEY"))
    return {
        "models": [
            {"id": "claude-opus-4-8", "label": "Opus 4.8", "kind": "llm"},
            {"id": "claude-sonnet-4-6", "label": "Sonnet 4.6", "kind": "llm"},
            {"id": "claude-fable-5", "label": "Fable 5 (needs access)", "kind": "llm"},
            {"id": "stub", "label": "Deterministic (no LLM)", "kind": "stub"},
        ],
        "default": "claude-opus-4-8",
        "llm_ready": llm_ready,
    }


@app.get("/api/kb")
def kb():
    return {sub: [p.to_dict() for p in parts] for sub, parts in _KB.items()}


@app.get("/api/memory")
def get_memory():
    return {"rules": memory.rule_lines(), "failures": memory.load_failures()}


@app.post("/api/run")
def run_loop(body: RunBody):
    req = Requirement.from_dict(body.requirement)
    model = body.model if (body.model in VALID_MODELS or body.model == "stub") else "stub"
    build_id = store.new_build_id()
    recorder = store.BuildRecorder(build_id, req.to_dict(), model)
    proposer = make_proposer(model, _KB, recorder=recorder)
    fallback = isinstance(proposer, LLMProposer) and not proposer.available

    def gen():
        # every run is its own hardware build, persisted to disk
        start = {"type": "build_started", "build_id": build_id, "model": model,
                 "message": f"Build {build_id} started."}
        recorder.log_event(start)
        yield _sse(start)
        if fallback:
            note = {"type": "note",
                    "message": f"{model}: no ANTHROPIC_API_KEY — running the deterministic proposer instead."}
            recorder.log_event(note)
            yield _sse(note)

        done_ev = None
        for ev in run(req, proposer, max_iters=MAX_ITERS, model=model):
            recorder.log_event(ev)
            if ev.get("type") == "done":
                done_ev = ev
            yield _sse(ev)

        # grow the knowledge base from any web-discovered parts, then persist the build
        new_parts = []
        if done_ev and done_ev.get("spec"):
            new_parts = store.harvest_web_parts(done_ev["spec"]["bom"], _KB)
        recorder.finalize(done_ev)
        learned = {"type": "stored", "build_id": build_id,
                   "new_parts": new_parts, "learned_total": store.learned_count(),
                   "message": (f"Saved build {build_id}. "
                               + (f"Added {len(new_parts)} new part(s) to the library."
                                  if new_parts else "No new parts to learn this run."))}
        recorder.log_event(learned)
        yield _sse(learned)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/builds")
def builds():
    return {"builds": store.list_builds(), "learned_parts": store.learned_count()}


@app.get("/api/builds/{build_id}")
def build_detail(build_id: str):
    b = store.get_build(build_id)
    return b or JSONResponse({"error": "not found"}, status_code=404)


@app.get("/api/builds/{build_id}/api_calls")
def build_api_calls(build_id: str):
    return {"build_id": build_id, "api_calls": store.get_build_api_calls(build_id)}


class IntakeBody(BaseModel):
    messages: list[dict]
    model: str = "claude-opus-4-8"


@app.post("/api/intake")
def intake(body: IntakeBody):
    return JSONResponse(converse_intake(body.messages, model=body.model))


class BenchBody(BaseModel):
    requirement: dict
    models: list[str] = ["claude-opus-4-8", "claude-sonnet-4-6", "stub"]


@app.post("/api/bench")
def bench(body: BenchBody):
    """Model Bench: run the SAME requirement across models, tagging each event
    with its model so the UI can compare final coverage side by side."""
    req = Requirement.from_dict(body.requirement)

    def gen():
        for model in body.models:
            m = model if (model in VALID_MODELS or model == "stub") else "stub"
            proposer = make_proposer(m, _KB)
            yield _sse({"type": "bench_start", "model": model, "message": f"Running {model}…"})
            for ev in run(req, proposer, max_iters=MAX_ITERS, model=model):
                ev = {**ev, "model": model}
                yield _sse(ev)
            yield _sse({"type": "bench_end", "model": model})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# Serve the built frontend if present (single-binary style demo).
_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(_DIST):
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
