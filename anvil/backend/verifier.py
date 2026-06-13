"""The verifier -- Anvil's source of truth.

Pure deterministic functions over (BOM, Rubric). No LLM, ever. Each constraint
maps to one check that returns a Check {status, observed, required, reason}.
The proposer may *claim* a fix works; only this module decides.

Design notes that are real engineering, not hand-waving:
  * Power budget is summed active draw; peak power is checked per voltage rail
    against the regulator's current rating (P = I * V).
  * A load sits on a rail if its input voltage appears in the regulator's
    provided rails. Capacity on a rail aggregates across regulators feeding it.
  * Compute uses the single best accelerator (max TOPS / RAM), not a sum --
    you don't add two SoMs' TOPS together in a real design.
  * Connector links are matched when a mate key appears on >= 2 parts (a plug
    and its socket). A key seen once is a dangling, unmated connection.
"""

from __future__ import annotations

from .schema import Component, Constraint, SpecResult, Check, all_components

EPS = 1e-6


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _sum(comps, attr) -> float:
    return sum((getattr(c, attr) or 0.0) for c in comps)


def _with(comps, attr):
    return [c for c in comps if getattr(c, attr) is not None]


def _ip_tuple(ip: str | None):
    """'IP67' -> (6, 7). Missing/garbage -> (-1, -1) so it never satisfies."""
    if not ip or not ip.upper().startswith("IP") or len(ip) < 4:
        return (-1, -1)
    try:
        return (int(ip[2]), int(ip[3]))
    except (ValueError, IndexError):
        return (-1, -1)


def _ok(c: Constraint, status, observed, required, reason) -> Check:
    return Check(
        constraint_id=c.id, dimension=c.dimension, kind=c.kind,
        status=status, observed=observed, required=required,
        reason=reason, weight=c.weight,
    )


# --------------------------------------------------------------------------- #
# HARD checks -- these gate the loop
# --------------------------------------------------------------------------- #

def check_power_budget(comps, c):
    max_W = c.required["max_W"]
    total = round(_sum(comps, "active_power_W"), 3)
    ok = total <= max_W + EPS
    over = round(total - max_W, 3)
    reason = (f"Active draw {total} W within {max_W} W budget." if ok
              else f"Active draw {total} W exceeds {max_W} W budget by {over} W.")
    return _ok(c, "pass" if ok else "fail",
               {"sum_active_power_W": total}, {"max_W": max_W}, reason)


def check_peak_power(comps, c):
    regs = [x for x in comps if x.rails_provided and x.rail_current_A]
    loads = [x for x in comps if x.input_voltage_V and (x.peak_power_W or x.active_power_W)]
    if not regs:
        if loads:
            return _ok(c, "fail", {"regulators": 0}, c.required,
                       "No power regulator defined to source peak current.")
        return _ok(c, "pass", {"regulators": 0}, c.required, "No loads to regulate.")

    # capacity per rail voltage, aggregated across regulators feeding it
    cap: dict[float, float] = {}
    for r in regs:
        for v in r.rails_provided:
            cap[v] = cap.get(v, 0.0) + r.rail_current_A * v

    worst = None  # (ratio, V, demand, capacity)
    for v, capacity in cap.items():
        demand = sum((x.peak_power_W or x.active_power_W or 0.0)
                     for x in loads if v in (x.input_voltage_V or []))
        if demand <= 0:
            continue
        ratio = demand / capacity if capacity else float("inf")
        if worst is None or ratio > worst[0]:
            worst = (ratio, v, round(demand, 3), round(capacity, 3))

    if worst is None:
        return _ok(c, "pass", {}, c.required, "No regulated loads draw peak power.")
    ratio, v, demand, capacity = worst
    ok = demand <= capacity + EPS
    reason = (f"Worst rail {v}V: peak {demand} W within {capacity} W capacity."
              if ok else
              f"Rail {v}V overloaded: peak {demand} W exceeds {capacity} W capacity.")
    return _ok(c, "pass" if ok else "fail",
               {"rail_V": v, "peak_demand_W": demand, "rail_capacity_W": capacity},
               c.required, reason)


def check_voltage_rails(comps, c):
    available = set()
    for x in comps:
        for v in (x.rails_provided or []):
            available.add(v)
    unmet = []
    for x in comps:
        for v in (x.input_voltage_V or []):
            if v not in available:
                unmet.append({"part": x.id, "needs_V": v})
    ok = not unmet
    reason = ("Every component's input voltage is supplied by a rail."
              if ok else
              f"{len(unmet)} component input voltage(s) have no matching rail: "
              + ", ".join(f"{u['part']}@{u['needs_V']}V" for u in unmet))
    return _ok(c, "pass" if ok else "fail",
               {"rails_available": sorted(available), "unmet": unmet},
               {"all_inputs_supplied": True}, reason)


