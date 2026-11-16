// PortFlow Control Tower v6 — Chattogram NCT and the Port of Hamburg. The page re-plans and re-simulates in the
// browser (src/engine.js, a JavaScript port of the Python CP-SAT + SimPy model) every time the copilot receives a
// command. DEFAULT_MCP_DATA below is the output of run_nct_pipeline.py (the 13 Nov 2026 Chattogram snapshot); a page
// may instead embed window.PORTFLOW_DEFAULT and point window.PORTFLOW_DATA_URL (or ?data=) at the daily live plan
// written by run_tower.py, which is loaded at runtime.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea } from 'recharts';
import { solve, simulateReplicated, makeSite, planFigures, yardLedger, explainRow } from './engine.js';

const DEFAULT_MCP_DATA = (typeof window !== 'undefined' && window.PORTFLOW_DEFAULT) || /*__MCP_DATA__*/;
const WORKER_SRC = /*__WORKER_SRC__*/'';

// Re-plan in a Web Worker when the page allows it; otherwise on the main thread.
function solveAsync(data, opt, onLog) {
  if (WORKER_SRC && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      return new Promise((ok) => {
        const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })), w = new Worker(url);
        const fallback = () => { w.terminate(); URL.revokeObjectURL(url); ok(solve(data, opt, onLog)); };
        w.onmessage = (e) => { if (e.data.log) onLog(e.data.log); if (e.data.done) { w.terminate(); URL.revokeObjectURL(url); ok(e.data.done); } };
        w.onerror = fallback;
        w.postMessage({ data, opt });
      });
    } catch (e) { /* blocked by the page's security policy: fall through */ }
  }
  return new Promise((ok) => setTimeout(() => ok(solve(data, opt, onLog)), 30));
}

