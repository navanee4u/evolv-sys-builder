"""Proposers select and revise the BOM. They NEVER judge pass/fail -- that is the
verifier's job alone.

Two implementations share one interface so the loop is agnostic:

  * StubProposer  -- deterministic, KB-only, no LLM. Used to prove the loop
    converges and to drive the golden run / CI. It encodes a simple but honest
    repair policy: when a constraint fails, re-select the responsible subsystem
    toward the property that failed.
  * LLMProposer   -- the real agent (proposer_llm.py), model-selectable, with
    web search. Falls back to the same KB.

`build_rubric` is the deterministic Requirement -> Rubric mapping. The LLM
parses free text into a Requirement; from there the rubric is mechanical so the
checklist is reproducible.
"""

from __future__ import annotations

import json
from pathlib import Path

from .schema import (Component, Constraint, Requirement, empty_bom,
                     all_components, SpecResult)

KB_DIR = Path(__file__).resolve().parent.parent / "kb"


# --------------------------------------------------------------------------- #
# knowledge base
# --------------------------------------------------------------------------- #

def load_kb(kb_dir: Path = KB_DIR) -> dict[str, list[Component]]:
    """Load every kb/*.json into {subsystem: [Component, ...]}."""
    by_sub: dict[str, list[Component]] = {}
    for f in sorted(kb_dir.glob("*.json")):
        for raw in json.loads(f.read_text(encoding="utf-8")):
            comp = Component.from_dict(raw)
            by_sub.setdefault(comp.subsystem, []).append(comp)
    return by_sub


# --------------------------------------------------------------------------- #
# Requirement -> Rubric (deterministic)
# --------------------------------------------------------------------------- #

def build_rubric(req: Requirement) -> list[Constraint]:
    R: list[Constraint] = []

    if req.power_budget_W is not None:
        R.append(Constraint("power_budget", "power", "hard",
                            f"sum(active_power_W) <= {req.power_budget_W}",
                            {"max_W": req.power_budget_W}))
        R.append(Constraint("peak_power", "power", "hard",
                            "sum(peak_power_W per rail) <= rail_current_A * rail_V", {}))
        R.append(Constraint("voltage_rails", "power", "hard",
                            "every input voltage is supplied by a rail", {}))
        R.append(Constraint("connectors", "connector", "hard",
                            "every connector has a mating pair", {}))
        # soft
        R.append(Constraint("power_margin", "power", "soft",
                            "active power leaves headroom",
                            {"budget_W": req.power_budget_W, "min_slack": 0.10}, weight=1.0))

    if req.runtime_h is not None:
        R.append(Constraint("endurance", "endurance", "hard",
                            f"battery_Wh / avg_power_W >= {req.runtime_h}",
                            {"runtime_h": req.runtime_h}))

    if req.workload_TOPS is not None:
        need = {"workload_TOPS": req.workload_TOPS}
        if req.model_footprint_GB is not None:
            need["model_footprint_GB"] = req.model_footprint_GB
        R.append(Constraint("compute", "compute", "hard",
                            f"accelerator TOPS >= {req.workload_TOPS}", need))

    if req.camera is not None:
        R.append(Constraint("sensing", "sensing", "hard",
                            "camera meets resolution/fps and CSI lanes fit", dict(req.camera)))

    if req.comms is not None:
        R.append(Constraint("comms", "comms", "hard",
                            f"radios+antennas cover {req.comms}", {"protocols": list(req.comms)}))

    if req.temp_C is not None:
        R.append(Constraint("thermal", "thermal", "hard",
                            f"all parts rated across {req.temp_C} C", {"temp_C": list(req.temp_C)}))

    if req.ip_rating is not None:
        R.append(Constraint("environment", "environment", "hard",
                            f"enclosure IP >= {req.ip_rating}", {"ip_rating": req.ip_rating}))

    if req.mass_budget_g is not None:
        R.append(Constraint("mass_budget", "mass", "hard",
                            f"sum(mass_g) <= {req.mass_budget_g}", {"max_g": req.mass_budget_g}))

    if req.enclosure_mm is not None:
        R.append(Constraint("size_enclosure", "size", "hard",
                            "all boards fit the enclosure", {"enclosure_mm": list(req.enclosure_mm)}))

    if req.actuation is not None:
        R.append(Constraint("actuation", "actuation", "hard",
                            "motor torque & driver current adequate", dict(req.actuation)))

    # always-on soft ranking signals
    R.append(Constraint("cost", "cost", "soft", "minimize BOM cost", {}, weight=0.5))
    R.append(Constraint("lead_time", "lead_time", "soft", "minimize lead time", {}, weight=0.5))
    return R


