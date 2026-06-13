// GET /api/models — selectable models + whether the LLM is wired.
// Mirrors server.py models(): same id/label/kind list, default, and llm_ready.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  const llm_ready = !!process.env.ANTHROPIC_API_KEY;
  return NextResponse.json({
    models: [
      { id: "claude-opus-4-8", label: "Opus 4.8", kind: "llm" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", kind: "llm" },
      { id: "claude-fable-5", label: "Fable 5 (needs access)", kind: "llm" },
      { id: "stub", label: "Deterministic (no LLM)", kind: "stub" },
    ],
    default: "claude-opus-4-8",
    llm_ready,
  });
}
