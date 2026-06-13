"""Unit tests for every verifier constraint -- a passing and a failing case each.

The verifier must be trustworthy before the loop is worth running, so this is
the most important test file in the repo. Run with: pytest anvil/tests
"""

from anvil.backend.schema import Component, Constraint, empty_bom
from anvil.backend.verifier import verify, check_one


def bom_of(*comps):
    b = empty_bom()
    for c in comps:
        b["subsystems"][c.subsystem].append(c)
    return b


def run(constraint, *comps):
    return check_one(list(comps), constraint)


# --------------------------------------------------------------------------- #
# power budget
# --------------------------------------------------------------------------- #

def test_power_budget_pass():
    c = Constraint(id="power_budget", dimension="power", required={"max_W": 12.0})
    r = run(c, Component(id="a", subsystem="compute", active_power_W=7.0),
               Component(id="b", subsystem="sensing", active_power_W=1.5))
    assert r.status == "pass"
    assert r.observed["sum_active_power_W"] == 8.5


def test_power_budget_fail():
    c = Constraint(id="power_budget", dimension="power", required={"max_W": 12.0})
    r = run(c, Component(id="a", subsystem="compute", active_power_W=18.0),
               Component(id="b", subsystem="sensing", active_power_W=1.5))
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# peak power per rail
# --------------------------------------------------------------------------- #

def _pmic(amps):
    return Component(id="pmic", subsystem="power", input_voltage_V=[12.0],
                     rails_provided=[5.0], rail_current_A=amps)


def test_peak_power_pass():
    c = Constraint(id="peak_power", dimension="power", required={})
    r = run(c, _pmic(5.0),  # 5V * 5A = 25 W cap
            Component(id="soc", subsystem="compute", input_voltage_V=[5.0], peak_power_W=15.0))
    assert r.status == "pass"


def test_peak_power_fail():
    c = Constraint(id="peak_power", dimension="power", required={})
    r = run(c, _pmic(2.0),  # 5V * 2A = 10 W cap
            Component(id="soc", subsystem="compute", input_voltage_V=[5.0], peak_power_W=15.0))
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# voltage rails
# --------------------------------------------------------------------------- #

def test_voltage_rails_pass():
    c = Constraint(id="voltage_rails", dimension="power", required={})
    r = run(c, Component(id="pmic", subsystem="power", rails_provided=[5.0, 3.3], input_voltage_V=[12.0]),
               Component(id="batt", subsystem="power", rails_provided=[12.0]),
               Component(id="soc", subsystem="compute", input_voltage_V=[5.0]))
    assert r.status == "pass"


def test_voltage_rails_fail():
    c = Constraint(id="voltage_rails", dimension="power", required={})
    r = run(c, Component(id="pmic", subsystem="power", rails_provided=[5.0]),
               Component(id="radio", subsystem="comms", input_voltage_V=[3.3]))  # no 3.3 rail
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# endurance
# --------------------------------------------------------------------------- #

def test_endurance_pass():
    c = Constraint(id="endurance", dimension="endurance", required={"runtime_h": 0.75})
    r = run(c, Component(id="batt", subsystem="power", battery_Wh=30.0),
               Component(id="soc", subsystem="compute", active_power_W=10.0))
    assert r.status == "pass"  # 30/10 = 3 h


def test_endurance_fail():
    c = Constraint(id="endurance", dimension="endurance", required={"runtime_h": 0.75})
    r = run(c, Component(id="batt", subsystem="power", battery_Wh=5.5),
               Component(id="soc", subsystem="compute", active_power_W=10.0))
    assert r.status == "fail"  # 5.5/10 = 0.55 h


# --------------------------------------------------------------------------- #
# thermal
# --------------------------------------------------------------------------- #

def test_thermal_pass():
    c = Constraint(id="thermal", dimension="thermal", required={"temp_C": [-20.0, 60.0]})
    r = run(c, Component(id="a", subsystem="compute", temp_op_C=[-25.0, 80.0]))
    assert r.status == "pass"


def test_thermal_fail():
    c = Constraint(id="thermal", dimension="thermal", required={"temp_C": [-20.0, 60.0]})
    r = run(c, Component(id="a", subsystem="compute", temp_op_C=[0.0, 70.0]))  # min too high
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# mass
# --------------------------------------------------------------------------- #

def test_mass_pass():
    c = Constraint(id="mass_budget", dimension="mass", required={"max_g": 450.0})
    r = run(c, Component(id="a", subsystem="compute", mass_g=200.0),
               Component(id="b", subsystem="power", mass_g=180.0))
    assert r.status == "pass"


