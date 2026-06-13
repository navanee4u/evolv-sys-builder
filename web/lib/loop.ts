// The self-correction loop -- Anvil's reason for existing.
//
//   Proposer proposes -> Verifier checks -> failures fed back -> Proposer revises
//   -> repeat, until every HARD constraint passes or MAX_ITERS.
//
// `runLoop` is an async generator of structured loop events. Those events ARE the
// demo: the API route streams them over SSE and the UI renders the rubric going
// red -> green. The verifier -- never the proposer -- decides pass/fail.
//
// Faithful port of anvil/backend/loop.py. The proposer methods are async here
// (the LLM proposer makes network calls); everything else mirrors the Python
// one-for-one, including the exact event types, messages and payloads.

import type {
  BOM,
  Check,
  Constraint,
  Requirement,
  SpecResult,
} from "@/lib/types";
import { allHardPass, failingHard } from "@/lib/types";
import { verify } from "@/lib/verifier";
import * as memory from "@/lib/memory";

export const MAX_ITERS = 6;

/** A single loop event. `type` selects the UI handler; `message` is the
 *  human-readable narration; everything else is type-specific payload. */
export interface LoopEvent {
  type:
    | "parse"
    | "rubric"
    | "consult"
    | "propose"
    | "spec"
    | "fail"
    | "investigate"
    | "swap"
    | "pass"
    | "exhausted"
    | "distill"
    | "done";
  message: string;
  [key: string]: unknown;
}

/** The proposer interface the loop is agnostic to. Mirrors proposer.py /
 *  proposer_llm.py: it selects and revises the BOM but NEVER judges pass/fail.
 *  Methods are async because the real (LLM) proposer makes network calls; the
 *  deterministic stub simply resolves immediately. */
export interface Proposer {
  name: string;
  parse(requirement: Requirement): Promise<[Requirement, Constraint[]]>;
  initial(
    req: Requirement,
    rubric: Constraint[],
    rules: string,
  ): Promise<[BOM, string[]]>;
  revise(
    req: Requirement,
    rubric: Constraint[],
    result: SpecResult,
  ): Promise<[BOM, string[]]>;
}

export interface RunLoopOpts {
  maxIters?: number;
  model?: string | null;
}

function ev(type: LoopEvent["type"], message = "", payload: Record<string, unknown> = {}): LoopEvent {
  return { type, message, ...payload };
}

function countHard(checks: Check[], status?: "pass" | "fail"): number {
  return checks.filter(
    (c) => c.kind === "hard" && (status === undefined || c.status === status),
  ).length;
}

/** Run the self-correction loop, yielding one structured event per meaningful
 *  step. Identical in behavior to loop.run() in anvil/backend/loop.py. */
export async function* runLoop(
  requirement: Requirement,
  proposer: Proposer,
  opts: RunLoopOpts = {},
): AsyncGenerator<LoopEvent, void, unknown> {
  const maxIters = opts.maxIters ?? MAX_ITERS;
  const name = requirement.name ?? "untitled";

  yield ev("parse", `Parsing requirements for '${name}'…`, {
    requirement,
    model: opts.model ?? proposer.name ?? "?",
  });

  const [req, rubric] = await proposer.parse(requirement);
  yield ev(
    "rubric",
    `Built rubric: ${rubric.length} constraints ` +
      `(${rubric.filter((c) => c.kind === "hard").length} hard).`,
    { rubric },
  );

  const rules = await memory.loadRules();
  const nrules = (await memory.ruleLines()).length;
  const failures = await memory.loadFailures();
  yield ev(
    "consult",
    `Consulted memory: ${nrules} distilled rule(s), ` +
      `${failures.length} past failure(s) on file.`,
    { rules: await memory.ruleLines() },
  );

  let [bom, notes] = await proposer.initial(req, rubric, rules);
  for (const n of notes) {
    yield ev("propose", n);
  }

  // track which dimensions ever failed, so we can distill only real fixes
  const everFailed = new Map<string, string>(); // constraint_id -> first failure reason
  let final: SpecResult | null = null;

  for (let it = 1; it <= maxIters; it++) {
    const result = verify(bom, rubric, it);
    final = result;
    const cov = Math.round(result.coverage * 100);
    yield ev(
      "spec",
      `Iteration ${it}: coverage ${cov}%  ` +
        `(${countHard(result.checks, "pass")}/${countHard(result.checks)} hard passing)`,
      { spec: result },
    );

    if (allHardPass(result)) {
      yield ev(
        "pass",
        `All hard constraints satisfied — coverage 100% at iteration ${it}.`,
        { spec: result },
      );
      break;
    }

    const failing = failingHard(result);
    for (const fc of failing) {
      if (!everFailed.has(fc.constraint_id)) {
        everFailed.set(fc.constraint_id, fc.reason);
      }
      yield ev("fail", `✗ ${fc.constraint_id}: ${fc.reason}`, {
        constraint: fc.constraint_id,
        observed: fc.observed,
        required: fc.required,
      });
    }

    if (it === maxIters) {
      yield ev(
        "exhausted",
        `Reached ${maxIters} iterations with ${failing.length} ` +
          `hard constraint(s) still failing.`,
        { spec: result },
      );
      break;
    }

    yield ev("investigate", "Investigating failures and revising the BOM…");
    const [revisedBom, actions] = await proposer.revise(req, rubric, result);
    bom = revisedBom;
    for (const a of actions) {
      yield ev("swap", a);
    }
  }

  // ---- distill (outer loop) ------------------------------------------- //
  const newRules: string[] = [];
  if (final && allHardPass(final)) {
    for (const [dim, reason] of everFailed) {
      await memory.appendFailure(
        dim,
        failingPart(dim),
        reason,
        proposer.name === "stub"
          ? "resolved via deterministic re-selection"
          : "resolved via proposer revision",
      );
      const r = await memory.distillRule(dim);
      if (r) {
        newRules.push(r);
        yield ev("distill", `Learned: ${r}`, { rule: r });
      }
    }
  }

  yield ev(
    "done",
    `Final coverage ${Math.round((final ? final.coverage : 0) * 100)}% ` +
      `in ${final ? final.iteration : 0} iteration(s).`,
    {
      spec: final,
      coverage: final ? final.coverage : 0.0,
      soft_score: final ? final.soft_score : 0.0,
      iterations: final ? final.iteration : 0,
      new_rules: newRules,
      all_hard_pass: !!(final && allHardPass(final)),
    },
  );
}

function failingPart(dim: string): string {
  return dim;
}
