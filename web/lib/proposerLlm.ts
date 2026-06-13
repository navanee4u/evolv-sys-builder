// The real proposer: an LLM selects and revises the BOM, KB-first, with web
// search for parts not in the library. Model is selectable at runtime. Faithful
// TypeScript port of anvil/backend/proposer_llm.py.
//
// It still NEVER judges pass/fail -- it only proposes. The verifier decides, and
// the loop feeds verifier failures back here so the model must INVESTIGATE the
// named failure rather than reshuffle blindly.
//
// Robustness: if the Anthropic SDK or API key is unavailable, or the model
// returns unusable output, we fall back to the deterministic StubProposer so the
// demo always closes the loop. Provenance is tracked: KB parts are source="kb",
// parts the model introduces (e.g. via web search) are source="web".

import Anthropic from "@anthropic-ai/sdk";

import {
  type BOM,
  type Component,
  type Constraint,
  type Requirement,
  type SpecResult,
  allComponents,
  emptyBom,
  failingHard,
} from "@/lib/types";
import { StubProposer, buildRubric, loadKb } from "@/lib/proposer";

export const VALID_MODELS = new Set<string>([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
]);

type Kb = Record<string, Component[]>;

/** Optional sink for per-call API logging (store.BuildRecorder | null in Python).
 *  Anything with a `logApiCall(rec)` method works; errors are swallowed. */
export interface Recorder {
  logApiCall(rec: Record<string, unknown>): void;
}

/** A proposer reply: the proposed/revised BOM and short narration lines. */
export type ProposeResult = [BOM, string[]];

// --------------------------------------------------------------------------- //
// Component <-> dict helpers (mirror schema.py to_dict / from_dict)
// --------------------------------------------------------------------------- //

// The canonical Component fields, snake_case, matching schema.py exactly. Used
// to filter unknown keys when materializing a web-introduced part.
const COMPONENT_FIELDS = new Set<string>([
  "id", "subsystem", "name", "vendor", "part_number", "source",
  "active_power_W", "peak_power_W", "input_voltage_V", "rails_provided",
  "rail_current_A", "battery_Wh",
  "mass_g", "dims_mm", "temp_op_C", "ip_rating",
  "compute_TOPS", "ram_GB", "csi_lanes",
  "resolution_mp", "fps", "interface",
  "radio_bands", "radio_chains", "antenna_bands", "antenna_count",
  "torque_Nm", "continuous_current_A", "stall_current_A", "driver_current_A",
  "connector_mates",
  "cost_usd", "lead_time_weeks",
]);

/** schema.py Component.to_dict(): drop null/undefined fields. */
function componentToDict(c: Component): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** schema.py Component.from_dict(): keep only known fields. Throws if no id. */
function componentFromDict(d: Record<string, unknown>): Component {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (COMPONENT_FIELDS.has(k)) out[k] = v;
  }
  if (typeof out.id !== "string" || !out.id) {
    throw new Error("component missing id");
  }
  if (typeof out.subsystem !== "string" || !out.subsystem) {
    throw new Error("component missing subsystem");
  }
  return out as unknown as Component;
}

/** Compact catalogue the model can choose from, by id. One JSON object per line:
 *  {id, subsystem, ...spec fields (minus name/vendor/part_number), name}. */
