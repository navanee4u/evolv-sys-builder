// GET /api/builds/[id] — full build manifest with its event_log inlined.
// Mirrors server.py build_detail(): 404 {error:"not found"} when unknown.

import { NextResponse } from "next/server";
import { getBuild } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const b = getBuild(id);
  if (!b) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(b);
}
