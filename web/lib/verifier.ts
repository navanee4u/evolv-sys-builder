// The verifier — Anvil's source of truth. Faithful TypeScript port of
// anvil/backend/verifier.py.
//
// Pure deterministic functions over (BOM, Rubric). No LLM, ever. Each constraint
// maps to one check that returns a Check {status, observed, required, reason}.
// The proposer may *claim* a fix works; only this module decides.
//
// Design notes that are real engineering, not hand-waving:
//   * Power budget is summed active draw; peak power is checked per voltage rail
//     against the regulator's current rating (P = I * V).
//   * A load sits on a rail if its input voltage appears in the regulator's
//     provided rails. Capacity on a rail aggregates across regulators feeding it.
//   * Compute uses the single best accelerator (max TOPS / RAM), not a sum --
//     you don't add two SoMs' TOPS together in a real design.
//   * Connector links are matched when a mate key appears on >= 2 parts (a plug
//     and its socket). A key seen once is a dangling, unmated connection.

import { Component, Constraint, Check, SpecResult, BOM, allComponents } from "@/lib/types";

const EPS = 1e-6;

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //

// Python's round() uses banker's rounding (round-half-to-even). Replicate it so
// the observed numbers match the Python verifier exactly.
function pyRound(value: number, ndigits = 0): number {
  if (!Number.isFinite(value)) return value;
  const m = Math.pow(10, ndigits);
  const x = value * m;
  const floor = Math.floor(x);
  const diff = x - floor;
  let rounded: number;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff < 0.5) {
    rounded = floor;
  } else {
    // exactly halfway -> round to even
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded / m;
}

// `getattr(c, attr) or 0.0` — null/undefined/0/NaN all coerce to 0.
function numAttr(c: Component, attr: keyof Component): number {
  const v = c[attr];
  return typeof v === "number" && !Number.isNaN(v) && v !== 0 ? v : 0.0;
}

function sumAttr(comps: Component[], attr: keyof Component): number {
  let total = 0.0;
  for (const c of comps) total += numAttr(c, attr);
  return total;
}

// [c for c in comps if getattr(c, attr) is not None]
function withAttr(comps: Component[], attr: keyof Component): Component[] {
  return comps.filter((c) => c[attr] !== null && c[attr] !== undefined);
}

// 'IP67' -> [6, 7]. Missing/garbage -> [-1, -1] so it never satisfies.
function ipTuple(ip: string | null | undefined): [number, number] {
  if (!ip || !ip.toUpperCase().startsWith("IP") || ip.length < 4) {
    return [-1, -1];
  }
  const a = parseInt(ip[2], 10);
  const b = parseInt(ip[3], 10);
  if (Number.isNaN(a) || Number.isNaN(b)) return [-1, -1];
  return [a, b];
}

// Lexicographic tuple comparison: a >= b  (matches Python tuple >=).
function tupleGte(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] >= b[1];
}
function tupleGt(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] > b[1];
}

function ok(
  c: Constraint,
  status: "pass" | "fail",
  observed: unknown,
  required: unknown,
  reason: string,
): Check {
  return {
    constraint_id: c.id,
    dimension: c.dimension,
    kind: c.kind,
    status,
    observed,
    required,
    reason,
    weight: c.weight,
  };
}