function kbDigest(kb: Kb): string {
  const lines: string[] = [];
  for (const [sub, parts] of Object.entries(kb)) {
    for (const p of parts) {
      const d = componentToDict(p);
      delete d.source;
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) {
        if (!["id", "subsystem", "name", "vendor", "part_number"].includes(k)) {
          rest[k] = v;
        }
      }
      lines.push(JSON.stringify({ id: p.id, subsystem: sub, ...rest, name: p.name }));
    }
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// LLM proposer
// --------------------------------------------------------------------------- //

export class LLMProposer {
  model: string;
  name: string;
  kb: Kb;
  recorder: Recorder | null;
  private stub: StubProposer;
  private kbById: Map<string, Component>;
  private client: Anthropic | null;

  constructor(model: string, kb?: Kb | null, recorder: Recorder | null = null) {
    if (!VALID_MODELS.has(model)) {
      throw new Error(`unknown model ${JSON.stringify(model)}`);
    }
    this.model = model;
    this.name = model;
    this.kb = kb ?? loadKb();
    this.recorder = recorder; // Recorder | null
    this.stub = new StubProposer(this.kb); // fallback + rubric builder
    this.kbById = new Map();
    for (const parts of Object.values(this.kb)) {
      for (const p of parts) this.kbById.set(p.id, p);
    }
    this.client = this.makeClient();
  }

  private makeClient(): Anthropic | null {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    try {
      return new Anthropic();
    } catch {
      return null;
    }
  }

  get available(): boolean {
    return this.client !== null;
  }

  // -- loop interface ----------------------------------------------------- //

  parse(requirement: Requirement): [Requirement, Constraint[]] {
    // the frontend already sends a structured Requirement; the rubric is
    // deterministic from there so the checklist is reproducible.
    return [requirement, buildRubric(requirement)];
  }

  async initial(req: Requirement, rubric: Constraint[], rules = ""): Promise<ProposeResult> {
    if (!this.available) {
      const [bom, notes] = this.stub.initial(req, rubric, rules);
      if (notes.length) {
        return [bom, ["(no API key — deterministic proposer) " + notes[0], ...notes.slice(1)]];
      }
      return [bom, notes];
    }
    const [sysPrompt, user] = this.buildPrompt(req, rubric, rules, null);
    const [bom, notes] = await this.ask(sysPrompt, user, null, "initial");
    if (bom === null) {
      const [sbom, snotes] = this.stub.initial(req, rubric, rules);
      return [sbom, [...this.fallbackNotes(notes), ...snotes]];
    }
    return [bom, notes];
  }

  async revise(req: Requirement, rubric: Constraint[], result: SpecResult): Promise<ProposeResult> {
    if (!this.available) {
      return this.stub.revise(req, rubric, result);
    }
    const [sysPrompt, user] = this.buildPrompt(req, rubric, null, result);
    const [bom, notes] = await this.ask(sysPrompt, user, result.bom, `revise@iter${result.iteration}`);
    if (bom === null) {
      const [sbom, snotes] = this.stub.revise(req, rubric, result);
      return [sbom, [...this.fallbackNotes(notes), ...snotes]];
    }
    return [bom, notes];
  }

  private fallbackNotes(notes: string[]): string[] {
    const why = notes.length ? notes[0] : "unusable response";
    return [`⚠ ${this.model} fell back to the deterministic proposer (${why}).`];
  }

  // -- LLM plumbing ------------------------------------------------------- //

  private buildPrompt(
    req: Requirement,
    rubric: Constraint[],
    rules: string | null,
    result: SpecResult | null,
  ): [string, string] {
    let system =
      "You are Anvil's hardware Proposer. You select real components into a " +
      "bill of materials. You do NOT decide pass/fail — a deterministic " +
      "verifier does. Prefer parts from the provided catalogue (source=kb); " +
      "if nothing fits, you may introduce a real part you know of and mark " +
      "it source=web with honest specs. Never invent specs.\n\n" +
      'Respond with ONLY a JSON object as your ENTIRE message — begin with { ' +
      "and end with } , no prose, no markdown fences. Schema: {\"select\": " +
      '["<kb id>", ...], "web": [<full component object>...], ' +
      '"notes": ["short narration"...]}.\n' +
      "Pick exactly one part per needed subsystem unless a constraint needs " +
      "more (e.g. radio + antenna, motor + driver, regulator + battery). " +
      "Do NOT use web_search unless a required part is absent from the catalogue.";
    if (rules) {
      system += `\n\nDistilled rules from past runs — apply them up front:\n${rules}`;
    }

    const parts: string[] = [
      `Requirement:\n${JSON.stringify(requirementToDict(req))}`,
      `\nRubric (hard constraints gate the design):\n` +
        rubric.map((c) => `- ${c.id} [${c.kind}]: ${c.predicate}`).join("\n"),
      `\nComponent catalogue (choose by id):\n${kbDigest(this.kb)}`,
    ];
    if (result !== null) {
      parts.push(
        "\nThe verifier REJECTED the current BOM. Investigate each " +
          "failing constraint and revise the responsible subsystem:\n" +
          failingHard(result)
            .map((c) => `- FAIL ${c.constraint_id}: ${c.reason}`)
            .join("\n"),
      );
      parts.push("\nCurrent selection: " + JSON.stringify(allComponents(result.bom).map((p) => p.id)));
    }
    return [system, parts.join("\n")];
  }

  private async ask(
    system: string,
    user: string,
    current: BOM | null,
    phase = "propose",
  ): Promise<[BOM | null, string[]]> {
    const t0 = Date.now();
    const rec: Record<string, unknown> = {
      phase,
      model: this.model,
      request: {
        system,
        messages: [{ role: "user", content: user }],
        max_tokens: 4096,
        tools: ["web_search_20250305"],
      },
    };
    try {
      const resp = await this.client!.messages.create({
        model: this.model,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: user }],
        tools: [{ type: "web_search_20250305", name: "web_search" } as never],
      });
      rec.latency_ms = Date.now() - t0;
      const text = resp.content
        .filter((b) => (b as { type?: string }).type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      rec.response = this.dump(resp);
      rec.response_text = text;
      rec.usage = this.dump((resp as { usage?: unknown }).usage ?? null);
      const data = extractJson(text);
      if (!data) {
        rec.outcome = "unparseable";
        this.record(rec);
        return [null, ["unparseable response"]];
      }
      rec.outcome = "ok";
      rec.parsed = data;
      this.record(rec);
      return this.materialize(data, current);
    } catch (e: unknown) {
      rec.latency_ms = Date.now() - t0;
      let msg = String((e as Error)?.message ?? e);
      if (msg.includes("not_found") || msg.includes("404")) {
        msg = `${this.model} not available on this API key`;
      }
      rec.outcome = "error";
      rec.error = String((e as Error)?.message ?? e).slice(0, 500);
      this.record(rec);
      return [null, [msg.slice(0, 140)]];
    }
  }

  private record(rec: Record<string, unknown>): void {
    if (this.recorder !== null) {
      try {
        this.recorder.logApiCall(rec);
      } catch {
        // best-effort logging; never break the run
      }
    }
  }

  private dump(obj: unknown): unknown {
    if (obj === null || obj === undefined) return null;
    // SDK responses are plain JSON-serializable objects; round-trip defensively.
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return String(obj);
    }
  }

  private materialize(data: Record<string, unknown>, current: BOM | null): [BOM, string[]] {
    const bom = emptyBom();
    // start from current selection so unaddressed subsystems persist on revise
    if (current !== null) {
      for (const p of allComponents(current)) {
        (bom.subsystems[p.subsystem] ??= []).push(p);
      }
    }

    // selected KB ids replace their subsystems
    const chosenSubs = new Set<string>();
    const picks: Component[] = [];
    const select = Array.isArray(data.select) ? (data.select as unknown[]) : [];
    for (const cid of select) {
      const p = typeof cid === "string" ? this.kbById.get(cid) : undefined;
      if (p) {
        picks.push(p);
        chosenSubs.add(p.subsystem);
      }
    }
    const web = Array.isArray(data.web) ? (data.web as unknown[]) : [];
    for (const raw of web) {
      try {
        const c = componentFromDict({ ...(raw as Record<string, unknown>), source: "web" });
        picks.push(c);
        chosenSubs.add(c.subsystem);
      } catch {
        continue;
      }
    }
    // rebuild touched subsystems from picks; keep untouched ones from current
    for (const sub of chosenSubs) {
      bom.subsystems[sub] = picks.filter((p) => p.subsystem === sub);
    }
    const rawNotes = Array.isArray(data.notes) ? (data.notes as unknown[]) : [];
    const notes = rawNotes.map((n) => String(n)).slice(0, 8);
    if (notes.length === 0) notes.push(`selected ${picks.length} component(s)`);
    return [bom, notes];
  }
}

