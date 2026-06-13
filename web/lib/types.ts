// Anvil data contracts — faithful TypeScript port of anvil/backend/schema.py.
//
// These are the single source of structure shared by the proposer, the verifier,
// the loop and the API routes. Every type here round-trips through JSON because
// the frontend renders these objects directly off the SSE stream.
//
// Field names are IDENTICAL to the Python (snake_case preserved). Components carry
// many optional fields (a motor has torque but no TOPS; a SoM has TOPS but no
// torque); the verifier reads only the fields a given constraint needs, and
// missing data is an honest `null`/`undefined`.

// --------------------------------------------------------------------------- //
// Requirement -> Rubric
// --------------------------------------------------------------------------- //

/** One row of the rubric. `required` holds the machine-checkable numbers;
 *  `predicate` is a human-readable echo of the same thing for the UI. */
export interface Constraint {
  id: string;
  dimension: string; // power|mass|size|thermal|compute|sensing|comms|actuation|connector|endurance|environment
  kind: "hard" | "soft"; // "hard" gates the loop; "soft" is scored for ranking
  predicate: string;
  required: Record<string, unknown>;
  weight: number; // soft only
}

export interface Camera {
  mp?: number;
  fps?: number;
  interface?: string;
}

export interface Actuation {
  torque_Nm?: number;
  continuous_current_A?: number;
  count?: number;
}

/** The user's structured intent. The proposer parses free text into this (and
 *  into a Rubric); the deterministic stub proposer + golden run build it
 *  directly. Every field is optional so partial requirement sets still run. */
export interface Requirement {
  name?: string;
  power_budget_W?: number | null;
  runtime_h?: number | null;
  workload_TOPS?: number | null;
  model_footprint_GB?: number | null;
  temp_C?: number[] | null; // [min, max] operating environment
  ip_rating?: string | null;
  mass_budget_g?: number | null;
  enclosure_mm?: number[] | null; // [x, y, z] internal volume
  camera?: Camera | null; // {"mp": 8.3, "fps": 30, "interface": "MIPI-CSI"}
  comms?: string[] | null; // required protocols/bands, e.g. ["5GHz", "UWB"]
  actuation?: Actuation | null; // {"torque_Nm": 0.4, "continuous_current_A": 2.0, "count": 4}
  rail_voltages_V?: number[] | null; // voltages the design must supply (informational)
  notes?: string;
}

// --------------------------------------------------------------------------- //
// Components and BOM
// --------------------------------------------------------------------------- //

export interface Component {
  id: string;
  subsystem: string; // compute|power|sensing|comms|actuation|mechanical|connector
  name?: string;
  vendor?: string;
  part_number?: string;
  source?: "kb" | "web"; // provenance, shown in UI

  // power
  active_power_W?: number | null;
  peak_power_W?: number | null;
  input_voltage_V?: number[] | null; // voltages this part consumes
  rails_provided?: number[] | null; // voltages a PMIC/regulator supplies
  rail_current_A?: number | null; // per-rail current the regulator can source
  battery_Wh?: number | null; // batteries declare capacity here

  // physical
  mass_g?: number | null;
  dims_mm?: number[] | null; // [x, y, z]
  temp_op_C?: number[] | null; // [min, max]
  ip_rating?: string | null;

  // compute
  compute_TOPS?: number | null;
  ram_GB?: number | null;
  csi_lanes?: number | null; // MIPI-CSI camera ports available

  // sensing
  resolution_mp?: number | null;
  fps?: number | null;
  interface?: string | null; // e.g. "MIPI-CSI"

  // comms
  radio_bands?: string[] | null;
  radio_chains?: number | null;
  antenna_bands?: string[] | null;
  antenna_count?: number | null;

  // actuation
  torque_Nm?: number | null;
  continuous_current_A?: number | null; // motor draw
  stall_current_A?: number | null;
  driver_current_A?: number | null; // driver rating

  // connectors / interconnect
  connector_mates?: string[] | null; // mate keys this part exposes

  // soft / ranking
  cost_usd?: number | null;
  lead_time_weeks?: number | null;
}

// A BOM is subsystem -> list of selected components.
export const SUBSYSTEMS = [
  "compute",
  "power",
  "sensing",
  "comms",
  "actuation",
  "mechanical",
  "connector",
] as const;

export type Subsystem = (typeof SUBSYSTEMS)[number];

export interface BOM {
  subsystems: Record<string, Component[]>;
}

export function emptyBom(): BOM {
  const subsystems: Record<string, Component[]> = {};
  for (const s of SUBSYSTEMS) subsystems[s] = [];
  return { subsystems };
}

export function allComponents(bom: BOM): Component[] {
  const out: Component[] = [];
  for (const parts of Object.values(bom.subsystems)) {
    for (const p of parts) out.push(p);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Verifier output
// --------------------------------------------------------------------------- //

export interface Check {
  constraint_id: string;
  dimension: string;
  kind: "hard" | "soft";
  status: "pass" | "fail";
  reason: string;
  observed: unknown;
  required: unknown;
  weight: number;
}

export interface SpecResult {
  bom: BOM;
  checks: Check[];
  coverage: number; // fraction of HARD constraints passing — headline metric
  soft_score: number; // weighted soft score, drives Stage-2 ranking
  iteration: number;
}

export function allHardPass(result: SpecResult): boolean {
  const hard = result.checks.filter((c) => c.kind === "hard");
  return hard.length > 0 && hard.every((c) => c.status === "pass");
}

export function failingHard(result: SpecResult): Check[] {
  return result.checks.filter((c) => c.kind === "hard" && c.status === "fail");
}
