// Proposers select and revise the BOM. They NEVER judge pass/fail -- that is the
// verifier's job alone. Faithful port of anvil/backend/proposer.py.
//
// Two implementations share one interface so the loop is agnostic:
//   * StubProposer -- deterministic, KB-only, no LLM. Used to prove the loop
//     converges and to drive the golden run / CI. It encodes a simple but honest
//     repair policy: when a constraint fails, re-select the responsible subsystem
//     toward the property that failed.
//   * LLMProposer  -- the real agent (proposer_llm.ts), model-selectable, with
//     web search. Falls back to the same KB.
//
// `buildRubric` is the deterministic Requirement -> Rubric mapping. The LLM
// parses free text into a Requirement; from there the rubric is mechanical so the
// checklist is reproducible.

import {
  type Component,
  type Constraint,
  type Requirement,
  type SpecResult,
  type Camera,
  type Actuation,
  type BOM,
  emptyBom,
  failingHard,
} from "@/lib/types";
import { loadKb as loadKbSeed } from "@/lib/kb";

// --------------------------------------------------------------------------- //
// knowledge base
// --------------------------------------------------------------------------- //

/** Load every kb/*.json into { subsystem: Component[] }. Passthrough to the
 *  bundled seed loader (which is process.cwd()-relative and best-effort). */
export function loadKb(): Record<string, Component[]> {
  return loadKbSeed();
}

// --------------------------------------------------------------------------- //
// Requirement -> Rubric (deterministic)
// --------------------------------------------------------------------------- //

export function buildRubric(req: Requirement): Constraint[] {
  const R: Constraint[] = [];
  const C = (
    id: string,
    dimension: string,
    kind: "hard" | "soft",
    predicate: string,
    required: Record<string, unknown>,
    weight = 1.0,
  ): Constraint => ({ id, dimension, kind, predicate, required, weight });

  if (req.power_budget_W != null) {
    R.push(
      C("power_budget", "power", "hard",
        `sum(active_power_W) <= ${req.power_budget_W}`,
        { max_W: req.power_budget_W }),
    );
    R.push(
      C("peak_power", "power", "hard",
        "sum(peak_power_W per rail) <= rail_current_A * rail_V", {}),
    );
    R.push(
      C("voltage_rails", "power", "hard",
        "every input voltage is supplied by a rail", {}),
    );
    R.push(
      C("connectors", "connector", "hard",
        "every connector has a mating pair", {}),
    );
    // soft
    R.push(
      C("power_margin", "power", "soft",
        "active power leaves headroom",
        { budget_W: req.power_budget_W, min_slack: 0.10 }, 1.0),
    );
  }

  if (req.runtime_h != null) {
    R.push(
      C("endurance", "endurance", "hard",
        `battery_Wh / avg_power_W >= ${req.runtime_h}`,
        { runtime_h: req.runtime_h }),
    );
  }

  if (req.workload_TOPS != null) {
    const need: Record<string, unknown> = { workload_TOPS: req.workload_TOPS };
    if (req.model_footprint_GB != null) {
      need.model_footprint_GB = req.model_footprint_GB;
    }
    R.push(
      C("compute", "compute", "hard",
        `accelerator TOPS >= ${req.workload_TOPS}`, need),
    );
  }

  if (req.camera != null) {
    R.push(
      C("sensing", "sensing", "hard",
        "camera meets resolution/fps and CSI lanes fit",
        { ...(req.camera as Camera) }),
    );
  }

  if (req.comms != null) {
    R.push(
      C("comms", "comms", "hard",
        `radios+antennas cover ${JSON.stringify(req.comms)}`,
        { protocols: [...req.comms] }),
    );
  }

  if (req.temp_C != null) {
    R.push(
      C("thermal", "thermal", "hard",
        `all parts rated across ${JSON.stringify(req.temp_C)} C`,
        { temp_C: [...req.temp_C] }),
    );
  }

  if (req.ip_rating != null) {
    R.push(
      C("environment", "environment", "hard",
        `enclosure IP >= ${req.ip_rating}`,
        { ip_rating: req.ip_rating }),
    );
  }

  if (req.mass_budget_g != null) {
    R.push(
      C("mass_budget", "mass", "hard",
        `sum(mass_g) <= ${req.mass_budget_g}`,
        { max_g: req.mass_budget_g }),
    );
  }

  if (req.enclosure_mm != null) {
    R.push(
      C("size_enclosure", "size", "hard",
        "all boards fit the enclosure",
        { enclosure_mm: [...req.enclosure_mm] }),
    );
  }

  if (req.actuation != null) {
    R.push(
      C("actuation", "actuation", "hard",
        "motor torque & driver current adequate",
        { ...(req.actuation as Actuation) }),
    );
  }

  // always-on soft ranking signals
  R.push(C("cost", "cost", "soft", "minimize BOM cost", {}, 0.5));
  R.push(C("lead_time", "lead_time", "soft", "minimize lead time", {}, 0.5));
  return R;
}

