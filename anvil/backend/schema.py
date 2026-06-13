"""Anvil data contracts.

These are the single source of structure shared by the proposer, the verifier,
the loop and the server. Keep them plain and serializable: every type here must
round-trip through JSON because the frontend renders these objects directly off
the SSE stream.

Components carry many optional fields (a motor has torque but no TOPS; a SoM has
TOPS but no torque). We model that with one dataclass full of optional fields
rather than a subsystem class hierarchy -- the verifier reads only the fields a
given constraint needs, and missing data is an honest `None`.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional


# --------------------------------------------------------------------------- #
# Requirement -> Rubric
# --------------------------------------------------------------------------- #

@dataclass
class Constraint:
    """One row of the rubric. `required` holds the machine-checkable numbers;
    `predicate` is a human-readable echo of the same thing for the UI."""
    id: str
    dimension: str                 # power|mass|size|thermal|compute|sensing|comms|actuation|connector|endurance|environment
    kind: str = "hard"             # "hard" gates the loop; "soft" is scored for ranking
    predicate: str = ""
    required: dict[str, Any] = field(default_factory=dict)
    weight: float = 1.0            # soft only

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Constraint":
        return Constraint(
            id=d["id"],
            dimension=d["dimension"],
            kind=d.get("kind", "hard"),
            predicate=d.get("predicate", ""),
            required=d.get("required", {}),
            weight=d.get("weight", 1.0),
        )


@dataclass
class Requirement:
    """The user's structured intent. The proposer parses free text into this
    (and into a Rubric); the deterministic stub proposer + golden run build it
    directly. Every field is optional so partial requirement sets still run."""
    name: str = "untitled"
    power_budget_W: Optional[float] = None
    runtime_h: Optional[float] = None
    workload_TOPS: Optional[float] = None
    model_footprint_GB: Optional[float] = None
    temp_C: Optional[list[float]] = None         # [min, max] operating environment
    ip_rating: Optional[str] = None
    mass_budget_g: Optional[float] = None
    enclosure_mm: Optional[list[float]] = None   # [x, y, z] internal volume
    camera: Optional[dict] = None                # {"mp": 8.3, "fps": 30, "interface": "MIPI-CSI"}
    comms: Optional[list[str]] = None            # required protocols/bands, e.g. ["5GHz", "UWB"]
    actuation: Optional[dict] = None             # {"torque_Nm": 0.4, "continuous_current_A": 2.0, "count": 4}
    rail_voltages_V: Optional[list[float]] = None  # voltages the design must supply (informational)
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Requirement":
        known = {f for f in Requirement.__dataclass_fields__}
        return Requirement(**{k: v for k, v in d.items() if k in known})


# --------------------------------------------------------------------------- #
# Components and BOM
# --------------------------------------------------------------------------- #

@dataclass
class Component:
    id: str
    subsystem: str                 # compute|power|sensing|comms|actuation|mechanical|connector
    name: str = ""
    vendor: str = ""
    part_number: str = ""
    source: str = "kb"             # "kb" | "web" -- provenance, shown in UI

    # power
    active_power_W: Optional[float] = None
    peak_power_W: Optional[float] = None
    input_voltage_V: Optional[list[float]] = None    # voltages this part consumes
    rails_provided: Optional[list[float]] = None      # voltages a PMIC/regulator supplies
    rail_current_A: Optional[float] = None            # per-rail current the regulator can source
    battery_Wh: Optional[float] = None                # batteries declare capacity here

    # physical
    mass_g: Optional[float] = None
    dims_mm: Optional[list[float]] = None             # [x, y, z]
    temp_op_C: Optional[list[float]] = None           # [min, max]
    ip_rating: Optional[str] = None

    # compute
    compute_TOPS: Optional[float] = None
    ram_GB: Optional[float] = None
    csi_lanes: Optional[int] = None                   # MIPI-CSI camera ports available

    # sensing
    resolution_mp: Optional[float] = None
    fps: Optional[float] = None
    interface: Optional[str] = None                   # e.g. "MIPI-CSI"

    # comms
    radio_bands: Optional[list[str]] = None
    radio_chains: Optional[int] = None
    antenna_bands: Optional[list[str]] = None
    antenna_count: Optional[int] = None

    # actuation
    torque_Nm: Optional[float] = None
    continuous_current_A: Optional[float] = None       # motor draw
    stall_current_A: Optional[float] = None
    driver_current_A: Optional[float] = None           # driver rating

    # connectors / interconnect
    connector_mates: Optional[list[str]] = None        # mate keys this part exposes

    # soft / ranking
    cost_usd: Optional[float] = None
    lead_time_weeks: Optional[float] = None

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @staticmethod
    def from_dict(d: dict) -> "Component":
        known = {f for f in Component.__dataclass_fields__}
        return Component(**{k: v for k, v in d.items() if k in known})


# A BOM is subsystem -> list of selected components.
SUBSYSTEMS = ["compute", "power", "sensing", "comms", "actuation", "mechanical", "connector"]


def empty_bom() -> dict:
    return {"subsystems": {s: [] for s in SUBSYSTEMS}}


def all_components(bom: dict) -> list[Component]:
    out: list[Component] = []
    for parts in bom["subsystems"].values():
        for p in parts:
            out.append(p if isinstance(p, Component) else Component.from_dict(p))
    return out


def bom_to_dict(bom: dict) -> dict:
    return {
        "subsystems": {
            s: [(p.to_dict() if isinstance(p, Component) else p) for p in parts]
            for s, parts in bom["subsystems"].items()
        }
    }


# --------------------------------------------------------------------------- #
# Verifier output
# --------------------------------------------------------------------------- #

@dataclass
class Check:
    constraint_id: str
    dimension: str
    kind: str
    status: str                    # "pass" | "fail"
    reason: str = ""
    observed: Any = None
    required: Any = None
    weight: float = 1.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SpecResult:
    bom: dict
    checks: list[Check]
    coverage: float = 0.0          # fraction of HARD constraints passing -- headline metric
    soft_score: float = 0.0        # weighted soft score, drives Stage-2 ranking
    iteration: int = 0

    def to_dict(self) -> dict:
        return {
            "bom": bom_to_dict(self.bom),
            "checks": [c.to_dict() for c in self.checks],
            "coverage": self.coverage,
            "soft_score": self.soft_score,
            "iteration": self.iteration,
        }

    @property
    def all_hard_pass(self) -> bool:
        hard = [c for c in self.checks if c.kind == "hard"]
        return bool(hard) and all(c.status == "pass" for c in hard)

    @property
    def failing_hard(self) -> list[Check]:
        return [c for c in self.checks if c.kind == "hard" and c.status == "fail"]