# --------------------------------------------------------------------------- #
# selection helpers
# --------------------------------------------------------------------------- #

def _best(parts, ok, key, reverse=False):
    cands = [p for p in parts if ok(p)]
    if not cands:
        return None
    return sorted(cands, key=key, reverse=reverse)[0]


def _rails_needed(parts) -> set[float]:
    need = set()
    for p in parts:
        for v in (p.input_voltage_V or []):
            need.add(v)
    return need


# --------------------------------------------------------------------------- #
# Stub proposer -- deterministic, KB only
# --------------------------------------------------------------------------- #

class StubProposer:
    name = "stub"

    def __init__(self, kb: dict[str, list[Component]] | None = None):
        self.kb = kb or load_kb()

    # -- the loop interface ------------------------------------------------- #

    def parse(self, requirement: Requirement) -> tuple[Requirement, list[Constraint]]:
        return requirement, build_rubric(requirement)

    def initial(self, req: Requirement, rubric, rules: str = "") -> tuple[dict, list[str]]:
        bom = empty_bom()
        notes: list[str] = []

        # compute: greedily grab the MOST capable accelerator (overshoots power on purpose)
        if req.workload_TOPS is not None:
            soc = self._pick_compute(req, prefer="capability")
            if soc:
                bom["subsystems"]["compute"].append(soc)
                notes.append(f"compute: selected {soc.name} ({soc.compute_TOPS} TOPS, {soc.active_power_W} W)")

        # sensing
        if req.camera is not None:
            cam = self._pick_camera(req)
            if cam:
                bom["subsystems"]["sensing"].append(cam)
                notes.append(f"sensing: selected {cam.name}")

        # comms: radio + matching antenna
        if req.comms is not None:
            radio, ant = self._pick_comms(req)
            if radio:
                bom["subsystems"]["comms"].append(radio)
                notes.append(f"comms: selected {radio.name}")
            if ant:
                bom["subsystems"]["comms"].append(ant)
                notes.append(f"comms: selected {ant.name}")

        # power: regulator + battery (sized to current draw)
        if req.power_budget_W is not None:
            self._select_power(bom, req)
            for p in bom["subsystems"]["power"]:
                notes.append(f"power: selected {p.name}")

        # mechanical: enclosure that satisfies IP and actually fits the boards
        if req.ip_rating is not None or req.enclosure_mm is not None:
            enc = self._pick_enclosure(req, bom)
            if enc:
                bom["subsystems"]["mechanical"].append(enc)
                notes.append(f"mechanical: selected {enc.name}")

        # actuation
        if req.actuation is not None:
            self._select_actuation(bom, req)
            for p in bom["subsystems"]["actuation"]:
                notes.append(f"actuation: selected {p.name}")

        return bom, notes

    def revise(self, req: Requirement, rubric, result: SpecResult) -> tuple[dict, list[str]]:
        """Targeted repair: for each failing hard check, re-select the responsible
        subsystem toward the property that failed. Deterministic and convergent."""
        bom = result.bom
        actions: list[str] = []
        failing = {c.constraint_id for c in result.failing_hard}

        # power overruns -> swap to the lowest-power compute that still meets the workload
        if {"power_budget", "peak_power"} & failing and req.workload_TOPS is not None:
            new = self._pick_compute(req, prefer="efficiency")
            old = self._first(bom, "compute")
            if new and (old is None or new.id != old.id):
                bom["subsystems"]["compute"] = [new]
                fc = next((c for c in result.failing_hard if c.constraint_id in ("power_budget", "peak_power")), None)
                why = fc.reason if fc else ""
                actions.append(
                    f"{why} Investigating compute: swapping {old.name if old else '∅'} "
                    f"({old.active_power_W if old else '?'} W) for {new.name} "
                    f"({new.active_power_W} W, {new.compute_TOPS} TOPS).")

        if "compute" in failing:
            new = self._pick_compute(req, prefer="capability")
            old = self._first(bom, "compute")
            if new and (old is None or new.id != old.id):
                bom["subsystems"]["compute"] = [new]
                actions.append(f"compute underpowered → selecting {new.name} ({new.compute_TOPS} TOPS).")

        if "endurance" in failing:
            batt = _best(self.kb.get("power", []), lambda p: p.battery_Wh,
                         key=lambda p: p.battery_Wh, reverse=True)
            if batt:
                bom["subsystems"]["power"] = [p for p in bom["subsystems"]["power"] if not p.battery_Wh] + [batt]
                actions.append(f"runtime short → upsizing battery to {batt.name} ({batt.battery_Wh} Wh).")

        if "thermal" in failing:
            env = req.temp_C
            for sub in list(bom["subsystems"]):
                fixed = []
                for p in bom["subsystems"][sub]:
                    if p.temp_op_C and (p.temp_op_C[0] > env[0] or p.temp_op_C[1] < env[1]):
                        repl = _best(self.kb.get(sub, []),
                                     lambda q: q.temp_op_C and q.temp_op_C[0] <= env[0] and q.temp_op_C[1] >= env[1]
                                     and self._same_role(q, p, req),
                                     key=lambda q: (q.cost_usd or 0))
                        if repl:
                            actions.append(f"thermal: {p.name} not rated for {env} C → {repl.name}.")
                            fixed.append(repl)
                            continue
                    fixed.append(p)
                bom["subsystems"][sub] = fixed

        if "environment" in failing or "size_enclosure" in failing:
            enc = self._pick_enclosure(req, bom)
            old = self._first(bom, "mechanical")
            if enc and (old is None or enc.id != old.id):
                bom["subsystems"]["mechanical"] = [enc]
                actions.append(f"enclosure → {enc.name} (IP/size).")

        if "mass_budget" in failing:
            # drop to the lightest battery that still meets endurance
            batt = _best(self.kb.get("power", []),
                         lambda p: p.battery_Wh and self._runtime_ok(req, bom, p),
                         key=lambda p: p.mass_g or 1e9)
            if batt:
                bom["subsystems"]["power"] = [p for p in bom["subsystems"]["power"] if not p.battery_Wh] + [batt]
                actions.append(f"mass over → lighter battery {batt.name} ({batt.mass_g} g).")

        if "sensing" in failing:
            cam = self._pick_camera(req)
            if cam:
                bom["subsystems"]["sensing"] = [cam]
                actions.append(f"sensing → {cam.name}.")

        if "comms" in failing:
            radio, ant = self._pick_comms(req)
            bom["subsystems"]["comms"] = [c for c in (radio, ant) if c]
            actions.append("comms → radio+antenna covering required bands.")

        if "voltage_rails" in failing:
            self._select_power(bom, req)
            actions.append("power: added regulator to supply missing rail(s).")

        if "connectors" in failing:
            added = self._add_cables(bom, result)
            for a in added:
                actions.append(f"connector: added {a}.")

        if "actuation" in failing:
            self._select_actuation(bom, req)
            actions.append("actuation → motor+driver with adequate torque/current.")

        if not actions:
            actions.append("No deterministic repair available for the failing constraints.")
        return bom, actions

    # -- selection internals ----------------------------------------------- #

    def _first(self, bom, sub) -> Component | None:
        parts = bom["subsystems"].get(sub, [])
        return parts[0] if parts else None

    def _pick_compute(self, req, prefer="capability") -> Component | None:
        def ok(p):
            if p.compute_TOPS is None or p.compute_TOPS < req.workload_TOPS:
                return False
            if req.model_footprint_GB and (p.ram_GB or 0) < req.model_footprint_GB:
                return False
            return True
        if prefer == "efficiency":
            return _best(self.kb.get("compute", []), ok, key=lambda p: p.active_power_W or 1e9)
        # capability: most TOPS first
        return _best(self.kb.get("compute", []), ok, key=lambda p: p.compute_TOPS, reverse=True)

    def _pick_camera(self, req) -> Component | None:
        cam = req.camera
        def ok(p):
            return (p.resolution_mp and p.resolution_mp >= cam["mp"]
                    and (p.fps or 0) >= cam.get("fps", 0)
                    and (cam.get("interface") is None or p.interface == cam["interface"]))
        return _best(self.kb.get("sensing", []), ok, key=lambda p: p.cost_usd or 1e9)

    def _pick_comms(self, req):
        protos = set(req.comms)
        radio = _best(self.kb.get("comms", []),
                      lambda p: p.radio_bands and protos.issubset(set(p.radio_bands)),
                      key=lambda p: p.cost_usd or 1e9)
        ant = None
        if radio:
            ant = _best(self.kb.get("comms", []),
                        lambda p: (p.antenna_bands and protos.issubset(set(p.antenna_bands))
                                   and (p.antenna_count or 0) >= (radio.radio_chains or 0)),
                        key=lambda p: p.cost_usd or 1e9)
        return radio, ant

    def _select_power(self, bom, req):
        loads = [p for parts in bom["subsystems"].values() for p in parts]
        rails = _rails_needed(loads) or {5.0, 3.3}
        pmic = _best(self.kb.get("power", []),
                     lambda p: p.rails_provided and rails.issubset(set(p.rails_provided)),
                     key=lambda p: -(p.rail_current_A or 0))
        batt = _best(self.kb.get("power", []),
                     lambda p: p.battery_Wh and (req.runtime_h is None or self._runtime_ok(req, bom, p)),
                     key=lambda p: p.battery_Wh or 1e9)  # smallest that meets runtime
        if batt is None:  # nothing meets runtime -> take the biggest
            batt = _best(self.kb.get("power", []), lambda p: p.battery_Wh,
                         key=lambda p: p.battery_Wh or 0, reverse=True)
        chosen = [c for c in (pmic, batt) if c]
        # keep any non-power-rail parts already there, replace power list
        bom["subsystems"]["power"] = chosen

    def _runtime_ok(self, req, bom, batt) -> bool:
        avg = sum((p.active_power_W or 0) for parts in bom["subsystems"].values() for p in parts)
        if avg <= 0:
            return True
        return (batt.battery_Wh / avg) >= req.runtime_h

    def _pick_enclosure(self, req, bom) -> Component | None:
        boards = [p for sub, parts in bom["subsystems"].items() if sub != "mechanical"
                  for p in parts if p.dims_mm]
        footprint = sum(p.dims_mm[0] * p.dims_mm[1] for p in boards)

        def fits(enc):
            if not enc.dims_mm:
                return False
            if req.ip_rating and _ip(enc.ip_rating) < _ip(req.ip_rating):
                return False
            es = sorted(enc.dims_mm)
            for b in boards:
                if any(sorted(b.dims_mm)[i] > es[i] for i in range(3)):
                    return False
            return enc.dims_mm[0] * enc.dims_mm[1] >= footprint
        return _best(self.kb.get("mechanical", []), fits, key=lambda p: p.cost_usd or 1e9)

    def _select_actuation(self, bom, req):
        act = req.actuation
        req_t = act.get("torque_Nm", 0)
        motor = _best(self.kb.get("actuation", []),
                      lambda p: p.torque_Nm and p.torque_Nm >= req_t,
                      key=lambda p: p.cost_usd or 1e9)
        driver = None
        if motor:
            need = max(motor.continuous_current_A or 0, motor.stall_current_A or 0)
            driver = _best(self.kb.get("actuation", []),
                           lambda p: (p.driver_current_A or 0) >= need,
                           key=lambda p: p.cost_usd or 1e9)
        bom["subsystems"]["actuation"] = [c for c in (motor, driver) if c]

    def _add_cables(self, bom, result) -> list[str]:
        chk = next((c for c in result.checks if c.constraint_id == "connectors"), None)
        if not chk:
            return []
        added = []
        for key in chk.observed.get("unmatched", []):
            cable = _best(self.kb.get("connector", []),
                          lambda p: p.connector_mates and key in p.connector_mates,
                          key=lambda p: p.cost_usd or 1e9)
            if cable:
                bom["subsystems"]["connector"].append(cable)
                added.append(cable.name)
        return added

    def _same_role(self, a, b, req) -> bool:
        return a.subsystem == b.subsystem


def _ip(ip):
    if not ip or not ip.upper().startswith("IP") or len(ip) < 4:
        return (-1, -1)
    try:
        return (int(ip[2]), int(ip[3]))
    except (ValueError, IndexError):
        return (-1, -1)
