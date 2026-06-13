"""The real proposer: an LLM selects and revises the BOM, KB-first, with web
search for parts not in the library. Model is selectable at runtime.

It still NEVER judges pass/fail -- it only proposes. The verifier decides, and
the loop feeds verifier failures back here so the model must INVESTIGATE the
named failure rather than reshuffle blindly.

Robustness: if the Anthropic SDK or API key is unavailable, or the model returns
unusable output, we fall back to the deterministic StubProposer so the demo
always closes the loop. Provenance is tracked: KB parts are source="kb", parts
the model introduces (e.g. via web search) are source="web".
"""

from __future__ import annotations

import json
import os

from .schema import Component, Requirement, empty_bom, all_components, SpecResult
from .proposer import StubProposer, build_rubric, load_kb

VALID_MODELS = {"claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"}


def _kb_digest(kb) -> str:
    """Compact catalogue the model can choose from, by id."""
    lines = []
    for sub, parts in kb.items():
        for p in parts:
            d = p.to_dict()
            d.pop("source", None)
            lines.append(json.dumps({"id": p.id, "subsystem": sub, **{k: v for k, v in d.items()
                                     if k not in ("id", "subsystem", "name", "vendor", "part_number")},
                                     "name": p.name}))
    return "\n".join(lines)


