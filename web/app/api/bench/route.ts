// POST /api/bench  {requirement, models?} -> text/event-stream of tagged events.
//
// Model Bench: run the SAME requirement across several models, tagging each loop
// event with its model so the UI can compare final coverage side by side.
// Faithful port of server.py /api/bench. Conventions mirror /api/run (inline sse
// + liveKb + proposer cast) so both SSE routes read the same way.

import { NextRequest } from "next/server";
import { loadKb } from "@/lib/kb";
import { runLoop, MAX_ITERS, type Proposer } from "@/lib/loop";
import { makeProposer, VALID_MODELS } from "@/lib/proposerLlm";
import { mergeLearnedInto } from "@/lib/store";
import type { Requirement, Component } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// Live KB = seed library + everything learned from past runs (grows over time).
function liveKb(): Record<string, Component[]> {
  const kb = loadKb();
  mergeLearnedInto(kb);
  return kb;
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const DEFAULT_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "stub"];

export async function POST(req: NextRequest) {
  let body: { requirement?: Requirement; models?: string[] };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const requirement = (body.requirement ?? {}) as Requirement;
  const models =
    Array.isArray(body.models) && body.models.length
      ? body.models
      : DEFAULT_MODELS;

  const kb = liveKb();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sse(event)));
      };

      try {
        for (const model of models) {
          const m =
            VALID_MODELS.has(model) || model === "stub" ? model : "stub";
          const proposer = makeProposer(m, kb);
          send({ type: "bench_start", model, message: `Running ${model}…` });
          // Stub/LLM proposers expose sync+async methods; the loop awaits all of
          // them, so a sync return is fine at runtime. Cast to the loop contract.
          for await (const ev of runLoop(
            requirement,
            proposer as unknown as Proposer,
            { maxIters: MAX_ITERS, model },
          )) {
            // tag every event with its model so the UI can compare side by side
            send({ ...(ev as unknown as Record<string, unknown>), model });
          }
          send({ type: "bench_end", model });
        }
      } catch (err) {
        send({
          type: "error",
          message: `Bench failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