def check_endurance(comps, c):
    req_h = c.required["runtime_h"]
    batt = round(_sum(comps, "battery_Wh"), 3)
    avg = round(_sum(comps, "active_power_W"), 3)
    if avg <= 0:
        return _ok(c, "fail", {"battery_Wh": batt, "avg_power_W": avg},
                   {"runtime_h": req_h}, "No active power draw to compute runtime.")
    runtime = round(batt / avg, 3)
    ok = runtime >= req_h - EPS
    reason = (f"Runtime {runtime} h ({batt} Wh / {avg} W) meets {req_h} h." if ok
              else f"Runtime {runtime} h ({batt} Wh / {avg} W) below {req_h} h.")
    return _ok(c, "pass" if ok else "fail",
               {"battery_Wh": batt, "avg_power_W": avg, "runtime_h": runtime},
               {"runtime_h": req_h}, reason)


def check_thermal(comps, c):
    env = c.required["temp_C"]  # [min, max]
    rated = _with(comps, "temp_op_C")
    offenders = []
    for x in rated:
        lo, hi = x.temp_op_C
        if lo > env[0] + EPS or hi < env[1] - EPS:
            offenders.append({"part": x.id, "rated_C": x.temp_op_C})
    ok = not offenders
    reason = (f"All parts rated across {env[0]}..{env[1]} C." if ok
              else f"{len(offenders)} part(s) not rated for {env[0]}..{env[1]} C: "
              + ", ".join(o["part"] for o in offenders))
    return _ok(c, "pass" if ok else "fail",
               {"env_C": env, "offenders": offenders}, {"temp_C": env}, reason)


def check_mass(comps, c):
    max_g = c.required["max_g"]
    total = round(_sum(comps, "mass_g"), 2)
    ok = total <= max_g + EPS
    reason = (f"Mass {total} g within {max_g} g budget." if ok
              else f"Mass {total} g exceeds {max_g} g budget by {round(total-max_g,2)} g.")
    return _ok(c, "pass" if ok else "fail",
               {"sum_mass_g": total}, {"max_g": max_g}, reason)


def check_size(comps, c):
    enc = c.required["enclosure_mm"]  # internal [x, y, z]
    boards = [x for x in comps if x.dims_mm and x.subsystem != "mechanical"]
    enc_sorted = sorted(enc)
    oversize = []
    footprint_used = 0.0
    for x in boards:
        d = sorted(x.dims_mm)
        if any(d[i] > enc_sorted[i] + EPS for i in range(3)):
            oversize.append({"part": x.id, "dims_mm": x.dims_mm})
        footprint_used += x.dims_mm[0] * x.dims_mm[1]
    footprint_avail = enc[0] * enc[1]
    footprint_used = round(footprint_used, 1)
    fits_area = footprint_used <= footprint_avail + EPS
    ok = not oversize and fits_area
    if oversize:
        reason = "Parts too large for enclosure: " + ", ".join(o["part"] for o in oversize)
    elif not fits_area:
        reason = (f"Board footprint {footprint_used} mm^2 exceeds enclosure "
                  f"floor {footprint_avail} mm^2 (single-layer packing).")
    else:
        reason = (f"All parts fit; footprint {footprint_used}/{footprint_avail} mm^2.")
    return _ok(c, "pass" if ok else "fail",
               {"footprint_used_mm2": footprint_used,
                "footprint_avail_mm2": footprint_avail, "oversize": oversize},
               {"enclosure_mm": enc}, reason)


def check_compute(comps, c):
    req_tops = c.required["workload_TOPS"]
    req_ram = c.required.get("model_footprint_GB")
    accels = _with(comps, "compute_TOPS")
    if not accels:
        return _ok(c, "fail", {"compute_TOPS": 0}, c.required, "No compute module selected.")
    best = max(accels, key=lambda x: x.compute_TOPS)
    tops = best.compute_TOPS
    ram = max((x.ram_GB or 0) for x in accels)
    ok_tops = tops >= req_tops - EPS
    ok_ram = req_ram is None or ram >= req_ram - EPS
    ok = ok_tops and ok_ram
    if not ok_tops:
        reason = f"Best accelerator {best.id} at {tops} TOPS below {req_tops} TOPS workload."
    elif not ok_ram:
        reason = f"RAM {ram} GB below {req_ram} GB model footprint."
    else:
        reason = f"{best.id}: {tops} TOPS / {ram} GB meets {req_tops} TOPS workload."
    return _ok(c, "pass" if ok else "fail",
               {"compute_TOPS": tops, "ram_GB": ram, "accelerator": best.id},
               c.required, reason)