// --------------------------------------------------------------------------- //
// selection helpers
// --------------------------------------------------------------------------- //

/** Filter `parts` by `ok`, sort by `key` (ascending; descending if reverse),
 *  return the first or null. Mirrors Python's stable `sorted(...)[0]`. */
function best<T>(
  parts: T[] | undefined,
  ok: (p: T) => boolean,
  key: (p: T) => number,
  reverse = false,
): T | null {
  const cands = (parts ?? []).filter(ok);
  if (cands.length === 0) return null;
  // Stable sort (Node's Array.sort is stable), matching Python's sorted().
  const sorted = cands
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ka = key(a.p);
      const kb = key(b.p);
      if (ka < kb) return reverse ? 1 : -1;
      if (ka > kb) return reverse ? -1 : 1;
      return a.i - b.i; // stability tiebreak
    });
  return sorted[0].p;
}

function railsNeeded(parts: Component[]): Set<number> {
  const need = new Set<number>();
  for (const p of parts) {
    for (const v of p.input_voltage_V ?? []) need.add(v);
  }
  return need;
}

const BIG = 1e9;

// --------------------------------------------------------------------------- //
// Stub proposer -- deterministic, KB only
// --------------------------------------------------------------------------- //

export class StubProposer {
  name = "stub";
  kb: Record<string, Component[]>;

  constructor(kb?: Record<string, Component[]>) {
    this.kb = kb ?? loadKb();
  }

  // -- the loop interface ------------------------------------------------- //

  parse(requirement: Requirement): [Requirement, Constraint[]] {
    return [requirement, buildRubric(requirement)];
  }

  initial(
    req: Requirement,
    _rubric?: Constraint[],
    _rules = "",
  ): [BOM, string[]] {
    const bom = emptyBom();
    const notes: string[] = [];

    // compute: greedily grab the MOST capable accelerator (overshoots power on purpose)
    if (req.workload_TOPS != null) {
      const soc = this.pickCompute(req, "capability");
      if (soc) {
        bom.subsystems.compute.push(soc);
        notes.push(
          `compute: selected ${soc.name} (${soc.compute_TOPS} TOPS, ${soc.active_power_W} W)`,
        );
      }
    }

    // sensing
    if (req.camera != null) {
      const cam = this.pickCamera(req);
      if (cam) {
        bom.subsystems.sensing.push(cam);
        notes.push(`sensing: selected ${cam.name}`);
      }
    }

    // comms: radio + matching antenna
    if (req.comms != null) {
      const [radio, ant] = this.pickComms(req);
      if (radio) {
        bom.subsystems.comms.push(radio);
        notes.push(`comms: selected ${radio.name}`);
      }
      if (ant) {
        bom.subsystems.comms.push(ant);
        notes.push(`comms: selected ${ant.name}`);
      }
    }

    // power: regulator + battery (sized to current draw)
    if (req.power_budget_W != null) {
      this.selectPower(bom, req);
      for (const p of bom.subsystems.power) {
        notes.push(`power: selected ${p.name}`);
      }
    }

    // mechanical: enclosure that satisfies IP and actually fits the boards
    if (req.ip_rating != null || req.enclosure_mm != null) {
      const enc = this.pickEnclosure(req, bom);
      if (enc) {
        bom.subsystems.mechanical.push(enc);
        notes.push(`mechanical: selected ${enc.name}`);
      }
    }

    // actuation
    if (req.actuation != null) {
      this.selectActuation(bom, req);
      for (const p of bom.subsystems.actuation) {
        notes.push(`actuation: selected ${p.name}`);
      }
    }

    return [bom, notes];
  }

