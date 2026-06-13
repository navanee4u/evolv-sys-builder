// GET /api/kb — the live catalogue grouped by subsystem.
// Mirrors server.py kb(): the live KB is the seed library plus everything
// learned from past runs (merge_learned_into), serialized with null fields
// dropped (schema.py Component.to_dict()).

import { NextResponse } from "next/server";
import { loadKb } from "@/lib/proposer";
import { mergeLearnedInto } from "@/lib/store";
import type { Component } from "@/lib/types";

export const runtime = "nodejs";

/** schema.py Component.to_dict(): drop keys whose value is None/undefined. */
function compactComponent(c: Component): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export function GET() {
  const kb = loadKb();
  mergeLearnedInto(kb);
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [sub, parts] of Object.entries(kb)) {
    out[sub] = parts.map(compactComponent);
  }
  return NextResponse.json(out);
}