class LLMProposer:
    def __init__(self, model: str, kb=None, recorder=None):
        if model not in VALID_MODELS:
            raise ValueError(f"unknown model {model!r}")
        self.model = model
        self.name = model
        self.kb = kb or load_kb()
        self.recorder = recorder                     # store.BuildRecorder | None
        self._stub = StubProposer(self.kb)          # fallback + rubric builder
        self._kb_by_id = {p.id: p for parts in self.kb.values() for p in parts}
        self._client = self._make_client()

    def _make_client(self):
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return None
        try:
            from anthropic import Anthropic
            return Anthropic()
        except Exception:
            return None

    @property
    def available(self) -> bool:
        return self._client is not None

    # -- loop interface ----------------------------------------------------- #

    def parse(self, requirement: Requirement):
        # the frontend already sends a structured Requirement; the rubric is
        # deterministic from there so the checklist is reproducible.
        return requirement, build_rubric(requirement)

    def initial(self, req: Requirement, rubric, rules: str = ""):
        if not self.available:
            bom, notes = self._stub.initial(req, rubric, rules)
            return bom, ["(no API key — deterministic proposer) " + notes[0]] + notes[1:] if notes else notes
        sys_prompt, user = self._build_prompt(req, rubric, rules, result=None)
        bom, notes = self._ask(sys_prompt, user, phase="initial")
        if bom is None:
            sbom, snotes = self._stub.initial(req, rubric, rules)
            return sbom, self._fallback_notes(notes) + snotes
        return bom, notes

    def revise(self, req: Requirement, rubric, result: SpecResult):
        if not self.available:
            return self._stub.revise(req, rubric, result)
        sys_prompt, user = self._build_prompt(req, rubric, None, result=result)
        bom, notes = self._ask(sys_prompt, user, current=result.bom,
                               phase=f"revise@iter{result.iteration}")
        if bom is None:
            sbom, snotes = self._stub.revise(req, rubric, result)
            return sbom, self._fallback_notes(notes) + snotes
        return bom, notes

    def _fallback_notes(self, notes):
        why = notes[0] if notes else "unusable response"
        return [f"⚠ {self.model} fell back to the deterministic proposer ({why})."]

    # -- LLM plumbing ------------------------------------------------------- #

    def _build_prompt(self, req, rubric, rules, result):
        system = (
            "You are Anvil's hardware Proposer. You select real components into a "
            "bill of materials. You do NOT decide pass/fail — a deterministic "
            "verifier does. Prefer parts from the provided catalogue (source=kb); "
            "if nothing fits, you may introduce a real part you know of and mark "
            "it source=web with honest specs. Never invent specs.\n\n"
            "Respond with ONLY a JSON object as your ENTIRE message — begin with { "
            "and end with } , no prose, no markdown fences. Schema: {\"select\": "
            "[\"<kb id>\", ...], \"web\": [<full component object>...], "
            "\"notes\": [\"short narration\"...]}.\n"
            "Pick exactly one part per needed subsystem unless a constraint needs "
            "more (e.g. radio + antenna, motor + driver, regulator + battery). "
            "Do NOT use web_search unless a required part is absent from the catalogue."
        )
        if rules:
            system += f"\n\nDistilled rules from past runs — apply them up front:\n{rules}"

        parts = [f"Requirement:\n{json.dumps(req.to_dict(), default=str)}",
                 f"\nRubric (hard constraints gate the design):\n" +
                 "\n".join(f"- {c.id} [{c.kind}]: {c.predicate}" for c in rubric),
                 f"\nComponent catalogue (choose by id):\n{_kb_digest(self.kb)}"]
        if result is not None:
            parts.append("\nThe verifier REJECTED the current BOM. Investigate each "
                         "failing constraint and revise the responsible subsystem:\n" +
                         "\n".join(f"- FAIL {c.constraint_id}: {c.reason}" for c in result.failing_hard))
            parts.append("\nCurrent selection: " +
                         json.dumps([p.id for p in all_components(result.bom)]))
        return system, "\n".join(parts)

    def _ask(self, system, user, current=None, phase="propose"):
        import time
        t0 = time.time()
        rec = {"phase": phase, "model": self.model, "request": {
            "system": system, "messages": [{"role": "user", "content": user}],
            "max_tokens": 4096, "tools": ["web_search_20250305"]}}
        try:
            resp = self._client.messages.create(
                model=self.model, max_tokens=4096, system=system,
                messages=[{"role": "user", "content": user}],
                tools=[{"type": "web_search_20250305", "name": "web_search"}],
            )
            rec["latency_ms"] = int((time.time() - t0) * 1000)
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
            rec["response"] = self._dump(resp)
            rec["response_text"] = text
            rec["usage"] = self._dump(getattr(resp, "usage", None))
            data = _extract_json(text)
            if not data:
                rec["outcome"] = "unparseable"
                self._record(rec)
                return None, ["unparseable response"]
            rec["outcome"] = "ok"
            rec["parsed"] = data
            self._record(rec)
            return self._materialize(data, current)
        except Exception as e:
            rec["latency_ms"] = int((time.time() - t0) * 1000)
            msg = str(e)
            if "not_found" in msg or "404" in msg:
                msg = f"{self.model} not available on this API key"
            rec["outcome"] = "error"
            rec["error"] = str(e)[:500]
            self._record(rec)
            return None, [msg[:140]]

    def _record(self, rec):
        if self.recorder is not None:
            try:
                self.recorder.log_api_call(rec)
            except Exception:
                pass

    @staticmethod
    def _dump(obj):
        if obj is None:
            return None
        for attr in ("model_dump", "to_dict", "dict"):
            fn = getattr(obj, attr, None)
            if callable(fn):
                try:
                    return fn()
                except Exception:
                    pass
        return str(obj)

    def _materialize(self, data, current):
        bom = empty_bom()
        # start from current selection so unaddressed subsystems persist on revise
        if current is not None:
            for p in all_components(current):
                bom["subsystems"][p.subsystem].append(p)

        def place(comp: Component):
            bom["subsystems"][comp.subsystem] = [
                c for c in bom["subsystems"][comp.subsystem] if c.subsystem != comp.subsystem or True]
            # replace any existing of same subsystem-role only if model re-selected it
            bom["subsystems"][comp.subsystem].append(comp)

        # selected KB ids replace their subsystems
        chosen_subs = set()
        picks = []
        for cid in data.get("select", []):
            p = self._kb_by_id.get(cid)
            if p:
                picks.append(p)
                chosen_subs.add(p.subsystem)
        for raw in data.get("web", []):
            try:
                c = Component.from_dict({**raw, "source": "web"})
                picks.append(c)
                chosen_subs.add(c.subsystem)
            except Exception:
                continue
        # rebuild touched subsystems from picks; keep untouched ones from current
        for sub in chosen_subs:
            bom["subsystems"][sub] = [p for p in picks if p.subsystem == sub]
        notes = [str(n) for n in data.get("notes", [])][:8] or \
                [f"selected {len(picks)} component(s)"]
        return bom, notes