  /** Targeted repair: for each failing hard check, re-select the responsible
   *  subsystem toward the property that failed. Deterministic and convergent. */
  revise(
    req: Requirement,
    _rubric: Constraint[] | undefined,
    result: SpecResult,
  ): [BOM, string[]] {
    const bom = result.bom;
    const actions: string[] = [];
    const failingChecks = failingHard(result);
    const failing = new Set(failingChecks.map((c) => c.constraint_id));

    // power overruns -> swap to the lowest-power compute that still meets the workload
    if (
      (failing.has("power_budget") || failing.has("peak_power")) &&
      req.workload_TOPS != null
    ) {
      const nw = this.pickCompute(req, "efficiency");
      const old = this.first(bom, "compute");
      if (nw && (old === null || nw.id !== old.id)) {
        bom.subsystems.compute = [nw];
        const fc = failingChecks.find(
          (c) => c.constraint_id === "power_budget" || c.constraint_id === "peak_power",
        );
        const why = fc ? fc.reason : "";
        actions.push(
          `${why} Investigating compute: swapping ${old ? old.name : "∅"} ` +
            `(${old ? old.active_power_W : "?"} W) for ${nw.name} ` +
            `(${nw.active_power_W} W, ${nw.compute_TOPS} TOPS).`,
        );
      }
    }

    if (failing.has("compute")) {
      const nw = this.pickCompute(req, "capability");
      const old = this.first(bom, "compute");
      if (nw && (old === null || nw.id !== old.id)) {
        bom.subsystems.compute = [nw];
        actions.push(
          `compute underpowered → selecting ${nw.name} (${nw.compute_TOPS} TOPS).`,
        );
      }
    }

    if (failing.has("endurance")) {
      const batt = best(
        this.kb["power"],
        (p) => !!p.battery_Wh,
        (p) => p.battery_Wh as number,
        true,
      );
      if (batt) {
        bom.subsystems.power = [
          ...bom.subsystems.power.filter((p) => !p.battery_Wh),
          batt,
        ];
        actions.push(
          `runtime short → upsizing battery to ${batt.name} (${batt.battery_Wh} Wh).`,
        );
      }
    }

    if (failing.has("thermal")) {
      const env = req.temp_C as number[];
      for (const sub of Object.keys(bom.subsystems)) {
        const fixed: Component[] = [];
        for (const p of bom.subsystems[sub]) {
          if (
            p.temp_op_C &&
            (p.temp_op_C[0] > env[0] || p.temp_op_C[1] < env[1])
          ) {
            const repl = best(
              this.kb[sub],
              (q) =>
                !!q.temp_op_C &&
                q.temp_op_C[0] <= env[0] &&
                q.temp_op_C[1] >= env[1] &&
                this.sameRole(q, p, req),
              (q) => q.cost_usd ?? 0,
            );
            if (repl) {
              actions.push(
                `thermal: ${p.name} not rated for ${JSON.stringify(env)} C → ${repl.name}.`,
              );
              fixed.push(repl);
              continue;
            }
          }
          fixed.push(p);
        }
        bom.subsystems[sub] = fixed;
      }
    }

    if (failing.has("environment") || failing.has("size_enclosure")) {
      const enc = this.pickEnclosure(req, bom);
      const old = this.first(bom, "mechanical");
      if (enc && (old === null || enc.id !== old.id)) {
        bom.subsystems.mechanical = [enc];
        actions.push(`enclosure → ${enc.name} (IP/size).`);
      }
    }

    if (failing.has("mass_budget")) {
      // drop to the lightest battery that still meets endurance
      const batt = best(
        this.kb["power"],
        (p) => !!p.battery_Wh && this.runtimeOk(req, bom, p),
        (p) => p.mass_g ?? BIG,
      );
      if (batt) {
        bom.subsystems.power = [
          ...bom.subsystems.power.filter((p) => !p.battery_Wh),
          batt,
        ];
        actions.push(
          `mass over → lighter battery ${batt.name} (${batt.mass_g} g).`,
        );
      }
    }

    if (failing.has("sensing")) {
      const cam = this.pickCamera(req);
      if (cam) {
        bom.subsystems.sensing = [cam];
        actions.push(`sensing → ${cam.name}.`);
      }
    }

    if (failing.has("comms")) {
      const [radio, ant] = this.pickComms(req);
      bom.subsystems.comms = [radio, ant].filter((c): c is Component => !!c);
      actions.push("comms → radio+antenna covering required bands.");
    }

    if (failing.has("voltage_rails")) {
      this.selectPower(bom, req);
      actions.push("power: added regulator to supply missing rail(s).");
    }

    if (failing.has("connectors")) {
      const added = this.addCables(bom, result);
      for (const a of added) {
        actions.push(`connector: added ${a}.`);
      }
    }

    if (failing.has("actuation")) {
      this.selectActuation(bom, req);
      actions.push("actuation → motor+driver with adequate torque/current.");
    }

    if (actions.length === 0) {
      actions.push("No deterministic repair available for the failing constraints.");
    }
    return [bom, actions];
  }

