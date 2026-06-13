"""Golden run -- the build's own /goal.

A fixed requirement set (an outdoor inspection drone payload) must converge to
coverage == 1.0 with the deterministic KB-only proposer, within MAX_ITERS, and
must exhibit the self-correction event (a hard constraint goes red then green).

This is wired into `make verify`. A failure here is a real failure: investigate
the specific constraint, fix it, re-run -- the same loop Anvil runs.

Run directly:  python -m anvil.tests.golden_run
As a test:     pytest anvil/tests/golden_run.py
"""

from anvil.backend.loop import run, MAX_ITERS
from anvil.backend.proposer import StubProposer
from anvil.backend.schema import Requirement

DRONE = Requirement(
    name="Outdoor Inspection Drone Payload",
    power_budget_W=12.0,
    runtime_h=0.75,                       # 45 min
    workload_TOPS=21.0,
    model_footprint_GB=6.0,
    temp_C=[-20.0, 60.0],
    ip_rating="IP67",
    mass_budget_g=450.0,
    enclosure_mm=[120.0, 80.0, 40.0],
    camera={"mp": 8.29, "fps": 30, "interface": "MIPI-CSI"},   # true 4K UHD = 3840x2160 = 8.29 MP
    comms=["5GHz", "UWB"],
)


def drive(requirement=DRONE):
    """Run the loop to completion, returning (events, done_event)."""
    events = list(run(requirement, StubProposer(), max_iters=MAX_ITERS))
    done = next(e for e in events if e["type"] == "done")
    return events, done


def test_golden_run_converges():
    events, done = drive()
    assert done["all_hard_pass"], f"did not converge: {done['message']}"
    assert done["coverage"] == 1.0
    assert done["iterations"] <= MAX_ITERS


def test_golden_run_self_corrects():
    """The hero event: a hard constraint must fail before the run goes all-green."""
    events, done = drive()
    assert any(e["type"] == "fail" for e in events), "no constraint ever failed — no self-correction shown"
    assert any(e["type"] == "swap" for e in events), "no repair/swap was applied"
    # power_budget specifically should be the one that goes red then green
    assert any(e["type"] == "fail" and e.get("constraint") == "power_budget" for e in events)


def test_golden_run_distills_rule():
    events, _ = drive()
    assert any(e["type"] == "distill" for e in events), "no rule distilled from the resolved failure"


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    events, done = drive()
    print("=" * 70)
    for e in events:
        tag = e["type"].upper().ljust(12)
        print(f"{tag} {e['message']}")
    print("=" * 70)
    print(f"RESULT: coverage={done['coverage']*100:.0f}%  "
          f"iterations={done['iterations']}  all_hard_pass={done['all_hard_pass']}")
    raise SystemExit(0 if done["all_hard_pass"] and done["coverage"] == 1.0 else 1)
