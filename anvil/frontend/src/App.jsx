import { useEffect, useRef, useState } from "react";

/* --------------------------------------------------------------------------
   Anvil — the window into the self-correction loop.
   Four regions, all driven by the SSE event stream from /api/run:
     1. Requirement intake -> live rubric checklist (grey -> red -> green)
     2. BOM tree by subsystem with kb/web provenance; parts flash on swap
     3. Activity stream — the agent's narration of the correction
     4. Header — model selector, iteration, coverage % (hero metric), memory
-------------------------------------------------------------------------- */

const PRESETS = {
  drone: {
    name: "Outdoor Inspection Drone Payload",
    power_budget_W: 12.0, runtime_min: 45, workload_TOPS: 21, model_footprint_GB: 6,
    temp_min: -20, temp_max: 60, ip_rating: "IP67", mass_budget_g: 450,
    enc_x: 120, enc_y: 80, enc_z: 40, cam_mp: 8.29, cam_fps: 30, comms: "5GHz, UWB",
    torque_Nm: "", cont_A: "",
  },
  arm: {
    name: "Indoor Robot Arm Joint",
    power_budget_W: 18.0, runtime_min: 120, workload_TOPS: 20, model_footprint_GB: 4,
    temp_min: 0, temp_max: 50, ip_rating: "IP54", mass_budget_g: 800,
    enc_x: 140, enc_y: 100, enc_z: 60, cam_mp: "", cam_fps: "", comms: "",
    torque_Nm: 0.4, cont_A: 1.5,
  },
};

function formToRequirement(f) {
  const req = { name: f.name };
  const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
  if (num(f.power_budget_W) != null) req.power_budget_W = num(f.power_budget_W);
  if (num(f.runtime_min) != null) req.runtime_h = num(f.runtime_min) / 60;
  if (num(f.workload_TOPS) != null) req.workload_TOPS = num(f.workload_TOPS);
  if (num(f.model_footprint_GB) != null) req.model_footprint_GB = num(f.model_footprint_GB);
  if (num(f.temp_min) != null && num(f.temp_max) != null) req.temp_C = [num(f.temp_min), num(f.temp_max)];
  if (f.ip_rating) req.ip_rating = f.ip_rating;
  if (num(f.mass_budget_g) != null) req.mass_budget_g = num(f.mass_budget_g);
  if (num(f.enc_x) != null) req.enclosure_mm = [num(f.enc_x), num(f.enc_y), num(f.enc_z)];
  if (num(f.cam_mp) != null) req.camera = { mp: num(f.cam_mp), fps: num(f.cam_fps) || 30, interface: "MIPI-CSI" };
  if (f.comms && f.comms.trim()) req.comms = f.comms.split(",").map((s) => s.trim()).filter(Boolean);
  if (num(f.torque_Nm) != null) req.actuation = { torque_Nm: num(f.torque_Nm), continuous_current_A: num(f.cont_A) || 0 };
  return req;
}

const BLANK_FORM = {
  name: "", power_budget_W: "", runtime_min: "", workload_TOPS: "", model_footprint_GB: "",
  temp_min: "", temp_max: "", ip_rating: "", mass_budget_g: "", enc_x: "", enc_y: "", enc_z: "",
  cam_mp: "", cam_fps: "", comms: "", torque_Nm: "", cont_A: "",
};

function requirementToForm(req = {}) {
  const f = { ...BLANK_FORM, name: req.name || "" };
  const s = (k, v) => { if (v !== undefined && v !== null) f[k] = v; };
  s("power_budget_W", req.power_budget_W);
  if (req.runtime_h != null) f.runtime_min = Math.round(req.runtime_h * 60);
  s("workload_TOPS", req.workload_TOPS);
  s("model_footprint_GB", req.model_footprint_GB);
  if (req.temp_C) { f.temp_min = req.temp_C[0]; f.temp_max = req.temp_C[1]; }
  s("ip_rating", req.ip_rating);
  s("mass_budget_g", req.mass_budget_g);
  if (req.enclosure_mm) { f.enc_x = req.enclosure_mm[0]; f.enc_y = req.enclosure_mm[1]; f.enc_z = req.enclosure_mm[2]; }
  if (req.camera) { f.cam_mp = req.camera.mp; f.cam_fps = req.camera.fps || 30; }
  if (req.comms) f.comms = req.comms.join(", ");
  if (req.actuation) { f.torque_Nm = req.actuation.torque_Nm; f.cont_A = req.actuation.continuous_current_A; }
  return f;
}

async function streamSSE(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
    }
  }
}

/* ---- small UI atoms ---- */

function CoverageRing({ value }) {
  const r = 34, c = 2 * Math.PI * r;
  const off = c * (1 - value);
  const col = value >= 1 ? "var(--color-pass)" : value > 0 ? "var(--color-warn)" : "var(--color-edge)";
  return (
    <svg width="92" height="92" viewBox="0 0 92 92" className="shrink-0">
      <circle cx="46" cy="46" r={r} fill="none" strokeWidth="8" className="ring-track" />
      <circle cx="46" cy="46" r={r} fill="none" strokeWidth="8" strokeLinecap="round"
        stroke={col} strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 46 46)" style={{ transition: "stroke-dashoffset .6s ease, stroke .6s" }} />
      <text x="46" y="44" textAnchor="middle" className="mono" fill="var(--color-ink)" fontSize="20" fontWeight="700">
        {Math.round(value * 100)}%
      </text>
      <text x="46" y="60" textAnchor="middle" fill="var(--color-ink-dim)" fontSize="9" letterSpacing="1.5">COVERAGE</text>
    </svg>
  );
}