  // -- selection internals ----------------------------------------------- //

  private first(bom: BOM, sub: string): Component | null {
    const parts = bom.subsystems[sub] ?? [];
    return parts.length > 0 ? parts[0] : null;
  }

  private pickCompute(
    req: Requirement,
    prefer: "capability" | "efficiency" = "capability",
  ): Component | null {
    const workload = req.workload_TOPS as number;
    const ok = (p: Component): boolean => {
      if (p.compute_TOPS == null || p.compute_TOPS < workload) return false;
      if (req.model_footprint_GB && (p.ram_GB ?? 0) < req.model_footprint_GB) {
        return false;
      }
      return true;
    };
    if (prefer === "efficiency") {
      return best(this.kb["compute"], ok, (p) => p.active_power_W ?? BIG);
    }
    // capability: most TOPS first
    return best(this.kb["compute"], ok, (p) => p.compute_TOPS as number, true);
  }

  private pickCamera(req: Requirement): Component | null {
    const cam = req.camera as Camera;
    const ok = (p: Component): boolean =>
      !!p.resolution_mp &&
      p.resolution_mp >= (cam.mp as number) &&
      (p.fps ?? 0) >= (cam.fps ?? 0) &&
      (cam.interface == null || p.interface === cam.interface);
    return best(this.kb["sensing"], ok, (p) => p.cost_usd ?? BIG);
  }

  private pickComms(req: Requirement): [Component | null, Component | null] {
    const protos = new Set(req.comms as string[]);
    const isSubset = (sup: string[] | null | undefined): boolean => {
      if (!sup) return false;
      const s = new Set(sup);
      for (const x of protos) if (!s.has(x)) return false;
      return true;
    };
    const radio = best(
      this.kb["comms"],
      (p) => !!p.radio_bands && isSubset(p.radio_bands),
      (p) => p.cost_usd ?? BIG,
    );
    let ant: Component | null = null;
    if (radio) {
      ant = best(
        this.kb["comms"],
        (p) =>
          !!p.antenna_bands &&
          isSubset(p.antenna_bands) &&
          (p.antenna_count ?? 0) >= (radio.radio_chains ?? 0),
        (p) => p.cost_usd ?? BIG,
      );
    }
    return [radio, ant];
  }

  private selectPower(bom: BOM, req: Requirement): void {
    const loads: Component[] = [];
    for (const parts of Object.values(bom.subsystems)) {
      for (const p of parts) loads.push(p);
    }
    let rails = railsNeeded(loads);
    if (rails.size === 0) rails = new Set([5.0, 3.3]);
    const railsSubset = (provided: number[] | null | undefined): boolean => {
      if (!provided) return false;
      const s = new Set(provided);
      for (const r of rails) if (!s.has(r)) return false;
      return true;
    };
    const pmic = best(
      this.kb["power"],
      (p) => !!p.rails_provided && railsSubset(p.rails_provided),
      (p) => -(p.rail_current_A ?? 0),
    );
    let batt = best(
      this.kb["power"],
      (p) =>
        !!p.battery_Wh &&
        (req.runtime_h == null || this.runtimeOk(req, bom, p)),
      (p) => p.battery_Wh ?? BIG, // smallest that meets runtime
    );
    if (batt === null) {
      // nothing meets runtime -> take the biggest
      batt = best(
        this.kb["power"],
        (p) => !!p.battery_Wh,
        (p) => p.battery_Wh ?? 0,
        true,
      );
    }
    const chosen = [pmic, batt].filter((c): c is Component => !!c);
    // keep any non-power-rail parts already there, replace power list
    bom.subsystems.power = chosen;
  }