def test_mass_fail():
    c = Constraint(id="mass_budget", dimension="mass", required={"max_g": 450.0})
    r = run(c, Component(id="a", subsystem="compute", mass_g=300.0),
               Component(id="b", subsystem="power", mass_g=280.0))
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# size / packing
# --------------------------------------------------------------------------- #

def test_size_pass():
    c = Constraint(id="size_enclosure", dimension="size", required={"enclosure_mm": [120.0, 80.0, 40.0]})
    r = run(c, Component(id="a", subsystem="compute", dims_mm=[70.0, 45.0, 13.0]))
    assert r.status == "pass"


def test_size_fail_oversize():
    c = Constraint(id="size_enclosure", dimension="size", required={"enclosure_mm": [120.0, 80.0, 40.0]})
    r = run(c, Component(id="a", subsystem="compute", dims_mm=[130.0, 45.0, 13.0]))  # too long
    assert r.status == "fail"


def test_size_fail_footprint():
    c = Constraint(id="size_enclosure", dimension="size", required={"enclosure_mm": [120.0, 80.0, 40.0]})
    # two big boards exceed the 9600 mm^2 floor
    r = run(c, Component(id="a", subsystem="compute", dims_mm=[100.0, 70.0, 10.0]),
               Component(id="b", subsystem="comms", dims_mm=[80.0, 60.0, 10.0]))
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# compute
# --------------------------------------------------------------------------- #

def test_compute_pass():
    c = Constraint(id="compute", dimension="compute",
                   required={"workload_TOPS": 21.0, "model_footprint_GB": 6.0})
    r = run(c, Component(id="soc", subsystem="compute", compute_TOPS=40.0, ram_GB=8))
    assert r.status == "pass"


def test_compute_fail_tops():
    c = Constraint(id="compute", dimension="compute", required={"workload_TOPS": 21.0})
    r = run(c, Component(id="soc", subsystem="compute", compute_TOPS=20.0, ram_GB=8))
    assert r.status == "fail"


def test_compute_fail_ram():
    c = Constraint(id="compute", dimension="compute",
                   required={"workload_TOPS": 21.0, "model_footprint_GB": 6.0})
    r = run(c, Component(id="soc", subsystem="compute", compute_TOPS=40.0, ram_GB=4))
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# sensing
# --------------------------------------------------------------------------- #

def test_sensing_pass():
    c = Constraint(id="sensing", dimension="sensing",
                   required={"mp": 8.3, "fps": 30, "interface": "MIPI-CSI"})
    r = run(c, Component(id="cam", subsystem="sensing", resolution_mp=12.3, fps=60,
                         interface="MIPI-CSI", csi_lanes=2),
               Component(id="soc", subsystem="compute", csi_lanes=8))
    assert r.status == "pass"


def test_sensing_fail_resolution():
    c = Constraint(id="sensing", dimension="sensing",
                   required={"mp": 8.3, "fps": 30, "interface": "MIPI-CSI"})
    r = run(c, Component(id="cam", subsystem="sensing", resolution_mp=8.08, fps=30,
                         interface="MIPI-CSI", csi_lanes=2),
               Component(id="soc", subsystem="compute", csi_lanes=8))
    assert r.status == "fail"


def test_sensing_fail_lanes():
    c = Constraint(id="sensing", dimension="sensing",
                   required={"mp": 8.3, "fps": 30, "interface": "MIPI-CSI"})
    r = run(c, Component(id="cam", subsystem="sensing", resolution_mp=12.3, fps=60,
                         interface="MIPI-CSI", csi_lanes=4),
               Component(id="soc", subsystem="compute", csi_lanes=2))  # not enough lanes
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# comms
# --------------------------------------------------------------------------- #

def test_comms_pass():
    c = Constraint(id="comms", dimension="comms", required={"protocols": ["5GHz", "UWB"]})
    r = run(c, Component(id="radio", subsystem="comms",
                         radio_bands=["2.4GHz", "5GHz", "UWB"], radio_chains=2),
               Component(id="ant", subsystem="comms",
                         antenna_bands=["2.4GHz", "5GHz", "UWB"], antenna_count=2))
    assert r.status == "pass"


def test_comms_fail_missing_band():
    c = Constraint(id="comms", dimension="comms", required={"protocols": ["5GHz", "UWB"]})
    r = run(c, Component(id="radio", subsystem="comms", radio_bands=["2.4GHz", "5GHz"], radio_chains=2),
               Component(id="ant", subsystem="comms", antenna_bands=["2.4GHz", "5GHz"], antenna_count=2))
    assert r.status == "fail"  # no UWB radio