// The real engine (CP-SAT + yard simulation) on a server, when one is configured: window.PORTFLOW_API or ?api=<url>.
// The page asks it first and falls back to the in-browser planner if it is unreachable, busy or slow.
function apiUrl() {
  if (typeof window === 'undefined') return null;
  try { const q = new URLSearchParams(window.location.search).get('api'); if (q === 'off') return null; if (q && /^https:\/\/|^http:\/\/localhost/.test(q)) return q.replace(/\/$/, ''); } catch (e) { /* no URL API */ }
  return window.PORTFLOW_API ? String(window.PORTFLOW_API).replace(/\/$/, '') : null;
}
async function solveServer(data, opt, onLog) {
  const api = apiUrl();
  if (!api || !data.site_kind || typeof fetch === 'undefined') return null;
  onLog(`asking the server CP-SAT engine (${api.replace(/^https?:\/\//, '')}); a sleeping server can take a minute to wake`);
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tm = ctl && setTimeout(() => ctl.abort(), 100000), t0 = Date.now();
  try {
    const r = await fetch(`${api}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify({ site: data.site_kind, scenario: { etaShift: opt.etaShift, qgcOutages: opt.qgcOutages, rtgOutages: opt.rtgOutages, icd: opt.icd, occ: opt.occ, tugSets: opt.tugSets } }) });
    if (!r.ok) { onLog(`server CP-SAT: HTTP ${r.status}; re-planning in the browser instead`); return null; }
    const res = await r.json();
    (res.trace || []).forEach((it) => onLog(`server CP-SAT iteration ${it.iteration}: objective ${it.master_objective ?? it.objective ?? '-'}, turnaround ${it.avg_turnaround_days ?? '-'} d${it.cuts_added && Object.keys(it.cuts_added).length ? `, yard cuts ${Object.entries(it.cuts_added).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join(' ')}` : ''}`));
    onLog(`server CP-SAT answered in ${((Date.now() - t0) / 1000).toFixed(1)} s (solve ${res.runtime_s} s, data of ${res.data_generated_utc || 'today'})`);
    return res;
  } catch (e) { onLog(`server CP-SAT unreachable (${(e && e.name) || 'error'}); re-planning in the browser instead`); return null; } finally { if (tm) clearTimeout(tm); }
}

const CSS = `
.pf{--bg:#05090d;--panel:#0a1219;--well:#060b10;--line:#16293a;--line-hi:#2b4a63;--ink:#d7e5f0;--muted:#8097a9;--tele:#5ef2c8;--amber:#ffb224;--red:#ff5a52;--blue:#4aa3ff;--ok:#3ddc84;
 --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;--disp:'Rajdhani','Segoe UI',system-ui,sans-serif;
 background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:12px;line-height:1.45;min-height:100vh;padding:14px 16px 28px;box-sizing:border-box}
.pf *{box-sizing:border-box}.pf .num{font-variant-numeric:tabular-nums}
.pf button{font:inherit;color:inherit;cursor:pointer}
.pf button:focus-visible,.pf input:focus-visible{outline:2px solid var(--tele);outline-offset:2px}
.pf-top{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 22px;border-bottom:1px solid var(--line-hi);padding-bottom:10px}
.pf-brand{font-family:var(--disp);font-weight:700;font-size:25px;letter-spacing:.09em;line-height:1;text-transform:uppercase}
.pf-brand small{display:block;font-family:var(--mono);font-weight:400;font-size:10.5px;letter-spacing:.04em;color:var(--muted);text-transform:none;margin-top:5px}
.pf-clock{font-family:var(--disp);font-weight:600;font-size:25px;letter-spacing:.06em;color:var(--tele);line-height:1}
.pf-clock small{display:block;font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.02em;margin-top:5px}
.pf-lamps{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.pf-lamp{border:1px solid var(--line-hi);background:var(--well);padding:4px 9px;font-size:10.5px;display:flex;align-items:center;gap:7px;white-space:nowrap}
.pf-lamp i{width:8px;height:8px;border-radius:50%;background:var(--c);box-shadow:0 0 8px var(--c)}
.pf-scrub{display:flex;align-items:center;gap:10px;margin:10px 0;background:var(--panel);border:1px solid var(--line);padding:7px 10px}
.pf-scrub input{flex:1;accent-color:var(--tele);min-width:80px}
.pf-btn{background:var(--well);border:1px solid var(--line-hi);padding:5px 10px;min-height:30px;white-space:nowrap}
.pf-btn:hover{border-color:var(--tele)}.pf-btn.on{background:#0e2a2a;border-color:var(--tele);color:var(--tele)}
.pf-btn:disabled{opacity:.45;cursor:default}
.pf-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px}
.pf-panel{background:var(--panel);border:1px solid var(--line);padding:11px 12px;min-width:0;grid-column:span 12}
.s7{grid-column:span 7}.s5{grid-column:span 5}
@media(max-width:980px){.s7,.s5{grid-column:span 12}}
.pf-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.pf-tag{font-family:var(--disp);font-size:10.5px;letter-spacing:.16em;color:var(--tele);text-transform:uppercase}
.pf-head h2{font-family:var(--disp);font-weight:600;font-size:17px;letter-spacing:.05em;margin:0;text-transform:uppercase}
.pf-note{color:var(--muted);font-size:10.5px;margin:6px 0 0;max-width:96ch}
.pf-seg{display:flex;gap:4px;flex-wrap:wrap}
.pf-radar{position:relative;background:radial-gradient(ellipse at 33% 60%,#0b2030 0,#060b10 70%);border:1px solid var(--line);overflow:hidden}
.pf-radar svg{display:block;width:100%;height:auto}
.pf-sweep{transform-origin:250px 258px;animation:pfsweep 7s linear infinite}
@keyframes pfsweep{to{transform:rotate(360deg)}}
.pf-ship{cursor:pointer;transition:opacity .4s}
.pf-ship .ping{animation:pfping 1.8s ease-out infinite;transform-origin:center;transform-box:fill-box}
@keyframes pfping{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(2.6)}}
.pf-card{background:var(--well);border:1px solid var(--line-hi);border-top:0;padding:8px 10px;font-size:10.5px}
.pf-card h3{font-family:var(--disp);font-size:15px;letter-spacing:.06em;margin:0 0 4px;color:#fff}
.pf-card h3 span{font-family:var(--mono);font-size:10.5px;font-weight:400;letter-spacing:0;margin-left:10px}
.pf-card dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:5px 14px;margin:0}.pf-card dt{color:var(--muted);font-size:10px}.pf-card dd{margin:0}
.pf-chat{display:flex;flex-direction:column;gap:8px;height:100%}
.pf-msgs{background:var(--well);border:1px solid var(--line);padding:8px;height:214px;overflow-y:auto;display:flex;flex-direction:column;gap:7px}
.pf-msg{max-width:92%;padding:6px 9px;border:1px solid var(--line);white-space:pre-wrap;animation:pfin .3s ease-out}
.pf-msg.u{align-self:flex-end;background:#0e2233;border-color:#24507a}.pf-msg.a{align-self:flex-start;background:#0a1a18;border-color:#1d4a42}
@keyframes pfin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pf-in{display:flex;gap:6px}.pf-in input{flex:1;min-width:0;background:var(--well);border:1px solid var(--line-hi);color:var(--ink);font:inherit;padding:7px 9px;min-height:34px}
.pf-chips{display:flex;flex-wrap:wrap;gap:5px}
.pf-chip{background:transparent;border:1px solid var(--line-hi);padding:3px 8px;font-size:10.5px;color:var(--muted);text-align:left}
.pf-chip:hover{color:var(--ink);border-color:var(--tele)}
.pf-chip.act{color:var(--amber);border-color:#6b4c12;background:#1a1408}
.pf-term{background:#020507;border:1px solid var(--line);height:128px;overflow-y:auto;padding:6px 8px;font-size:10.5px;color:#9fe8d2}
.pf-term div{white-space:pre-wrap;animation:pfin .2s ease-out}.pf-term .cur::after{content:'▍';animation:pfblink 1s steps(2) infinite}
@keyframes pfblink{50%{opacity:0}}
.pf-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.pf-kpi{background:var(--well);border:1px solid var(--line);padding:8px 10px;position:relative;overflow:hidden}
.pf-kpi .l{font-family:var(--disp);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.pf-kpi .v{font-family:var(--disp);font-weight:600;font-size:27px;line-height:1.1;color:#fff}
.pf-kpi .v small{font-size:13px;color:var(--muted);font-weight:500;margin-left:3px}
.pf-kpi .d{font-size:10.5px;color:var(--muted)}.pf-kpi .d b{font-weight:500}
.pf-kpi.flash::after{content:'';position:absolute;inset:0;border:1px solid var(--tele);animation:pfflash 1.2s ease-out forwards;pointer-events:none}
@keyframes pfflash{from{opacity:1;box-shadow:inset 0 0 22px rgba(94,242,200,.5)}to{opacity:0}}
.pf-scroll{overflow-x:auto}
.pf-gbar{transition:transform .9s cubic-bezier(.2,.8,.2,1);cursor:pointer}
.pf-gbar rect{transition:width .9s cubic-bezier(.2,.8,.2,1)}
.pf-table{width:100%;border-collapse:collapse;font-size:10.5px;min-width:980px}
.pf-table th{font-family:var(--disp);font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:right;padding:5px 7px;border-bottom:1px solid var(--line-hi);white-space:nowrap}
.pf-table td{text-align:right;padding:5px 7px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
.pf-table th:first-child,.pf-table td:first-child,.pf-table .tl{text-align:left}
.pf-table tr{cursor:pointer}.pf-table tr.sel td{background:#0e2a2a}
.pf-key{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;margin-right:12px}
.pf-key i{width:10px;height:10px;background:var(--c);display:inline-block}
.pf-read{background:var(--well);border:1px solid var(--line);padding:6px 9px;min-height:30px;margin-top:8px;font-size:10.5px}
.pf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-top:8px}
.pf-stat{background:var(--well);border:1px solid var(--line);padding:5px 8px}
.pf-stat .l{font-family:var(--disp);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.pf-stat .v{font-size:12.5px}
.y3-stage{position:relative;overflow:hidden;contain:strict;isolation:isolate;background:radial-gradient(ellipse at 50% 60%,#0d1c29 0,#060a0f 72%);border:1px solid var(--line)}
.y3-fit{position:absolute;left:0;top:0;width:900px;height:380px;transform-origin:0 0;will-change:transform}
.pf.playing .y3-box.hz .t::after{animation-play-state:paused}
.y3-scene{position:absolute;left:50%;top:50%;transform-style:preserve-3d;transform:translate(-50%,-30%) rotateX(58deg) rotateZ(24deg);
 background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);outline:1px solid var(--line-hi)}
.y3-box{position:absolute;transform-style:preserve-3d;transform:translateZ(var(--z));transition:left .45s ease,top .45s ease,transform .45s ease;animation:y3drop .7s cubic-bezier(.25,1.2,.5,1) backwards;animation-delay:var(--dl)}
.y3-box i{position:absolute;display:block;outline:1px solid rgba(5,8,12,.85);outline-offset:-1px}
.y3-box .t{left:0;top:0;width:100%;height:100%;transform:translateZ(var(--h));background:var(--c0)}
.y3-box .s{left:0;top:100%;width:100%;height:var(--h);transform-origin:0 0;transform:rotateX(90deg);background:var(--c2)}
.y3-box .e{left:100%;top:0;width:var(--h);height:100%;transform-origin:0 0;transform:rotateY(-90deg);background:var(--c1)}
.y3-box.im .t{background:repeating-linear-gradient(45deg,#ff8a1f 0 3px,#14100a 3px 6px)}
.y3-box.hz i{outline:1.5px solid #fff}
.y3-box.hz .t::after{content:'';position:absolute;inset:0;border:2.5px solid #fff;box-shadow:0 0 9px 3px rgba(255,90,82,.95);animation:y3haz 1s ease-in-out infinite alternate}
.y3-box.mv i{outline:2px solid var(--tele)}
.y3-box.dim i{opacity:.07;animation:none}
@keyframes y3drop{from{transform:translateZ(calc(var(--z) + 420px));opacity:0}to{transform:translateZ(var(--z));opacity:1}}
@keyframes y3haz{from{opacity:.35}to{opacity:1}}
.pf-foot{margin-top:14px;color:var(--muted);font-size:10.5px}.pf-foot summary{cursor:pointer;color:var(--ink)}.pf-foot li{margin:3px 0;max-width:110ch}
.pf-foot a{color:var(--tele)}
.pf-map{height:430px;border:1px solid var(--line);background:#06121b}
.pf-map .leaflet-tile-pane{filter:invert(1) hue-rotate(185deg) brightness(.85) contrast(.92) saturate(.55)}
.pf-map .leaflet-container,.pf .leaflet-container{background:#06121b;font:inherit}
.pf .pf-mk{background:none;border:0}
.pf .pf-tip{background:rgba(5,9,13,.82);border:1px solid #2b4a63;color:#d7e5f0;font:10.5px var(--mono);padding:1px 5px;box-shadow:none}
.pf .pf-tip::before{display:none}
.pf .leaflet-control-attribution{background:rgba(5,9,13,.75);color:#8097a9}.pf .leaflet-control-attribution a{color:#5ef2c8}
.pf-banner{margin:8px 0 0;padding:6px 10px;border:1px solid #6b4c12;background:#1a1408;color:var(--amber);font-size:10.5px}
.pf-banner.ok{border-color:#1d4a42;background:#0a1a18;color:var(--tele)}
.pf-nav{display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px}.pf-nav a{color:var(--muted);text-decoration:none;border:1px solid var(--line-hi);padding:3px 8px}.pf-nav a:hover,.pf-nav a.on{color:var(--tele);border-color:var(--tele)}
@media(prefers-reduced-motion:reduce){.pf-sweep,.pf-ship .ping,.y3-box,.y3-box.hz .t::after,.pf-msg,.pf-term div{animation:none}.y3-box,.pf-gbar,.pf-gbar rect{transition:none}}
`;

const C = { tele: '#5ef2c8', amber: '#ffb224', red: '#ff5a52', blue: '#4aa3ff', ok: '#3ddc84', muted: '#8097a9', ink: '#d7e5f0', line: '#16293a', hi: '#2b4a63' };
const fmt = (x, d = 1) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
const tip = { contentStyle: { background: '#05080c', border: '1px solid #2b4a63', borderRadius: 0, fontSize: 11, fontFamily: 'inherit', color: C.ink }, labelStyle: { color: C.muted }, itemStyle: { color: C.ink, padding: 0 } };
const ax = { stroke: C.muted, tick: { fill: C.muted, fontSize: 10 }, tickLine: false };

const pyKpis = (k) => ({ objective: k.objective, turnaround: k.avg_turnaround_days, wait: k.total_anchorage_wait_hrs, hold: k.total_tide_hold_hrs, beta: k.backpressure_beta_max,
  peak: k.peak_yard_occupancy_pct, gateWait: k.avg_gate_truck_wait_mins, rehandle: k.unproductive_rehandle_hrs, icdBoxes: k.icd_evacuated_containers, hfo: k.hfo_proxy_tonnes });

function useTween(target, ms = 800) {
  const [x, setX] = useState(target); const cur = useRef(target);
  useEffect(() => {
    const a = cur.current, t0 = performance.now(); let raf;
    const step = (now) => { const k = Math.min(1, (now - t0) / ms), v = a + (target - a) * (1 - Math.pow(1 - k, 3)); cur.current = v; setX(v); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return x;
}

// ------------------------------------------------------------------ plan clock
function planClock(epochIso, t) {
  const d = new Date(new Date(epochIso.slice(0, 19) + 'Z').getTime() + t * 3600e3);
  return { day: DAYS[d.getUTCDay()], date: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), label: `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

// ------------------------------------------------------------------ radar geometry (schematic chart, not to scale)
const CH = [[338, 258], [420, 262], [472, 254], [512, 232], [540, 200], [572, 172], [618, 154], [690, 140], [738, 132]];
const CH_LEN = CH.slice(1).reduce((a, p, i) => { a.push(a[i] + Math.hypot(p[0] - CH[i][0], p[1] - CH[i][1])); return a; }, [0]);
const CH_TOTAL = CH_LEN[CH_LEN.length - 1];
function chan(s) {
  const d = clamp(s, 0, CH_TOTAL); let i = 1; while (i < CH.length - 1 && CH_LEN[i] < d) i++;
  const k = (d - CH_LEN[i - 1]) / (CH_LEN[i] - CH_LEN[i - 1]), p = lerp(CH[i - 1], CH[i], k);
  return { p, ang: Math.atan2(CH[i][1] - CH[i - 1][1], CH[i][0] - CH[i - 1][0]) };
}
const QUAY_S0 = CH_LEN[5] + 8, QUAY_S1 = CH_TOTAL - 6;                    // the quay runs beside the last reach of the channel
const quayS = (m) => QUAY_S0 + (m / 1000) * (QUAY_S1 - QUAY_S0);
const off = (c, d) => [c.p[0] + Math.sin(c.ang) * d, c.p[1] - Math.cos(c.ang) * d];   // d > 0 = towards the north bank
const ORIGIN = (v) => (/Colombo/.test(v.last_port) ? [-14, 318] : [128, 446]);
const START_K = { ANCHORAGE: 1, BAY_NEAR: 0.72, BAY_MID: 0.4, BAY_FAR: 0.06 };
const anchorSlot = (i) => [186 + (i % 3) * 72, 232 + (Math.floor(i / 3) % 3) * 34];

function shipAt(row, v, t, idx, T) {
  const slot = anchorSlot(idx), o = ORIGIN(v), mid = (row.berth_start_m + row.berth_end_m) / 2, sB = quayS(mid), berth = off(chan(sB), 7);
  const face = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (t < row.eta_hr) { const k0 = START_K[v.area] ?? 0.2, k = k0 + (1 - k0) * (row.eta_hr > 0 ? t / row.eta_hr : 1); return { phase: 'INBOUND', p: lerp(o, slot, k), ang: face(o, slot), text: `Inbound, ${fmt(row.eta_hr - t, 0)} h to the anchorage` }; }
  if (t < row.transit_in_hr) return { phase: 'ANCHOR', p: slot, ang: -0.5, text: `At anchor, pilot booked in ${fmt(row.transit_in_hr - t, 0)} h` };
  if (t < row.berth_start_hr) {
    const u = (t - row.transit_in_hr) / T;
    if (u < 0.18) return { phase: 'CHANNEL', p: lerp(slot, CH[0], u / 0.18), ang: face(slot, CH[0]), text: 'Under pilotage, inbound' };
    const w = (u - 0.18) / 0.82, c = chan(w * sB), side = clamp((w - 0.8) / 0.2, 0, 1);
    return { phase: 'CHANNEL', p: off(c, 7 * side), ang: c.ang, text: 'Under pilotage, inbound on the Karnaphuli' };
  }
  if (t < row.tidal_depart_hr) return { phase: 'BERTH', p: berth, ang: chan(sB).ang, text: t < row.cargo_done_hr ? `Working cargo with ${row.assigned_qcs} quay cranes` : 'Cargo complete, holding for tide or daylight' };
  if (t < row.tidal_depart_hr + T) { const u = (t - row.tidal_depart_hr) / T, c = chan((1 - u) * sB); return { phase: 'CHANNEL', p: off(c, 7 * clamp(1 - u / 0.2, 0, 1)), ang: c.ang + Math.PI, text: 'Under pilotage, outbound' }; }
  const u = (t - row.tidal_depart_hr - T) / 10;
  return u < 1 ? { phase: 'SAILED', p: lerp(CH[0], o, u), ang: face(CH[0], o), text: 'Sailed', fade: 1 - u } : null;
}
const PHASE_C = { INBOUND: C.blue, ANCHOR: C.amber, CHANNEL: C.tele, BERTH: C.ok, SAILED: C.muted };

function NctCard({ cur, gate, tide, dc }) {
  return (
        <div className="pf-card">
          <h3>{cur.r.vessel_id}<span style={{ color: PHASE_C[cur.s.phase] }}>{cur.s.text}</span></h3>
          <dl>
            <div><dt>IMO / MMSI</dt><dd className="num">{cur.v.imo} / {cur.v.mmsi}</dd></div>
            <div><dt>Length × beam</dt><dd className="num">{fmt(cur.v.loa_m, 2)} × {fmt(cur.v.beam_m, 1)} m</dd></div>
            <div><dt>Draught</dt><dd className="num">{cur.v.draught_reported_m == null ? 'not reported' : `${fmt(cur.v.draught_reported_m)} m reported`}, {fmt(cur.r.draft_m)} m planned</dd></div>
            <div><dt>Reported status</dt><dd>{cur.v.status}</dd></div>
            <div><dt>Speed and course</dt><dd>{cur.v.sog_kn != null ? `${fmt(cur.v.sog_kn)} kn, ${fmt(cur.v.cog_deg, 0)}° (AIS ${cur.v.ais_time_utc || ''})` : 'not published by any source read'}</dd></div>
            <div><dt>Tide gate now</dt><dd style={{ color: gate ? C.ok : C.red }}>{gate ? 'open' : tide < cur.r.tide_needed_m ? `shut: needs ${fmt(cur.r.tide_needed_m)} m of tide` : 'shut: night rule'}</dd></div>
            <div><dt>Assigned berth</dt><dd className="num">{cur.r.berth_start_m}–{cur.r.berth_end_m} m, {cur.r.assigned_qcs} quay cranes</dd></div>
            <div><dt>Last port</dt><dd>{cur.v.last_port}</dd></div>
            {dc && <div><dt>Daylight bar windows</dt><dd>{dc.inbound_starts_planned} at {fmt(dc.planned_m)} m{dc.inbound_starts_reported != null && dc.reported_m !== dc.planned_m ? `; ${dc.inbound_starts_reported} at the reported ${fmt(dc.reported_m)} m` : ''}</dd></div>}
          </dl>
        </div>
  );
}

const Radar = React.memo(function Radar({ data, site, schedule, t, sel, onSel, tide }) {
  const T = data.config.transit_hrs, vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const ships = schedule.map((r) => ({ r, v: vmap[r.vessel_id], s: shipAt(r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })).filter((x) => x.s);
  const fixed = (data.live.fixed_occupants || []).filter((fx) => t < fx.release_hr + T).map((fx) => ({ fx, pos: t < fx.release_hr ? off(chan(quayS(fx.berth_start_m + fx.loa_m / 2)), 7) : chan((1 - (t - fx.release_hr) / T) * quayS(fx.loa_m / 2)).p }));
  const q0 = off(chan(quayS(0)), 13), q820 = off(chan(quayS(820)), 13), q1000 = off(chan(quayS(1000)), 13);
  const berthRank = Object.fromEntries(ships.filter((x) => x.s.phase === 'BERTH').sort((a, b) => a.r.berth_start_m - b.r.berth_start_m).map((x, i) => [x.r.vessel_id, i]));
  const cur = ships.find((x) => x.r.vessel_id === sel), dc = cur && (data.draught_check || []).find((d) => d.vessel === sel);
  const hr = Math.floor(t), gate = cur && site.transitOk(hr, cur.r.loa_m, cur.r.draft_m), night = !(site.clock(hr) >= data.config.daylight_hours[0] && site.clock(hr) < data.config.daylight_hours[1]);
  const hull = 'M13,0 L5,-4.6 L-11,-4.6 L-11,4.6 L5,4.6 Z';
  return (
    <div><div className="pf-radar">
      <svg viewBox="0 0 760 430" role="img" aria-label="Schematic chart of the Bay of Bengal approach, the outer anchorage, the Karnaphuli channel and the NCT quay with the planned position of each vessel">
        <defs><linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#5ef2c8" stopOpacity="0" /><stop offset="1" stopColor="#5ef2c8" stopOpacity=".28" /></linearGradient></defs>
        {[60, 120, 180, 240].map((r) => <circle key={r} cx="250" cy="258" r={r} fill="none" stroke="#12303f" strokeDasharray="2 5" />)}
        <g className="pf-sweep"><path d="M250,258 L250,18 A240,240 0 0 1 420,88 Z" fill="url(#sw)" /></g>
        <path d="M430,0 C420,60 452,120 440,180 C434,214 470,236 452,244 L560,158 C600,130 680,112 760,96 L760,0 Z" fill="#0c1a22" stroke="#24404f" />
        <path d="M452,272 C480,268 520,262 556,214 C590,180 650,168 760,150 L760,430 L470,430 C440,380 470,330 452,272 Z" fill="#0c1a22" stroke="#24404f" />
        <polyline points={CH.map((p) => p.join(',')).join(' ')} fill="none" stroke="#1d5068" strokeWidth="1.2" strokeDasharray="6 5" />
        <line x1={q0[0]} y1={q0[1]} x2={q820[0]} y2={q820[1]} stroke={C.tele} strokeWidth="3.5" />
        <line x1={q820[0]} y1={q820[1]} x2={q1000[0]} y2={q1000[1]} stroke={C.muted} strokeWidth="3.5" strokeDasharray="4 3" />
        <g fontFamily="Rajdhani, sans-serif" fontSize="11" letterSpacing="1.4" fill={C.muted}>
          <text x="20" y="26">BAY OF BENGAL</text><text x="170" y="196">OUTER ANCHORAGE</text><text x="378" y="286">SEA BUOY</text>
          <text x="470" y="318">KARNAPHULI RIVER</text><text x={q0[0] - 70} y={q0[1] - 44} fill={C.tele}>NCT OCEAN QUAY 0–820 m</text><text x="754" y={q1000[1] + 54} textAnchor="end">BARGE BERTH ↑</text>
          <text x="20" y="418">from Singapore · Port Klang ↗</text><text x="20" y="340">← from Colombo</text><text x="640" y="60">CHATTOGRAM</text>
        </g>
        <ellipse cx="258" cy="252" rx="104" ry="62" fill="rgba(255,178,36,.04)" stroke="#5a4313" strokeDasharray="3 4" />
        {cur && cur.s.phase !== 'SAILED' && <polyline points={[ORIGIN(cur.v), anchorSlot(order.indexOf(sel)), ...CH.filter((_, i) => CH_LEN[i] < quayS((cur.r.berth_start_m + cur.r.berth_end_m) / 2)), off(chan(quayS((cur.r.berth_start_m + cur.r.berth_end_m) / 2)), 7)].map((p) => p.join(',')).join(' ')} fill="none" stroke={C.tele} strokeOpacity=".45" strokeWidth="1" />}
        {(data.live.also_in_port_not_modelled || []).map((o, i) => { const c = off(chan(CH_LEN[3] + i * 26), -8); return <g key={o.name} transform={`translate(${c[0]},${c[1]}) rotate(${(chan(CH_LEN[3]).ang * 180) / Math.PI})`}><path d={hull} fill="none" stroke="#51677a" /><title>{`${o.name}: ${o.status}. Terminal not published, not in the plan.`}</title></g>; })}
        {fixed.map(({ fx, pos }) => <g key={fx.name}><g transform={`translate(${pos[0]},${pos[1]}) rotate(${(chan(quayS(fx.loa_m / 2)).ang * 180) / Math.PI})`}><path d={hull} fill="#51677a" /><title>{`${fx.name}: ${fx.status}`}</title></g>
          <text x={pos[0] - 30} y={pos[1] + 17} fontSize="9" fill="#6f8598">{fx.name}</text></g>)}
        {ships.map(({ r, s }) => (
          <g key={r.vessel_id} className="pf-ship" opacity={s.fade ?? 1} onClick={() => onSel(r.vessel_id)} tabIndex="0" role="button" aria-label={`${r.vessel_id}, ${s.text}`} onKeyDown={(e) => e.key === 'Enter' && onSel(r.vessel_id)}>
            <g transform={`translate(${s.p[0].toFixed(1)},${s.p[1].toFixed(1)})`}>
              {(s.phase === 'CHANNEL' || r.vessel_id === sel) && <circle className="ping" r="12" fill="none" stroke={PHASE_C[s.phase]} />}
              <circle r="16" fill="transparent" />
              <path d={hull} transform={`rotate(${((s.ang * 180) / Math.PI).toFixed(1)})`} fill={PHASE_C[s.phase]} stroke={r.vessel_id === sel ? '#fff' : 'none'} strokeWidth="1.4" />
              <text textAnchor="middle" y={s.phase === 'BERTH' ? (berthRank[r.vessel_id] % 2 ? 21 : -11) : -10} fontSize="10.5" fill={r.vessel_id === sel ? '#fff' : C.ink} stroke="#060b10" strokeWidth="2.5" paintOrder="stroke">{r.vessel_id}</text>
            </g>
          </g>
        ))}
        <g fontSize="10" fill={C.muted}><text x="592" y="420">tide {fmt(tide, 2)} m · {night ? 'night rule on' : 'daylight'}</text></g>
      </svg></div>
      {cur && <NctCard cur={cur} gate={gate} tide={tide} dc={dc} />}
    </div>
  );
});

// ------------------------------------------------------------------ Hamburg: real map of the Elbe and the terminals (Leaflet, OpenStreetMap)
const TERM_C = { CTB: '#4aa3ff', CTH: '#c58cff', CTT: '#ffb224', CTA: '#5ef2c8' };
const SEA_EXIT = [54.06, 7.85];
const mxy = (p) => [p[1] * 111320 * Math.cos((p[0] * Math.PI) / 180), p[0] * 110540];
const TILE_OSM = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }];
const TILE_SEA = ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { pane: 'sea', maxZoom: 18, attribution: 'sea marks &copy; <a href="https://www.openseamap.org">OpenSeaMap</a>' }];
function useBaseMap(box, Lf, bounds, draw, deps) {           // one Leaflet map: OSM base (darkened in CSS), OpenSeaMap marks, then the site's own layers
  const map = useRef(null), mk = useRef({});
  useEffect(() => {
    if (!Lf || !box.current || map.current) return undefined;
    const m = Lf.map(box.current, { scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true }).fitBounds(bounds);
    Lf.tileLayer(...TILE_OSM).addTo(m);
    m.createPane('sea'); m.getPane('sea').style.zIndex = 250; m.getPane('sea').style.pointerEvents = 'none';
    Lf.tileLayer(...TILE_SEA).addTo(m);
    draw(m);
    m.on('click', () => m.scrollWheelZoom.enable());           // the wheel zooms only after a click, so the page still scrolls
    map.current = m;
    return () => { m.remove(); map.current = null; mk.current = {}; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { map, mk };
}
function syncShips(Lf, map, mk, ships, sel, onSel) {           // create or move one marker per ship; markers of ships gone from view are removed
  const m = map.current; if (!m || !Lf) return;
  const keep = new Set();
  for (const x of ships) {
    keep.add(x.id); const c = x.fixed ? '#8aa0b3' : PHASE_C[x.s.phase], on = x.id === sel, html = shipSvg(c, x.s.ang, on);
    let e = mk.current[x.id];
    if (!e) {
      e = { m: Lf.marker(x.s.p, { icon: Lf.divIcon({ className: 'pf-mk', iconSize: [26, 26], iconAnchor: [13, 13], html }), title: x.id, keyboard: true }).addTo(m), html };
      e.m.on('click', () => !x.fixed && onSel(x.id)); e.m.bindTooltip(x.tip || x.id, { permanent: !x.fixed, direction: 'right', offset: [10, 0], className: 'pf-tip' });
      mk.current[x.id] = e;
    } else e.m.setLatLng(x.s.p);
    if (e.html !== html) { const el = e.m.getElement(); if (el) el.innerHTML = html; e.html = html; }
    const el = e.m.getElement(); if (el) el.style.opacity = String(x.s.fade ?? 1);
  }
  for (const [id, e] of Object.entries(mk.current)) if (!keep.has(id)) { e.m.remove(); delete mk.current[id]; }
}
const segM = (a, b) => Math.hypot(mxy(b)[0] - mxy(a)[0], mxy(b)[1] - mxy(a)[1]);
function along(path, f) {                                     // point and heading at fraction f of a lat/lon polyline
  const L = []; let tot = 0; for (let i = 1; i < path.length; i++) { tot += segM(path[i - 1], path[i]); L.push(tot); }
  const d = clamp(f, 0, 1) * tot; let i = 0; while (i < L.length - 1 && L[i] < d) i++;
  const a = path[i], b = path[i + 1] || path[i], d0 = i ? L[i - 1] : 0, k = L[i] > d0 ? (d - d0) / (L[i] - d0) : 0;
  const A = mxy(a), B = mxy(b);
  return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], ang: Math.atan2(B[0] - A[0], B[1] - A[1]) };
}
function quayOf(quays, axisM) { return Object.values(quays).find((q) => axisM >= q.axis_lo && axisM < q.axis_hi + 1) || Object.values(quays)[0]; }
function berthPoint(quays, axisStart, len) {
  const q = quayOf(quays, axisStart), line = q.line; let tot = 0; for (let i = 1; i < line.length; i++) tot += segM(line[i - 1], line[i]);
  const s = along(line, (axisStart - q.axis_lo + len / 2) / tot);
  return { q, p: s.p, ang: s.ang };
}
function hamPath(data, v, q) {                                  // inbound route: from the ship's river position (if any) up the Elbe to its terminal
  const route = data.live.elbe_route, inRiver = v && v.lat != null && v.lon > route[0][1] && v.lon < route[route.length - 1][1] && /ELBE|ESTUARY/.test(v.area || '');
  const pts = inRiver ? [[v.lat, v.lon], ...route.filter((p) => p[1] > v.lon)] : route;
  return [...pts, ...q.approach];
}
function hamShipAt(data, row, v, t, idx, T) {
  const bp = berthPoint(data.live.quays, row.berth_start_m, row.berth_end_m - row.berth_start_m), path = [...hamPath(data, v, bp.q), bp.p];
  const hold = [54.03 + 0.035 * (idx % 3), 7.98 - 0.11 * Math.floor(idx / 3)];
  if (t < row.eta_hr) {
    const o = v && v.lat != null && !/ELBE|ESTUARY|PORT/.test(v.area || '') ? [v.lat, v.lon] : hold, k = row.eta_hr > 0 ? t / row.eta_hr : 1;
    return { phase: 'INBOUND', p: [o[0] + (hold[0] - o[0]) * k, o[1] + (hold[1] - o[1]) * k], ang: Math.atan2(hold[1] - o[1], hold[0] - o[0]), text: `Inbound, ${fmt(row.eta_hr - t, 0)} h to the Elbe` };
  }
  if (t < row.transit_in_hr) return { phase: 'ANCHOR', p: hold, ang: 1.6, text: `Waiting off Elbe-1, passage starts in ${fmt(row.transit_in_hr - t, 0)} h` };
  if (t < row.berth_start_hr) { const s = along(path, (t - row.transit_in_hr) / T); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'On the Elbe, inbound' }; }
  if (t < row.tidal_depart_hr) return { phase: 'BERTH', p: bp.p, ang: bp.ang, text: t < row.cargo_done_hr ? `Working cargo with ${row.assigned_qcs} quay cranes` : 'Cargo complete, waiting for the tide' };
  const out = [bp.p, ...[...bp.q.approach].reverse(), ...[...data.live.elbe_route].reverse(), SEA_EXIT];
  if (t < row.tidal_depart_hr + T) { const s = along(out, (t - row.tidal_depart_hr) / T * 0.93); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'On the Elbe, outbound' }; }
  const u = (t - row.tidal_depart_hr - T) / 6;
  return u < 1 ? { ...along(out, 0.93 + 0.07 * u), phase: 'SAILED', text: 'Sailed', fade: 1 - u } : null;
}
const shipSvg = (c, ang, selOn) => `<svg viewBox="-13 -13 26 26" width="26" height="26" style="overflow:visible"><g transform="rotate(${((ang * 180) / Math.PI).toFixed(0)})"><path d="M0,-10 L5,7 L0,3.6 L-5,7 Z" fill="${c}" stroke="${selOn ? '#fff' : '#05090d'}" stroke-width="${selOn ? 1.6 : 1}"/></g></svg>`;

const ElbeMap = React.memo(function ElbeMap({ data, site, schedule, t, sel, onSel }) {
  const box = useRef(null), [zoomed, setZoomed] = useState('river');
  const T = data.config.transit_hrs, Lf = typeof window !== 'undefined' ? window.L : null;
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const { map, mk } = useBaseMap(box, Lf, [[53.47, 7.85], [54.1, 10.0]], (m) => {
    Lf.polyline(data.live.elbe_route, { color: '#5ef2c8', weight: 1.4, opacity: 0.55, dashArray: '6 6' }).addTo(m);
    Object.values(data.live.quays).forEach((q) => Lf.polyline(q.line, { color: TERM_C[q.terminal], weight: 6, opacity: 0.9 }).addTo(m).bindTooltip(`${q.id} · ${q.name} · ${fmt(q.length_m, 0)} m`, { sticky: true }));
    (data.live.gauges || []).forEach((g) => { const pos = GAUGE_LL[g.name]; if (pos) Lf.circleMarker(pos, { radius: 3.5, color: '#4aa3ff', weight: 1, fillOpacity: 1 }).addTo(m).bindTooltip(`${g.name} gauge, Elbe km ${g.km}`); });
  }, [data, Lf]);
  const ships = [
    ...schedule.map((r) => ({ id: r.vessel_id, r, v: vmap[r.vessel_id], s: hamShipAt(data, r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })),
    ...(data.live.fixed_occupants || []).map((f) => { const r = { vessel_id: f.name, berth_start_m: f.berth_start_m, berth_end_m: f.berth_start_m + Math.ceil(f.loa_m), eta_hr: -99, transit_in_hr: -98, berth_start_hr: -97, cargo_done_hr: f.release_hr, tidal_depart_hr: f.release_hr, assigned_qcs: 0 };
      return { id: f.name, r, v: f, fixed: true, s: hamShipAt(data, r, f, t, 0, T) }; }),
  ].filter((x) => x.s);
  useEffect(() => syncShips(Lf, map, mk, ships, sel, onSel));
  const go = (w) => { const m = map.current; if (!m) return; setZoomed(w); m.flyToBounds(w === 'port' ? [[53.493, 9.895], [53.545, 9.965]] : [[53.47, 7.85], [54.1, 10.0]], { duration: 0.8 }); };
  const cur = ships.find((x) => x.id === sel && !x.fixed), hr = Math.floor(t), gate = cur && site.gateNow(sel, hr);
  return (
    <div>
      <div className="pf-seg" style={{ marginBottom: 6 }}><button className={`pf-btn${zoomed === 'river' ? ' on' : ''}`} onClick={() => go('river')}>Elbe, sea to port</button><button className={`pf-btn${zoomed === 'port' ? ' on' : ''}`} onClick={() => go('port')}>Terminals</button>
        {Object.entries(TERM_C).map(([k, c]) => <span key={k} className="pf-key" style={{ '--c': c, marginLeft: 6 }}><i />{k}</span>)}</div>
      {Lf ? <div ref={box} className="pf-map" role="application" aria-label="Map of the Elbe from the North Sea to the Hamburg container terminals with each ship at its planned position" /> : <div className="pf-map pf-read">The map library did not load; the plan is still in the berth chart and the table below.</div>}
      {cur && (
        <div className="pf-card">
          <h3>{cur.id}<span style={{ color: PHASE_C[cur.s.phase] }}>{cur.s.text}</span></h3>
          <dl>
            <div><dt>IMO / MMSI</dt><dd className="num">{cur.v.imo} / {cur.v.mmsi}</dd></div>
            <div><dt>Length × beam</dt><dd className="num">{fmt(cur.v.loa_m, 0)} × {fmt(cur.v.beam_m, 0)} m</dd></div>
            <div><dt>Draught</dt><dd className="num">{cur.v.draught_reported_m == null ? 'not reported' : `${fmt(cur.v.draught_reported_m)} m on AIS`}{cur.v.tide_dependent ? ', tide-dependent on the Elbe' : ', tide-independent'}</dd></div>
            <div><dt>Terminal</dt><dd>{data.live.terminals[cur.v.terminal]} ({cur.v.terminal_basis})</dd></div>
            <div><dt>Last AIS</dt><dd>{cur.v.ais_time_utc ? `${cur.v.ais_time_utc.slice(5, 16).replace('T', ' ')}Z, ${cur.v.sog_kn ?? '—'} kn` : 'no position kept'}</dd></div>
            <div><dt>Elbe gate now</dt><dd style={{ color: gate ? C.ok : C.red }}>{gate ? 'open' : `shut: needs ${fmt(cur.r.tide_needed_m)} m above mean low water plus the forecast error`}</dd></div>
            <div><dt>Berth</dt><dd className="num">{berthLabel(data, cur.r)}, {cur.r.assigned_qcs} quay cranes</dd></div>
            <div><dt>Arrival basis</dt><dd>{cur.v.eta_basis}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
});
// ------------------------------------------------------------------ Chattogram: real map of the Bay of Bengal, the outer anchorage and the Karnaphuli (Leaflet, OpenStreetMap)
// Quay lines are the water side of the OpenStreetMap quay outlines (way 1074952516 for NCT, 1074952517 for CCT and the general
// cargo berths); the river line is OSM's Karnaphuli centre line. Which end of the NCT quay holds the barge berth is not published:
// the planner's 0-1000 m axis is laid on the northern 1,000 m of the outline, barge berth upstream.
const NCT_LINE = [[22.28917, 91.79354], [22.29073, 91.79363], [22.29242, 91.79369], [22.29334, 91.79386], [22.29525, 91.79427], [22.29738, 91.79478], [22.29785, 91.7949], [22.29829, 91.7951], [22.29927, 91.79561], [22.30175, 91.79674]];
const CCT_LINE = [[22.30332, 91.79751], [22.30486, 91.7986], [22.30609, 91.79953], [22.30754, 91.80096], [22.30918, 91.80284], [22.31084, 91.80517], [22.31271, 91.80779], [22.31412, 91.80983], [22.31529, 91.81145], [22.31639, 91.81299]];
const KARNAPHULI = [[22.2249, 91.80495], [22.24215, 91.82622], [22.24493, 91.82969], [22.25606, 91.83605], [22.26039, 91.83707], [22.26485, 91.83635], [22.268, 91.83321], [22.2705, 91.82876], [22.27148, 91.8196], [22.27287, 91.81295], [22.27483, 91.80756], [22.27699, 91.80365], [22.28003, 91.79987], [22.28354, 91.79733], [22.28708, 91.79612]];
const SEA_BUOY = [22.19, 91.77], BAY_ENTRY = [21.0, 91.55];
const ROUTE_SG = [[1.25, 103.85], [2.6, 101.4], [4.2, 99.8], [5.9, 97.6], [6.0, 94.6], BAY_ENTRY];
const ROUTE_CMB = [[6.95, 79.85], [5.85, 80.6], BAY_ENTRY];
const CTG_VIEWS = { bay: [[0.5, 78.5], [23.2, 104.5]], approach: [[21.55, 91.25], [22.45, 92.05]], port: [[22.22, 91.765], [22.32, 91.845]] };
const lineLen = (line) => { let s = 0; for (let i = 1; i < line.length; i++) s += segM(line[i - 1], line[i]); return s; };
const NCT_LEN = lineLen(NCT_LINE);
const nctPoint = (axisM) => along(NCT_LINE, (NCT_LEN - 1000 + clamp(axisM, 0, 1000)) / NCT_LEN);
function seaPath(v) {                                           // from where the ship is (AIS) or its last port (schedule) to the Bay entry
  if (v && v.lat != null) {
    const { lat, lon } = v;
    const ahead = lon >= 97 && lat < 6.5 ? ROUTE_SG.filter((p) => p[1] < lon) : lon >= 94 && lat < 6.5 ? [[6.0, 94.6], BAY_ENTRY] : lon < 82 && lat < 10 ? (lon < 80.6 ? [[5.85, 80.6], BAY_ENTRY] : [BAY_ENTRY]) : [];
    return { path: [[lat, lon], ...ahead], live: true };
  }
  return { path: /Colombo/.test((v && v.last_port) || '') ? ROUTE_CMB : ROUTE_SG, live: false };
}
function ctgShipAt(row, v, t, idx, T) {
  const slot = [22.035 + 0.032 * (idx % 3), 91.665 + 0.038 * (Math.floor(idx / 3) % 3)];
  const bp = nctPoint((row.berth_start_m + row.berth_end_m) / 2), sea = seaPath(v), inbound = [...sea.path, slot];
  if (t < row.eta_hr) {
    const k0 = sea.live ? 0 : START_K[(v && v.area) || ''] ?? 0.2, k = k0 + (1 - k0) * (row.eta_hr > 0 ? t / row.eta_hr : 1), s = along(inbound, k);
    return { phase: 'INBOUND', p: s.p, ang: s.ang, text: `Inbound, ${fmt(row.eta_hr - t, 0)} h to the anchorage` };
  }
  if (t < row.transit_in_hr) return { phase: 'ANCHOR', p: slot, ang: 0.6, text: `At anchor, pilot booked in ${fmt(row.transit_in_hr - t, 0)} h` };
  const river = [slot, SEA_BUOY, ...KARNAPHULI, bp.p];
  if (t < row.berth_start_hr) { const s = along(river, (t - row.transit_in_hr) / T); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'Under pilotage, inbound on the Karnaphuli' }; }
  if (t < row.tidal_depart_hr) return { phase: 'BERTH', p: bp.p, ang: bp.ang, text: t < row.cargo_done_hr ? `Working cargo with ${row.assigned_qcs} quay cranes` : 'Cargo complete, holding for tide or daylight' };
  const out = [...river].reverse();
  if (t < row.tidal_depart_hr + T) { const s = along(out, (t - row.tidal_depart_hr) / T); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'Under pilotage, outbound' }; }
  const u = (t - row.tidal_depart_hr - T) / 10;
  return u < 1 ? { ...along([slot, BAY_ENTRY], u), phase: 'SAILED', text: 'Sailed', fade: 1 - u } : null;
}

const KarnaphuliMap = React.memo(function KarnaphuliMap({ data, site, schedule, t, sel, onSel, tide }) {
  const box = useRef(null), [zoomed, setZoomed] = useState('bay');
  const T = data.config.transit_hrs, Lf = typeof window !== 'undefined' ? window.L : null;
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const { map, mk } = useBaseMap(box, Lf, CTG_VIEWS.bay, (m) => {
    [ROUTE_SG, ROUTE_CMB].forEach((r) => Lf.polyline([...r, [22.08, 91.7]], { color: '#4aa3ff', weight: 1.2, opacity: 0.45, dashArray: '4 7' }).addTo(m));
    Lf.rectangle([[22.02, 91.645], [22.13, 91.775]], { color: '#ffb224', weight: 1, opacity: 0.6, fill: false, dashArray: '3 4' }).addTo(m).bindTooltip('Outer anchorage (approximate)');
    Lf.polyline([SEA_BUOY, ...KARNAPHULI, NCT_LINE[NCT_LINE.length - 1]], { color: '#5ef2c8', weight: 1.4, opacity: 0.6, dashArray: '6 6' }).addTo(m).bindTooltip('Karnaphuli channel (OpenStreetMap river line)');
    const n0 = (NCT_LEN - 1000) / NCT_LEN, n820 = (NCT_LEN - 180) / NCT_LEN, part = (a, b) => Array.from({ length: 25 }, (_, i) => along(NCT_LINE, a + ((b - a) * i) / 24).p);
    Lf.polyline(part(n0, n820), { color: '#5ef2c8', weight: 6, opacity: 0.95 }).addTo(m).bindTooltip('NCT ocean quay, 0-820 m on the plan axis', { sticky: true });
    Lf.polyline(part(n820, 1), { color: '#8097a9', weight: 6, opacity: 0.9 }).addTo(m).bindTooltip('NCT barge berth, 820-1000 m (not planned)', { sticky: true });
    Lf.polyline(CCT_LINE, { color: '#3a4b5b', weight: 6, opacity: 0.9 }).addTo(m).bindTooltip('CCT and general cargo berths (not modelled)', { sticky: true });
    if (data.live.tide_detail) Lf.circleMarker([22.208, 91.792], { radius: 4, color: '#4aa3ff', weight: 1, fillOpacity: 1 }).addTo(m).bindTooltip('Open-Meteo sea-level grid cell used for the tide forecast');
  }, [data, Lf]);
  const ships = [
    ...schedule.map((r) => ({ id: r.vessel_id, r, v: vmap[r.vessel_id], s: ctgShipAt(r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })),
    ...(data.live.fixed_occupants || []).map((f) => { const r = { vessel_id: f.name, berth_start_m: f.berth_start_m, berth_end_m: f.berth_start_m + Math.ceil(f.loa_m), eta_hr: -99, transit_in_hr: -98, berth_start_hr: -97, cargo_done_hr: f.release_hr, tidal_depart_hr: f.release_hr, assigned_qcs: 0 };
      return { id: f.name, r, v: f, fixed: true, tip: `${f.name} (alongside)`, s: ctgShipAt(r, f, t, 0, T) }; }),
    ...(data.live.also_in_port_not_modelled || []).map((o, i) => { const s = along(CCT_LINE, 0.25 + 0.3 * i); return { id: o.name, v: o, fixed: true, tip: `${o.name}: in port, terminal not published, not in the plan`, s: { ...s, phase: 'BERTH' } }; }),
  ].filter((x) => x.s);
  useEffect(() => syncShips(Lf, map, mk, ships, sel, onSel));
  const go = (w) => { const m = map.current; if (!m) return; setZoomed(w); m.flyToBounds(CTG_VIEWS[w], { duration: 0.8 }); };
  const cur = ships.find((x) => x.id === sel && !x.fixed), dc = cur && (data.draught_check || []).find((d) => d.vessel === sel);
  const hr = Math.floor(t), gate = cur && site.transitOk(hr, cur.r.loa_m, cur.r.draft_m);
  return (
    <div>
      <div className="pf-seg" style={{ marginBottom: 6 }}>
        {[['bay', 'Bay of Bengal'], ['approach', 'Approach and anchorage'], ['port', 'Karnaphuli and NCT']].map(([k, l]) => <button key={k} className={`pf-btn${zoomed === k ? ' on' : ''}`} onClick={() => go(k)}>{l}</button>)}
      </div>
      {Lf ? <div ref={box} className="pf-map" role="application" aria-label="Map of the Bay of Bengal, the Chattogram outer anchorage and the Karnaphuli river to the NCT quay, with each ship at its planned position" /> : <div className="pf-map pf-read">The map library did not load; the plan is still in the berth chart and the table below.</div>}
      {cur && <NctCard cur={cur} gate={gate} tide={tide} dc={dc} />}
    </div>
  );
});

const GAUGE_LL = { 'CUXHAVEN STEUBENHÖFT': [53.8677, 8.7174], 'BRUNSBÜTTEL MPM': [53.8878, 9.1487], 'GLÜCKSTADT': [53.7844, 9.4094], 'STADERSAND': [53.6297, 9.5266], 'SCHULAU': [53.5679, 9.7029], 'HAMBURG ST. PAULI': [53.5454, 9.97] };
function berthLabel(data, r) {
  if (!data.live.quays) return `${r.berth_start_m}–${r.berth_end_m} m`;
  const q = quayOf(data.live.quays, r.berth_start_m);
  return `${q.id} ${fmt(r.berth_start_m - q.axis_lo, 0)}–${fmt(r.berth_end_m - q.axis_lo, 0)} m`;
}

// ------------------------------------------------------------------ berth Gantt with tide strip
const G0 = { L: 64, R: 12, W: 1180, tideTop: 14, tideH: 62, top: 96, H: 250 };
const Gantt = React.memo(function Gantt({ data, site, schedule, ghost, t, sel, onSel, tMax }) {
  const quays = data.live.quays ? Object.values(data.live.quays) : null, AX = quays ? data.config.quay_ocean_m : 1000, G = quays ? { ...G0, L: 92, H: 380 } : G0;
  const tMaxTide = Math.max(4.2, ...data.tide_hourly.slice(0, data.config.horizon_hrs + 1)) * 1.04;
  const cfg = data.config, H = cfg.horizon_hrs, px = (G.W - G.L - G.R) / H, x = (h) => G.L + h * px, y = (m) => G.top + (m / AX) * G.H, ty = (v) => G.tideTop + G.tideH - (v / tMaxTide) * G.tideH;
  const ep = Number(data.live.plan_epoch_local.slice(11, 13));
  const nights = []; for (let h = 0; h < H; h++) { const c = site.clock(h), n = !(c >= cfg.daylight_hours[0] && c < cfg.daylight_hours[1]); if (n && (h === 0 || nights.length === 0 || nights[nights.length - 1][1] !== h)) nights.push([h, h + 1]); else if (n) nights[nights.length - 1][1] = h + 1; }
  const days = []; for (let h = (24 - ep) % 24; h <= H; h += 24) days.push(h);
  const s = schedule.find((r) => r.vessel_id === sel), need = s ? s.tide_needed_m : quays ? 0 : cfg.max_draught_m + cfg.ukc_m - cfg.channel_depth_m;
  const open = []; for (let h = 0; h < H; h++) if (quays ? s && site.gateNow(s.vessel_id, h) : site.transitOk(h, s ? s.loa_m : 185, s ? s.draft_m : cfg.max_draught_m)) open.push(h);
  const tidePath = data.tide_hourly.slice(0, H + 1).map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)},${ty(v).toFixed(1)}`).join(' ');
  const hgt = (m) => (m / AX) * G.H;
  return (
    <div className="pf-scroll">
      <svg viewBox={`0 0 ${G.W} ${G.top + G.H + 30}`} style={{ display: 'block', width: '100%', minWidth: 860 }} role="img" aria-label="Berth plan: quay position against time, with the tide curve and night bands">
        <defs><pattern id="hold" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#132a3c" /><rect width="2.5" height="6" fill="#3b6a8f" /></pattern></defs>
        {nights.map(([a, b]) => <rect key={a} x={x(a)} y={G.tideTop} width={(b - a) * px} height={G.top + G.H - G.tideTop} fill="#000" opacity=".42" />)}
        {days.map((h) => { const c = planClock(data.live.plan_epoch_local, h); return <g key={h}><line x1={x(h)} x2={x(h)} y1={G.tideTop} y2={G.top + G.H} stroke={C.line} /><text x={x(h) + 4} y={G.top + G.H + 14} fontSize="10" fill={C.muted}>{c.day} {c.date}</text></g>; })}
        <text x={G.L - 6} y={G.tideTop + 8} fontSize="9.5" fill={C.muted} textAnchor="end">{quays ? 'm > MLW' : 'tide m'}</text>
        {[1, 2, 3, ...(tMaxTide > 4.6 ? [4] : [])].map((v) => <text key={v} x={G.L - 6} y={ty(v) + 3} fontSize="9" fill={C.muted} textAnchor="end">{v}</text>)}
        <path d={`${tidePath} L${x(H)},${ty(0)} L${x(0)},${ty(0)} Z`} fill="rgba(74,163,255,.14)" /><path d={tidePath} fill="none" stroke={C.blue} strokeWidth="1.3" />
        {need > 0 && <line x1={x(0)} x2={x(H)} y1={ty(need)} y2={ty(need)} stroke={C.amber} strokeDasharray="4 3" />}
        <text x={x(H) - 4} y={ty(Math.max(need, 0.15)) - 3} fontSize="9.5" fill={C.amber} textAnchor="end">{quays ? (s ? (need > 0 ? `${s.vessel_id} needs ${fmt(need)} m above mean low water on the river, plus the forecast error` : `${s.vessel_id} is tide-independent`) : 'select a ship') : `${s ? `${s.vessel_id} needs` : `${fmt(cfg.max_draught_m)} m draught needs`} ${fmt(need)} m of tide`}</text>
        {open.map((h) => <rect key={h} x={x(h)} y={G.tideTop + G.tideH + 5} width={px} height="5" fill={C.ok} />)}
        <text x={G.L - 6} y={G.tideTop + G.tideH + 11} fontSize="9" fill={C.ok} textAnchor="end">gate open</text>
        <rect x={x(0)} y={y(0)} width={H * px} height={G.H} fill="none" stroke={C.hi} />
        {quays ? <>
          {quays.map((q, i) => <g key={q.id}>{i > 0 && <rect x={x(0)} y={y(q.axis_lo - 200)} width={H * px} height={hgt(200)} fill="#05090d" />}
            <line x1={x(0)} x2={x(H)} y1={y(q.axis_lo)} y2={y(q.axis_lo)} stroke={C.hi} /><rect x={G.L - 5} y={y(q.axis_lo)} width="3" height={hgt(q.length_m)} fill={TERM_C[q.terminal]} />
            <text x={G.L - 9} y={y((q.axis_lo + q.axis_hi) / 2) + 3} fontSize="10" fill={C.ink} textAnchor="end">{q.id}</text><text x={G.L - 9} y={y((q.axis_lo + q.axis_hi) / 2) + 14} fontSize="8.5" fill={C.muted} textAnchor="end">{fmt(q.length_m, 0)} m</text></g>)}
        </> : <>
          <rect x={x(0)} y={y(cfg.quay_ocean_m)} width={H * px} height={y(1000) - y(cfg.quay_ocean_m)} fill="#0b141c" /><text x={x(0) + 6} y={y(910) + 4} fontSize="10" fill={C.muted}>barge berth 820–1000 m: river barges, not planned here</text>
          {[0, 205, 410, 615, 820, 1000].map((m) => <g key={m}><line x1={x(0)} x2={x(H)} y1={y(m)} y2={y(m)} stroke={C.line} /><text x={G.L - 6} y={y(m) + 3} fontSize="9.5" fill={C.muted} textAnchor="end">{m} m</text></g>)}
        </>}
        {(data.live.fixed_occupants || []).map((fx) => <g key={fx.name}><rect x={x(0)} y={y(fx.berth_start_m)} width={Math.max(0, Math.min(fx.release_hr, H)) * px} height={hgt(fx.loa_m)} fill="#27333e" stroke="#3a4b5b" />
          <text x={x(0) + 4} y={y(fx.berth_start_m) + Math.min(13, hgt(fx.loa_m) - 2)} fontSize="9.5" fill={C.muted}>{fx.name} (alongside)</text><title>{`${fx.name}: ${fx.status}${fx.release_basis ? `; leaves about hour ${fx.release_hr} (${fx.release_basis})` : ''}`}</title></g>)}
        {ghost && ghost.map((r) => <rect key={`g${r.vessel_id}`} x={x(r.berth_start_hr)} y={y(r.berth_start_m)} width={(r.tidal_depart_hr - r.berth_start_hr) * px} height={hgt(r.berth_end_m - r.berth_start_m)} fill="none" stroke={C.red} strokeDasharray="4 3" opacity=".8" />)}
        {schedule.map((r) => { const w = (r.tidal_depart_hr - r.berth_start_hr) * px, cw = (r.cargo_done_hr - r.berth_start_hr) * px, h = hgt(r.berth_end_m - r.berth_start_m), on = r.vessel_id === sel;
          return (
            <g key={r.vessel_id} className="pf-gbar" style={{ transform: `translate(${x(r.berth_start_hr)}px,${y(r.berth_start_m)}px)` }} onClick={() => onSel(r.vessel_id)}>
              <rect width={w} height={h} fill="url(#hold)" /><rect width={cw} height={h} fill={on ? '#2b8f86' : '#2f6f9f'} />
              <rect width={w} height={h} fill="none" stroke={on ? '#fff' : '#7fb6e0'} strokeWidth={on ? 1.6 : 0.8} />
              <line x1={-data.config.transit_hrs * px} x2="0" y1={h / 2} y2={h / 2} stroke={C.tele} strokeWidth="2" /><line x1={w} x2={w + data.config.transit_hrs * px} y1={h / 2} y2={h / 2} stroke={C.tele} strokeWidth="2" />
              <text x="5" y={Math.min(14, h - 2)} fontSize="10.5" fill="#fff">{r.vessel_id}</text>{h > 30 && <text x="5" y="27" fontSize="9.5" fill="#cfe3f2">{r.assigned_qcs} {quays ? 'STS' : 'QGC'} · {r.moves} moves{r.anchorage_wait_hrs > 0 ? ` · waited ${r.anchorage_wait_hrs} h` : ''}</text>}
              <title>{`${r.vessel_id}: berth ${berthLabel(data, r)}, alongside hour ${r.berth_start_hr}, cargo done hour ${r.cargo_done_hr}, sails hour ${r.tidal_depart_hr} (held ${r.tide_departure_hold_hrs} h for tide${quays ? '' : ' or daylight'}), ${r.assigned_qcs} cranes, ${r.moves} moves`}</title>
            </g>
          ); })}
        <g style={{ transform: `translateX(${x(Math.min(t, tMax))}px)` }}><line y1={G.tideTop} y2={G.top + G.H} stroke={C.tele} strokeWidth="1.4" /><path d={`M-5,${G.tideTop - 8} L5,${G.tideTop - 8} L0,${G.tideTop} Z`} fill={C.tele} /></g>
      </svg>
    </div>
  );
});

// ------------------------------------------------------------------ CSS-3D yard
const Y3 = { U: 21, V: 22, H: 15, G: 1 };
const FACE = { 1: ['#2fbf8f', '#1e8a67', '#15634a'], 2: ['#e0a52a', '#a6781a', '#7a5812'], 3: ['#e2584f', '#a63d37', '#7a2c28'], 4: ['#5d7388', '#44566a', '#33414f'] };
const CH_NAME = { 1: 'green channel', 2: 'yellow channel', 3: 'red channel', 4: 'inherited stock, channel not in the manifest' };
const IMDG_NAME = { 1: 'IMDG class 3', 2: 'IMDG class 2.1', 3: 'IMDG class 5.1' };
export function yardState(Y, nMoves) {
  const map = new Map();
  Y.yard_tensor_before.forEach((rows, b) => rows.forEach((col, r) => col.forEach((d, t) => { if (d > 0) map.set(`${b}-${r}-${t}`, { id: `${b}-${r}-${t}`, b, r, t, d, ch: Y.yard_channel_before[b][r][t], im: Y.yard_imdg_before[b][r][t], moved: false }); })));
  Y.premarshal_moves.slice(0, nMoves).forEach(([b1, r1, t1, b2, r2, t2]) => { const k = `${b1 - 1}-${r1 - 1}-${t1 - 1}`, x = map.get(k); if (!x) return; map.delete(k); map.set(`${b2 - 1}-${r2 - 1}-${t2 - 1}`, { ...x, b: b2 - 1, r: r2 - 1, t: t2 - 1, moved: true }); });
  const boxes = [...map.values()], stacks = {};
  boxes.forEach((x) => { (stacks[`${x.b}-${x.r}`] = stacks[`${x.b}-${x.r}`] || [])[x.t] = x; });
  let blocking = 0;
  Object.values(stacks).forEach((st) => { let min = Infinity; st.forEach((x) => { x.blocking = x.d > min; x.under = x.blocking ? min : null; if (x.blocking) blocking++; min = Math.min(min, x.d); }); });
  boxes.forEach((x) => { x.top = !map.has(`${x.b}-${x.r}-${x.t + 1}`); x.south = !map.has(`${x.b}-${x.r + 1}-${x.t}`); x.east = !map.has(`${x.b + 1}-${x.r}-${x.t}`); });
  return { boxes: boxes.sort((a, b) => (a.id < b.id ? -1 : 1)), blocking };
}
const Yard3D = React.memo(function Yard3D({ boxes, onlyBlocking, onHover, dropKey }) {
  const ref = useRef(null), [w, setW] = useState(900), fit = Math.min(1.2, w / 900);
  useEffect(() => { const el = ref.current; if (!el) return undefined; const m = () => setW(el.clientWidth || 900); m(); if (typeof ResizeObserver === 'undefined') return undefined; const ro = new ResizeObserver(m); ro.observe(el); return () => ro.disconnect(); }, []);
  const W = 40 * Y3.U, D = 6 * Y3.V;
  return (
    <div ref={ref} className="y3-stage" style={{ height: 380 * fit }} role="img" aria-label="Three-dimensional view of one yard block, 40 bays by 6 rows by 5 tiers">
      <div className="y3-fit" style={{ transform: `translateX(${(w - 900 * fit) / 2}px) scale(${fit})` }}>
        <div key={dropKey} className="y3-scene" style={{ width: W, height: D, backgroundSize: `${Y3.U}px ${Y3.V}px` }}>
          {boxes.map((x) => { const f = FACE[x.ch] || FACE[4];
            return (
              <div key={x.id} className={`y3-box${x.blocking ? ' hz' : ''}${x.im ? ' im' : ''}${x.moved ? ' mv' : ''}${onlyBlocking && !x.blocking ? ' dim' : ''}`} onMouseEnter={() => onHover(x)} onMouseLeave={() => onHover(null)}
                style={{ left: x.b * Y3.U + Y3.G, top: x.r * Y3.V + Y3.G, width: Y3.U - 2 * Y3.G, height: Y3.V - 2 * Y3.G, '--z': `${x.t * Y3.H}px`, '--h': `${Y3.H - 1}px`, '--dl': `${(x.t * 0.16 + x.b * 0.012).toFixed(2)}s`, '--c0': f[0], '--c1': f[1], '--c2': f[2] }}>
                {x.south && <i className="s" />}{x.east && <i className="e" />}{(x.top || x.blocking) && <i className="t" />}
              </div>
            ); })}
          {[1, 10, 20, 30, 40].map((n) => <span key={n} style={{ position: 'absolute', left: (n - 1) * Y3.U + 2, top: D + 14, color: C.muted, fontSize: 11 }}>B{pad(n)}</span>)}
        </div>
      </div>
    </div>
  );
});

// ------------------------------------------------------------------ copilot: text -> structured actions
const RULES = (vessels, sc, k, t, HH) => `You are the command parser for a container-terminal planning engine at ${HH ? 'the Port of Hamburg (terminals CTB Burchardkai, CTH Eurogate, CTT Tollerort, CTA Altenwerder; ships come up the Elbe)' : 'Chattogram NCT'}. Turn the operator's message into JSON only, no prose around it:
{"actions":[...],"reply":"one or two plain sentences"}
Action types (use only these):
{"type":"delay","vessel":"<exact name>","hours":<int>}  a ship arrives later (negative = earlier)
{"type":"qgc_out","count":<int>,"start_hr":<int>,"hours":<int>${HH ? ',"terminal":"CTB|CTH|CTT|CTA"' : ''}}  quay cranes out of service; a named crane such as QGC-03 is count 1; the engine models the pool, not individual cranes${HH ? '; terminal defaults to CTB' : ''}
{"type":"rtg_out","count":<int 1-6>,"hours":<int>}  yard cranes out in the berth's yard cluster
{"type":"icd","pct":<0-60>}  share of boxes evacuated ${HH ? 'by night rail and barge' : 'to off-dock depots'}
{"type":"yard","pct":<40-95>}  yard occupancy at the start
${HH ? '' : '{"type":"tugs","sets":<1-4>}  pilot and tug sets available at once\n'}{"type":"reset"}  back to the nominal plan
Vessels (name, hours until arrival): ${vessels.map((v) => `${v.name} ${v.eta_hr}`).join('; ')}. "The next feeder" or an unnamed incoming ship means the first with hours > 0. Default durations: 24 h for outages, 6 h for delays. start_hr is hours from the plan start; the plan clock now reads hour ${Math.floor(t)}.
Current scenario: ${JSON.stringify(sc)}. Current result: turnaround ${k.turnaround} d, ${HH ? 'wait before the Elbe passage' : 'anchorage wait'} ${k.wait} h, tide hold ${k.hold} h, peak yard ${k.peak}%, backpressure ${k.beta}.
If the message is a question rather than a command, return "actions":[] and answer it in "reply" from the figures above. If it is a command, "reply" restates what you understood in one sentence.`;

const TERM_WORDS = { CTB: /\bctb\b|burchardkai/, CTH: /\bcth\b|eurogate|predöhl|predohl/, CTT: /\bctt\b|tollerort/, CTA: /\bcta\b|altenwerder/ };
function offlineParse(text, vessels, HH) {
  const s = text.toLowerCase(), num = (re, d) => { const m = s.match(re); return m ? Number(m[1]) : d; }, acts = [];
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }, wnum = (re, d) => { const m = s.match(re); return m ? (words[m[1]] ?? Number(m[1])) : d; };
  if (/\breset\b|nominal|start over|clear all/.test(s)) return [{ type: 'reset' }];
  const hrs = num(/(\d+)\s*-?\s*(?:h\b|hr|hour)/, null);
  if (/delay|late|fog|storm|held up|slow/.test(s)) {
    const inbound = vessels.filter((v) => v.eta_hr > 0).sort((a, b) => a.eta_hr - b.eta_hr);
    let names = vessels.filter((v) => v.name.toLowerCase().split(' ').some((w) => w.length > 3 && s.includes(w)) || s.includes(v.name.toLowerCase())).map((v) => v.name);
    if (!names.length) names = inbound.slice(0, wnum(/(\d+|one|two|three|four|five|six)\s+(?:ships|vessels|feeders)/, 1)).map((v) => v.name);
    names.forEach((n) => acts.push({ type: 'delay', vessel: n, hours: hrs ?? 6 }));
  }
  if (/rtg|yard crane/.test(s)) acts.push({ type: 'rtg_out', count: wnum(/(\d+|one|two|three|four|five|six)\s*(?:x\s*)?(?:rtg|yard crane)/, 2), hours: hrs ?? 24 });
  else if (/qgc|quay crane|sts|gantry|crane/.test(s) && /off|out|broke|down|fail|trip/.test(s)) acts.push({ type: 'qgc_out', count: wnum(/(\d+|one|two|three|four|five|six)\s+(?:qgc|quay|crane|sts)/, 1), start_hr: 0, hours: hrs ?? 24, ...(HH ? { terminal: Object.keys(TERM_WORDS).find((k) => TERM_WORDS[k].test(s)) || 'CTB' } : {}) });
  if (/icd|off-?dock|evacuat|depot|rail|barge/.test(s)) acts.push({ type: 'icd', pct: num(/(\d+)\s*%/, /stop|halt|suspend|no off|without|zero|strike|closed/.test(s) ? 0 : 40) });
  else if (/yard|occupan/.test(s) && /%/.test(s)) acts.push({ type: 'yard', pct: num(/(\d+)\s*%/, 86) });
  if (!HH && /tug|pilot/.test(s)) acts.push({ type: 'tugs', sets: wnum(/(\d+|one|two|three|four)\s*(?:pilot|tug|set)/, 1) });
  return acts;
}
const NOMINAL = { etaShift: {}, qgcOutages: [], rtgOutages: [], icd: null, occ: null, tugSets: null };
function applyActions(sc, acts, names, HH, cfg) {
  let n = { ...sc, etaShift: { ...sc.etaShift }, qgcOutages: [...sc.qgcOutages], rtgOutages: [...sc.rtgOutages] }; const said = [];
  for (const a of acts || []) {
    if (a.type === 'reset') { n = { ...NOMINAL, etaShift: {}, qgcOutages: [], rtgOutages: [] }; said.push('nominal scenario restored'); }
    else if (a.type === 'delay' && names.includes(a.vessel)) { const h = clamp(Math.round(a.hours || 6), -24, 96); n.etaShift[a.vessel] = (n.etaShift[a.vessel] || 0) + h; said.push(`${a.vessel} ${h >= 0 ? 'delayed' : 'advanced'} ${Math.abs(h)} h`); }
    else if (a.type === 'qgc_out') {
      const term = HH ? (cfg.crane_pools[a.terminal] ? a.terminal : 'CTB') : null, cap = HH ? cfg.crane_pools[term] - 1 : 13;
      const c = clamp(Math.round(a.count || 1), 1, cap), s0 = clamp(Math.round(a.start_hr || 0), 0, cfg.horizon_hrs - 12), h = clamp(Math.round(a.hours || 24), 1, cfg.horizon_hrs);
      n.qgcOutages.push(HH ? [s0, s0 + h, c, term] : [s0, s0 + h, c]); said.push(`${c} quay crane${c > 1 ? 's' : ''}${HH ? ` at ${term}` : ''} out for ${h} h from hour ${s0}`); }
    else if (a.type === 'rtg_out') { const c = clamp(Math.round(a.count || 2), 1, 6), h = clamp(Math.round(a.hours || 24), 1, 25); for (let i = 0; i < c; i++) n.rtgOutages.push([0, h * 60]); said.push(`${c} yard crane${c > 1 ? 's' : ''} out for ${h} h`); }
    else if (a.type === 'icd') { n.icd = clamp(Number(a.pct), 0, 60) / 100; said.push(`${HH ? 'night rail and barge evacuation' : 'off-dock evacuation'} ${Math.round(n.icd * 100)}%`); }
    else if (a.type === 'yard') { n.occ = clamp(Number(a.pct), 40, 95); said.push(`yard starts ${n.occ}% full`); }
    else if (a.type === 'tugs' && !HH) { n.tugSets = clamp(Math.round(a.sets || 1), 1, 4); said.push(`${n.tugSets} pilot and tug set${n.tugSets > 1 ? 's' : ''}`); }
  }
  return { next: n, said };
}
const scChips = (sc, cfg) => [
  ...Object.entries(sc.etaShift).filter(([, h]) => h).map(([v, h]) => `${v} ${h > 0 ? '+' : ''}${h} h`), ...sc.qgcOutages.map(([a, b, c, q]) => `${c} ${q ? `${q} STS` : 'QGC'} out h${a}–${b}`),
  ...(sc.rtgOutages.length ? [`${sc.rtgOutages.length} RTG out ${sc.rtgOutages[0][1] / 60} h`] : []), ...(sc.icd != null ? [`ICD ${Math.round(sc.icd * 100)}%`] : []), ...(sc.occ != null ? [`yard ${sc.occ}%`] : []), ...(sc.tugSets != null && sc.tugSets !== cfg.pilot_tug_sets ? [`${sc.tugSets} tug sets`] : []),
];
const QUICK = ['Delay the next feeder by 6 hours due to Kutubdia fog', 'Take QGC-03 offline for 24 hours', 'Increase off-dock ICD evacuation to 40%', 'A storm delayed three ships by 12 hours and two yard cranes broke', 'Stop off-dock evacuation', 'Only one pilot and tug set today', 'Reset'];
const QUICK_HH = ['Delay the next ship by 6 hours, fog in the German Bight', 'Take 6 quay cranes at Burchardkai offline for 48 hours', 'Stop night rail and barge evacuation', 'A storm delayed three ships by 12 hours and two yard cranes broke', 'Yard starts 86% full', 'Take 4 cranes at Altenwerder out for 24 hours', 'Reset'];

const SidePanels = React.memo(function SidePanels({ trace, R, cfg, HH }) {
  return (
        <section className="pf-panel s5">
          <div className="pf-head"><div><div className="pf-tag">Yard simulation</div><h2>Occupancy through one shift cycle</h2></div></div>
          <div style={{ height: 190 }}><ResponsiveContainer><LineChart data={trace} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="h" type="number" domain={[0, 24]} ticks={[0, 6, 12, 18, 24]} unit=" h" {...ax} /><YAxis domain={[40, 100]} unit="%" {...ax} />
            <ReferenceArea x1={0} x2={6} fill="#000" fillOpacity={0.35} /><ReferenceLine y={80} stroke={C.red} strokeDasharray="4 3" label={{ value: '80% cliff', fill: C.red, fontSize: 10, position: 'insideTopRight' }} />
            <Tooltip {...tip} formatter={(v, n) => [`${fmt(v)}%`, n === 'now' ? 'this scenario' : HH ? 'no night evacuation' : 'no off-dock evacuation']} labelFormatter={(h) => `${fmt(h)} h into the cycle`} />
            <Line dataKey="none" stroke={C.muted} strokeWidth={1.5} dot={false} isAnimationActive={false} /><Line dataKey="now" stroke={C.tele} strokeWidth={2} dot={false} animationDuration={900} />
          </LineChart></ResponsiveContainer></div>
          <div><span className="pf-key" style={{ '--c': C.tele }}><i />this scenario</span><span className="pf-key" style={{ '--c': C.muted }}><i />{HH ? 'no night rail/barge evacuation' : 'no off-dock evacuation'}</span></div>
          <p className="pf-note">First 6 hours: night shift ({HH ? 'boxes leave by rail and barge' : 'evacuation to depots'}, and grooming). Then the discharge wave. One berth's yard cluster, {cfg.rtg_per_berth_cluster} yard {HH ? 'machines (straddle carriers or stacking cranes)' : 'cranes'}{HH ? '; Hamburg yard figures are assumptions' : ''}.</p>
          <div className="pf-head" style={{ marginTop: 12 }}><div><div className="pf-tag">Reefer power in kW, {R.n_reefers} plugs</div><h2>Evening peak shaved</h2></div></div>
          <div style={{ height: 150 }}><ResponsiveContainer><LineChart data={R.series_30min} margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="hour" type="number" domain={[0, 24]} ticks={[0, 6, 12, 17, 22]} {...ax} /><YAxis domain={['auto', 'auto']} {...ax} width={44} />
            <ReferenceArea x1={17} x2={22} fill={C.amber} fillOpacity={0.1} /><Tooltip {...tip} formatter={(v, n) => [`${fmt(v, 0)} kW`, n === 'smart_kw' ? 'capped' : 'uncontrolled']} labelFormatter={(h) => `${pad(Math.floor(h))}:${pad((h % 1) * 60)}`} />
            <Line dataKey="unmanaged_kw" stroke={C.muted} strokeWidth={1.5} dot={false} isAnimationActive={false} /><Line dataKey="smart_kw" stroke={C.tele} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart></ResponsiveContainer></div>
          <div className="pf-stats">
            <div className="pf-stat"><div className="l">Mean daily peak</div><div className="v num">{fmt(R.unmanaged_peak_demand_kw, 0)} → {fmt(R.smart_shaved_peak_demand_kw, 0)} kW</div></div>
            <div className="pf-stat"><div className="l">Shaved</div><div className="v num" style={{ color: C.ok }}>−{fmt(R.peak_shaved_pct)}%</div></div>
            <div className="pf-stat"><div className="l">Warmest box, 7 days</div><div className="v num">{fmt(R.max_box_temp_degC, 2)} °C</div></div>
            <div className="pf-stat"><div className="l">Cold-chain breaches</div><div className="v num">{R.cold_chain_breaches}</div></div>
          </div>
          <p className="pf-note">Shaded: 17:00–22:00 peak tariff window. Limit −18 °C.</p>
        </section>
  );
});

function valNote(val) {
  const ok = (val || []).filter((v) => v.gap_pct != null);
  if (!ok.length) return 'Re-plans made here use the in-page planner, a fast heuristic checked against CP-SAT in every scheduled run.';
  return `Re-plans made here use the in-page planner; it matched CP-SAT exactly on ${ok.filter((v) => Math.abs(v.gap_pct) < 0.05).length} of ${val.length} test cases and was within ${fmt(Math.max(...ok.map((v) => Math.abs(v.gap_pct))))}% on the rest.`;
}

function Kpi({ label, v, unit, d, base, nom, flash, better = 'low' }) {
  const x = useTween(v), delta = base ? ((v - base) / base) * 100 : 0, good = better === 'low' ? delta <= 0 : delta >= 0;
  return (
    <div className={`pf-kpi${flash ? ' flash' : ''}`} key={flash}>
      <div className="l">{label}</div><div className="v num">{fmt(x, d)}<small>{unit}</small></div>
      <div className="d">FCFS baseline <b className="num">{fmt(base, d)}</b> · <b style={{ color: Math.abs(delta) < 0.05 ? C.muted : good ? C.ok : C.red }}>{delta <= 0 ? '−' : '+'}{fmt(Math.abs(delta))}%</b></div>
      <div className="d">nominal plan <b className="num">{fmt(nom, d)}</b></div>
    </div>
  );
}

// Loads the daily live plan when the page names one, and falls back to the embedded plan.
export default function PortFlowControlTower() {
  const url = typeof window === 'undefined' ? null : (new URLSearchParams(window.location.search).get('data') || window.PORTFLOW_DATA_URL || null);
  const [st, setSt] = useState({ data: DEFAULT_MCP_DATA, src: url ? 'loading' : 'embedded', note: '' });
  useEffect(() => {
    if (!url) return undefined;
    let on = true; const ac = typeof AbortController !== 'undefined' ? new AbortController() : null, to = setTimeout(() => ac && ac.abort(), 10000);
    fetch(url, { cache: 'no-store', signal: ac ? ac.signal : undefined }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!on) return; if (d.status === 'ok' && d.optimised && d.optimised.schedule && d.optimised.schedule.length) setSt({ data: d, src: 'live', note: '' });
        else setSt((x) => ({ ...x, src: 'embedded', note: `Today's live run found ${d.status === 'no_queue' ? 'no ship in the queue' : 'no feasible plan'}${d.reason ? ` (${d.reason})` : ''}; showing the plan embedded in the page instead.` })); })
      .catch((e) => on && setSt((x) => ({ ...x, src: 'embedded', note: `The live plan could not be loaded (${e.name === 'AbortError' ? 'timed out' : e.message}); showing the plan embedded in the page instead.` })))
      .finally(() => clearTimeout(to));
    return () => { on = false; clearTimeout(to); };
  }, [url]);
  if (st.src === 'loading') return <div className="pf"><style>{CSS}</style><div className="pf-brand">PortFlow Control Tower<small>loading today's live plan…</small></div></div>;
  return <Tower key={`${st.src}-${st.data.generated_utc || ''}`} data={st.data} feed={st} />;
}

function Tower({ data, feed }) {
  const cfg = data.config, site = useMemo(() => makeSite(data), [data]), HH = data.site_kind === 'hamburg';
  const isLive = data.status === 'ok';
  const hasLeaflet = typeof window !== 'undefined' && !!window.L;   // the public pages load Leaflet; elsewhere the schematic chart is used
  const nominal = useMemo(() => ({ schedule: data.optimised.schedule, kpis: pyKpis(data.optimised.kpis) }), [data]);
  const baseK = useMemo(() => pyKpis(data.baseline.kpis), [data]);
  const [plan, setPlan] = useState({ ...nominal, source: 'CP-SAT reference', yardTrace: null });
  const [sc, setSc] = useState(NOMINAL);
  const [t, setT] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(8);
  const [sel, setSel] = useState(() => (data.live.vessels.some((v) => v.name === 'HR FARHA') ? 'HR FARHA' : (data.optimised.schedule[0] || {}).vessel_id));
  const [ghost, setGhost] = useState(false);
  const [msgs, setMsgs] = useState([{ role: 'a', text: HH
    ? `Live queue loaded: ${data.live.vessels.length} container ships declaring Hamburg on AIS and ${(data.live.fixed_occupants || []).length} alongside, read ${data.live.retrieved}. The nominal plan is on screen. Tell me what changed and I will re-plan the berths and re-run the yard simulation here in the page.`
    : `Live queue loaded: ${data.live.vessels.length} container ships bound for Chattogram, read ${data.live.retrieved}. The nominal plan is on screen. Tell me what changed and I will re-plan the berths and re-run the yard simulation here in the page.` }]);
  const [log, setLog] = useState(['engine ready: berth planner + yard discrete-event simulation loaded in the page']);
  const [input, setInput] = useState(''), [busy, setBusy] = useState(false), [flash, setFlash] = useState(0), [mode, setMode] = useState('checking');
  const [yMode, setYMode] = useState('after'), [step, setStep] = useState(null), [onlyB, setOnlyB] = useState(false), [hover, setHover] = useState(null), [dropKey, setDropKey] = useState(0);
  const sample = useRef(null), msgEnd = useRef(null), termEnd = useRef(null);
  const tMax = useMemo(() => Math.min(cfg.horizon_hrs, Math.max(...plan.schedule.map((r) => r.tidal_depart_hr)) + cfg.transit_hrs + 8), [plan, cfg]);
  const names = useMemo(() => data.live.vessels.map((v) => v.name), [data]);

  useEffect(() => { let live = true; const c = typeof window !== 'undefined' ? window.claude : null;
    if (c && typeof c.use === 'function') c.use('sample').then((fn) => { if (live) { sample.current = fn; setMode(fn ? 'claude' : 'offline'); } }).catch(() => live && setMode('offline')); else setMode('offline');
    return () => { live = false; }; }, []);
  // nominal yard trace and the no-relief comparison are simulated once in the page
  const traces = useMemo(() => { const modes = data.optimised.schedule.map((r) => r.crane_intensity), mk = modes.sort((a, b) => modes.filter((x) => x === b).length - modes.filter((x) => x === a).length)[0] || '2.629';
    const p = { occ: cfg.initial_yard_occupancy_pct, intensity: (cfg.qgc_gmph * Number(mk)) / cfg.ref_boxes_per_hr, rtgFleet: cfg.rtg_per_berth_cluster, yardCap: cfg.yard_cluster_teu, blocking: data.yard.blocking_ratio, premarshalJobs: data.yard.night_premarshal_relocations_executed, trace: true };
    return { nominal: simulateReplicated({ ...p, icd: cfg.icd_ratio }, 1).trace, none: simulateReplicated({ ...p, icd: 0 }, 1).trace }; }, [data, cfg]);
  useEffect(() => { if (!playing) return undefined; let raf, last = performance.now();
    const tick = (now) => { const dt = (now - last) / 1000; last = now; setT((x) => { const n = x + dt * speed; if (n >= tMax) { setPlaying(false); return tMax; } return n; }); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [playing, speed, tMax]);
  useEffect(() => { if (msgEnd.current) msgEnd.current.scrollTop = msgEnd.current.scrollHeight; }, [msgs]);
  useEffect(() => { if (termEnd.current) termEnd.current.scrollTop = termEnd.current.scrollHeight; }, [log]);
  useEffect(() => { if (step == null) return undefined; if (step >= data.yard.premarshal_moves.length) { const id = setTimeout(() => { setStep(null); setYMode('after'); }, 900); return () => clearTimeout(id); } const id = setTimeout(() => setStep(step + 1), 200); return () => clearTimeout(id); }, [step, data]);

  const yard = useMemo(() => yardState(data.yard, step != null ? step : yMode === 'after' ? data.yard.premarshal_moves.length : 0), [data, step, yMode]);
  const say = (role, text) => setMsgs((m) => [...m, { role, text }]);
  const reveal = (lines) => new Promise((res) => { let i = 0; const push = () => { if (i >= lines.length) { res(); return; } const ln = lines[i++]; setLog((l) => [...l.slice(-80), ln]); setTimeout(push, 95); }; push(); });

  const run = useCallback(async (text) => {
    if (busy || !text.trim()) return; setBusy(true); setInput(''); say('u', text); setPlaying(false);
    const stamp = `[${planClock(data.live.plan_epoch_local, t).label}]`;
    let acts = null, reply = '';
    if (mode === 'claude' && sample.current) {
      try { await reveal([`${stamp} copilot: asking Claude to read the command`]);
        const r = await sample.current.json([{ role: 'user', content: `${RULES(data.live.vessels, sc, plan.kpis, t, HH)}\n\nOPERATOR MESSAGE: ${text}` }], { modelTier: 'quick', cache: false });
        acts = Array.isArray(r && r.actions) ? r.actions : []; reply = (r && r.reply) || '';
      } catch (e) { await reveal([`copilot: Claude unavailable (${(e && e.code) || 'error'}); using the built-in command parser`]); }
    }
    if (acts == null) { acts = offlineParse(text, data.live.vessels, HH); if (mode !== 'claude') await reveal([`${stamp} copilot: built-in command parser (Claude is not available in this view)`]); }
    const { next, said } = applyActions(sc, acts, names, HH, cfg);
    if (!said.length) { say('a', reply || `I could not turn that into a change to the plan. Try: delay a ship by some hours, take quay or yard cranes out${HH ? ' at a terminal' : ''}, set the ${HH ? 'night rail and barge' : 'off-dock'} evacuation share, set the starting yard level${HH ? '' : ', or set the number of pilot and tug sets'}.`); setBusy(false); return; }
    await reveal([`parsed: ${said.join('; ')}`]);
    const lines = [], t0 = performance.now();
    const opt = { etaShift: next.etaShift, qgcOutages: next.qgcOutages, rtgOutages: next.rtgOutages, icd: next.icd ?? undefined, occ: next.occ ?? undefined, tugSets: next.tugSets ?? undefined, reps: 8 };
    const srvLines = [], srv = scChips(next, cfg).length ? await solveServer(data, opt, (l) => srvLines.push(l)) : null;
    if (srvLines.length) await reveal(srvLines);
    const res = srv || await solveAsync(data, opt, (l) => lines.push(l));
    await reveal(lines);
    if (!res.feasible && srv) { await reveal(['no feasible plan: scenario not applied']); say('a', `The CP-SAT engine on the server found no plan that finishes inside the ${cfg.horizon_hrs}-hour horizon with ${said.join(', ')} within its time limit. I kept the previous plan.`); setBusy(false); return; }
    if (!res.feasible) { await reveal(['no feasible plan: scenario not applied']); say('a', `The in-page planner found no plan that finishes inside the ${cfg.horizon_hrs}-hour tide table with ${said.join(', ')}${res.blocker ? `; ${res.blocker} is the ship it could not fit` : ''}. This planner is a fast heuristic: the CP-SAT engine searches exhaustively and can find plans it misses (in testing it fitted a storm-plus-no-evacuation case this planner rejected), so check the case with the Python engine${HH ? ' (run_tower.py)' : ' on the MCP server with nct_simulate_disruption'}. I kept the previous plan.`); setBusy(false); return; }
    await reveal([`${res.converged ? 'converged' : 'stopped'} after ${res.iterations} iteration(s) in ${Math.round(performance.now() - t0)} ms: turnaround ${res.kpis.turnaround} d, wait ${res.kpis.wait} h, backpressure ${res.kpis.beta.toFixed(2)}`]);
    const old = Object.fromEntries(plan.schedule.map((r) => [r.vessel_id, r])), k0 = plan.kpis, k1 = res.kpis;
    const moved = res.schedule.filter((r) => { const o = old[r.vessel_id]; return o && (o.berth_start_hr !== r.berth_start_hr || Math.abs(o.berth_start_m - r.berth_start_m) > 5 || o.assigned_qcs !== r.assigned_qcs); });
    const isNominal = !scChips(next, cfg).length;
    setSc(next); setPlan(isNominal ? { ...nominal, source: 'CP-SAT reference', yardTrace: null } : { schedule: res.schedule, kpis: k1, source: srv ? 'server CP-SAT re-plan' : 'in-page re-plan', yardTrace: res.yardTrace }); setFlash((f) => f + 1); setT(0);
    const kk = isNominal ? nominal.kpis : k1;
    say('a', `${reply ? `${reply}\n` : ''}Re-planned: average turnaround ${fmt(k0.turnaround, 2)} → ${fmt(kk.turnaround, 2)} days, ${HH ? 'wait before the Elbe' : 'anchorage wait'} ${fmt(k0.wait, 0)} → ${fmt(kk.wait, 0)} h, peak yard ${fmt(k0.peak)} → ${fmt(kk.peak)}%, backpressure ${fmt(k0.beta, 2)} → ${fmt(kk.beta, 2)}.${moved.length && !isNominal ? `\nMoved: ${moved.slice(0, 4).map((r) => `${r.vessel_id} to ${berthLabel(data, r)} at hour ${r.berth_start_hr} with ${r.assigned_qcs} quay cranes`).join('; ')}${moved.length > 4 ? `; and ${moved.length - 4} more` : ''}.` : ''}\nPlaying the new plan on the chart.`);
    if (!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { setSpeed(16); setPlaying(true); }
    setBusy(false);
  }, [busy, mode, sc, plan, t, data, names, cfg, nominal, HH]);

  const clk = planClock(data.live.plan_epoch_local, t), hr = Math.min(Math.floor(t), cfg.horizon_hrs), tideNow = data.tide_hourly[hr] + (data.tide_hourly[Math.min(hr + 1, cfg.horizon_hrs)] - data.tide_hourly[hr]) * (t - hr);
  const night = !(site.clock(hr) >= cfg.daylight_hours[0] && site.clock(hr) < cfg.daylight_hours[1]);
  const k = plan.kpis, chips = scChips(sc, cfg), Y = data.yard, R = data.reefer, hy = data.hydrostatics;
  // money, just-in-time fuel and tide-window risk of the plan on screen (Python figures for the reference plan, in-page otherwise)
  const fig = useMemo(() => (plan.source === 'CP-SAT reference' && data.advice ? data.advice : planFigures(data, plan.schedule)), [plan, data]);
  const figBase = useMemo(() => (data.advice_baseline ? data.advice_baseline.totals : planFigures(data, data.baseline.schedule).totals), [data]);
  const figNom = useMemo(() => (data.advice ? data.advice.totals : planFigures(data, data.optimised.schedule).totals), [data]);
  const risky = (f) => f.ships.filter((x) => x.risk && x.risk.p_miss >= 0.2).length;
  const figMap = Object.fromEntries(fig.ships.map((x) => [x.vessel_id, x]));
  const ledger = useMemo(() => yardLedger(data, plan.schedule, sc.icd ?? undefined, sc.occ ?? undefined), [data, plan, sc]);
  const ledgerRows = useMemo(() => { const ks = Object.keys(ledger.pools), n = ledger.pools[ks[0]].length, out = []; for (let h = 0; h < n; h += 2) { const row = { h }; ks.forEach((k) => { row[k] = ledger.pools[k][h]; }); out.push(row); } return out; }, [ledger]);
  const windNow = HH && data.live.wind_ms_hourly ? data.live.wind_ms_hourly[Math.min(Math.floor(t), data.live.wind_ms_hourly.length - 1)] : null;
  const trace = useMemo(() => (plan.yardTrace || traces.nominal).map((p, i) => ({ h: +(p[0] / 60).toFixed(2), now: p[1], none: traces.none[i] ? traces.none[i][1] : null })), [plan, traces]);
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);

  return (
    <div className={`pf${playing ? ' playing' : ''}`}>
      <style>{CSS}</style>
      <header className="pf-top">
        <div className="pf-brand">PortFlow Control Tower<small>{HH ? 'Port of Hamburg · Burchardkai · Eurogate · Tollerort · Altenwerder' : 'Chattogram · New Mooring Container Terminal'} · engine v{data.engine_version}</small></div>
        <div className="pf-clock num">{clk.label}<small>plan hour {fmt(t, 1)} of {tMax} · {HH ? 'UTC' : 'Bangladesh time'}</small></div>
        <div className="pf-lamps">
          <span className="pf-lamp" style={{ '--c': plan.source === 'CP-SAT reference' ? C.ok : C.tele }}><i />PLAN: {plan.source.toUpperCase()}</span>
          <span className="pf-lamp" style={{ '--c': isLive ? C.ok : C.amber }}><i />{isLive ? `LIVE DATA ${data.live.retrieved}` : `SNAPSHOT ${data.live.retrieved}`}</span>
          <span className="pf-lamp" style={{ '--c': C.blue }}><i />{HH ? `ST. PAULI +${fmt(tideNow, 2)} m MLW` : `TIDE ${fmt(tideNow, 2)} m`}</span>
          {!HH && <span className="pf-lamp" style={{ '--c': night ? C.amber : C.ok }}><i />{night ? 'NIGHT RULE ON' : 'DAYLIGHT'}</span>}
          {windNow != null && <span className="pf-lamp" style={{ '--c': windNow >= cfg.wind_limit_ms ? C.red : C.ok }}><i />WIND {fmt(windNow)} m/s{windNow >= cfg.wind_limit_ms ? ': BIG SHIPS HOLD' : ''}</span>}
          <span className="pf-lamp" style={{ '--c': k.peak >= 80 ? C.red : C.ok }}><i />YARD PEAK {fmt(k.peak)}%</span>
          <span className="pf-lamp" style={{ '--c': mode === 'claude' ? C.ok : C.amber }}><i />COPILOT: {mode === 'claude' ? 'CLAUDE' : mode === 'offline' ? 'BUILT-IN PARSER' : '…'}</span>
        </div>
      </header>
      {typeof window !== 'undefined' && window.PORTFLOW_NAV && <nav className="pf-nav" aria-label="Ports" style={{ marginTop: 8 }}>
        <a href="chattogram.html" className={HH ? '' : 'on'}>Chattogram control tower</a><a href="hamburg.html" className={HH ? 'on' : ''}>Hamburg control tower</a><a href="../index.html">Hamburg live AIS and tide</a>
        <a href="https://github.com/artahmid03-source/portflow-simopt-mcp">Source on GitHub</a>
      </nav>}
      {feed && feed.note && <div className="pf-banner" role="status">{feed.note}</div>}

      <div className="pf-scrub">
        <button className="pf-btn" onClick={() => { if (t >= tMax) setT(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <input type="range" min="0" max={tMax} step="0.25" value={Math.min(t, tMax)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Plan time" />
        <div className="pf-seg">{[4, 8, 16, 32].map((s) => <button key={s} className={`pf-btn${speed === s ? ' on' : ''}`} onClick={() => setSpeed(s)} aria-label={`${s} plan hours per second`}>{s} h/s</button>)}</div>
      </div>

      <div className="pf-grid">
        <section className="pf-panel s7">
          <div className="pf-head"><div><div className="pf-tag">{HH ? 'German Bight, Elbe and port' : 'Approach and channel'}</div><h2>Vessel traffic</h2></div>
            <div><span className="pf-key" style={{ '--c': C.blue }}><i />inbound</span><span className="pf-key" style={{ '--c': C.amber }}><i />{HH ? 'waiting' : 'at anchor'}</span><span className="pf-key" style={{ '--c': C.tele }}><i />{HH ? 'on the Elbe' : 'under pilotage'}</span><span className="pf-key" style={{ '--c': C.ok }}><i />alongside</span></div></div>
          {HH ? <ElbeMap data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} />
            : hasLeaflet ? <KarnaphuliMap data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} tide={tideNow} />
              : <Radar data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} tide={tideNow} />}
          <p className="pf-note">{HH
            ? `OpenStreetMap with OpenSeaMap sea marks. At hour 0 each ship is where AIS last heard it (moored ships at their quay); from there it moves as the plan says: waiting off Elbe-1, a ${cfg.transit_hrs}-hour passage, alongside, and out. Grey: ships already alongside at the plan start. Click a ship for its details.`
            : hasLeaflet ? `OpenStreetMap with OpenSeaMap sea marks; quay and river lines from OpenStreetMap. ${isLive ? 'At hour 0 each ship is where AIS last heard it (Singapore, the Malacca Strait or Colombo; AIS does not reach Chattogram)' : `Ship details were read from public sources on ${data.live.retrieved} without positions, so each ship starts on the sea route from its last port at a point matching its reported area`}; from there it moves as the plan says: outer anchorage, pilotage up the Karnaphuli, the NCT quay, and out. Grey: ships alongside at the start, or in port at a terminal not modelled. Click a ship for its details.`
            : isLive ? 'Schematic, not to scale. Ships are drawn from the region where AIS last heard them (Singapore and the Malacca Strait, or Colombo) and then move according to the plan. Click a ship for its details.'
              : `Schematic, not to scale. Ship names, numbers, sizes and status were read from public sources on ${data.live.retrieved}; no source gave latitude, longitude, speed or course, so each ship is drawn from its reported area and then moves according to the plan. Click a ship for its details.`}</p>
        </section>

        <section className="pf-panel s5">
          <div className="pf-chat">
            <div className="pf-head" style={{ marginBottom: 0 }}><div><div className="pf-tag">Copilot</div><h2>Tell the tower what changed</h2></div>
              <button className="pf-btn" disabled={busy || !chips.length} onClick={() => run('Reset')}>Reset scenario</button></div>
            <div className="pf-msgs" ref={msgEnd} aria-live="polite">{msgs.map((m, i) => <div key={i} className={`pf-msg ${m.role}`}>{m.text}</div>)}{busy && <div className="pf-msg a">working…</div>}</div>
            {chips.length > 0 && <div className="pf-chips" aria-label="Active changes">{chips.map((c) => <span key={c} className="pf-chip act">{c}</span>)}</div>}
            <form className="pf-in" onSubmit={(e) => { e.preventDefault(); run(input); }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={`e.g. ${names[1] || names[0]} is 8 hours late and one quay crane is down`} aria-label="Command for the copilot" disabled={busy} />
              <button className="pf-btn on" type="submit" disabled={busy || !input.trim()}>Send</button>
            </form>
            <div className="pf-chips">{(HH ? QUICK_HH : QUICK).slice(0, 6).map((q) => <button key={q} className="pf-chip" disabled={busy} onClick={() => run(q)}>{q}</button>)}</div>
            <div className="pf-tag" style={{ marginTop: 2 }}>Solver log</div>
            <div className="pf-term" ref={termEnd}>{log.map((l, i) => <div key={i} className={i === log.length - 1 ? 'cur' : ''}>{l}</div>)}</div>
          </div>
        </section>

        <section className="pf-panel">
          <div className="pf-kpis">
            <Kpi label="Average turnaround" v={k.turnaround} unit="days" d={2} base={baseK.turnaround} nom={nominal.kpis.turnaround} flash={flash} />
            <Kpi label={HH ? 'Wait before the Elbe' : 'Anchorage wait'} v={k.wait} unit="h" d={0} base={baseK.wait} nom={nominal.kpis.wait} flash={flash} />
            <Kpi label="Peak yard occupancy" v={k.peak} unit="%" d={1} base={baseK.peak} nom={nominal.kpis.peak} flash={flash} />
            <Kpi label="Quay slowdown from yard" v={k.beta} unit="×" d={2} base={baseK.beta} nom={nominal.kpis.beta} flash={flash} />
            <Kpi label="Gate truck wait" v={k.gateWait} unit="min" d={0} base={baseK.gateWait} nom={nominal.kpis.gateWait} flash={flash} />
            <Kpi label="Cost of the queue" v={fig.totals.cost_usd / 1000} unit="k USD" d={0} base={figBase.cost_usd / 1000} nom={figNom.cost_usd / 1000} flash={flash} />
            <Kpi label="Ships at risk of missing their tide" v={risky(fig)} unit={`of ${plan.schedule.length}`} d={0} base={risky({ ships: planFigures(data, data.baseline.schedule).ships })} nom={risky(data.advice || planFigures(data, data.optimised.schedule))} flash={flash} />
            <Kpi label={HH ? 'Held for tide' : 'Held for tide or daylight'} v={k.hold} unit="h" d={0} base={baseK.hold} nom={nominal.kpis.hold} flash={flash} />
          </div>
          <p className="pf-note">FCFS baseline: {data.baseline_rule ? data.baseline_rule.replace('off-dock', HH ? 'night rail and barge' : 'off-dock') : `ships berth in arrival order with every crane they can take and no ${HH ? 'night rail and barge' : 'off-dock'} evacuation`}. Nominal plan: the Python engine (CP-SAT with simulation cuts) at {Math.round(cfg.icd_ratio * 100)}% evacuation{isLive ? `, run ${(data.generated_utc || '').slice(0, 16).replace('T', ' ')} UTC on today's data` : ''}. {valNote(data.validation)}{HH && Math.abs(baseK.turnaround - k.turnaround) < 0.005 ? ' With today\'s queue the quays have room, so the baseline and the optimised plan coincide; use the copilot to stress the plan.' : ''}</p>
        </section>

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Quay against time</div><h2>{HH ? 'Berth plan by terminal, with the Elbe tide' : 'Berth plan, tide and night bands'}</h2></div>
            <div className="pf-seg"><button className={`pf-btn${ghost ? ' on' : ''}`} onClick={() => setGhost(!ghost)}>{ghost ? 'Hide' : 'Show'} FCFS baseline</button></div></div>
          <Gantt data={data} site={site} schedule={plan.schedule} ghost={ghost ? data.baseline.schedule : null} t={t} sel={sel} onSel={setSel} tMax={tMax} />
          <p className="pf-note">{HH
            ? `One axis for five quay segments (left labels; the colour strip is the terminal). Solid bar: working cargo. Hatched: cargo finished, ship held until the tide lets it sail. Teal stubs: the ${cfg.transit_hrs}-hour Elbe passage in and out. Grey: ships already alongside, leaving at an estimated hour. Tide strip: forecast level at St. Pauli above mean low water. Green ticks: hours the selected ship may come alongside under the tide rule.`
            : `Solid bar: working cargo. Hatched: cargo finished, ship held until the tide and daylight allow it to sail. Teal stubs: the ${cfg.transit_hrs}-hour pilotage in and out. Dark bands: night, when ships over ${cfg.night_max_loa_m} m or deeper than ${fmt(cfg.night_max_draught_m)} m may not move. Green ticks: hours when the selected ship may transit.`}</p>
        </section>

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Yard ledger</div><h2>Yard occupancy over the whole plan</h2></div>
            <div className="pf-stats" style={{ marginTop: 0 }}><div className="pf-stat"><div className="l">Peak</div><div className="v num" style={{ color: ledger.peak_pct >= 80 ? C.red : C.ok }}>{fmt(ledger.peak_pct)}%</div></div>
              {data.ledger && data.ledger.refined_kpis && <div className="pf-stat"><div className="l">Turnaround with the yard carried over</div><div className="v num">{fmt(data.ledger.refined_kpis.avg_turnaround_days, 2)} days (plan {fmt(data.optimised.kpis.avg_turnaround_days, 2)})</div></div>}</div></div>
          <div style={{ height: 200 }}><ResponsiveContainer><LineChart data={ledgerRows} margin={{ top: 6, right: 10, bottom: 0, left: -14 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="h" type="number" domain={[0, cfg.horizon_hrs]} unit=" h" {...ax} /><YAxis domain={[40, 100]} unit="%" {...ax} />
            <ReferenceLine y={80} stroke={C.red} strokeDasharray="4 3" label={{ value: '80% cliff', fill: C.red, fontSize: 10, position: 'insideTopRight' }} />
            <ReferenceLine x={Math.min(t, cfg.horizon_hrs)} stroke={C.tele} />
            <Tooltip {...tip} formatter={(v, n) => [`${fmt(v)}%`, n === 'all' ? 'yard' : n]} labelFormatter={(h) => `plan hour ${h}`} />
            {Object.keys(ledger.pools).map((k, i) => <Line key={k} dataKey={k} stroke={HH ? TERM_C[k] : [C.tele, C.blue, C.amber][i % 3]} strokeWidth={2} dot={false} isAnimationActive={false} />)}
          </LineChart></ResponsiveContainer></div>
          <p className="pf-note">The yard simulation above follows one shift; this ledger follows {HH ? 'each terminal\'s' : 'the whole'} yard hour by hour through the plan: imports land while a ship works (less the share evacuated at night) and leave after a {cfg.import_dwell_days}-day dwell, exports arrive in the 72 h before their ship and leave as it loads; half of each call is imports. Above about 80% yard cranes slow down sharply.{data.ledger && data.ledger.refined_kpis ? ((data.ledger.status || 'converged') === 'converged' ? ` Feeding each ship's ledger slowdown back into the planner settles in ${data.ledger.trace.length} rounds at ${fmt(data.ledger.refined_kpis.avg_turnaround_days, 2)} days, the more realistic figure when the yard runs this full.` : ` Feeding each ship's ledger slowdown back into the planner does not settle: ${data.ledger.status}. The last feasible round gives ${fmt(data.ledger.refined_kpis.avg_turnaround_days, 2)} days, so the yard, not the quay, is the binding limit.`) : ''} Background flows (earlier calls' imports leaving, later calls' exports arriving) run at this plan's average rates. Capacities and dwell are assumptions.</p>
        </section>

        <section className="pf-panel s7">
          <div className="pf-head"><div><div className="pf-tag">Yard block, 40 × 6 × 5</div><h2>Stack plan for {hy.vessel_id}'s parcel</h2></div>
            <div className="pf-seg">
              <button className={`pf-btn${yMode === 'before' && step == null ? ' on' : ''}`} onClick={() => { setStep(null); setYMode('before'); }}>As landed</button>
              <button className={`pf-btn${yMode === 'after' && step == null ? ' on' : ''}`} onClick={() => { setStep(null); setYMode('after'); }}>After night grooming</button>
              <button className={`pf-btn${step != null ? ' on' : ''}`} onClick={() => { setYMode('before'); setStep(0); }}>▶ Replay {Y.premarshal_moves.length} moves</button>
              <button className="pf-btn" onClick={() => setDropKey((x) => x + 1)}>Restack</button>
              <button className={`pf-btn${onlyB ? ' on' : ''}`} onClick={() => setOnlyB(!onlyB)}>Blocking only</button>
            </div></div>
          <Yard3D boxes={yard.boxes} onlyBlocking={onlyB} onHover={setHover} dropKey={dropKey} />
          <div style={{ marginTop: 8 }}><span className="pf-key" style={{ '--c': FACE[1][0] }}><i />green channel</span><span className="pf-key" style={{ '--c': FACE[2][0] }}><i />yellow</span><span className="pf-key" style={{ '--c': FACE[3][0] }}><i />red</span><span className="pf-key" style={{ '--c': FACE[4][0] }}><i />inherited stock</span><span className="pf-key" style={{ '--c': '#ff8a1f' }}><i />dangerous goods</span><span className="pf-key" style={{ '--c': '#fff' }}><i />glowing: blocks an earlier-leaving box</span></div>
          <div className="pf-read num">{hover ? `Bay ${hover.b + 1}, row ${hover.r + 1}, tier ${hover.t + 1}: leaves in ${fmt(hover.d, 0)} h, ${CH_NAME[hover.ch]}${hover.im ? `, ${IMDG_NAME[hover.im]} (never relocated)` : ''}${hover.blocking ? `. Blocking: sits above a box leaving in ${fmt(hover.under, 0)} h` : ''}${hover.moved ? '. Moved by night grooming' : ''}` : step != null ? `Night grooming: move ${Math.min(step, Y.premarshal_moves.length)} of ${Y.premarshal_moves.length}` : 'Point at a box for its slot, departure time and customs channel.'}</div>
          <div className="pf-stats">
            <div className="pf-stat"><div className="l">Blocking boxes now</div><div className="v num" style={{ color: C.red }}>{yard.blocking}</div></div>
            <div className="pf-stat"><div className="l">Random stacking</div><div className="v num">{data.yard_baseline.initial_blocking_inversions}</div></div>
            <div className="pf-stat"><div className="l">Dwell-aware stacking</div><div className="v num">{Y.initial_blocking_inversions}</div></div>
            <div className="pf-stat"><div className="l">After grooming</div><div className="v num">{Y.post_premarshal_blocking_inversions}</div></div>
            <div className="pf-stat"><div className="l">Block fill</div><div className="v num">{fmt(Y.block_fill_pct)}%</div></div>
          </div>
        </section>

        <SidePanels trace={trace} R={R} cfg={cfg} HH={HH} />

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Queue</div><h2>Ships in the plan</h2></div>
            <div className="pf-stats" style={{ marginTop: 0 }}><div className="pf-stat"><div className="l">Stability check, {hy.vessel_id}{HH ? ', 360-box test parcel' : ''}</div><div className="v num">GM {fmt(hy.GM_metacentric_height_m, 2)} m · list {fmt(hy.heeling_list_angle_deg, 2)}° · {hy.imo_stability_compliant ? 'pass' : 'FAIL'}</div></div></div></div>
          <div className="pf-scroll"><table className="pf-table"><thead><tr><th>Vessel</th><th>IMO</th><th>MMSI</th><th>LOA m</th><th>Draught m</th><th className="tl">Reported status</th><th className="tl">Arrival basis</th><th>Berth</th><th>Alongside</th><th>Sails</th><th>Cranes</th><th>Wait h</th><th>Hold h</th><th>Cost k USD</th><th className="tl">Just-in-time advice</th><th>Tide risk</th><th className="tl">Why it waits</th></tr></thead>
            <tbody>{plan.schedule.map((r) => { const v = vmap[r.vessel_id]; return (
              <tr key={r.vessel_id} className={sel === r.vessel_id ? 'sel' : ''} onClick={() => setSel(r.vessel_id)}>
                <td>{r.vessel_id}</td><td>{v.imo}</td><td>{v.mmsi}</td><td>{fmt(v.loa_m, 2)}</td><td>{v.draught_reported_m == null ? '—' : fmt(v.draught_reported_m)} / {fmt(r.draft_m)}</td><td className="tl">{v.status}</td><td className="tl" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.eta_basis}>{v.eta_basis}</td>
                <td>{berthLabel(data, r)}</td><td>{planClock(data.live.plan_epoch_local, r.berth_start_hr).label}</td><td>{planClock(data.live.plan_epoch_local, r.tidal_depart_hr).label}</td><td>{r.assigned_qcs}</td><td>{r.anchorage_wait_hrs}</td><td>{r.tide_departure_hold_hrs}</td>
                <td>{figMap[r.vessel_id] ? fmt(figMap[r.vessel_id].cost_usd / 1000, 0) : '—'}</td>
                <td className="tl">{figMap[r.vessel_id] && figMap[r.vessel_id].jit ? `${fmt(figMap[r.vessel_id].jit.speed_now_kn)} → ${fmt(figMap[r.vessel_id].jit.speed_advised_kn)} kn, saves ${fmt(figMap[r.vessel_id].jit.fuel_saved_t)} t fuel` : r.anchorage_wait_hrs > 0 ? 'no position to advise from' : 'no wait planned'}</td>
                <td style={{ color: figMap[r.vessel_id] && figMap[r.vessel_id].risk && figMap[r.vessel_id].risk.p_miss >= 0.2 ? C.amber : undefined }} title={figMap[r.vessel_id] && figMap[r.vessel_id].risk ? `planned window closes at hour ${figMap[r.vessel_id].risk.window_closes_hr}; slack ${figMap[r.vessel_id].risk.slack_h} h against an arrival error of ±${figMap[r.vessel_id].risk.sigma_h} h; next window ${figMap[r.vessel_id].risk.extra_wait_if_missed_h ?? '—'} h later` : 'no tide window to miss'}>{figMap[r.vessel_id] && figMap[r.vessel_id].risk ? `${fmt(figMap[r.vessel_id].risk.p_miss * 100, 0)}%` : '—'}</td>
                <td className="tl" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={explainRow(data, r)}>{explainRow(data, r) || '—'}</td>
              </tr>); })}</tbody></table></div>
          <p className="pf-note">{HH
            ? `Draught: reported on AIS / used in the plan (capped at the inbound tide-dependent limit). Box counts per call are estimates (${data.live.estimates.moves_per_call}); the terminal comes from where AIS has seen the ship moored, or else from a carrier-to-terminal assumption. ${(data.live.excluded || []).length} ships declaring Hamburg were left out (see below).`
            : `Draught: reported by the ship / used in the plan (capped at the ${fmt(cfg.max_draught_m)} m limit). Box counts per call are estimates from ${isLive ? 'length and beam' : 'deadweight'}; terminals are not published, so every ship is treated as an NCT call.`}</p>
        </section>
      </div>

      {(HH || data.backtest) && <section className="pf-panel" style={{ marginTop: 10 }}>
        <div className="pf-head"><div><div className="pf-tag">Plan against reality</div><h2>How close yesterday's plans came</h2></div></div>
        {data.backtest && (data.backtest.plan.n || data.backtest.port_list.n) ? <div className="pf-scroll"><table className="pf-table" style={{ minWidth: 640 }}><thead><tr><th>Source</th><th>Calls matched</th><th>Mean error, alongside</th><th>Bias</th><th>90th percentile</th><th>Right terminal</th></tr></thead><tbody>
          {[['PortFlow plan', data.backtest.plan], ["Port's expected-vessel list (HVCC)", data.backtest.port_list]].map(([l, x]) => <tr key={l}><td>{l}</td><td>{x.n}</td><td>{x.n ? `${fmt(x.mae_h)} h` : '—'}</td><td>{x.n ? `${x.bias_h > 0 ? '+' : ''}${fmt(x.bias_h)} h` : '—'}</td><td>{x.n ? `${fmt(x.p90_abs_h)} h` : '—'}</td><td>{x.terminal_accuracy != null && !Number.isNaN(x.terminal_accuracy) ? `${fmt(x.terminal_accuracy * 100, 0)}%` : '—'}</td></tr>)}
        </tbody></table></div> : <div className="pf-read">Collecting: every plan is archived (the first of each day is scored), and once the planned ships have berthed, AIS mooring times are compared with the plan here. {data.backtest ? `${data.backtest.plans_archived} plans archived, ${data.backtest.observed_calls} container-quay calls seen so far.` : ''}</div>}
        <p className="pf-note">Positive bias: ships berth later than planned. {data.backtest ? data.backtest.resolution_note : ''} The tide-window risk uses an arrival error of {data.backtest && data.backtest.eta_sigma_fit ? `${data.backtest.eta_sigma_fit.a} h + ${data.backtest.eta_sigma_fit.b} × lead time (fitted)` : '2 h + 0.06 × lead time (assumed until enough calls are matched)'}.</p>
      </section>}

      <details className="pf-foot"><summary>What is measured, what is assumed</summary><ul>
        <li>Read from public sources on {data.live.retrieved}: {data.live.what_is_live}</li>
        <li>Not available: {data.live.what_is_not_live}</li>
        <li>Sources: {Object.values(data.live.sources).join(' · ')}</li>
        {HH
          ? <li>Assumed: {fmt(cfg.qgc_gmph, 0)} moves per crane-hour; quay cranes per terminal {Object.entries(cfg.crane_pools).map(([k2, v2]) => `${k2} ${v2}`).join(', ')} (Eurogate's count is not confirmed); yard starting {fmt(cfg.initial_yard_occupancy_pct, 0)}% full with {Math.round(cfg.icd_ratio * 100)}% of boxes leaving by night rail and barge; Elbe passage {cfg.transit_hrs} h; the tide check applies between Waltershof and Brunsbüttel; ships moored at the start leave at an estimated hour.</li>
          : <li>Assumed: channel depth {fmt(cfg.channel_depth_m)} m below datum, under-keel clearance {fmt(cfg.ukc_m)} m, {cfg.pilot_tug_sets} pilot and tug sets, yard starting {fmt(cfg.initial_yard_occupancy_pct, 0)}% full, {fmt(cfg.qgc_gmph)} moves per crane-hour, {cfg.qgc_total} quay cranes. The quay-crane, yard-crane and reefer-plug counts are the ones supplied for this model; published figures for NCT differ.</li>}
        <li>{data.live.tide_note}</li>
        {data.advice && <li>Money and fuel: charter {data.advice.assumptions.charter_usd_day} USD/day, main-engine fuel {data.advice.assumptions.fuel_t_day} t/day, fuel {data.advice.assumptions.fuel_usd_t} USD/t, {data.advice.assumptions.idle_t_day} t/day at anchor, {data.advice.assumptions.co2_per_t_hfo} t CO₂ per t fuel. {cfg.objective === 'cost' ? 'The plan minimises this cost (waiting and time alongside at each ship\'s charter rate).' : ''}</li>}
        {HH && <li>Elbe rules in the plan: tide-independent and tide-dependent draughts; ships wider than 90 m together meet only in the Wedel–Blankenese passing box and above 104 m not at all; ships over 330 m or 45 m wide do not move at {fmt(cfg.wind_limit_ms)} m/s or more (wind forecast: {data.live.wind_source || 'not available today'}); ships wider than 51 m are not sent under the Köhlbrand bridge to Altenwerder unless the port's list says so. The wind, meeting and bridge thresholds are assumptions.</li>}
        {!HH && data.live.rules && <li>River rules in the plan: up to {fmt(data.live.rules.max_draught_m)} m draught and {fmt(data.live.rules.max_loa_m, 0)} m length; transits only from 5 h before to 1 h after each predicted high water ({data.live.rules.source}).</li>}
        {(data.live.excluded || []).length > 0 && <li>Left out of the plan: {data.live.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}.</li>}
      </ul></details>
    </div>
  );
}
