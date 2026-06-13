// GET /api/builds — newest-first list of builds + learned-part count.
// Mirrors server.py builds(): {builds: store.list_builds(), learned_parts: store.learned_count()}.

import { NextResponse } from "next/server";
import { listBuilds, learnedCount } from "@/lib/store";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    builds: listBuilds(),
    learned_parts: learnedCount(),
  });
}
