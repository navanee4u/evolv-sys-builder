// POST /api/run  {requirement, model} -> text/event-stream of loop events.
//
// Faithful port of server.py /api/run. Every run is its own hardware build,
// persisted best-effort to os.tmpdir() via BuildRecorder. We create a proposer
// (LLM with deterministic fallback), then stream the self-correction loop's
// events as SSE. After the loop closes we harvest any web-discovered parts into
// the learned KB and emit a 'stored' event, then finalize the build record.

import { NextRequest } from "next/server";
import { loadKb } from "@/lib/kb";
import { runLoop, MAX_ITERS, type LoopEvent, type Proposer } from "@/lib/loop";
import { makeProposer, VALID_MODELS, LLMProposer } from "@/lib/proposerLlm";
import {
  BuildRecorder,
  newBuildId,
  mergeLearnedInto,
  harvestWebParts,
  learnedCount,
} from "@/lib/store";
import type { Requirement, Component, BOM } from "@/lib/types";

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

export async function POST(req: NextRequest) {
  let body: { requirement?: Requirement; model?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const requirement = (body.requirement ?? {}) as Requirement;
  const rawModel = body.model ?? "claude-opus-4-8";
  const model =
    VALID_MODELS.has(rawModel) || rawModel === "stub" ? rawModel : "stub";

  const kb = liveKb();
  const buildId = newBuildId();
  const recorder = new BuildRecorder(
    buildId,
    requirement as unknown as Record<string, unknown>,
    model,
  );
  const proposer = makeProposer(model, kb, recorder);
  const fallback = proposer instanceof LLMProposer && !proposer.available;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sse(event)));
      };

      try {
        // every run is its own hardware build, persisted to disk
        const startEv = {
          type: "build_started",
          build_id: buildId,
          model,
          message: `Build ${buildId} started.`,
        };
        recorder.logEvent(startEv);
        send(startEv);

        if (fallback) {
          const note = {
            type: "note",
            message: `${model}: no ANTHROPIC_API_KEY — running the deterministic proposer instead.`,
          };
          recorder.logEvent(note);
          send(note);
        }

        // Stub/LLM proposers expose sync+async methods; the loop awaits all of
        // them, so a sync return is fine at runtime. Cast to the loop contract.
        let doneEv: LoopEvent | null = null;
        for await (const ev of runLoop(requirement, proposer as unknown as Proposer, {
          maxIters: MAX_ITERS,
          model,
        })) {
          recorder.logEvent(ev as unknown as Record<string, unknown>);
          if (ev.type === "done") {
            doneEv = ev;
          }
          send(ev as unknown as Record<string, unknown>);
        }

        // grow the knowledge base from any web-discovered parts, then persist.
        let newParts: Component[] = [];
        const spec = doneEv?.spec as { bom?: BOM } | undefined;
        if (spec?.bom) {
          newParts = harvestWebParts(spec.bom, kb);
        }
        recorder.finalize(
          doneEv as unknown as Record<string, unknown> | null,
        );
        const learned = {
          type: "stored",
          build_id: buildId,
          new_parts: newParts,
          learned_total: learnedCount(),
          message:
            `Saved build ${buildId}. ` +
            (newParts.length
              ? `Added ${newParts.length} new part(s) to the library.`
              : "No new parts to learn this run."),
        };
        recorder.logEvent(learned);
        send(learned);
      } catch (err) {
        send({
          type: "error",
          message: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
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
