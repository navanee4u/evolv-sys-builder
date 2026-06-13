// Seed knowledge-base loader. Reads the bundled JSON files committed under
// web/data/kb/ at module init (relative to process.cwd(), which is the web/
// directory both in `next dev` and on Vercel). The KB is the proposer's first
// source of parts; the verifier never reads it directly.

import fs from "node:fs";
import path from "node:path";
import type { Component } from "@/lib/types";

// Maps each KB JSON file to the subsystem bucket it populates. comms_antennas
// holds both comms radios and antennas (both subsystem === "comms").
const KB_FILES: Record<string, string> = {
  "compute.json": "compute",
  "power.json": "power",
  "sensing.json": "sensing",
  "comms_antennas.json": "comms",
  "actuation.json": "actuation",
  "mechanical.json": "mechanical",
  "connectors.json": "connector",
};

function kbDir(): string {
  return path.join(process.cwd(), "data", "kb");
}

/** Load the seed KB as { [subsystem]: Component[] }. Each component's own
 *  `subsystem` field (read verbatim from the JSON) is authoritative; the file
 *  name only decides the default bucket. Best-effort: a missing/malformed file
 *  contributes nothing rather than throwing. */
export function loadKb(): Record<string, Component[]> {
  const dir = kbDir();
  const out: Record<string, Component[]> = {};

  for (const [file, defaultSubsystem] of Object.entries(KB_FILES)) {
    let parts: Component[] = [];
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parts = parsed as Component[];
    } catch {
      parts = [];
    }
    for (const c of parts) {
      const sub = c.subsystem || defaultSubsystem;
      (out[sub] ??= []).push(c);
    }
  }

  return out;
}

/** Flat list of every seed component across all subsystems. */
export function loadKbFlat(): Component[] {
  const bySub = loadKb();
  return Object.values(bySub).flat();
}
