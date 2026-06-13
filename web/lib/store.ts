// Durable, file-based data store — everything Anvil accumulates at runtime
// (faithful port of anvil/backend/store.py).
//
//   data/
//     builds/<build_id>/
//       build.json        manifest: requirement, model, coverage, timing, summary
//       events.jsonl      every loop event that streamed to the UI
//       api_calls.jsonl   every Anthropic API call (full request + response + usage)
//     kb_learned.json     web-discovered components, deduped — the KB grows here
//     builds_index.jsonl  one line per build, for fast listing
//
// No database. Append-only files a human can read and a judge can watch grow.
// Each /api/run is treated as one hardware BUILD with its own folder.
//
// Vercel reality: the bundled `web/data` tree is read-only. Every WRITE targets
// os.tmpdir()/anvil and is wrapped in try/catch so a read-only FS NEVER throws
// on a request. Every READ merges the bundled seed under web/data with whatever
// has accumulated under tmp (tmp wins on id collisions).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allComponents, type BOM, type Component } from "@/lib/types";

// --------------------------------------------------------------------------- //
// roots: bundled seed (read-only) + tmp (writable runtime)
// --------------------------------------------------------------------------- //

function seedRoot(): string {
  return path.join(process.cwd(), "data");
}

function tmpRoot(): string {
  return path.join(os.tmpdir(), "anvil");
}

function seedBuildsDir(): string {
  return path.join(seedRoot(), "builds");
}

function tmpBuildsDir(): string {
  return path.join(tmpRoot(), "builds");
}

function seedLearnedPath(): string {
  return path.join(seedRoot(), "kb_learned.json");
}

function tmpLearnedPath(): string {
  return path.join(tmpRoot(), "kb_learned.json");
}

function seedIndexPath(): string {
  return path.join(seedRoot(), "builds_index.jsonl");
}

function tmpIndexPath(): string {
  return path.join(tmpRoot(), "builds_index.jsonl");
}

// --------------------------------------------------------------------------- //
// fs helpers — all writes best-effort, never throw on read-only FS
// --------------------------------------------------------------------------- //

function readTextSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function appendLineSafe(p: string, line: string): void {
  if (!ensureDir(path.dirname(p))) return;
  try {
    fs.appendFileSync(p, line + "\n", "utf-8");
  } catch {
    // read-only FS — swallow.
  }
}

function writeTextSafe(p: string, text: string): void {
  if (!ensureDir(path.dirname(p))) return;
  try {
    fs.writeFileSync(p, text, "utf-8");
  } catch {
    // read-only FS — swallow.
  }
}