def check_sensing(comps, c):
    req = c.required  # {"mp":.., "fps":.., "interface":..}
    cams = _with(comps, "resolution_mp")
    if not cams:
        return _ok(c, "fail", {"cameras": 0}, req, "No camera/sensor selected.")
    iface = req.get("interface")
    good = [x for x in cams
            if x.resolution_mp >= req["mp"] - EPS
            and (x.fps or 0) >= req.get("fps", 0) - EPS
            and (iface is None or x.interface == iface)]
    lanes_needed = sum((x.csi_lanes or 0) for x in cams)
    lanes_avail = sum((x.csi_lanes or 0) for x in comps if x.subsystem == "compute")
    ok_cam = bool(good)
    ok_lanes = lanes_needed <= lanes_avail
    ok = ok_cam and ok_lanes
    if not ok_cam:
        best = max(cams, key=lambda x: x.resolution_mp)
        reason = (f"No camera meets {req['mp']}MP @ {req.get('fps',0)}fps "
                  f"{iface or ''}; best is {best.id} ({best.resolution_mp}MP@{best.fps}fps).")
    elif not ok_lanes:
        reason = f"Camera CSI lanes needed ({lanes_needed}) exceed host lanes ({lanes_avail})."
    else:
        reason = f"{good[0].id} meets {req['mp']}MP @ {req.get('fps',0)}fps."
    return _ok(c, "pass" if ok else "fail",
               {"lanes_needed": lanes_needed, "lanes_avail": lanes_avail,
                "qualifying_cameras": [x.id for x in good]}, req, reason)


def check_comms(comps, c):
    req = c.required.get("protocols", [])
    radios = _with(comps, "radio_bands")
    antennas = _with(comps, "antenna_bands")
    radio_bands = set(b for r in radios for b in r.radio_bands)
    antenna_bands = set(b for a in antennas for b in a.antenna_bands)
    missing_radio = [p for p in req if p not in radio_bands]
    missing_ant = [p for p in req if p not in antenna_bands]
    max_chains = max((r.radio_chains or 0) for r in radios) if radios else 0
    total_ant = sum((a.antenna_count or 0) for a in antennas)
    ok_chains = total_ant >= max_chains
    ok = not missing_radio and not missing_ant and ok_chains
    if missing_radio:
        reason = f"No radio provides: {', '.join(missing_radio)}."
    elif missing_ant:
        reason = f"Antenna does not cover band(s): {', '.join(missing_ant)}."
    elif not ok_chains:
        reason = f"Antenna count {total_ant} below radio chains {max_chains}."
    else:
        reason = f"Radios + antennas cover {', '.join(req)}; {total_ant} antennas >= {max_chains} chains."
    return _ok(c, "pass" if ok else "fail",
               {"radio_bands": sorted(radio_bands), "antenna_bands": sorted(antenna_bands),
                "antenna_count": total_ant, "radio_chains": max_chains}, c.required, reason)


def check_actuation(comps, c):
    req = c.required  # {"torque_Nm":.., "continuous_current_A":..}
    motors = _with(comps, "torque_Nm")
    drivers = _with(comps, "driver_current_A")
    if not motors:
        return _ok(c, "fail", {"motors": 0}, req, "No actuator selected.")
    req_t = req.get("torque_Nm", 0)
    good_motor = [m for m in motors if m.torque_Nm >= req_t - EPS]
    if not good_motor:
        best = max(motors, key=lambda m: m.torque_Nm)
        return _ok(c, "fail", {"best_torque_Nm": best.torque_Nm}, req,
                   f"Best motor {best.id} at {best.torque_Nm} N·m below {req_t} N·m.")
    m = good_motor[0]
    need_A = max(m.continuous_current_A or 0, m.stall_current_A or 0)
    ok_driver = any((d.driver_current_A or 0) >= need_A - EPS for d in drivers)
    ok = ok_driver
    reason = (f"{m.id} ({m.torque_Nm} N·m) paired with adequate driver (>= {need_A} A)."
              if ok else
              f"No driver rated for {need_A} A to drive motor {m.id}.")
    return _ok(c, "pass" if ok else "fail",
               {"motor": m.id, "motor_current_A": need_A,
                "driver_current_A": max((d.driver_current_A or 0) for d in drivers) if drivers else 0},
               req, reason)


def check_connectors(comps, c):
    counts: dict[str, int] = {}
    for x in comps:
        for k in (x.connector_mates or []):
            counts[k] = counts.get(k, 0) + 1
    unmatched = sorted(k for k, n in counts.items() if n < 2)
    ok = not unmatched
    reason = ("Every connector has a mating pair." if ok
              else f"Unmated connector(s): {', '.join(unmatched)}.")
    return _ok(c, "pass" if ok else "fail",
               {"mate_keys": counts, "unmatched": unmatched},
               {"all_mated": True}, reason)


