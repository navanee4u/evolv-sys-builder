// GET /api/memory — distilled rules + failure log.
// Mirrors server.py get_memory(): {rules: memory.rule_lines(), failures: memory.load_failures()}.

import { NextResponse } from "next/server";
import { ruleLines, loadFailures } from "@/lib/memory";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    rules: ruleLines(),
    failures: loadFailures(),
  });
}