function statusColor(s) {
  return s === "pass" ? "var(--color-pass)" : s === "fail" ? "var(--color-fail)" : "var(--color-ink-dim)";
}

function RubricRow({ c }) {
  const s = c.status || "pending";
  const cls = s === "pass" ? "glow-pass" : s === "fail" ? "glow-fail" : "";
  return (
    <div className={`row-state flex items-center gap-3 px-3 py-2 rounded-lg border ${cls}`}
      style={{ borderColor: "var(--color-edge)", background: "var(--color-panel)" }}>
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: statusColor(s) }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="mono text-[13px]" style={{ color: "var(--color-ink)" }}>{c.id}</span>
          {c.kind === "soft" && <span className="text-[9px] px-1 rounded" style={{ background: "var(--color-edge)", color: "var(--color-ink-dim)" }}>SOFT</span>}
        </div>
        {c.reason && <div className="text-[11px] mt-0.5 truncate" style={{ color: "var(--color-ink-dim)" }}>{c.reason}</div>}
      </div>
      <span className="mono text-[10px] uppercase tracking-wider" style={{ color: statusColor(s) }}>{s}</span>
    </div>
  );
}

const SUB_LABEL = {
  compute: "Compute", power: "Power", sensing: "Sensing", comms: "Comms / Antenna",
  actuation: "Actuation", mechanical: "Mechanical", connector: "Interconnect",
};

function field(c, label, val, unit = "") {
  if (val === undefined || val === null) return null;
  return (
    <div key={label} className="flex justify-between gap-2">
      <span style={{ color: "var(--color-ink-dim)" }}>{label}</span>
      <span className="mono" style={{ color: "var(--color-ink)" }}>{Array.isArray(val) ? val.join("×") : val}{unit}</span>
    </div>
  );
}

