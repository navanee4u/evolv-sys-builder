"""The self-correction loop -- Anvil's reason for existing.

    Proposer proposes -> Verifier checks -> failures fed back -> Proposer revises
    -> repeat, until every HARD constraint passes or MAX_ITERS.

`run` is a generator of structured loop events. Those events ARE the demo: the
server streams them over SSE and the UI renders the rubric going red -> green.
The verifier -- never the proposer -- decides pass/fail.
"""

from __future__ import annotations

from typing import Iterator

from . import memory
from .schema import Requirement, SpecResult
from .verifier import verify

MAX_ITERS = 6


def _ev(type_, message="", **payload) -> dict:
    return {"type": type_, "message": message, **payload}


def run(requirement: Requirement, proposer, max_iters: int = MAX_ITERS,
        model: str | None = None) -> Iterator[dict]:
    yield _ev("parse", f"Parsing requirements for '{requirement.name}'…",
              requirement=requirement.to_dict(), model=model or getattr(proposer, "name", "?"))

    req, rubric = proposer.parse(requirement)
    yield _ev("rubric", f"Built rubric: {len(rubric)} constraints "
              f"({sum(1 for c in rubric if c.kind=='hard')} hard).",
              rubric=[c.to_dict() for c in rubric])

    rules = memory.load_rules()
    nrules = len(memory.rule_lines())
    yield _ev("consult",
              f"Consulted memory: {nrules} distilled rule(s), "
              f"{len(memory.load_failures())} past failure(s) on file.",
              rules=memory.rule_lines())

    bom, notes = proposer.initial(req, rubric, rules)
    for n in notes:
        yield _ev("propose", n)

    # track which dimensions ever failed, so we can distill only real fixes
    ever_failed: dict[str, str] = {}   # dim -> first failure reason
    final: SpecResult | None = None

    for it in range(1, max_iters + 1):
        result = verify(bom, rubric, iteration=it)
        final = result
        cov = int(round(result.coverage * 100))
        yield _ev("spec", f"Iteration {it}: coverage {cov}%  "
                  f"({sum(1 for c in result.checks if c.kind=='hard' and c.status=='pass')}/"
                  f"{sum(1 for c in result.checks if c.kind=='hard')} hard passing)",
                  spec=result.to_dict())

        if result.all_hard_pass:
            yield _ev("pass", f"All hard constraints satisfied — coverage 100% at iteration {it}.",
                      spec=result.to_dict())
            break

        for fc in result.failing_hard:
            ever_failed.setdefault(fc.constraint_id, fc.reason)
            yield _ev("fail", f"✗ {fc.constraint_id}: {fc.reason}",
                      constraint=fc.constraint_id, observed=fc.observed, required=fc.required)

        if it == max_iters:
            yield _ev("exhausted",
                      f"Reached {max_iters} iterations with {len(result.failing_hard)} "
                      f"hard constraint(s) still failing.", spec=result.to_dict())
            break

        yield _ev("investigate", "Investigating failures and revising the BOM…")
        bom, actions = proposer.revise(req, rubric, result)
        for a in actions:
            yield _ev("swap", a)

    # ---- distill (outer loop) ------------------------------------------- #
    new_rules: list[str] = []
    if final and final.all_hard_pass:
        for dim, reason in ever_failed.items():
            memory.append_failure(dim, _failing_part(dim, reason), reason,
                                  "resolved via deterministic re-selection" if proposer.name == "stub"
                                  else "resolved via proposer revision")
            r = memory.distill_rule(dim)
            if r:
                new_rules.append(r)
                yield _ev("distill", f"Learned: {r}", rule=r)

    yield _ev("done",
              f"Final coverage {int(round((final.coverage if final else 0)*100))}% "
              f"in {final.iteration if final else 0} iteration(s).",
              spec=final.to_dict() if final else None,
              coverage=final.coverage if final else 0.0,
              soft_score=final.soft_score if final else 0.0,
              iterations=final.iteration if final else 0,
              new_rules=new_rules,
              all_hard_pass=bool(final and final.all_hard_pass))


def _failing_part(dim, reason) -> str:
    return dim
