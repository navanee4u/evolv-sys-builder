"""Durable, file-based data store — everything Anvil accumulates at runtime.

  data/
    builds/<build_id>/
      build.json        manifest: requirement, model, coverage, timing, summary
      events.jsonl      every loop event that streamed to the UI
      api_calls.jsonl   every Anthropic API call (full request + response + usage)
    kb_learned.json     web-discovered components, deduped — the KB grows here
    builds_index.jsonl  one line per build, for fast listing

No database. Append-only files a human can read and a judge can watch grow.
Each /api/run is treated as one hardware BUILD with its own folder.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .schema import Component, all_components

_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _root() -> Path:
    return Path(os.environ.get("ANVIL_DATA_DIR", str(_DEFAULT_DATA_DIR)))


def _builds_dir() -> Path:
    return _root() / "builds"


def _learned_path() -> Path:
    return _root() / "kb_learned.json"


def _index_path() -> Path:
    return _root() / "builds_index.jsonl"


def _ensure():
    _builds_dir().mkdir(parents=True, exist_ok=True)
    if not _learned_path().exists():
        _learned_path().write_text("[]", encoding="utf-8")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_build_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"build-{stamp}-{uuid.uuid4().hex[:4]}"


# --------------------------------------------------------------------------- #
# per-build recorder
# --------------------------------------------------------------------------- #

class BuildRecorder:
    """Records one hardware build: its event stream and every API call it made."""

    def __init__(self, build_id: str, requirement: dict, model: str):
        _ensure()
        self.id = build_id
        self.requirement = requirement
        self.model = model
        self.started = _now_iso()
        self.t0 = time.time()
        self.dir = _builds_dir() / build_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self._events = self.dir / "events.jsonl"
        self._api = self.dir / "api_calls.jsonl"
        self.n_events = 0
        self.n_api_calls = 0

    def log_event(self, ev: dict):
        self.n_events += 1
        with self._events.open("a", encoding="utf-8") as f:
            f.write(json.dumps(ev) + "\n")

    def log_api_call(self, rec: dict):
        self.n_api_calls += 1
        rec = {"ts": _now_iso(), "build_id": self.id, **rec}
        with self._api.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, default=str) + "\n")

    def finalize(self, done_event: dict | None):
        spec = (done_event or {}).get("spec")
        manifest = {
            "build_id": self.id,
            "name": self.requirement.get("name", "untitled"),
            "model": self.model,
            "requirement": self.requirement,
            "started": self.started,
            "finished": _now_iso(),
            "elapsed_s": round(time.time() - self.t0, 2),
            "coverage": (done_event or {}).get("coverage", 0.0),
            "soft_score": (done_event or {}).get("soft_score", 0.0),
            "iterations": (done_event or {}).get("iterations", 0),
            "all_hard_pass": bool((done_event or {}).get("all_hard_pass")),
            "new_rules": (done_event or {}).get("new_rules", []),
            "api_calls": self.n_api_calls,
            "events": self.n_events,
            "final_bom": (spec or {}).get("bom"),
        }
        (self.dir / "build.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        with _index_path().open("a", encoding="utf-8") as f:
            f.write(json.dumps({k: manifest[k] for k in (
                "build_id", "name", "model", "started", "elapsed_s",
                "coverage", "iterations", "all_hard_pass", "api_calls")}) + "\n")
        return manifest


# --------------------------------------------------------------------------- #
# build listing / retrieval
# --------------------------------------------------------------------------- #

def list_builds(limit: int = 50) -> list[dict]:
    _ensure()
    if not _index_path().exists():
        return []
    rows = [json.loads(l) for l in _index_path().read_text(encoding="utf-8").splitlines() if l.strip()]
    return list(reversed(rows))[:limit]


def get_build(build_id: str) -> dict | None:
    d = _builds_dir() / build_id
    man = d / "build.json"
    if not man.exists():
        return None
    out = json.loads(man.read_text(encoding="utf-8"))
    ev = d / "events.jsonl"
    out["event_log"] = [json.loads(l) for l in ev.read_text(encoding="utf-8").splitlines() if l.strip()] if ev.exists() else []
    return out


def get_build_api_calls(build_id: str) -> list[dict]:
    f = _builds_dir() / build_id / "api_calls.jsonl"
    if not f.exists():
        return []
    return [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]


# --------------------------------------------------------------------------- #
# learned KB — web-discovered specs accumulate here
# --------------------------------------------------------------------------- #

def load_learned() -> list[Component]:
    _ensure()
    try:
        raw = json.loads(_learned_path().read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError):
        return []
    return [Component.from_dict(r) for r in raw]


def merge_learned_into(kb: dict[str, list[Component]]) -> int:
    """Merge the learned library into an in-memory KB dict (dedup by id). Returns count merged."""
    have = {p.id for parts in kb.values() for p in parts}
    n = 0
    for c in load_learned():
        if c.id not in have:
            kb.setdefault(c.subsystem, []).append(c)
            have.add(c.id)
            n += 1
    return n


def harvest_web_parts(bom: dict, kb: dict[str, list[Component]] | None = None) -> list[dict]:
    """Persist any source='web' components from a finished BOM into the learned
    library (dedup by id) and, if a live KB is given, merge them in so the next
    run can reuse them. Returns the newly stored components as dicts."""
    _ensure()
    existing = {c.id for c in load_learned()}
    in_kb = {p.id for parts in (kb or {}).values() for p in parts} if kb else set()
    new: list[Component] = []
    for comp in all_components(bom):
        if comp.source == "web" and comp.id not in existing:
            existing.add(comp.id)
            new.append(comp)
    if not new:
        return []
    # rewrite the learned file with the union
    current = load_learned() + new
    _learned_path().write_text(json.dumps([c.to_dict() for c in current], indent=2), encoding="utf-8")
    # merge into the live KB
    if kb is not None:
        for c in new:
            if c.id not in in_kb:
                kb.setdefault(c.subsystem, []).append(c)
    return [c.to_dict() for c in new]


def learned_count() -> int:
    return len(load_learned())