function BomCard({ c }) {
  return (
    <div className="flash-pass row-state rounded-lg border p-2.5" style={{ borderColor: "var(--color-edge)", background: "var(--color-panel)" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium truncate" style={{ color: "var(--color-ink)" }}>{c.name || c.id}</div>
          <div className="mono text-[10px] truncate" style={{ color: "var(--color-ink-dim)" }}>{c.vendor} · {c.part_number || c.id}</div>
        </div>
        <span className="text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0"
          style={{ background: c.source === "web" ? "rgba(2,132,199,.12)" : "var(--color-edge)", color: c.source === "web" ? "var(--color-accent)" : "var(--color-ink-dim)" }}>
          {c.source}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        {field(c, "active", c.active_power_W, " W")}
        {field(c, "peak", c.peak_power_W, " W")}
        {field(c, "TOPS", c.compute_TOPS)}
        {field(c, "RAM", c.ram_GB, " GB")}
        {field(c, "battery", c.battery_Wh, " Wh")}
        {field(c, "rails", c.rails_provided)}
        {field(c, "rail A", c.rail_current_A, " A")}
        {field(c, "res", c.resolution_mp, " MP")}
        {field(c, "fps", c.fps)}
        {field(c, "bands", c.radio_bands)}
        {field(c, "ant", c.antenna_count ? `×${c.antenna_count}` : undefined)}
        {field(c, "torque", c.torque_Nm, " N·m")}
        {field(c, "drv A", c.driver_current_A, " A")}
        {field(c, "IP", c.ip_rating)}
        {field(c, "mass", c.mass_g, " g")}
        {field(c, "temp", c.temp_op_C ? `${c.temp_op_C[0]}…${c.temp_op_C[1]}°C` : undefined)}
        {field(c, "cost", c.cost_usd ? `$${c.cost_usd}` : undefined)}
      </div>
    </div>
  );
}

const ACT_STYLE = {
  fail: { c: "var(--color-fail)", g: "✗" }, swap: { c: "var(--color-accent)", g: "⟳" },
  pass: { c: "var(--color-pass)", g: "✓" }, distill: { c: "var(--color-warn)", g: "✎" },
  investigate: { c: "var(--color-accent)", g: "→" }, propose: { c: "var(--color-ink-dim)", g: "·" },
  consult: { c: "var(--color-ink-dim)", g: "▤" }, parse: { c: "var(--color-ink-dim)", g: "▸" },
  rubric: { c: "var(--color-ink-dim)", g: "☰" }, spec: { c: "var(--color-ink-dim)", g: "∑" },
  done: { c: "var(--color-pass)", g: "■" }, note: { c: "var(--color-warn)", g: "!" },
  exhausted: { c: "var(--color-fail)", g: "✗" },
  build_started: { c: "var(--color-ink-dim)", g: "▶" }, stored: { c: "var(--color-warn)", g: "💾" },
};

function ActivityItem({ e }) {
  const st = ACT_STYLE[e.type] || { c: "var(--color-ink-dim)", g: "·" };
  return (
    <div className="flex gap-2.5 py-1.5 text-[12px] leading-snug">
      <span className="mono shrink-0 mt-px" style={{ color: st.c }}>{st.g}</span>
      <span style={{ color: e.type === "fail" || e.type === "swap" || e.type === "distill" ? "var(--color-ink)" : "var(--color-ink-dim)" }}>
        {e.message}
      </span>
    </div>
  );
}

/* ---- main ---- */

export default function App() {
  const [form, setForm] = useState(PRESETS.drone);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("claude-fable-5");
  const [llmReady, setLlmReady] = useState(false);
  const [running, setRunning] = useState(false);

  const [rubric, setRubric] = useState([]);
  const [bom, setBom] = useState(null);
  const [activity, setActivity] = useState([]);
  const [rules, setRules] = useState([]);
  const [iteration, setIteration] = useState(0);
  const [coverage, setCoverage] = useState(0);
  const [softScore, setSoftScore] = useState(0);
  const [bench, setBench] = useState(null); // {model: {coverage, iterations, done}}
  const [showAbout, setShowAbout] = useState(false);
  const [inputMode, setInputMode] = useState("describe"); // describe | manual
  const [chat, setChat] = useState([]);     // {role, content}
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [rationale, setRationale] = useState([]);
  const [reqReady, setReqReady] = useState(false);
  const [builds, setBuilds] = useState([]);
  const [learnedCount, setLearnedCount] = useState(0);
  const abortRef = useRef(null);
  const actEndRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetch("/api/models").then((r) => r.json()).then((d) => {
      setModels(d.models); setModel(d.default); setLlmReady(d.llm_ready);
    }).catch(() => {});
    fetch("/api/memory").then((r) => r.json()).then((d) => setRules(d.rules || [])).catch(() => {});
    fetchBuilds();
  }, []);

  useEffect(() => { actEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [activity]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat, chatBusy]);

  function fetchBuilds() {
    fetch("/api/builds").then((r) => r.json()).then((d) => {
      setBuilds(d.builds || []); setLearnedCount(d.learned_parts || 0);
    }).catch(() => {});
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const msgs = [...chat, { role: "user", content: text }];
    setChat(msgs); setChatInput(""); setChatBusy(true);
    try {
      const r = await fetch("/api/intake", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs, model: model === "stub" ? "claude-opus-4-8" : model }),
      });
      const d = await r.json();
      setChat((c) => [...c, { role: "assistant", content: d.message || "(no response)" }]);
      if (d.status === "ready" && d.requirement) {
        setForm(requirementToForm(d.requirement));
        setRationale(d.rationale || []);
        setReqReady(true);
      } else {
        setReqReady(false);
      }
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", content: "Error: " + e.message }]);
    } finally { setChatBusy(false); }
  }

  function loadBuild(id) {
    fetch("/api/builds/" + id).then((r) => r.json()).then((d) => {
      if (d.requirement) { setForm(requirementToForm(d.requirement)); setInputMode("manual"); setReqReady(false); }
    }).catch(() => {});
  }

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function applyPreset(k) { setForm(PRESETS[k]); }

  function applySpec(spec) {
    if (!spec) return;
    const byId = Object.fromEntries(spec.checks.map((c) => [c.constraint_id, c]));
    setRubric((prev) => prev.map((c) => ({ ...c, ...(byId[c.id] || {}) })));
    setBom(spec.bom);
    setIteration(spec.iteration);
    setCoverage(spec.coverage);
    setSoftScore(spec.soft_score);
  }

  function handleEvent(ev) {
    if (ev.type === "rubric") {
      setRubric(ev.rubric.map((c) => ({ ...c, status: "pending" })));
    } else if (ev.type === "consult") {
      if (ev.rules) setRules(ev.rules);
    } else if (ev.type === "distill" && ev.rule) {
      setRules((r) => (r.includes(ev.rule) ? r : [...r, ev.rule]));
    } else if (ev.type === "stored") {
      if (typeof ev.learned_total === "number") setLearnedCount(ev.learned_total);
      fetchBuilds();
    }
    if (ev.spec) applySpec(ev.spec);
    if (["build_started", "parse", "rubric", "consult", "propose", "fail", "investigate", "swap",
      "pass", "distill", "exhausted", "note", "done", "stored"].includes(ev.type)) {
      setActivity((a) => [...a, ev]);
    }
  }

  async function runLoop() {
    if (running) return;
    setRunning(true); setActivity([]); setBom(null); setRubric([]);
    setIteration(0); setCoverage(0); setSoftScore(0); setBench(null);
    abortRef.current = new AbortController();
    const body = { requirement: formToRequirement(form), model };
    try {
      await streamSSE("/api/run", body, handleEvent, abortRef.current.signal);
    } catch (e) {
      setActivity((a) => [...a, { type: "note", message: "Stream ended: " + e.message }]);
    } finally { setRunning(false); }
  }

  async function runBench() {
    if (running) return;
    setRunning(true); setActivity([]); setBom(null); setRubric([]);
    setIteration(0); setCoverage(0); setSoftScore(0);
    const benchModels = llmReady ? ["claude-opus-4-8", "claude-sonnet-4-6", "stub"] : ["stub"];
    setBench(Object.fromEntries(benchModels.map((m) => [m, { coverage: 0, iterations: 0, done: false }])));
    abortRef.current = new AbortController();
    const body = { requirement: formToRequirement(form), models: benchModels };
    try {
      await streamSSE("/api/bench", body, (ev) => {
        if (ev.type === "done" && ev.model) {
          setBench((b) => ({ ...b, [ev.model]: { coverage: ev.coverage, iterations: ev.iterations, done: true } }));
        }
        if (ev.model) ev.message = `[${ev.model}] ${ev.message}`;
        handleEvent(ev);
      }, abortRef.current.signal);
    } catch (e) { /* */ } finally { setRunning(false); }
  }

  function stop() { abortRef.current?.abort(); setRunning(false); }

  const hardChecks = rubric.filter((c) => c.kind === "hard");
  const softChecks = rubric.filter((c) => c.kind === "soft");
  const subsystems = bom ? Object.entries(bom.subsystems).filter(([, v]) => v.length) : [];

  return (
    <div className="min-h-full p-4 lg:p-6 max-w-[1500px] mx-auto">
      {/* HEADER */}
      <header className="surface px-5 py-4 mb-4 flex items-center gap-5 flex-wrap">
        <CoverageRing value={coverage} />
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xl font-bold tracking-tight" style={{ color: "var(--color-accent-deep)" }}>ANVIL</span>
            <span className="text-[11px] eyebrow mono px-2 py-0.5 rounded" style={{ background: "#ecfbff", color: "var(--color-accent)" }}>
              autonomous hardware architect
            </span>
            <span className="text-[11px] mono px-2 py-0.5 rounded" style={{ background: "#f1ecff", color: "var(--color-accent-2)" }}>
              by rapidflare
            </span>
            <button onClick={() => setShowAbout(true)}
              className="text-[11px] px-2 py-0.5 rounded border ml-1 hover:border-[var(--color-accent)]"
              style={{ borderColor: "var(--color-edge)", color: "var(--color-ink-dim)" }}>
              About the app ↗
            </button>
          </div>
          <div className="text-[12px] mt-1" style={{ color: "var(--color-ink-dim)" }}>
            Proposer proposes → <span style={{ color: "var(--color-ink)" }}>Verifier</span> checks → failures fed back → revise → repeat.
            <span className="ml-2">Iteration <b className="mono" style={{ color: "var(--color-ink)" }}>{iteration}</b></span>
            <span className="ml-2">· soft score <b className="mono" style={{ color: "var(--color-ink)" }}>{Math.round(softScore * 100)}%</b></span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}
            className="mono text-[13px] px-3 py-2 rounded-lg border outline-none"
            style={{ background: "var(--color-panel)", borderColor: "var(--color-edge)", color: "var(--color-ink)" }}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {!running ? (
            <>
              <button onClick={runLoop} className="px-4 py-2 rounded-lg font-semibold text-[14px]"
                style={{ background: "var(--color-accent)", color: "#ffffff" }}>Run loop</button>
              <button onClick={runBench} title="Run the same requirement across models"
                className="px-3 py-2 rounded-lg font-medium text-[13px] border"
                style={{ borderColor: "var(--color-edge)", color: "var(--color-ink)" }}>Model Bench</button>
            </>
          ) : (
            <button onClick={stop} className="px-4 py-2 rounded-lg font-semibold text-[14px] border"
              style={{ borderColor: "var(--color-fail)", color: "var(--color-fail)" }}>
              <span className="live-dot">● </span>Stop
            </button>
          )}
        </div>
        {!llmReady && (
          <div className="w-full text-[11px] mono px-3 py-1.5 rounded" style={{ background: "rgba(244,183,64,.1)", color: "var(--color-warn)" }}>
            No ANTHROPIC_API_KEY detected — LLM models fall back to the deterministic proposer. The verifier &amp; loop are unaffected.
          </div>
        )}
      </header>

      {/* BENCH STRIP */}
      {bench && (
        <div className="surface px-5 py-3 mb-4">
          <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: "var(--color-ink-dim)" }}>Model Bench — same requirement, final coverage</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Object.keys(bench).length}, minmax(0,1fr))` }}>
            {Object.entries(bench).map(([m, r]) => (
              <div key={m} className="rounded-lg border p-3" style={{ borderColor: "var(--color-edge)", background: "var(--color-panel)" }}>
                <div className="mono text-[12px] mb-2" style={{ color: "var(--color-ink)" }}>{m}</div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--color-edge)" }}>
                  <div style={{ width: `${r.coverage * 100}%`, background: r.coverage >= 1 ? "var(--color-pass)" : "var(--color-warn)", height: "100%", transition: "width .5s" }} />
                </div>
                <div className="flex justify-between mt-1.5 mono text-[11px]">
                  <span style={{ color: r.coverage >= 1 ? "var(--color-pass)" : "var(--color-warn)" }}>{Math.round(r.coverage * 100)}%</span>
                  <span style={{ color: "var(--color-ink-dim)" }}>{r.done ? `${r.iterations} iters` : "…"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_1fr] gap-4">
        {/* LEFT: intake + rubric + memory */}
        <div className="flex flex-col gap-4">
          <section className="surface p-4">
            <SectionTitle n="1" t="Requirements" sub={inputMode === "describe" ? "conversational" : "manual"} />
            <div className="flex gap-1 mb-3 p-1 rounded-lg" style={{ background: "var(--color-panel)" }}>
              {["describe", "manual"].map((m) => (
                <button key={m} onClick={() => setInputMode(m)}
                  className="flex-1 text-[12px] py-1.5 rounded-md capitalize transition-colors"
                  style={inputMode === m
                    ? { background: "var(--color-edge)", color: "var(--color-ink)" }
                    : { color: "var(--color-ink-dim)" }}>
                  {m === "describe" ? "Describe it" : "Manual"}
                </button>
              ))}
            </div>

            {inputMode === "describe" ? (
              <div>
                <div className="space-y-2 max-h-64 overflow-auto mb-2 pr-1">
                  {chat.length === 0 && (
                    <div className="text-[12px] leading-relaxed" style={{ color: "var(--color-ink-dim)" }}>
                      Describe your system in plain English — e.g. <i>“an outdoor inspection drone that flies 40 min,
                      runs a vision model, IP-sealed, under ~450 g.”</i> I’ll turn it into a checkable spec and fill in
                      sensible engineering defaults so you’re not guessing numbers.
                    </div>
                  )}
                  {chat.map((m, i) => <ChatBubble key={i} m={m} />)}
                  {chatBusy && <div className="text-[11px] live-dot" style={{ color: "var(--color-accent)" }}>● interviewing…</div>}
                  <div ref={chatEndRef} />
                </div>
                {reqReady && (
                  <div className="rounded-lg border p-2.5 mb-2 glow-pass" style={{ borderColor: "var(--color-pass)", background: "var(--color-panel)" }}>
                    <div className="text-[11px] font-semibold mb-1" style={{ color: "var(--color-pass)" }}>✓ Spec ready — loaded into the form</div>
                    {rationale.slice(0, 8).map((r, i) => (
                      <div key={i} className="text-[10.5px] flex gap-1.5" style={{ color: "var(--color-ink-dim)" }}>
                        <span style={{ color: "var(--color-accent)" }}>·</span>{r}
                      </div>
                    ))}
                    <div className="text-[10.5px] mt-1.5" style={{ color: "var(--color-ink-dim)" }}>Hit <b style={{ color: "var(--color-ink)" }}>Run loop</b>, or open <b style={{ color: "var(--color-ink)" }}>Manual</b> to tweak.</div>
                  </div>
                )}
                <div className="flex gap-2">
                  <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
                    placeholder="Describe the system…"
                    className="flex-1 text-[12px] px-2.5 py-2 rounded-lg border outline-none focus:border-[var(--color-accent)]"
                    style={{ background: "var(--color-panel)", borderColor: "var(--color-edge)", color: "var(--color-ink)" }} />
                  <button onClick={sendChat} disabled={chatBusy}
                    className="px-3 py-2 rounded-lg text-[13px] font-semibold"
                    style={{ background: "var(--color-accent)", color: "#ffffff", opacity: chatBusy ? 0.5 : 1 }}>Send</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex gap-2 mb-3">
                  <button onClick={() => applyPreset("drone")} className="text-[11px] px-2 py-1 rounded border mono" style={{ borderColor: "var(--color-edge)", color: "var(--color-ink-dim)" }}>drone preset</button>
                  <button onClick={() => applyPreset("arm")} className="text-[11px] px-2 py-1 rounded border mono" style={{ borderColor: "var(--color-edge)", color: "var(--color-ink-dim)" }}>arm preset</button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <Inp label="Name" v={form.name} on={(v) => set("name", v)} full />
                  <Inp label="Power (W)" v={form.power_budget_W} on={(v) => set("power_budget_W", v)} />
                  <Inp label="Runtime (min)" v={form.runtime_min} on={(v) => set("runtime_min", v)} />
                  <Inp label="Workload TOPS" v={form.workload_TOPS} on={(v) => set("workload_TOPS", v)} />
                  <Inp label="Model RAM (GB)" v={form.model_footprint_GB} on={(v) => set("model_footprint_GB", v)} />
                  <Inp label="Temp min °C" v={form.temp_min} on={(v) => set("temp_min", v)} />
                  <Inp label="Temp max °C" v={form.temp_max} on={(v) => set("temp_max", v)} />
                  <Inp label="IP rating" v={form.ip_rating} on={(v) => set("ip_rating", v)} />
                  <Inp label="Mass (g)" v={form.mass_budget_g} on={(v) => set("mass_budget_g", v)} />
                  <Inp label="Cam MP" v={form.cam_mp} on={(v) => set("cam_mp", v)} />
                  <Inp label="Cam FPS" v={form.cam_fps} on={(v) => set("cam_fps", v)} />
                  <Inp label="Comms" v={form.comms} on={(v) => set("comms", v)} full />
                  <Inp label="Encl X" v={form.enc_x} on={(v) => set("enc_x", v)} />
                  <Inp label="Encl Y" v={form.enc_y} on={(v) => set("enc_y", v)} />
                  <Inp label="Encl Z" v={form.enc_z} on={(v) => set("enc_z", v)} />
                  <Inp label="Torque N·m" v={form.torque_Nm} on={(v) => set("torque_Nm", v)} />
                </div>
              </div>
            )}
          </section>

          <section className="surface p-4">
            <SectionTitle t="Distilled memory" sub={`${rules.length} rule(s)`} />
            <div className="space-y-1.5 max-h-40 overflow-auto">
              {rules.length === 0 && <div className="text-[12px]" style={{ color: "var(--color-ink-dim)" }}>No rules yet — they appear as the loop resolves failures.</div>}
              {rules.map((r, i) => (
                <div key={i} className="text-[11.5px] flex gap-2">
                  <span style={{ color: "var(--color-warn)" }}>✎</span>
                  <span style={{ color: "var(--color-ink-dim)" }}>{r}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="surface p-4">
            <SectionTitle t="Build history" sub={`${builds.length} build(s) · ${learnedCount} learned`} />
            <div className="space-y-1.5 max-h-56 overflow-auto pr-1">
              {builds.length === 0 && <Empty>Every run is saved here as a hardware build.</Empty>}
              {builds.map((b) => (
                <button key={b.build_id} onClick={() => loadBuild(b.build_id)}
                  className="w-full text-left rounded-lg border px-2.5 py-1.5 row-state hover:border-[var(--color-accent)]"
                  style={{ borderColor: "var(--color-edge)", background: "var(--color-panel)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] truncate" style={{ color: "var(--color-ink)" }}>{b.name}</span>
                    <span className="mono text-[11px]" style={{ color: b.coverage >= 1 ? "var(--color-pass)" : "var(--color-warn)" }}>{Math.round(b.coverage * 100)}%</span>
                  </div>
                  <div className="flex items-center justify-between mono text-[10px]" style={{ color: "var(--color-ink-dim)" }}>
                    <span>{b.model}</span>
                    <span>{b.iterations} iters · {b.api_calls} calls</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* MIDDLE: rubric checklist + activity */}
        <div className="flex flex-col gap-4">
          <section className="surface p-4">
            <SectionTitle t="Rubric — verifier checklist" sub={`${hardChecks.filter((c) => c.status === "pass").length}/${hardChecks.length} hard`} />
            <div className="space-y-1.5">
              {rubric.length === 0 && <Empty>Submit requirements and run the loop to populate the rubric.</Empty>}
              {hardChecks.map((c) => <RubricRow key={c.id} c={c} />)}
              {softChecks.length > 0 && <div className="text-[10px] uppercase tracking-wider pt-2" style={{ color: "var(--color-ink-dim)" }}>soft / ranking</div>}
              {softChecks.map((c) => <RubricRow key={c.id} c={c} />)}
            </div>
          </section>

          <section className="surface p-4 flex flex-col" style={{ minHeight: 240 }}>
            <SectionTitle n="3" t="Activity — self-correction narration" />
            <div className="overflow-auto flex-1 max-h-80 pr-1">
              {activity.length === 0 && <Empty>The agent's reasoning streams here.</Empty>}
              {activity.map((e, i) => <ActivityItem key={i} e={e} />)}
              <div ref={actEndRef} />
            </div>
          </section>
        </div>

        {/* RIGHT: BOM tree */}
        <section className="surface p-4">
          <SectionTitle n="2" t="Bill of materials" sub={subsystems.length ? `${subsystems.reduce((n, [, v]) => n + v.length, 0)} parts` : ""} />
          <div className="space-y-4 max-h-[78vh] overflow-auto pr-1">
            {subsystems.length === 0 && <Empty>The proposed BOM appears here; parts flash when swapped.</Empty>}
            {subsystems.map(([sub, parts]) => (
              <div key={sub}>
                <div className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: "var(--color-ink-dim)" }}>{SUB_LABEL[sub] || sub}</div>
                <div className="space-y-2">
                  {parts.map((c) => <BomCard key={sub + ":" + c.id} c={c} />)}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  );
}

function SectionTitle({ n, t, sub }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {n && <span className="mono text-[10px] w-5 h-5 grid place-items-center rounded" style={{ background: "var(--color-edge)", color: "var(--color-accent)" }}>{n}</span>}
        <h2 className="text-[13px] font-semibold tracking-wide" style={{ color: "var(--color-ink)" }}>{t}</h2>
      </div>
      {sub && <span className="mono text-[11px]" style={{ color: "var(--color-ink-dim)" }}>{sub}</span>}
    </div>
  );
}

function Inp({ label, v, on, full }) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-ink-dim)" }}>{label}</span>
      <input value={v ?? ""} onChange={(e) => on(e.target.value)}
        className="mono text-[12px] px-2 py-1.5 rounded border outline-none focus:border-[var(--color-accent)]"
        style={{ background: "var(--color-panel)", borderColor: "var(--color-edge)", color: "var(--color-ink)" }} />
    </label>
  );
}

function Empty({ children }) {
  return <div className="text-[12px] py-6 text-center" style={{ color: "var(--color-ink-dim)" }}>{children}</div>;
}

function ChatBubble({ m }) {
  const me = m.role === "user";
  return (
    <div className={`flex ${me ? "justify-end" : "justify-start"}`}>
      <div className="text-[12px] leading-relaxed px-2.5 py-1.5 rounded-lg max-w-[90%] whitespace-pre-wrap"
        style={me
          ? { background: "rgba(2,132,199,.12)", color: "var(--color-ink)", borderTopRightRadius: 2 }
          : { background: "var(--color-panel)", border: "1px solid var(--color-edge)", color: "var(--color-ink-dim)", borderTopLeftRadius: 2 }}>
        {m.content}
      </div>
    </div>
  );
}

/* ---- About overlay ---- */

const HARD = [
  ["power budget", "Σ active draw ≤ budget"],
  ["peak power", "per-rail peak ≤ I·V"],
  ["voltage rails", "every input has a rail"],
  ["endurance", "Wh / avg W ≥ runtime"],
  ["thermal", "parts cover env temp"],
  ["mass", "Σ mass ≤ budget"],
  ["size / packing", "boards fit enclosure"],
  ["compute", "TOPS & RAM ≥ workload"],
  ["sensing", "res/fps + CSI lanes"],
  ["comms", "band + antenna + chains"],
  ["actuation", "torque & driver current"],
  ["connectors", "every mate pairs up"],
  ["environment", "IP rating ≥ required"],
];
const SOFT = ["cost", "power margin", "lead time"];

function LoopDiagram() {
  const box = (x, y, w, label, sub, color) => (
    <g>
      <rect x={x} y={y} width={w} height="56" rx="9" fill="var(--color-panel)" stroke={color} strokeWidth="1.5" />
      <text x={x + w / 2} y={y + 24} textAnchor="middle" fill="var(--color-ink)" fontSize="13" fontWeight="600">{label}</text>
      <text x={x + w / 2} y={y + 41} textAnchor="middle" fill="var(--color-ink-dim)" fontSize="10">{sub}</text>
    </g>
  );
  const arrow = (x1, x2, y) => (
    <g stroke="var(--color-ink-dim)" strokeWidth="1.5" fill="none">
      <line x1={x1} y1={y} x2={x2 - 7} y2={y} />
      <path d={`M ${x2 - 7} ${y - 4} L ${x2} ${y} L ${x2 - 7} ${y + 4}`} fill="var(--color-ink-dim)" />
    </g>
  );
  return (
    <svg viewBox="0 0 860 200" className="w-full">
      {box(8, 30, 150, "Proposer", "LLM · selects parts", "var(--color-accent)")}
      {arrow(158, 230, 58)}
      {box(230, 30, 160, "Verifier", "deterministic checks", "var(--color-pass)")}
      {arrow(390, 470, 58)}
      {/* pass branch */}
      {box(470, 30, 175, "Spec passes", "coverage = 100%", "var(--color-pass)")}
      {/* distill */}
      {arrow(645, 700, 58)}
      {box(700, 30, 150, "Distill", "→ memory rule", "var(--color-warn)")}
      {/* fail loop back */}
      <g stroke="var(--color-fail)" strokeWidth="1.5" fill="none">
        <path d="M 310 86 L 310 150 L 83 150 L 83 92" />
        <path d="M 79 99 L 83 92 L 87 99" fill="var(--color-fail)" />
      </g>
      <text x="310" y="170" textAnchor="middle" fill="var(--color-fail)" fontSize="11" fontWeight="600">
        failing constraints fed back → revise &amp; re-verify
      </text>
    </svg>
  );
}

function About({ onClose }) {
  return (
    <div onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center p-4 lg:p-8 overflow-auto"
      style={{ background: "rgba(24,24,27,.45)", backdropFilter: "blur(4px)" }}>
      <div onClick={(e) => e.stopPropagation()}
        className="surface w-full max-w-[920px] my-4 p-6 lg:p-8 relative">
        <button onClick={onClose} aria-label="Close"
          className="absolute top-4 right-4 w-8 h-8 grid place-items-center rounded-lg border text-[16px]"
          style={{ borderColor: "var(--color-edge)", color: "var(--color-ink-dim)" }}>×</button>

        {/* hero */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xl font-bold tracking-tight" style={{ color: "var(--color-ink)" }}>ANVIL</span>
          <span className="text-[11px] mono px-2 py-0.5 rounded" style={{ background: "var(--color-edge)", color: "var(--color-accent)" }}>about</span>
        </div>
        <p className="text-[14px] leading-relaxed max-w-[680px]" style={{ color: "var(--color-ink)" }}>
          Anvil turns robotic-system <b>requirements</b> into a verified hardware <b>spec</b> by running a
          self-correcting loop: it selects components, checks them against a machine-readable rubric, and
          fixes its own failures until every hard constraint passes.
        </p>
        <p className="text-[12px] mt-2" style={{ color: "var(--color-ink-dim)" }}>
          The product is the <b style={{ color: "var(--color-ink)" }}>loop</b>, not a dashboard. The thing to watch is a
          constraint going <span style={{ color: "var(--color-fail)" }}>red</span> → the agent investigating →
          a part swapping → the constraint going <span style={{ color: "var(--color-pass)" }}>green</span>.
        </p>

        {/* loop diagram */}
        <div className="surface mt-5 p-4" style={{ background: "var(--color-panel)" }}>
          <LoopDiagram />
        </div>

        {/* self-improvement callout */}
        <div className="mt-5 rounded-xl p-4 relative overflow-hidden"
          style={{ border: "1px solid var(--color-edge)", background: "linear-gradient(135deg, rgba(2,132,199,.07), rgba(96,72,240,.06))" }}>
          <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: "var(--color-accent)" }} />
          <div className="flex items-center gap-2 mb-2 pl-2">
            <span style={{ color: "var(--color-warn)" }}>✦</span>
            <h3 className="text-[13px] font-semibold" style={{ color: "var(--color-ink)" }}>It improves in two directions at once</h3>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 pl-2">
            <div>
              <div className="text-[12px] font-medium mb-1" style={{ color: "var(--color-pass)" }}>The hardware being forged</div>
              <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-ink-dim)" }}>
                Every iteration the BOM gets closer to spec. A part that blows the power budget is swapped for
                one that fits; <span style={{ color: "var(--color-fail)" }}>red</span> becomes
                <span style={{ color: "var(--color-pass)" }}> green</span>. The design converges in front of you.
              </p>
            </div>
            <div>
              <div className="text-[12px] font-medium mb-1" style={{ color: "var(--color-accent)" }}>The system itself</div>
              <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-ink-dim)" }}>
                Confirmed fixes distill into reusable rules, so Anvil stops re-deriving solved problems. It has
                even caught a flaw in its <i>own</i> rubric — and that loop closing on its own author is the point.
              </p>
            </div>
          </div>
          <div className="mt-3 ml-2 rounded-lg p-3 text-[11.5px] leading-relaxed mono"
            style={{ background: "var(--color-panel)", border: "1px solid var(--color-edge)", color: "var(--color-ink-dim)" }}>
            <span style={{ color: "var(--color-warn)" }}>true story · </span>
            The LLM reached for a real true-4K sensor (8.29 MP) and the verifier kept rejecting it against an
            <b style={{ color: "var(--color-ink)" }}> 8.3 MP</b> gate — a value no honest 4K part can hit. 4K UHD
            (3840×2160) is <b style={{ color: "var(--color-pass)" }}>8.29 MP</b>. The loop had surfaced a bug in the
            requirement itself; the spec was corrected to true 4K, and the run converged to 100%.
          </div>
        </div>

        {/* two engines */}
        <h3 className="text-[13px] font-semibold mt-6 mb-2" style={{ color: "var(--color-ink)" }}>Two engines, cleanly separated</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-accent)", background: "var(--color-panel)" }}>
            <div className="text-[13px] font-semibold mb-1" style={{ color: "var(--color-accent)" }}>Proposer — the LLM</div>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-ink-dim)" }}>
              Selects and revises the bill of materials, knowledge-base first, with web search for parts it
              doesn't have. Model-selectable at runtime. It <b style={{ color: "var(--color-ink)" }}>never</b> judges its
              own pass/fail — it only proposes, then must investigate the named failures it's handed back.
            </p>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-pass)", background: "var(--color-panel)" }}>
            <div className="text-[13px] font-semibold mb-1" style={{ color: "var(--color-pass)" }}>Verifier — deterministic Python</div>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-ink-dim)" }}>
              Pure functions over <span className="mono">(BOM, Rubric)</span> with no LLM. Real hardware math —
              power on each rail, thermal coverage, CSI lanes, antenna bands. Fast, repeatable, and the single
              <b style={{ color: "var(--color-ink)" }}> source of truth</b>. If it says fail, it's a fail.
            </p>
          </div>
        </div>

        {/* what the verifier checks */}
        <h3 className="text-[13px] font-semibold mt-6 mb-2" style={{ color: "var(--color-ink)" }}>
          What the verifier checks <span className="text-[11px] font-normal" style={{ color: "var(--color-ink-dim)" }}>· hard constraints gate the loop</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          {HARD.map(([k, v]) => (
            <div key={k} className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: "var(--color-edge)", background: "var(--color-panel)" }}>
              <div className="text-[12px]" style={{ color: "var(--color-ink)" }}>{k}</div>
              <div className="mono text-[10px]" style={{ color: "var(--color-ink-dim)" }}>{v}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--color-ink-dim)" }}>soft / ranking</span>
          {SOFT.map((s) => (
            <span key={s} className="mono text-[11px] px-2 py-0.5 rounded" style={{ background: "var(--color-edge)", color: "var(--color-ink-dim)" }}>{s}</span>
          ))}
        </div>

        {/* outer loop / memory */}
        <h3 className="text-[13px] font-semibold mt-6 mb-2" style={{ color: "var(--color-ink)" }}>The outer loop — memory</h3>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {["fail", "investigate", "verify", "distill", "consult"].map((s, i, a) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="px-2 py-1 rounded-lg border" style={{ borderColor: "var(--color-edge)", color: "var(--color-ink)", background: "var(--color-panel)" }}>{s}</span>
              {i < a.length - 1 && <span style={{ color: "var(--color-ink-dim)" }}>→</span>}
            </span>
          ))}
        </div>
        <p className="text-[12px] mt-2 leading-relaxed" style={{ color: "var(--color-ink-dim)" }}>
          A confirmed fix becomes a general rule written to a persistent file. Every run consults those rules
          up front, so Anvil stops re-deriving problems it has already solved — and you can watch the rule list grow.
        </p>

        {/* reading the screen */}
        <h3 className="text-[13px] font-semibold mt-6 mb-2" style={{ color: "var(--color-ink)" }}>Reading this screen</h3>
        <div className="grid sm:grid-cols-2 gap-2">
          {[
            ["1", "Requirements → Rubric", "Your inputs become a live checklist; each row goes grey → red → green."],
            ["2", "Bill of materials", "The proposed BOM by subsystem with kb/web provenance; parts flash when swapped."],
            ["3", "Activity stream", "The agent narrating its own investigation and fixes — the self-correction story."],
            ["coverage", "Hero metric", "Fraction of hard constraints passing. The loop runs until it hits 100% or max iterations."],
          ].map(([n, t, d]) => (
            <div key={t} className="flex gap-3 rounded-lg border p-3" style={{ borderColor: "var(--color-edge)", background: "var(--color-panel)" }}>
              <span className="mono text-[10px] h-5 px-1.5 grid place-items-center rounded shrink-0" style={{ background: "var(--color-edge)", color: "var(--color-accent)" }}>{n}</span>
              <div>
                <div className="text-[12px] font-medium" style={{ color: "var(--color-ink)" }}>{t}</div>
                <div className="text-[11px] mt-0.5" style={{ color: "var(--color-ink-dim)" }}>{d}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 text-[11px] flex items-center justify-between" style={{ borderTop: "1px solid var(--color-edge)", color: "var(--color-ink-dim)" }}>
          <span>Proposer proposes · Verifier decides · failures feed back · repeat.</span>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg font-semibold" style={{ background: "var(--color-accent)", color: "#ffffff" }}>Got it</button>
        </div>
      </div>
    </div>
  );
}
