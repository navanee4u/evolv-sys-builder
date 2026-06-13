// POST /api/intake {messages, model} -> JSON {status, message, rationale?, requirement?}
// Mirrors server.py intake(): conversational requirement extraction. Never crashes;
// converseIntake itself returns {status:"error", ...} when no API key is present.

import { NextResponse } from "next/server";
import { converseIntake, type IntakeMessage } from "@/lib/proposerLlm";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { messages?: IntakeMessage[]; model?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === "string" ? body.model : "claude-opus-4-8";
  const result = await converseIntake(messages, model);
  return NextResponse.json(result);
}