function parseJsonl<T = Record<string, unknown>>(text: string | null): T[] {
  if (!text) return [];
  const out: T[] = [];
  for (const ln of text.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function nowIso(): string {
  // ISO-8601 to seconds precision, mirroring Python isoformat(timespec="seconds").
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** "build-YYYYMMDD-HHMMSS-xxxx" — same shape as store.py new_build_id(). */
export function newBuildId(): string {
  const d = new Date();
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `build-${stamp}-${suffix}`;
}

// --------------------------------------------------------------------------- //
// per-build recorder — writes to tmp only, best-effort
// --------------------------------------------------------------------------- //

export interface BuildManifest {
  build_id: string;
  name: string;
  model: string;
  requirement: Record<string, unknown>;
  started: string;
  finished: string;
  elapsed_s: number;
  coverage: number;
  soft_score: number;
  iterations: number;
  all_hard_pass: boolean;
  new_rules: unknown[];
  api_calls: number;
  events: number;
  final_bom: BOM | null;
}

/** Records one hardware build: its event stream and every API call it made. */
export class BuildRecorder {
  readonly id: string;
  readonly requirement: Record<string, unknown>;
  readonly model: string;
  readonly started: string;
  private readonly t0: number;
  private readonly dir: string;
  private readonly eventsPath: string;
  private readonly apiPath: string;
  nEvents = 0;
  nApiCalls = 0;

  constructor(buildId: string, requirement: Record<string, unknown>, model: string) {
    this.id = buildId;
    this.requirement = requirement;
    this.model = model;
    this.started = nowIso();
    this.t0 = Date.now();
    this.dir = path.join(tmpBuildsDir(), buildId);
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.apiPath = path.join(this.dir, "api_calls.jsonl");
    ensureDir(this.dir);
  }

  logEvent(ev: Record<string, unknown>): void {
    this.nEvents += 1;
    appendLineSafe(this.eventsPath, JSON.stringify(ev));
  }

  logApiCall(rec: Record<string, unknown>): void {
    this.nApiCalls += 1;
    const withMeta = { ts: nowIso(), build_id: this.id, ...rec };
    appendLineSafe(this.apiPath, JSON.stringify(withMeta));
  }

  finalize(doneEvent: Record<string, unknown> | null): BuildManifest {
    const done = doneEvent ?? {};
    const spec = (done.spec as { bom?: BOM } | undefined) ?? undefined;
    const manifest: BuildManifest = {
      build_id: this.id,
      name: (this.requirement.name as string) ?? "untitled",
      model: this.model,
      requirement: this.requirement,
      started: this.started,
      finished: nowIso(),
      elapsed_s: Math.round((Date.now() - this.t0) / 10) / 100,
      coverage: (done.coverage as number) ?? 0.0,
      soft_score: (done.soft_score as number) ?? 0.0,
      iterations: (done.iterations as number) ?? 0,
      all_hard_pass: Boolean(done.all_hard_pass),
      new_rules: (done.new_rules as unknown[]) ?? [],
      api_calls: this.nApiCalls,
      events: this.nEvents,
      final_bom: spec?.bom ?? null,
    };
    writeTextSafe(
      path.join(this.dir, "build.json"),
      JSON.stringify(manifest, null, 2),
    );
    const indexRow = {
      build_id: manifest.build_id,
      name: manifest.name,
      model: manifest.model,
      started: manifest.started,
      elapsed_s: manifest.elapsed_s,
      coverage: manifest.coverage,
      iterations: manifest.iterations,
      all_hard_pass: manifest.all_hard_pass,
      api_calls: manifest.api_calls,
    };
    appendLineSafe(tmpIndexPath(), JSON.stringify(indexRow));
    return manifest;
  }
}

// --------------------------------------------------------------------------- //
// build listing / retrieval — merges seed + tmp
// --------------------------------------------------------------------------- //

/** Most-recent-first list of build index rows, capped at `limit`. Merges the
 *  bundled seed index with tmp-accumulated builds (tmp wins on build_id). */
export function listBuilds(limit = 50): Array<Record<string, unknown>> {
  const seed = parseJsonl(readTextSafe(seedIndexPath()));
  const tmp = parseJsonl(readTextSafe(tmpIndexPath()));
  // tmp rows are newer; let them override seed rows with the same build_id.
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const row of [...seed, ...tmp]) {
    const id = String((row as Record<string, unknown>).build_id ?? "");
    if (!id) continue;
    if (!byId.has(id)) order.push(id);
    byId.set(id, row as Record<string, unknown>);
  }
  const merged = order.map((id) => byId.get(id)!);
  return merged.reverse().slice(0, limit);
}

function buildDirFor(buildId: string): string | null {
  // tmp wins (a build re-run there is newer than the bundled copy).
  const tmpD = path.join(tmpBuildsDir(), buildId);
  if (fs.existsSync(path.join(tmpD, "build.json"))) return tmpD;
  const seedD = path.join(seedBuildsDir(), buildId);
  if (fs.existsSync(path.join(seedD, "build.json"))) return seedD;
  return null;
}

/** Full build manifest with its `event_log` inlined, or null if unknown. */
export function getBuild(buildId: string): Record<string, unknown> | null {
  const dir = buildDirFor(buildId);
  if (!dir) return null;
  const manText = readTextSafe(path.join(dir, "build.json"));
  if (!manText) return null;
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(manText) as Record<string, unknown>;
  } catch {
    return null;
  }
  out.event_log = parseJsonl(readTextSafe(path.join(dir, "events.jsonl")));
  return out;
}

/** Every recorded Anthropic API call for a build (empty list if none). */
export function getBuildApiCalls(buildId: string): Array<Record<string, unknown>> {
  const dir = buildDirFor(buildId);
  if (!dir) return [];
  return parseJsonl(readTextSafe(path.join(dir, "api_calls.jsonl")));
}

// --------------------------------------------------------------------------- //
// learned KB — web-discovered specs accumulate here (seed + tmp)
// --------------------------------------------------------------------------- //

function parseLearned(text: string | null): Component[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text);
    return Array.isArray(raw) ? (raw as Component[]) : [];
  } catch {
    return [];
  }
}

/** All learned components: bundled seed first, then tmp-accumulated, deduped by
 *  id (first occurrence wins, so seed is authoritative for shared ids). */
export function loadLearned(): Component[] {
  const seen = new Set<string>();
  const out: Component[] = [];
  for (const c of [
    ...parseLearned(readTextSafe(seedLearnedPath())),
    ...parseLearned(readTextSafe(tmpLearnedPath())),
  ]) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Merge the learned library into an in-memory KB dict (dedup by id). Returns
 *  the count merged. Mirrors store.py merge_learned_into. */
export function mergeLearnedInto(kb: Record<string, Component[]>): number {
  const have = new Set<string>();
  for (const parts of Object.values(kb)) for (const p of parts) have.add(p.id);
  let n = 0;
  for (const c of loadLearned()) {
    if (!have.has(c.id)) {
      (kb[c.subsystem] ??= []).push(c);
      have.add(c.id);
      n += 1;
    }
  }
  return n;
}

/** Persist any source='web' components from a finished BOM into the learned
 *  library (dedup by id) and, if a live KB is given, merge them in so the next
 *  run can reuse them. Returns the newly stored components. Best-effort write. */
export function harvestWebParts(
  bom: BOM,
  kb: Record<string, Component[]> | null = null,
): Component[] {
  const existing = new Set(loadLearned().map((c) => c.id));
  const inKb = new Set<string>();
  if (kb) for (const parts of Object.values(kb)) for (const p of parts) inKb.add(p.id);

  const fresh: Component[] = [];
  for (const comp of allComponents(bom)) {
    if (comp.source === "web" && comp.id && !existing.has(comp.id)) {
      existing.add(comp.id);
      fresh.push(comp);
    }
  }
  if (fresh.length === 0) return [];

  // rewrite the tmp learned file with the union (seed + tmp + new).
  const union = [...loadLearned(), ...fresh];
  writeTextSafe(tmpLearnedPath(), JSON.stringify(union, null, 2));

  // merge into the live KB
  if (kb) {
    for (const c of fresh) {
      if (!inKb.has(c.id)) (kb[c.subsystem] ??= []).push(c);
    }
  }
  return fresh;
}

/** Total count of learned (web-harvested) components across seed + tmp. */
export function learnedCount(): number {
  return loadLearned().length;
}
