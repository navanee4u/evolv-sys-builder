// File-based persistent memory — the OUTER loop (faithful port of anvil/backend/memory.py).
//
//   failures.jsonl : every hard-constraint failure the loop hit + how it was fixed.
//   rules.md       : distilled general rules, consulted at the start of each run so
//                    the proposer stops re-deriving solved problems.
//
// No database. Just append-only files a human can read and a judge can watch grow.
//
// Vercel reality: the bundled seed (web/data/memory/{rules.md,failures.jsonl}) is
// read-only. All WRITES target os.tmpdir()/anvil/memory and are best-effort —
// wrapped in try/catch so a read-only FS NEVER throws on a request. Reads MERGE
// the bundled seed with whatever has accumulated in tmp.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --------------------------------------------------------------------------- //
// paths: bundled (read-only seed) + tmp (writable runtime)
// --------------------------------------------------------------------------- //

function seedDir(): string {
  return path.join(process.cwd(), "data", "memory");
}

function tmpDir(): string {
  return path.join(os.tmpdir(), "anvil", "memory");
}

function seedRulesPath(): string {
  return path.join(seedDir(), "rules.md");
}

function tmpRulesPath(): string {
  return path.join(tmpDir(), "rules.md");
}

function seedFailuresPath(): string {
  return path.join(seedDir(), "failures.jsonl");
}

function tmpFailuresPath(): string {
  return path.join(tmpDir(), "failures.jsonl");
}

// A confirmed fix in dimension X distills to this general guidance.
const RULE_TEMPLATES: Record<string, string> = {
  power_budget:
    "Tight power budget: pick the lowest-power compute module that still clears the TOPS workload, not the most capable one.",
  peak_power:
    "Size regulator rail current to the summed PEAK draw on each rail, not the average.",
  endurance:
    "Long-runtime targets: size the battery from avg_power x required_hours up front, with margin.",
  thermal:
    "Outdoor/wide-temp environments: restrict the whole BOM to industrial-temp (-40..85 C) parts from the start.",
  environment:
    "Sealed/IP-rated requirements: choose the enclosure IP rating before placing boards.",
  size_enclosure:
    "Pick the enclosure from the summed board footprint, not the smallest available shell.",
  mass_budget:
    "Mass-constrained builds: the battery dominates mass -- size it last against remaining budget.",
  compute:
    "Match accelerator TOPS and RAM to the model footprint before optimizing anything else.",
  sensing:
    "Verify camera CSI lane count against host SoM lanes, not just resolution/fps.",
  comms:
    "Pair every radio band with a matching antenna band and antenna_count >= radio_chains.",
  voltage_rails:
    "Enumerate every load's input voltage and provide a regulated rail for each before finalizing power.",
  connectors:
    "Every inter-board link needs a mating connector pair; add the cable when a mate key is dangling.",
  actuation: "Rate the motor driver to stall current, not just continuous current.",
};

const RULES_HEADER =
  "# Anvil distilled rules\n\n" +
  "_General hardware-selection rules learned across runs._\n\n";

// --------------------------------------------------------------------------- //
// failure record
// --------------------------------------------------------------------------- //

export interface FailureRecord {
  rubric_dim: string;
  failing_part: string;
  reason: string;
  fix_applied: string;
}

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

/** Read a UTF-8 file, returning `fallback` if it is missing/unreadable. */
function readTextSafe(p: string, fallback = ""): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return fallback;
  }
}

/** Best-effort: ensure the tmp memory dir exists. Never throws. */
function ensureTmp(): boolean {
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Bullet rules ("- ...") parsed out of a rules.md body, trimmed. */
function bulletsOf(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((ln) => ln.startsWith("- "))
    .map((ln) => ln.slice(2).trim());
}

// --------------------------------------------------------------------------- //
// public API — reads merge seed + tmp; writes go to tmp only (best-effort)
// --------------------------------------------------------------------------- //

/** Full rules markdown: the bundled seed body, then any distilled bullets that
 *  exist only in tmp appended underneath. */
export function loadRules(): string {
  const seed = readTextSafe(seedRulesPath(), RULES_HEADER);
  const tmpBody = readTextSafe(tmpRulesPath(), "");
  if (!tmpBody) return seed;

  const seedBullets = new Set(bulletsOf(seed));
  const extra = bulletsOf(tmpBody).filter((b) => !seedBullets.has(b));
  if (extra.length === 0) return seed;

  const base = seed.endsWith("\n") ? seed : seed + "\n";
  return base + extra.map((b) => `- ${b}`).join("\n") + "\n";
}

/** The bullet rules only (for the UI panel), seed + tmp, deduped, order-stable. */
export function ruleLines(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [
    ...bulletsOf(readTextSafe(seedRulesPath(), "")),
    ...bulletsOf(readTextSafe(tmpRulesPath(), "")),
  ]) {
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

/** Append a failure record to the tmp log. Best-effort; never throws. */
export function appendFailure(
  rubric_dim: string,
  failing_part: string,
  reason: string,
  fix_applied: string,
): void {
  const rec: FailureRecord = { rubric_dim, failing_part, reason, fix_applied };
  if (!ensureTmp()) return;
  try {
    fs.appendFileSync(tmpFailuresPath(), JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    // read-only FS — best-effort, swallow.
  }
}

/** All failure records: bundled seed first, then tmp-accumulated ones. */
export function loadFailures(): FailureRecord[] {
  const out: FailureRecord[] = [];
  for (const p of [seedFailuresPath(), tmpFailuresPath()]) {
    for (const ln of readTextSafe(p, "").split(/\r?\n/)) {
      const s = ln.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as FailureRecord);
      } catch {
        // skip malformed line
      }
    }
  }
  return out;
}

/** Add the general rule for a resolved dimension if not already present (seed or
 *  tmp). Returns the rule text if it was newly added, else null. Best-effort. */
export function distillRule(dimension: string): string | null {
  const rule = RULE_TEMPLATES[dimension];
  if (!rule) return null;
  if (new Set(ruleLines()).has(rule)) return null;
  if (!ensureTmp()) return null;
  try {
    // seed the header into tmp the first time so the file is self-describing.
    if (!fs.existsSync(tmpRulesPath())) {
      fs.writeFileSync(tmpRulesPath(), RULES_HEADER, "utf-8");
    }
    fs.appendFileSync(tmpRulesPath(), `- ${rule}\n`, "utf-8");
  } catch {
    return null;
  }
  return rule;
}