// --------------------------------------------------------------------------- //
// Requirement.to_dict() — drop null/undefined (mirrors schema.py)
// --------------------------------------------------------------------------- //

function requirementToDict(req: Requirement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Robust JSON extraction (mirrors proposer_llm._extract_json)
// --------------------------------------------------------------------------- //

export function extractJson(text: string): Record<string, unknown> | null {
  text = text.trim();
  // strip a ```json … ``` fence if present
  if (text.includes("```")) {
    const m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (m) {
      try {
        return JSON.parse(m[1]) as Record<string, unknown>;
      } catch {
        // fall through to brace scan
      }
    }
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  // scan for the first balanced {...} object (robust to prose with braces)
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  // last resort: greedy first-to-last
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace === -1) return null;
  try {
    return JSON.parse(text.slice(start, lastBrace + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Factory
// --------------------------------------------------------------------------- //

/** Factory used by the server. 'stub' -> deterministic; else LLM (with fallback). */
export function makeProposer(
  model: string,
  kb?: Kb | null,
  recorder: Recorder | null = null,
): StubProposer | LLMProposer {
  if (model === "stub") {
    return new StubProposer(kb ?? undefined);
  }
  return new LLMProposer(model, kb, recorder);
}

// --------------------------------------------------------------------------- //
// Conversational requirement intake
// --------------------------------------------------------------------------- //

const INTAKE_SYSTEM =
  "You are Anvil's requirements interviewer. A hardware engineer describes a robot " +
  "or embedded system in plain English; your job is to turn that into a structured, " +
  "machine-checkable requirement so they never have to guess arbitrary numbers.\n\n" +
  "Behaviour:\n" +
  "- If a CRITICAL dimension is missing or ambiguous, ask ONE short, friendly clarifying " +
  "question (batch a couple at most). Critical dimensions: power budget, runtime, compute " +
  "workload (TOPS), operating temperature, ingress protection, mass, enclosure size, " +
  "camera, comms, actuation — but only those that matter for THIS system.\n" +
  "- Otherwise, infer sensible engineering defaults from the use-case and proceed. Always " +
  "explain the values you chose in one line each so the user can correct them.\n\n" +
  "Respond with ONLY a JSON object (no prose outside it):\n" +
  "{\n" +
  '  "status": "need_info" | "ready",\n' +
  '  "message": "your reply to the user (a question, or a summary of the spec you built)",\n' +
  '  "rationale": ["why power=…", "why temp=…", ...],   // only when ready\n' +
  '  "requirement": {                                    // null when need_info\n' +
  '     "name": str, "power_budget_W": num, "runtime_h": num, "workload_TOPS": num,\n' +
  '     "model_footprint_GB": num, "temp_C": [min,max], "ip_rating": "IP67",\n' +
  '     "mass_budget_g": num, "enclosure_mm": [x,y,z],\n' +
  '     "camera": {"mp": num, "fps": num, "interface": "MIPI-CSI"},\n' +
  '     "comms": ["5GHz","UWB"], "actuation": {"torque_Nm": num, "continuous_current_A": num}\n' +
  "  }\n" +
  "}\n" +
  "Omit requirement keys that don't apply to the system (e.g. no camera on a motor controller).";

export interface IntakeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface IntakeResult {
  status: "need_info" | "ready" | "error";
  message: string;
  rationale?: string[];
  requirement?: Requirement | null;
  [key: string]: unknown;
}

/** Interview-style requirement extraction. `messages` is the running chat
 *  [{role, content}, ...]. Returns the parsed JSON object (status/message/requirement). */
export async function converseIntake(
  messages: IntakeMessage[],
  model = "claude-opus-4-8",
): Promise<IntakeResult> {
  if (!VALID_MODELS.has(model)) model = "claude-opus-4-8";
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      status: "error",
      message:
        "Conversational intake needs an ANTHROPIC_API_KEY. Use the manual form, or set the key and restart.",
      requirement: null,
    };
  }
  try {
    const client = new Anthropic();
    const resp = await client.messages.create({
      model,
      max_tokens: 1500,
      system: INTAKE_SYSTEM,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = resp.content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const data = extractJson(text);
    if (!data) {
      return {
        status: "need_info",
        message: text || "Could you tell me more about the system?",
        requirement: null,
      };
    }
    return data as IntakeResult;
  } catch (e: unknown) {
    let msg = String((e as Error)?.message ?? e);
    if (msg.includes("not_found") || msg.includes("404")) {
      msg = `${model} is not available on this API key — try Opus 4.8 or Sonnet 4.6.`;
    }
    return { status: "error", message: msg.slice(0, 200), requirement: null };
  }
}