def test_comms_fail_antenna_count():
    c = Constraint(id="comms", dimension="comms", required={"protocols": ["5GHz"]})
    r = run(c, Component(id="radio", subsystem="comms", radio_bands=["5GHz"], radio_chains=2),
               Component(id="ant", subsystem="comms", antenna_bands=["5GHz"], antenna_count=1))
    assert r.status == "fail"  # 1 antenna < 2 chains


# --------------------------------------------------------------------------- #
# actuation
# --------------------------------------------------------------------------- #

def test_actuation_pass():
    c = Constraint(id="actuation", dimension="actuation", required={"torque_Nm": 0.4})
    r = run(c, Component(id="motor", subsystem="actuation", torque_Nm=0.45,
                         continuous_current_A=1.5, stall_current_A=2.0),
               Component(id="drv", subsystem="actuation", driver_current_A=2.0))
    assert r.status == "pass"


def test_actuation_fail_torque():
    c = Constraint(id="actuation", dimension="actuation", required={"torque_Nm": 1.0})
    r = run(c, Component(id="motor", subsystem="actuation", torque_Nm=0.45,
                         continuous_current_A=1.5, stall_current_A=2.0),
               Component(id="drv", subsystem="actuation", driver_current_A=2.0))
    assert r.status == "fail"


def test_actuation_fail_driver():
    c = Constraint(id="actuation", dimension="actuation", required={"torque_Nm": 0.4})
    r = run(c, Component(id="motor", subsystem="actuation", torque_Nm=0.45,
                         continuous_current_A=1.5, stall_current_A=2.0),
               Component(id="drv", subsystem="actuation", driver_current_A=1.0))  # under-rated
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# connectors
# --------------------------------------------------------------------------- #

def test_connectors_pass():
    c = Constraint(id="connectors", dimension="connector", required={})
    r = run(c, Component(id="cam", subsystem="sensing", connector_mates=["MIPI-CSI-22"]),
               Component(id="soc", subsystem="compute", connector_mates=["MIPI-CSI-22"]))
    assert r.status == "pass"


def test_connectors_fail():
    c = Constraint(id="connectors", dimension="connector", required={})
    r = run(c, Component(id="radio", subsystem="comms", connector_mates=["U.FL"]))  # dangling
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# environment / IP rating
# --------------------------------------------------------------------------- #

def test_environment_pass():
    c = Constraint(id="environment", dimension="environment", required={"ip_rating": "IP67"})
    r = run(c, Component(id="enc", subsystem="mechanical", ip_rating="IP67"))
    assert r.status == "pass"


def test_environment_fail():
    c = Constraint(id="environment", dimension="environment", required={"ip_rating": "IP67"})
    r = run(c, Component(id="enc", subsystem="mechanical", ip_rating="IP54"))
    assert r.status == "fail"


# --------------------------------------------------------------------------- #
# soft checks
# --------------------------------------------------------------------------- #

def test_cost_soft():
    c = Constraint(id="cost", dimension="cost", kind="soft", required={"max_usd": 500.0})
    assert run(c, Component(id="a", subsystem="compute", cost_usd=300.0)).status == "pass"
    assert run(c, Component(id="a", subsystem="compute", cost_usd=800.0)).status == "fail"


def test_power_margin_soft():
    c = Constraint(id="power_margin", dimension="power", kind="soft",
                   required={"budget_W": 12.0, "min_slack": 0.10})
    assert run(c, Component(id="a", subsystem="compute", active_power_W=8.0)).status == "pass"
    assert run(c, Component(id="a", subsystem="compute", active_power_W=11.5)).status == "fail"


# --------------------------------------------------------------------------- #
# coverage aggregation
# --------------------------------------------------------------------------- #

def test_coverage_aggregation():
    rubric = [
        Constraint(id="power_budget", dimension="power", required={"max_W": 12.0}),
        Constraint(id="mass_budget", dimension="mass", required={"max_g": 450.0}),
        Constraint(id="cost", dimension="cost", kind="soft", required={"max_usd": 500.0}),
    ]
    bom = bom_of(Component(id="a", subsystem="compute", active_power_W=8.0, mass_g=100.0, cost_usd=300.0))
    res = verify(bom, rubric)
    assert res.coverage == 1.0          # both hard pass
    assert res.soft_score == 1.0
    assert res.all_hard_pass
