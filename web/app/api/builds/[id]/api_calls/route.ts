// GET /api/builds/[id]/api_calls — every recorded Anthropic API call for a build.
// Mirrors server.py build_api_calls(): {build_id, api_calls}.

import { NextResponse } from "next/server";
import { getBuildApiCalls } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json({
    build_id: id,
    api_calls: getBuildApiCalls(id),
  });
}
