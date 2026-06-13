"""File-based persistent memory -- the OUTER loop.

  failures.jsonl : every hard-constraint failure the loop hit + how it was fixed.
  rules.md       : distilled general rules, consulted at the start of each run so
                   the proposer stops re-deriving solved problems.

No database. Just append-only files a human can read and a judge can watch grow.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_DEFAULT_MEM_DIR = Path(__file__).resolve().parent.parent / "memory"


def _dir() -> Path:
    # resolved per-call so tests (and the server) can redirect via ANVIL_MEM_DIR
    return Path(os.environ.get("ANVIL_MEM_DIR", str(_DEFAULT_MEM_DIR)))


def _rules_path() -> Path:
    return _dir() / "rules.md"


def _failures_path() -> Path:
    return _dir() / "failures.jsonl"

# A confirmed fix in dimension X distills to this general guidance.
_RULE_TEMPLATES = {
    "power_budget": "Tight power budget: pick the lowest-power compute module that still clears the TOPS workload, not the most capable one.",
    "peak_power": "Size regulator rail current to the summed PEAK draw on each rail, not the average.",
    "endurance": "Long-runtime targets: size the battery from avg_power x required_hours up front, with margin.",
    "thermal": "Outdoor/wide-temp environments: restrict the whole BOM to industrial-temp (-40..85 C) parts from the start.",
    "environment": "Sealed/IP-rated requirements: choose the enclosure IP rating before placing boards.",
    "size_enclosure": "Pick the enclosure from the summed board footprint, not the smallest available shell.",
    "mass_budget": "Mass-constrained builds: the battery dominates mass -- size it last against remaining budget.",
    "compute": "Match accelerator TOPS and RAM to the model footprint before optimizing anything else.",
    "sensing": "Verify camera CSI lane count against host SoM lanes, not just resolution/fps.",
    "comms": "Pair every radio band with a matching antenna band and antenna_count >= radio_chains.",
    "voltage_rails": "Enumerate every load's input voltage and provide a regulated rail for each before finalizing power.",
    "connectors": "Every inter-board link needs a mating connector pair; add the cable when a mate key is dangling.",
    "actuation": "Rate the motor driver to stall current, not just continuous current.",
}


def _ensure():
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    rules = _rules_path()
    if not rules.exists():
        rules.write_text("# Anvil distilled rules\n\n"
                         "_General hardware-selection rules learned across runs._\n\n",
                         encoding="utf-8")
    if not _failures_path().exists():
        _failures_path().write_text("", encoding="utf-8")


def load_rules() -> str:
    _ensure()
    return _rules_path().read_text(encoding="utf-8")


def rule_lines() -> list[str]:
    """The bullet rules only (for the UI panel)."""
    return [ln[2:].strip() for ln in load_rules().splitlines() if ln.startswith("- ")]


def append_failure(rubric_dim: str, failing_part: str, reason: str, fix_applied: str):
    _ensure()
    rec = {"rubric_dim": rubric_dim, "failing_part": failing_part,
           "reason": reason, "fix_applied": fix_applied}
    with _failures_path().open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def load_failures() -> list[dict]:
    _ensure()
    out = []
    for ln in _failures_path().read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if ln:
            out.append(json.loads(ln))
    return out


def distill_rule(dimension: str) -> str | None:
    """Add the general rule for a resolved dimension if not already present.
    Returns the rule text if it was newly added, else None."""
    _ensure()
    rule = _RULE_TEMPLATES.get(dimension)
    if not rule:
        return None
    existing = set(rule_lines())
    if rule in existing:
        return None
    with _rules_path().open("a", encoding="utf-8") as f:
        f.write(f"- {rule}\n")
    return rule