  private runtimeOk(req: Requirement, bom: BOM, batt: Component): boolean {
    let avg = 0;
    for (const parts of Object.values(bom.subsystems)) {
      for (const p of parts) avg += p.active_power_W ?? 0;
    }
    if (avg <= 0) return true;
    return (batt.battery_Wh as number) / avg >= (req.runtime_h as number);
  }

  private pickEnclosure(req: Requirement, bom: BOM): Component | null {
    const boards: Component[] = [];
    for (const [sub, parts] of Object.entries(bom.subsystems)) {
      if (sub === "mechanical") continue;
      for (const p of parts) if (p.dims_mm) boards.push(p);
    }
    let footprint = 0;
    for (const p of boards) {
      const d = p.dims_mm as number[];
      footprint += d[0] * d[1];
    }

    const fits = (enc: Component): boolean => {
      if (!enc.dims_mm) return false;
      if (req.ip_rating && ipTuple(enc.ip_rating) < ipTuple(req.ip_rating)) {
        return false;
      }
      const es = [...enc.dims_mm].sort((a, b) => a - b);
      for (const b of boards) {
        const bs = [...(b.dims_mm as number[])].sort((a, b) => a - b);
        for (let i = 0; i < 3; i++) {
          if (bs[i] > es[i]) return false;
        }
      }
      return enc.dims_mm[0] * enc.dims_mm[1] >= footprint;
    };
    return best(this.kb["mechanical"], fits, (p) => p.cost_usd ?? BIG);
  }

  private selectActuation(bom: BOM, req: Requirement): void {
    const act = req.actuation as Actuation;
    const reqT = act.torque_Nm ?? 0;
    const motor = best(
      this.kb["actuation"],
      (p) => p.torque_Nm != null && p.torque_Nm >= reqT,
      (p) => p.cost_usd ?? BIG,
    );
    let driver: Component | null = null;
    if (motor) {
      const need = Math.max(
        motor.continuous_current_A ?? 0,
        motor.stall_current_A ?? 0,
      );
      driver = best(
        this.kb["actuation"],
        (p) => (p.driver_current_A ?? 0) >= need,
        (p) => p.cost_usd ?? BIG,
      );
    }
    bom.subsystems.actuation = [motor, driver].filter(
      (c): c is Component => !!c,
    );
  }

  private addCables(bom: BOM, result: SpecResult): string[] {
    const chk = result.checks.find((c) => c.constraint_id === "connectors");
    if (!chk) return [];
    const added: string[] = [];
    const observed = chk.observed as { unmatched?: string[] } | undefined;
    for (const key of observed?.unmatched ?? []) {
      const cable = best(
        this.kb["connector"],
        (p) => !!p.connector_mates && p.connector_mates.includes(key),
        (p) => p.cost_usd ?? BIG,
      );
      if (cable) {
        bom.subsystems.connector.push(cable);
        added.push(cable.name ?? cable.id);
      }
    }
    return added;
  }

  private sameRole(a: Component, b: Component, _req: Requirement): boolean {
    return a.subsystem === b.subsystem;
  }
}

// --------------------------------------------------------------------------- //
// IP rating comparison
// --------------------------------------------------------------------------- //

/** Compare IP ratings as a (solids, liquids) tuple. Returns a single comparable
 *  number so `<` works like Python's tuple comparison. */
function ipTuple(ip: string | null | undefined): number {
  if (!ip || !ip.toUpperCase().startsWith("IP") || ip.length < 4) {
    return -1 * 100 + -1; // (-1, -1)
  }
  const d0 = Number.parseInt(ip[2], 10);
  const d1 = Number.parseInt(ip[3], 10);
  if (Number.isNaN(d0) || Number.isNaN(d1)) {
    return -1 * 100 + -1;
  }
  return d0 * 100 + d1;
}