// Sorted ascending copy of a numeric array (matches Python sorted()).
function sortedNums(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

// req helpers — mirror Python's c.required["x"] (throws if missing) and .get(x, d).
function reqNum(c: Constraint, key: string): number {
  return c.required[key] as number;
}
function reqGet<T>(c: Constraint, key: string, dflt: T): T {
  const v = c.required[key];
  return v === undefined ? dflt : (v as T);
}

// --------------------------------------------------------------------------- //
// HARD checks -- these gate the loop
// --------------------------------------------------------------------------- //

function checkPowerBudget(comps: Component[], c: Constraint): Check {
  const maxW = reqNum(c, "max_W");
  const total = pyRound(sumAttr(comps, "active_power_W"), 3);
  const isOk = total <= maxW + EPS;
  const over = pyRound(total - maxW, 3);
  const reason = isOk
    ? `Active draw ${total} W within ${maxW} W budget.`
    : `Active draw ${total} W exceeds ${maxW} W budget by ${over} W.`;
  return ok(c, isOk ? "pass" : "fail", { sum_active_power_W: total }, { max_W: maxW }, reason);
}

function checkPeakPower(comps: Component[], c: Constraint): Check {
  const regs = comps.filter(
    (x) =>
      x.rails_provided !== null &&
      x.rails_provided !== undefined &&
      x.rails_provided.length > 0 &&
      !!x.rail_current_A,
  );
  const loads = comps.filter(
    (x) =>
      x.input_voltage_V !== null &&
      x.input_voltage_V !== undefined &&
      x.input_voltage_V.length > 0 &&
      (!!x.peak_power_W || !!x.active_power_W),
  );
  if (regs.length === 0) {
    if (loads.length > 0) {
      return ok(c, "fail", { regulators: 0 }, c.required, "No power regulator defined to source peak current.");
    }
    return ok(c, "pass", { regulators: 0 }, c.required, "No loads to regulate.");
  }

  // capacity per rail voltage, aggregated across regulators feeding it
  const cap = new Map<number, number>();
  for (const r of regs) {
    for (const v of r.rails_provided!) {
      cap.set(v, (cap.get(v) ?? 0.0) + (r.rail_current_A as number) * v);
    }
  }

  let worst: { ratio: number; v: number; demand: number; capacity: number } | null = null;
  for (const [v, capacity] of cap.entries()) {
    let demand = 0.0;
    for (const x of loads) {
      if ((x.input_voltage_V ?? []).includes(v)) {
        demand += x.peak_power_W ?? x.active_power_W ?? 0.0;
      }
    }
    if (demand <= 0) continue;
    const ratio = capacity ? demand / capacity : Infinity;
    if (worst === null || ratio > worst.ratio) {
      worst = { ratio, v, demand: pyRound(demand, 3), capacity: pyRound(capacity, 3) };
    }
  }

  if (worst === null) {
    return ok(c, "pass", {}, c.required, "No regulated loads draw peak power.");
  }
  const isOk = worst.demand <= worst.capacity + EPS;
  const reason = isOk
    ? `Worst rail ${worst.v}V: peak ${worst.demand} W within ${worst.capacity} W capacity.`
    : `Rail ${worst.v}V overloaded: peak ${worst.demand} W exceeds ${worst.capacity} W capacity.`;
  return ok(
    c,
    isOk ? "pass" : "fail",
    { rail_V: worst.v, peak_demand_W: worst.demand, rail_capacity_W: worst.capacity },
    c.required,
    reason,
  );
}

function checkVoltageRails(comps: Component[], c: Constraint): Check {
  const available = new Set<number>();
  for (const x of comps) {
    for (const v of x.rails_provided ?? []) available.add(v);
  }
  const unmet: { part: string; needs_V: number }[] = [];
  for (const x of comps) {
    for (const v of x.input_voltage_V ?? []) {
      if (!available.has(v)) unmet.push({ part: x.id, needs_V: v });
    }
  }
  const isOk = unmet.length === 0;
  const reason = isOk
    ? "Every component's input voltage is supplied by a rail."
    : `${unmet.length} component input voltage(s) have no matching rail: ` +
      unmet.map((u) => `${u.part}@${u.needs_V}V`).join(", ");
  return ok(
    c,
    isOk ? "pass" : "fail",
    { rails_available: sortedNums([...available]), unmet },
    { all_inputs_supplied: true },
    reason,
  );
}

function checkEndurance(comps: Component[], c: Constraint): Check {
  const reqH = reqNum(c, "runtime_h");
  const batt = pyRound(sumAttr(comps, "battery_Wh"), 3);
  const avg = pyRound(sumAttr(comps, "active_power_W"), 3);
  if (avg <= 0) {
    return ok(c, "fail", { battery_Wh: batt, avg_power_W: avg }, { runtime_h: reqH }, "No active power draw to compute runtime.");
  }
  const runtime = pyRound(batt / avg, 3);
  const isOk = runtime >= reqH - EPS;
  const reason = isOk
    ? `Runtime ${runtime} h (${batt} Wh / ${avg} W) meets ${reqH} h.`
    : `Runtime ${runtime} h (${batt} Wh / ${avg} W) below ${reqH} h.`;
  return ok(
    c,
    isOk ? "pass" : "fail",
    { battery_Wh: batt, avg_power_W: avg, runtime_h: runtime },
    { runtime_h: reqH },
    reason,
  );
}

function checkThermal(comps: Component[], c: Constraint): Check {
  const env = c.required["temp_C"] as number[]; // [min, max]
  const rated = withAttr(comps, "temp_op_C");
  const offenders: { part: string; rated_C: number[] }[] = [];
  for (const x of rated) {
    const [lo, hi] = x.temp_op_C as number[];
    if (lo > env[0] + EPS || hi < env[1] - EPS) {
      offenders.push({ part: x.id, rated_C: x.temp_op_C as number[] });
    }
  }
  const isOk = offenders.length === 0;
  const reason = isOk
    ? `All parts rated across ${env[0]}..${env[1]} C.`
    : `${offenders.length} part(s) not rated for ${env[0]}..${env[1]} C: ` + offenders.map((o) => o.part).join(", ");
  return ok(c, isOk ? "pass" : "fail", { env_C: env, offenders }, { temp_C: env }, reason);
}

function checkMass(comps: Component[], c: Constraint): Check {
  const maxG = reqNum(c, "max_g");
  const total = pyRound(sumAttr(comps, "mass_g"), 2);
  const isOk = total <= maxG + EPS;
  const reason = isOk
    ? `Mass ${total} g within ${maxG} g budget.`
    : `Mass ${total} g exceeds ${maxG} g budget by ${pyRound(total - maxG, 2)} g.`;
  return ok(c, isOk ? "pass" : "fail", { sum_mass_g: total }, { max_g: maxG }, reason);
}

function checkSize(comps: Component[], c: Constraint): Check {
  const enc = c.required["enclosure_mm"] as number[]; // internal [x, y, z]
  const boards = comps.filter((x) => x.dims_mm && x.dims_mm.length > 0 && x.subsystem !== "mechanical");
  const encSorted = sortedNums(enc);
  const oversize: { part: string; dims_mm: number[] }[] = [];
  let footprintUsed = 0.0;
  for (const x of boards) {
    const dims = x.dims_mm as number[];
    const d = sortedNums(dims);
    if ([0, 1, 2].some((i) => d[i] > encSorted[i] + EPS)) {
      oversize.push({ part: x.id, dims_mm: dims });
    }
    footprintUsed += dims[0] * dims[1];
  }
  const footprintAvail = enc[0] * enc[1];
  footprintUsed = pyRound(footprintUsed, 1);
  const fitsArea = footprintUsed <= footprintAvail + EPS;
  const isOk = oversize.length === 0 && fitsArea;
  let reason: string;
  if (oversize.length > 0) {
    reason = "Parts too large for enclosure: " + oversize.map((o) => o.part).join(", ");
  } else if (!fitsArea) {
    reason = `Board footprint ${footprintUsed} mm^2 exceeds enclosure floor ${footprintAvail} mm^2 (single-layer packing).`;
  } else {
    reason = `All parts fit; footprint ${footprintUsed}/${footprintAvail} mm^2.`;
  }
  return ok(
    c,
    isOk ? "pass" : "fail",
    { footprint_used_mm2: footprintUsed, footprint_avail_mm2: footprintAvail, oversize },
    { enclosure_mm: enc },
    reason,
  );
}

function checkCompute(comps: Component[], c: Constraint): Check {
  const reqTops = reqNum(c, "workload_TOPS");
  const reqRam = reqGet<number | undefined>(c, "model_footprint_GB", undefined);
  const accels = withAttr(comps, "compute_TOPS");
  if (accels.length === 0) {
    return ok(c, "fail", { compute_TOPS: 0 }, c.required, "No compute module selected.");
  }
  // max by compute_TOPS — first max wins on ties (matches Python max())
  let best = accels[0];
  for (const x of accels) {
    if ((x.compute_TOPS as number) > (best.compute_TOPS as number)) best = x;
  }
  const tops = best.compute_TOPS as number;
  let ram = 0;
  for (const x of accels) ram = Math.max(ram, x.ram_GB ?? 0);
  const okTops = tops >= reqTops - EPS;
  const okRam = reqRam === undefined || reqRam === null || ram >= reqRam - EPS;
  const isOk = okTops && okRam;
  let reason: string;
  if (!okTops) {
    reason = `Best accelerator ${best.id} at ${tops} TOPS below ${reqTops} TOPS workload.`;
  } else if (!okRam) {
    reason = `RAM ${ram} GB below ${reqRam} GB model footprint.`;
  } else {
    reason = `${best.id}: ${tops} TOPS / ${ram} GB meets ${reqTops} TOPS workload.`;
  }
  return ok(c, isOk ? "pass" : "fail", { compute_TOPS: tops, ram_GB: ram, accelerator: best.id }, c.required, reason);
}

function checkSensing(comps: Component[], c: Constraint): Check {
  const req = c.required; // {"mp":.., "fps":.., "interface":..}
  const cams = withAttr(comps, "resolution_mp");
  if (cams.length === 0) {
    return ok(c, "fail", { cameras: 0 }, req, "No camera/sensor selected.");
  }
  const iface = reqGet<string | undefined | null>(c, "interface", undefined);
  const reqMp = req["mp"] as number;
  const reqFps = reqGet<number>(c, "fps", 0);
  const good = cams.filter(
    (x) =>
      (x.resolution_mp as number) >= reqMp - EPS &&
      (x.fps ?? 0) >= reqFps - EPS &&
      (iface === undefined || iface === null || x.interface === iface),
  );
  let lanesNeeded = 0;
  for (const x of cams) lanesNeeded += x.csi_lanes ?? 0;
  let lanesAvail = 0;
  for (const x of comps) if (x.subsystem === "compute") lanesAvail += x.csi_lanes ?? 0;
  const okCam = good.length > 0;
  const okLanes = lanesNeeded <= lanesAvail;
  const isOk = okCam && okLanes;
  let reason: string;
  if (!okCam) {
    let best = cams[0];
    for (const x of cams) if ((x.resolution_mp as number) > (best.resolution_mp as number)) best = x;
    reason = `No camera meets ${reqMp}MP @ ${reqFps}fps ${iface ?? ""}; best is ${best.id} (${best.resolution_mp}MP@${best.fps}fps).`;
  } else if (!okLanes) {
    reason = `Camera CSI lanes needed (${lanesNeeded}) exceed host lanes (${lanesAvail}).`;
  } else {
    reason = `${good[0].id} meets ${reqMp}MP @ ${reqFps}fps.`;
  }
  return ok(
    c,
    isOk ? "pass" : "fail",
    { lanes_needed: lanesNeeded, lanes_avail: lanesAvail, qualifying_cameras: good.map((x) => x.id) },
    req,
    reason,
  );
}

function checkComms(comps: Component[], c: Constraint): Check {
  const req = reqGet<string[]>(c, "protocols", []);
  const radios = withAttr(comps, "radio_bands");
  const antennas = withAttr(comps, "antenna_bands");
  const radioBands = new Set<string>();
  for (const r of radios) for (const b of r.radio_bands ?? []) radioBands.add(b);
  const antennaBands = new Set<string>();
  for (const a of antennas) for (const b of a.antenna_bands ?? []) antennaBands.add(b);
  const missingRadio = req.filter((p) => !radioBands.has(p));
  const missingAnt = req.filter((p) => !antennaBands.has(p));
  let maxChains = 0;
  if (radios.length > 0) {
    for (const r of radios) maxChains = Math.max(maxChains, r.radio_chains ?? 0);
  }
  let totalAnt = 0;
  for (const a of antennas) totalAnt += a.antenna_count ?? 0;
  const okChains = totalAnt >= maxChains;
  const isOk = missingRadio.length === 0 && missingAnt.length === 0 && okChains;
  let reason: string;
  if (missingRadio.length > 0) {
    reason = `No radio provides: ${missingRadio.join(", ")}.`;
  } else if (missingAnt.length > 0) {
    reason = `Antenna does not cover band(s): ${missingAnt.join(", ")}.`;
  } else if (!okChains) {
    reason = `Antenna count ${totalAnt} below radio chains ${maxChains}.`;
  } else {
    reason = `Radios + antennas cover ${req.join(", ")}; ${totalAnt} antennas >= ${maxChains} chains.`;
  }
  return ok(
    c,
    isOk ? "pass" : "fail",
    {
      radio_bands: [...radioBands].sort(),
      antenna_bands: [...antennaBands].sort(),
      antenna_count: totalAnt,
      radio_chains: maxChains,
    },
    c.required,
    reason,
  );
}

function checkActuation(comps: Component[], c: Constraint): Check {
  const req = c.required; // {"torque_Nm":.., "continuous_current_A":..}
  const motors = withAttr(comps, "torque_Nm");
  const drivers = withAttr(comps, "driver_current_A");
  if (motors.length === 0) {
    return ok(c, "fail", { motors: 0 }, req, "No actuator selected.");
  }
  const reqT = reqGet<number>(c, "torque_Nm", 0);
  const goodMotor = motors.filter((m) => (m.torque_Nm as number) >= reqT - EPS);
  if (goodMotor.length === 0) {
    let best = motors[0];
    for (const m of motors) if ((m.torque_Nm as number) > (best.torque_Nm as number)) best = m;
    return ok(c, "fail", { best_torque_Nm: best.torque_Nm }, req, `Best motor ${best.id} at ${best.torque_Nm} N·m below ${reqT} N·m.`);
  }
  const m = goodMotor[0];
  const needA = Math.max(m.continuous_current_A ?? 0, m.stall_current_A ?? 0);
  const okDriver = drivers.some((d) => (d.driver_current_A ?? 0) >= needA - EPS);
  const isOk = okDriver;
  const reason = isOk
    ? `${m.id} (${m.torque_Nm} N·m) paired with adequate driver (>= ${needA} A).`
    : `No driver rated for ${needA} A to drive motor ${m.id}.`;
  let maxDriver = 0;
  if (drivers.length > 0) {
    for (const d of drivers) maxDriver = Math.max(maxDriver, d.driver_current_A ?? 0);
  }
  return ok(
    c,
    isOk ? "pass" : "fail",
    { motor: m.id, motor_current_A: needA, driver_current_A: maxDriver },
    req,
    reason,
  );
}

function checkConnectors(comps: Component[], c: Constraint): Check {
  const counts = new Map<string, number>();
  for (const x of comps) {
    for (const k of x.connector_mates ?? []) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const unmatched = [...counts.entries()]
    .filter(([, n]) => n < 2)
    .map(([k]) => k)
    .sort();
  const isOk = unmatched.length === 0;
  const reason = isOk ? "Every connector has a mating pair." : `Unmated connector(s): ${unmatched.join(", ")}.`;
  // counts -> plain object (mirrors Python dict in JSON)
  const mateKeys: Record<string, number> = {};
  for (const [k, n] of counts.entries()) mateKeys[k] = n;
  return ok(c, isOk ? "pass" : "fail", { mate_keys: mateKeys, unmatched }, { all_mated: true }, reason);
}

function checkEnvironment(comps: Component[], c: Constraint): Check {
  const reqIp = c.required["ip_rating"] as string;
  const enclosures = withAttr(comps, "ip_rating");
  if (enclosures.length === 0) {
    return ok(c, "fail", { ip_rating: null }, c.required, "No enclosure with an IP rating.");
  }
  // max by ip tuple — first max wins on ties (matches Python max())
  let best = enclosures[0];
  for (const x of enclosures) {
    if (tupleGt(ipTuple(x.ip_rating), ipTuple(best.ip_rating))) best = x;
  }
  const isOk = tupleGte(ipTuple(best.ip_rating), ipTuple(reqIp));
  const reason = isOk
    ? `Enclosure ${best.id} rated ${best.ip_rating} meets ${reqIp}.`
    : `Best enclosure ${best.id} (${best.ip_rating}) below required ${reqIp}.`;
  return ok(c, isOk ? "pass" : "fail", { ip_rating: best.ip_rating }, { ip_rating: reqIp }, reason);
}

// --------------------------------------------------------------------------- //
// SOFT checks -- scored for Stage-2 ranking, never gate the loop
// --------------------------------------------------------------------------- //

function checkCost(comps: Component[], c: Constraint): Check {
  const target = reqGet<number | undefined>(c, "max_usd", undefined);
  const total = pyRound(sumAttr(comps, "cost_usd"), 2);
  const isOk = target === undefined || target === null || total <= target;
  const reason = `BOM cost $${total}` + (target !== undefined && target !== null ? ` within $${target} target.` : ".");
  return ok(c, isOk ? "pass" : "fail", { cost_usd: total }, c.required, reason);
}

function checkPowerMargin(comps: Component[], c: Constraint): Check {
  const budget = reqGet<number | undefined>(c, "budget_W", undefined);
  const target = reqGet<number>(c, "min_slack", 0.1);
  const used = sumAttr(comps, "active_power_W");
  if (!budget) {
    return ok(c, "pass", { slack: null }, c.required, "No power budget to score margin.");
  }
  const slack = pyRound((budget - used) / budget, 3);
  const isOk = slack >= target;
  const reason = `Power slack ${Math.trunc(slack * 100)}% (target ${Math.trunc(target * 100)}%).`;
  return ok(c, isOk ? "pass" : "fail", { slack, used_W: pyRound(used, 2), budget_W: budget }, c.required, reason);
}

function checkLeadTime(comps: Component[], c: Constraint): Check {
  const target = reqGet<number | undefined>(c, "max_weeks", undefined);
  let worst = 0;
  if (comps.length > 0) {
    for (const x of comps) worst = Math.max(worst, x.lead_time_weeks ?? 0);
  }
  const isOk = target === undefined || target === null || worst <= target;
  const reason = `Longest lead time ${worst} wk` + (target !== undefined && target !== null ? ` within ${target} wk.` : ".");
  return ok(c, isOk ? "pass" : "fail", { max_lead_weeks: worst }, c.required, reason);
}

// --------------------------------------------------------------------------- //
// dispatch + top-level verify
// --------------------------------------------------------------------------- //

type CheckFn = (comps: Component[], c: Constraint) => Check;

const CHECKS: Record<string, CheckFn> = {
  power_budget: checkPowerBudget,
  peak_power: checkPeakPower,
  voltage_rails: checkVoltageRails,
  endurance: checkEndurance,
  thermal: checkThermal,
  mass_budget: checkMass,
  size_enclosure: checkSize,
  compute: checkCompute,
  sensing: checkSensing,
  comms: checkComms,
  actuation: checkActuation,
  connectors: checkConnectors,
  environment: checkEnvironment,
  cost: checkCost,
  power_margin: checkPowerMargin,
  lead_time: checkLeadTime,
};

// fallback: dispatch by dimension when the constraint id isn't canonical
const BY_DIMENSION: Record<string, CheckFn> = {
  power: checkPowerBudget,
  mass: checkMass,
  size: checkSize,
  thermal: checkThermal,
  compute: checkCompute,
  sensing: checkSensing,
  comms: checkComms,
  actuation: checkActuation,
  connector: checkConnectors,
  endurance: checkEndurance,
  environment: checkEnvironment,
};

export function checkOne(comps: Component[], c: Constraint): Check {
  const fn = CHECKS[c.id] ?? BY_DIMENSION[c.dimension];
  if (fn === undefined) {
    return ok(c, "fail", null, c.required, `No verifier for constraint '${c.id}'.`);
  }
  try {
    return fn(comps, c);
  } catch (e) {
    // a malformed BOM should fail the check, not crash the loop
    const msg = e instanceof Error ? e.message : String(e);
    return ok(c, "fail", { error: msg }, c.required, `Verifier error: ${msg}`);
  }
}

export function verify(bom: BOM, rubric: Constraint[], iteration = 0): SpecResult {
  const comps = allComponents(bom);
  const checks = rubric.map((c) => checkOne(comps, c));

  const hard = checks.filter((c) => c.kind === "hard");
  const coverage = hard.length > 0 ? hard.filter((c) => c.status === "pass").length / hard.length : 0.0;

  const soft = checks.filter((c) => c.kind === "soft");
  let softW = 0;
  for (const c of soft) softW += c.weight;
  let softPassW = 0;
  for (const c of soft) if (c.status === "pass") softPassW += c.weight;
  const softScore = softW ? softPassW / softW : 0.0;

  return {
    bom,
    checks,
    coverage: pyRound(coverage, 4),
    soft_score: pyRound(softScore, 4),
    iteration,
  };
}