def check_environment(comps, c):
    req_ip = c.required["ip_rating"]
    enclosures = _with(comps, "ip_rating")
    if not enclosures:
        return _ok(c, "fail", {"ip_rating": None}, c.required, "No enclosure with an IP rating.")
    best = max(enclosures, key=lambda x: _ip_tuple(x.ip_rating))
    ok = _ip_tuple(best.ip_rating) >= _ip_tuple(req_ip)
    reason = (f"Enclosure {best.id} rated {best.ip_rating} meets {req_ip}." if ok
              else f"Best enclosure {best.id} ({best.ip_rating}) below required {req_ip}.")
    return _ok(c, "pass" if ok else "fail",
               {"ip_rating": best.ip_rating}, {"ip_rating": req_ip}, reason)


# --------------------------------------------------------------------------- #
# SOFT checks -- scored for Stage-2 ranking, never gate the loop
# --------------------------------------------------------------------------- #

def check_cost(comps, c):
    target = c.required.get("max_usd")
    total = round(_sum(comps, "cost_usd"), 2)
    ok = target is None or total <= target
    reason = f"BOM cost ${total}" + (f" within ${target} target." if target else ".")
    return _ok(c, "pass" if ok else "fail",
               {"cost_usd": total}, c.required, reason)


def check_power_margin(comps, c):
    budget = c.required.get("budget_W")
    target = c.required.get("min_slack", 0.10)
    used = _sum(comps, "active_power_W")
    if not budget:
        return _ok(c, "pass", {"slack": None}, c.required, "No power budget to score margin.")
    slack = round((budget - used) / budget, 3)
    ok = slack >= target
    reason = f"Power slack {int(slack*100)}% (target {int(target*100)}%)."
    return _ok(c, "pass" if ok else "fail",
               {"slack": slack, "used_W": round(used, 2), "budget_W": budget},
               c.required, reason)


def check_lead_time(comps, c):
    target = c.required.get("max_weeks")
    worst = max((x.lead_time_weeks or 0) for x in comps) if comps else 0
    ok = target is None or worst <= target
    reason = f"Longest lead time {worst} wk" + (f" within {target} wk." if target else ".")
    return _ok(c, "pass" if ok else "fail",
               {"max_lead_weeks": worst}, c.required, reason)


# --------------------------------------------------------------------------- #
# dispatch + top-level verify
# --------------------------------------------------------------------------- #

CHECKS = {
    "power_budget": check_power_budget,
    "peak_power": check_peak_power,
    "voltage_rails": check_voltage_rails,
    "endurance": check_endurance,
    "thermal": check_thermal,
    "mass_budget": check_mass,
    "size_enclosure": check_size,
    "compute": check_compute,
    "sensing": check_sensing,
    "comms": check_comms,
    "actuation": check_actuation,
    "connectors": check_connectors,
    "environment": check_environment,
    "cost": check_cost,
    "power_margin": check_power_margin,
    "lead_time": check_lead_time,
}

# fallback: dispatch by dimension when the constraint id isn't canonical
BY_DIMENSION = {
    "power": check_power_budget,
    "mass": check_mass,
    "size": check_size,
    "thermal": check_thermal,
    "compute": check_compute,
    "sensing": check_sensing,
    "comms": check_comms,
    "actuation": check_actuation,
    "connector": check_connectors,
    "endurance": check_endurance,
    "environment": check_environment,
}


def check_one(comps: list[Component], c: Constraint) -> Check:
    fn = CHECKS.get(c.id) or BY_DIMENSION.get(c.dimension)
    if fn is None:
        return _ok(c, "fail", None, c.required, f"No verifier for constraint '{c.id}'.")
    try:
        return fn(comps, c)
    except Exception as e:  # a malformed BOM should fail the check, not crash the loop
        return _ok(c, "fail", {"error": str(e)}, c.required, f"Verifier error: {e}")


def verify(bom: dict, rubric: list[Constraint], iteration: int = 0) -> SpecResult:
    comps = all_components(bom)
    checks = [check_one(comps, c) for c in rubric]

    hard = [c for c in checks if c.kind == "hard"]
    coverage = (sum(1 for c in hard if c.status == "pass") / len(hard)) if hard else 0.0

    soft = [c for c in checks if c.kind == "soft"]
    soft_w = sum(c.weight for c in soft)
    soft_score = (sum(c.weight for c in soft if c.status == "pass") / soft_w) if soft_w else 0.0

    return SpecResult(bom=bom, checks=checks,
                      coverage=round(coverage, 4), soft_score=round(soft_score, 4),
                      iteration=iteration)