def _extract_json(text: str):
    text = text.strip()
    # strip a ```json … ``` fence if present
    if "```" in text:
        import re
        m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                pass
    start = text.find("{")
    if start == -1:
        return None
    # scan for the first balanced {...} object (robust to prose with braces)
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    break
    # last resort: greedy first-to-last
    try:
        return json.loads(text[start:text.rfind("}") + 1])
    except json.JSONDecodeError:
        return None


def make_proposer(model: str, kb=None, recorder=None):
    """Factory used by the server. 'stub' -> deterministic; else LLM (with fallback)."""
    if model == "stub":
        return StubProposer(kb)
    return LLMProposer(model, kb, recorder=recorder)


# --------------------------------------------------------------------------- #
# Conversational requirement intake
# --------------------------------------------------------------------------- #

_INTAKE_SYSTEM = (
    "You are Anvil's requirements interviewer. A hardware engineer describes a robot "
    "or embedded system in plain English; your job is to turn that into a structured, "
    "machine-checkable requirement so they never have to guess arbitrary numbers.\n\n"
    "Behaviour:\n"
    "- If a CRITICAL dimension is missing or ambiguous, ask ONE short, friendly clarifying "
    "question (batch a couple at most). Critical dimensions: power budget, runtime, compute "
    "workload (TOPS), operating temperature, ingress protection, mass, enclosure size, "
    "camera, comms, actuation — but only those that matter for THIS system.\n"
    "- Otherwise, infer sensible engineering defaults from the use-case and proceed. Always "
    "explain the values you chose in one line each so the user can correct them.\n\n"
    "Respond with ONLY a JSON object (no prose outside it):\n"
    "{\n"
    '  "status": "need_info" | "ready",\n'
    '  "message": "your reply to the user (a question, or a summary of the spec you built)",\n'
    '  "rationale": ["why power=…", "why temp=…", ...],   // only when ready\n'
    '  "requirement": {                                    // null when need_info\n'
    '     "name": str, "power_budget_W": num, "runtime_h": num, "workload_TOPS": num,\n'
    '     "model_footprint_GB": num, "temp_C": [min,max], "ip_rating": "IP67",\n'
    '     "mass_budget_g": num, "enclosure_mm": [x,y,z],\n'
    '     "camera": {"mp": num, "fps": num, "interface": "MIPI-CSI"},\n'
    '     "comms": ["5GHz","UWB"], "actuation": {"torque_Nm": num, "continuous_current_A": num}\n'
    "  }\n"
    "}\n"
    "Omit requirement keys that don't apply to the system (e.g. no camera on a motor controller)."
)


def converse_intake(messages: list[dict], model: str = "claude-opus-4-8") -> dict:
    """Interview-style requirement extraction. `messages` is the running chat
    [{role, content}, ...]. Returns the parsed JSON object (status/message/requirement)."""
    if model not in VALID_MODELS:
        model = "claude-opus-4-8"
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"status": "error",
                "message": "Conversational intake needs an ANTHROPIC_API_KEY. Use the manual form, or set the key and restart.",
                "requirement": None}
    try:
        from anthropic import Anthropic
        client = Anthropic()
        resp = client.messages.create(
            model=model, max_tokens=1500, system=_INTAKE_SYSTEM,
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        data = _extract_json(text)
        if not data:
            return {"status": "need_info", "message": text or "Could you tell me more about the system?",
                    "requirement": None}
        return data
    except Exception as e:
        msg = str(e)
        if "not_found" in msg or "404" in msg:
            msg = f"{model} is not available on this API key — try Opus 4.8 or Sonnet 4.6."
        return {"status": "error", "message": msg[:200], "requirement": None}
