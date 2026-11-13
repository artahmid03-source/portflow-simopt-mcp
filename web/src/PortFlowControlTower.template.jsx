// PortFlow Control Tower v6 — Chattogram NCT. The page re-plans and re-simulates in the browser
// (src/engine.js, a JavaScript port of the Python CP-SAT + SimPy model) every time the copilot
// receives a command. DEFAULT_MCP_DATA below is the output of run_nct_pipeline.py.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea } from 'recharts';
import { solve, simulateReplicated, makeSite } from './engine.js';

const DEFAULT_MCP_DATA = /*__MCP_DATA__*/;

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
@media(prefers-reduced-motion:reduce){.pf-sweep,.pf-ship .ping,.y3-box,.y3-box.hz .t::after,.pf-msg,.pf-term div{animation:none}.y3-box,.pf-gbar,.pf-gbar rect{transition:none}}
`;

const C = { tele: '#5ef2c8', amber: '#ffb224', red: '#ff5a52', blue: '#4aa3ff', ok: '#3ddc84', muted: '#8097a9', ink: '#d7e5f0', line: '#16293a', hi: '#2b4a63' };
const fmt = (x, d = 1) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
  return { day: DAYS[d.getUTCDay()], date: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), label: `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} Nov ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
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

const Radar = React.memo(function Radar({ data, site, schedule, t, sel, onSel, tide }) {
  const T = data.config.transit_hrs, vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const ships = schedule.map((r) => ({ r, v: vmap[r.vessel_id], s: shipAt(r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })).filter((x) => x.s);
  const fx = data.live.fixed_occupants[0], fxOn = t < fx.release_hr + T;
  const fxPos = t < fx.release_hr ? off(chan(quayS(fx.berth_start_m + fx.loa_m / 2)), 7) : chan((1 - (t - fx.release_hr) / T) * quayS(fx.loa_m / 2)).p;
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
        {data.live.also_in_port_not_modelled.map((o, i) => { const c = off(chan(CH_LEN[3] + i * 26), -8); return <g key={o.name} transform={`translate(${c[0]},${c[1]}) rotate(${(chan(CH_LEN[3]).ang * 180) / Math.PI})`}><path d={hull} fill="none" stroke="#51677a" /><title>{`${o.name}: ${o.status}. Terminal not published, not in the plan.`}</title></g>; })}
        {fxOn && <g transform={`translate(${fxPos[0]},${fxPos[1]}) rotate(${(chan(quayS(fx.loa_m / 2)).ang * 180) / Math.PI})`}><path d={hull} fill="#51677a" /><title>{`${fx.name}: ${fx.status}`}</title></g>}
        {fxOn && <text x={fxPos[0] - 30} y={fxPos[1] + 17} fontSize="9" fill="#6f8598">{fx.name}</text>}
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
      {cur && (
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
      )}
    </div>
  );
});

// ------------------------------------------------------------------ berth Gantt with tide strip
const G = { L: 64, R: 12, W: 1180, tideTop: 14, tideH: 62, top: 96, H: 250 };
const Gantt = React.memo(function Gantt({ data, site, schedule, ghost, t, sel, onSel, tMax }) {
  const cfg = data.config, H = cfg.horizon_hrs, px = (G.W - G.L - G.R) / H, x = (h) => G.L + h * px, y = (m) => G.top + (m / 1000) * G.H, ty = (v) => G.tideTop + G.tideH - (v / 4.2) * G.tideH;
  const ep = Number(data.live.plan_epoch_local.slice(11, 13));
  const nights = []; for (let h = 0; h < H; h++) { const c = site.clock(h), n = !(c >= cfg.daylight_hours[0] && c < cfg.daylight_hours[1]); if (n && (h === 0 || nights.length === 0 || nights[nights.length - 1][1] !== h)) nights.push([h, h + 1]); else if (n) nights[nights.length - 1][1] = h + 1; }
  const days = []; for (let h = (24 - ep) % 24; h <= H; h += 24) days.push(h);
  const s = schedule.find((r) => r.vessel_id === sel), need = s ? s.tide_needed_m : cfg.max_draught_m + cfg.ukc_m - cfg.channel_depth_m;
  const open = []; for (let h = 0; h < H; h++) if (site.transitOk(h, s ? s.loa_m : 185, s ? s.draft_m : cfg.max_draught_m)) open.push(h);
  const tidePath = data.tide_hourly.slice(0, H + 1).map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)},${ty(v).toFixed(1)}`).join(' ');
  const fx = data.live.fixed_occupants[0];
  return (
    <div className="pf-scroll">
      <svg viewBox={`0 0 ${G.W} ${G.top + G.H + 30}`} style={{ display: 'block', width: '100%', minWidth: 860 }} role="img" aria-label="Berth plan: quay position against time, with the tide curve and night bands">
        <defs><pattern id="hold" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#132a3c" /><rect width="2.5" height="6" fill="#3b6a8f" /></pattern></defs>
        {nights.map(([a, b]) => <rect key={a} x={x(a)} y={G.tideTop} width={(b - a) * px} height={G.top + G.H - G.tideTop} fill="#000" opacity=".42" />)}
        {days.map((h) => { const c = planClock(data.live.plan_epoch_local, h); return <g key={h}><line x1={x(h)} x2={x(h)} y1={G.tideTop} y2={G.top + G.H} stroke={C.line} /><text x={x(h) + 4} y={G.top + G.H + 14} fontSize="10" fill={C.muted}>{c.day} {c.date}</text></g>; })}
        <text x={G.L - 6} y={G.tideTop + 8} fontSize="9.5" fill={C.muted} textAnchor="end">tide m</text>
        {[1, 2, 3].map((v) => <text key={v} x={G.L - 6} y={ty(v) + 3} fontSize="9" fill={C.muted} textAnchor="end">{v}</text>)}
        <path d={`${tidePath} L${x(H)},${ty(0)} L${x(0)},${ty(0)} Z`} fill="rgba(74,163,255,.14)" /><path d={tidePath} fill="none" stroke={C.blue} strokeWidth="1.3" />
        <line x1={x(0)} x2={x(H)} y1={ty(need)} y2={ty(need)} stroke={C.amber} strokeDasharray="4 3" />
        <text x={x(H) - 4} y={ty(need) - 3} fontSize="9.5" fill={C.amber} textAnchor="end">{s ? `${s.vessel_id} needs` : `${fmt(cfg.max_draught_m)} m draught needs`} {fmt(need)} m of tide</text>
        {open.map((h) => <rect key={h} x={x(h)} y={G.tideTop + G.tideH + 5} width={px} height="5" fill={C.ok} />)}
        <text x={G.L - 6} y={G.tideTop + G.tideH + 11} fontSize="9" fill={C.ok} textAnchor="end">gate open</text>
        <rect x={x(0)} y={y(0)} width={H * px} height={G.H} fill="none" stroke={C.hi} />
        <rect x={x(0)} y={y(cfg.quay_ocean_m)} width={H * px} height={y(1000) - y(cfg.quay_ocean_m)} fill="#0b141c" /><text x={x(0) + 6} y={y(910) + 4} fontSize="10" fill={C.muted}>barge berth 820–1000 m: river barges, not planned here</text>
        {[0, 205, 410, 615, 820, 1000].map((m) => <g key={m}><line x1={x(0)} x2={x(H)} y1={y(m)} y2={y(m)} stroke={C.line} /><text x={G.L - 6} y={y(m) + 3} fontSize="9.5" fill={C.muted} textAnchor="end">{m} m</text></g>)}
        <rect x={x(0)} y={y(fx.berth_start_m)} width={fx.release_hr * px} height={(fx.loa_m / 1000) * G.H} fill="#27333e" /><text x={x(0) + 4} y={y(fx.berth_start_m) + 13} fontSize="9.5" fill={C.muted}>{fx.name} (already alongside)</text>
        {ghost && ghost.map((r) => <rect key={`g${r.vessel_id}`} x={x(r.berth_start_hr)} y={y(r.berth_start_m)} width={(r.tidal_depart_hr - r.berth_start_hr) * px} height={((r.berth_end_m - r.berth_start_m) / 1000) * G.H} fill="none" stroke={C.red} strokeDasharray="4 3" opacity=".8" />)}
        {schedule.map((r) => { const w = (r.tidal_depart_hr - r.berth_start_hr) * px, cw = (r.cargo_done_hr - r.berth_start_hr) * px, h = ((r.berth_end_m - r.berth_start_m) / 1000) * G.H, on = r.vessel_id === sel;
          return (
            <g key={r.vessel_id} className="pf-gbar" style={{ transform: `translate(${x(r.berth_start_hr)}px,${y(r.berth_start_m)}px)` }} onClick={() => onSel(r.vessel_id)}>
              <rect width={w} height={h} fill="url(#hold)" /><rect width={cw} height={h} fill={on ? '#2b8f86' : '#2f6f9f'} />
              <rect width={w} height={h} fill="none" stroke={on ? '#fff' : '#7fb6e0'} strokeWidth={on ? 1.6 : 0.8} />
              <line x1={-data.config.transit_hrs * px} x2="0" y1={h / 2} y2={h / 2} stroke={C.tele} strokeWidth="2" /><line x1={w} x2={w + data.config.transit_hrs * px} y1={h / 2} y2={h / 2} stroke={C.tele} strokeWidth="2" />
              <text x="5" y="14" fontSize="10.5" fill="#fff">{r.vessel_id}</text><text x="5" y="27" fontSize="9.5" fill="#cfe3f2">{r.assigned_qcs} QGC · {r.moves} moves{r.anchorage_wait_hrs > 0 ? ` · waited ${r.anchorage_wait_hrs} h` : ''}</text>
              <title>{`${r.vessel_id}: berth ${r.berth_start_m}–${r.berth_end_m} m, alongside hour ${r.berth_start_hr}, cargo done hour ${r.cargo_done_hr}, sails hour ${r.tidal_depart_hr} (held ${r.tide_departure_hold_hrs} h for tide or daylight)`}</title>
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
const RULES = (vessels, sc, k, t) => `You are the command parser for a container-terminal planning engine at Chattogram NCT. Turn the operator's message into JSON only, no prose around it:
{"actions":[...],"reply":"one or two plain sentences"}
Action types (use only these):
{"type":"delay","vessel":"<exact name>","hours":<int>}  a ship arrives later (negative = earlier)
{"type":"qgc_out","count":<int>,"start_hr":<int>,"hours":<int>}  quay cranes out of service; a named crane such as QGC-03 is count 1; the engine models the pool, not individual cranes
{"type":"rtg_out","count":<int 1-6>,"hours":<int>}  yard cranes out in the berth's yard cluster
{"type":"icd","pct":<0-60>}  share of boxes evacuated to off-dock depots
{"type":"yard","pct":<40-95>}  yard occupancy at the start
{"type":"tugs","sets":<1-4>}  pilot and tug sets available at once
{"type":"reset"}  back to the nominal plan
Vessels (name, hours until arrival): ${vessels.map((v) => `${v.name} ${v.eta_hr}`).join('; ')}. "The next feeder" or an unnamed incoming ship means the first with hours > 0. Default durations: 24 h for outages, 6 h for delays. start_hr is hours from the plan start; the plan clock now reads hour ${Math.floor(t)}.
Current scenario: ${JSON.stringify(sc)}. Current result: turnaround ${k.turnaround} d, anchorage wait ${k.wait} h, tide hold ${k.hold} h, peak yard ${k.peak}%, backpressure ${k.beta}.
If the message is a question rather than a command, return "actions":[] and answer it in "reply" from the figures above. If it is a command, "reply" restates what you understood in one sentence.`;

function offlineParse(text, vessels) {
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
  else if (/qgc|quay crane|sts|gantry|crane/.test(s) && /off|out|broke|down|fail|trip/.test(s)) acts.push({ type: 'qgc_out', count: wnum(/(\d+|one|two|three|four|five|six)\s+(?:qgc|quay|crane|sts)/, 1), start_hr: 0, hours: hrs ?? 24 });
  if (/icd|off-?dock|evacuat|depot/.test(s)) acts.push({ type: 'icd', pct: num(/(\d+)\s*%/, /stop|halt|suspend|no off|without|zero|strike|closed/.test(s) ? 0 : 40) });
  else if (/yard|occupan/.test(s) && /%/.test(s)) acts.push({ type: 'yard', pct: num(/(\d+)\s*%/, 86) });
  if (/tug|pilot/.test(s)) acts.push({ type: 'tugs', sets: wnum(/(\d+|one|two|three|four)\s*(?:pilot|tug|set)/, 1) });
  return acts;
}
const NOMINAL = { etaShift: {}, qgcOutages: [], rtgOutages: [], icd: null, occ: null, tugSets: null };
function applyActions(sc, acts, names) {
  let n = { ...sc, etaShift: { ...sc.etaShift }, qgcOutages: [...sc.qgcOutages], rtgOutages: [...sc.rtgOutages] }; const said = [];
  for (const a of acts || []) {
    if (a.type === 'reset') { n = { ...NOMINAL, etaShift: {}, qgcOutages: [], rtgOutages: [] }; said.push('nominal scenario restored'); }
    else if (a.type === 'delay' && names.includes(a.vessel)) { const h = clamp(Math.round(a.hours || 6), -24, 96); n.etaShift[a.vessel] = (n.etaShift[a.vessel] || 0) + h; said.push(`${a.vessel} ${h >= 0 ? 'delayed' : 'advanced'} ${Math.abs(h)} h`); }
    else if (a.type === 'qgc_out') { const c = clamp(Math.round(a.count || 1), 1, 13), s0 = clamp(Math.round(a.start_hr || 0), 0, 180), h = clamp(Math.round(a.hours || 24), 1, 192); n.qgcOutages.push([s0, s0 + h, c]); said.push(`${c} quay crane${c > 1 ? 's' : ''} out for ${h} h from hour ${s0}`); }
    else if (a.type === 'rtg_out') { const c = clamp(Math.round(a.count || 2), 1, 6), h = clamp(Math.round(a.hours || 24), 1, 25); for (let i = 0; i < c; i++) n.rtgOutages.push([0, h * 60]); said.push(`${c} yard crane${c > 1 ? 's' : ''} out for ${h} h`); }
    else if (a.type === 'icd') { n.icd = clamp(Number(a.pct), 0, 60) / 100; said.push(`off-dock evacuation ${Math.round(n.icd * 100)}%`); }
    else if (a.type === 'yard') { n.occ = clamp(Number(a.pct), 40, 95); said.push(`yard starts ${n.occ}% full`); }
    else if (a.type === 'tugs') { n.tugSets = clamp(Math.round(a.sets || 1), 1, 4); said.push(`${n.tugSets} pilot and tug set${n.tugSets > 1 ? 's' : ''}`); }
  }
  return { next: n, said };
}
const scChips = (sc, cfg) => [
  ...Object.entries(sc.etaShift).filter(([, h]) => h).map(([v, h]) => `${v} ${h > 0 ? '+' : ''}${h} h`), ...sc.qgcOutages.map(([a, b, c]) => `${c} QGC out h${a}–${b}`),
  ...(sc.rtgOutages.length ? [`${sc.rtgOutages.length} RTG out ${sc.rtgOutages[0][1] / 60} h`] : []), ...(sc.icd != null ? [`ICD ${Math.round(sc.icd * 100)}%`] : []), ...(sc.occ != null ? [`yard ${sc.occ}%`] : []), ...(sc.tugSets != null && sc.tugSets !== cfg.pilot_tug_sets ? [`${sc.tugSets} tug sets`] : []),
];
const QUICK = ['Delay the next feeder by 6 hours due to Kutubdia fog', 'Take QGC-03 offline for 24 hours', 'Increase off-dock ICD evacuation to 40%', 'A storm delayed three ships by 12 hours and two yard cranes broke', 'Stop off-dock evacuation', 'Only one pilot and tug set today', 'Reset'];

const SidePanels = React.memo(function SidePanels({ trace, R, cfg }) {
  return (
        <section className="pf-panel s5">
          <div className="pf-head"><div><div className="pf-tag">Yard simulation</div><h2>Occupancy through one shift cycle</h2></div></div>
          <div style={{ height: 190 }}><ResponsiveContainer><LineChart data={trace} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="h" type="number" domain={[0, 24]} ticks={[0, 6, 12, 18, 24]} unit=" h" {...ax} /><YAxis domain={[40, 100]} unit="%" {...ax} />
            <ReferenceArea x1={0} x2={6} fill="#000" fillOpacity={0.35} /><ReferenceLine y={80} stroke={C.red} strokeDasharray="4 3" label={{ value: '80% cliff', fill: C.red, fontSize: 10, position: 'insideTopRight' }} />
            <Tooltip {...tip} formatter={(v, n) => [`${fmt(v)}%`, n === 'now' ? 'this scenario' : 'no off-dock evacuation']} labelFormatter={(h) => `${fmt(h)} h into the cycle`} />
            <Line dataKey="none" stroke={C.muted} strokeWidth={1.5} dot={false} isAnimationActive={false} /><Line dataKey="now" stroke={C.tele} strokeWidth={2} dot={false} animationDuration={900} />
          </LineChart></ResponsiveContainer></div>
          <div><span className="pf-key" style={{ '--c': C.tele }}><i />this scenario</span><span className="pf-key" style={{ '--c': C.muted }}><i />no off-dock evacuation</span></div>
          <p className="pf-note">First 6 hours: night shift (evacuation to depots and grooming). Then the discharge wave. One berth's yard cluster, {cfg.rtg_per_berth_cluster} yard cranes.</p>
          <div className="pf-head" style={{ marginTop: 12 }}><div><div className="pf-tag">Reefer power in kW, {R.n_reefers} plugs</div><h2>Evening peak shaved</h2></div></div>
          <div style={{ height: 150 }}><ResponsiveContainer><LineChart data={R.series_30min} margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="hour" type="number" domain={[0, 24]} ticks={[0, 6, 12, 17, 22]} {...ax} /><YAxis domain={[600, 1500]} {...ax} width={44} />
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

export default function PortFlowControlTower() {
  const [mcpData] = useState(DEFAULT_MCP_DATA);
  const data = mcpData, cfg = data.config, site = useMemo(() => makeSite(data), [data]);
  const nominal = useMemo(() => ({ schedule: data.optimised.schedule, kpis: pyKpis(data.optimised.kpis) }), [data]);
  const baseK = useMemo(() => pyKpis(data.baseline.kpis), [data]);
  const [plan, setPlan] = useState({ ...nominal, source: 'CP-SAT reference', yardTrace: null });
  const [sc, setSc] = useState(NOMINAL);
  const [t, setT] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(8);
  const [sel, setSel] = useState('HR FARHA'), [ghost, setGhost] = useState(false);
  const [msgs, setMsgs] = useState([{ role: 'a', text: `Live queue loaded: ${data.live.vessels.length} container ships bound for Chattogram, read ${data.live.retrieved}. The nominal plan is on screen. Tell me what changed and I will re-plan the berths and re-run the yard simulation here in the page.` }]);
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
  const traces = useMemo(() => { const p = { occ: cfg.initial_yard_occupancy_pct, intensity: (cfg.qgc_gmph * 2.629) / cfg.ref_boxes_per_hr, rtgFleet: cfg.rtg_per_berth_cluster, yardCap: cfg.yard_cluster_teu, blocking: data.yard.blocking_ratio, premarshalJobs: data.yard.night_premarshal_relocations_executed, trace: true };
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
        const r = await sample.current.json([{ role: 'user', content: `${RULES(data.live.vessels, sc, plan.kpis, t)}\n\nOPERATOR MESSAGE: ${text}` }], { modelTier: 'quick', cache: false });
        acts = Array.isArray(r && r.actions) ? r.actions : []; reply = (r && r.reply) || '';
      } catch (e) { await reveal([`copilot: Claude unavailable (${(e && e.code) || 'error'}); using the built-in command parser`]); }
    }
    if (acts == null) { acts = offlineParse(text, data.live.vessels); if (mode !== 'claude') await reveal([`${stamp} copilot: built-in command parser (Claude is not available in this view)`]); }
    const { next, said } = applyActions(sc, acts, names);
    if (!said.length) { say('a', reply || 'I could not turn that into a change to the plan. Try: delay a ship by some hours, take quay or yard cranes out, set the off-dock evacuation share, set the starting yard level, or set the number of pilot and tug sets.'); setBusy(false); return; }
    await reveal([`parsed: ${said.join('; ')}`]);
    const lines = [], t0 = performance.now();
    const res = await new Promise((ok) => setTimeout(() => ok(solve(data, { etaShift: next.etaShift, qgcOutages: next.qgcOutages, rtgOutages: next.rtgOutages, icd: next.icd ?? undefined, occ: next.occ ?? undefined, tugSets: next.tugSets ?? undefined, reps: 8 }, (l) => lines.push(l))), 30));
    await reveal(lines);
    if (!res.feasible) { await reveal(['no feasible plan: scenario not applied']); say('a', `The in-page planner found no plan that finishes inside the ${cfg.horizon_hrs}-hour tide table with ${said.join(', ')}${res.blocker ? `; ${res.blocker} is the ship it could not fit` : ''}. This planner is a fast heuristic: the CP-SAT engine searches exhaustively and can find plans it misses (in testing it fitted a storm-plus-no-evacuation case this planner rejected), so check the case on the MCP server with nct_simulate_disruption. I kept the previous plan.`); setBusy(false); return; }
    await reveal([`${res.converged ? 'converged' : 'stopped'} after ${res.iterations} iteration(s) in ${Math.round(performance.now() - t0)} ms: turnaround ${res.kpis.turnaround} d, wait ${res.kpis.wait} h, backpressure ${res.kpis.beta.toFixed(2)}`]);
    const old = Object.fromEntries(plan.schedule.map((r) => [r.vessel_id, r])), k0 = plan.kpis, k1 = res.kpis;
    const moved = res.schedule.filter((r) => { const o = old[r.vessel_id]; return o && (o.berth_start_hr !== r.berth_start_hr || Math.abs(o.berth_start_m - r.berth_start_m) > 5 || o.assigned_qcs !== r.assigned_qcs); });
    const isNominal = !scChips(next, cfg).length;
    setSc(next); setPlan(isNominal ? { ...nominal, source: 'CP-SAT reference', yardTrace: null } : { schedule: res.schedule, kpis: k1, source: 'in-page re-plan', yardTrace: res.yardTrace }); setFlash((f) => f + 1); setT(0);
    const kk = isNominal ? nominal.kpis : k1;
    say('a', `${reply ? `${reply}\n` : ''}Re-planned: average turnaround ${fmt(k0.turnaround, 2)} → ${fmt(kk.turnaround, 2)} days, anchorage wait ${fmt(k0.wait, 0)} → ${fmt(kk.wait, 0)} h, peak yard ${fmt(k0.peak)} → ${fmt(kk.peak)}%, backpressure ${fmt(k0.beta, 2)} → ${fmt(kk.beta, 2)}.${moved.length && !isNominal ? `\nMoved: ${moved.slice(0, 4).map((r) => `${r.vessel_id} to ${r.berth_start_m} m at hour ${r.berth_start_hr} with ${r.assigned_qcs} QGC`).join('; ')}${moved.length > 4 ? `; and ${moved.length - 4} more` : ''}.` : ''}\nPlaying the new plan on the chart.`);
    if (!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { setSpeed(16); setPlaying(true); }
    setBusy(false);
  }, [busy, mode, sc, plan, t, data, names, cfg, nominal]);

  const clk = planClock(data.live.plan_epoch_local, t), hr = Math.min(Math.floor(t), cfg.horizon_hrs), tideNow = data.tide_hourly[hr] + (data.tide_hourly[Math.min(hr + 1, cfg.horizon_hrs)] - data.tide_hourly[hr]) * (t - hr);
  const night = !(site.clock(hr) >= cfg.daylight_hours[0] && site.clock(hr) < cfg.daylight_hours[1]);
  const k = plan.kpis, chips = scChips(sc, cfg), Y = data.yard, R = data.reefer, hy = data.hydrostatics;
  const trace = useMemo(() => (plan.yardTrace || traces.nominal).map((p, i) => ({ h: +(p[0] / 60).toFixed(2), now: p[1], none: traces.none[i] ? traces.none[i][1] : null })), [plan, traces]);
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);

  return (
    <div className={`pf${playing ? ' playing' : ''}`}>
      <style>{CSS}</style>
      <header className="pf-top">
        <div className="pf-brand">PortFlow Control Tower<small>Chattogram · New Mooring Container Terminal · engine v{data.engine_version}</small></div>
        <div className="pf-clock num">{clk.label}<small>plan hour {fmt(t, 1)} of {tMax} · Bangladesh time</small></div>
        <div className="pf-lamps">
          <span className="pf-lamp" style={{ '--c': plan.source === 'CP-SAT reference' ? C.ok : C.tele }}><i />PLAN: {plan.source.toUpperCase()}</span>
          <span className="pf-lamp" style={{ '--c': C.blue }}><i />TIDE {fmt(tideNow, 2)} m</span>
          <span className="pf-lamp" style={{ '--c': night ? C.amber : C.ok }}><i />{night ? 'NIGHT RULE ON' : 'DAYLIGHT'}</span>
          <span className="pf-lamp" style={{ '--c': k.peak >= 80 ? C.red : C.ok }}><i />YARD PEAK {fmt(k.peak)}%</span>
          <span className="pf-lamp" style={{ '--c': mode === 'claude' ? C.ok : C.amber }}><i />COPILOT: {mode === 'claude' ? 'CLAUDE' : mode === 'offline' ? 'BUILT-IN PARSER' : '…'}</span>
        </div>
      </header>

      <div className="pf-scrub">
        <button className="pf-btn" onClick={() => { if (t >= tMax) setT(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <input type="range" min="0" max={tMax} step="0.25" value={Math.min(t, tMax)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Plan time" />
        <div className="pf-seg">{[4, 8, 16, 32].map((s) => <button key={s} className={`pf-btn${speed === s ? ' on' : ''}`} onClick={() => setSpeed(s)} aria-label={`${s} plan hours per second`}>{s} h/s</button>)}</div>
      </div>

      <div className="pf-grid">
        <section className="pf-panel s7">
          <div className="pf-head"><div><div className="pf-tag">Approach and channel</div><h2>Vessel traffic</h2></div>
            <div><span className="pf-key" style={{ '--c': C.blue }}><i />inbound</span><span className="pf-key" style={{ '--c': C.amber }}><i />at anchor</span><span className="pf-key" style={{ '--c': C.tele }}><i />under pilotage</span><span className="pf-key" style={{ '--c': C.ok }}><i />alongside</span></div></div>
          <Radar data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} tide={tideNow} />
          <p className="pf-note">Schematic, not to scale. Ship names, numbers, sizes and status were read from public sources on {data.live.retrieved}; no source gave latitude, longitude, speed or course, so each ship is drawn from its reported area and then moves according to the plan. Click a ship for its details.</p>
        </section>

        <section className="pf-panel s5">
          <div className="pf-chat">
            <div className="pf-head" style={{ marginBottom: 0 }}><div><div className="pf-tag">Copilot</div><h2>Tell the tower what changed</h2></div>
              <button className="pf-btn" disabled={busy || !chips.length} onClick={() => run('Reset')}>Reset scenario</button></div>
            <div className="pf-msgs" ref={msgEnd} aria-live="polite">{msgs.map((m, i) => <div key={i} className={`pf-msg ${m.role}`}>{m.text}</div>)}{busy && <div className="pf-msg a">working…</div>}</div>
            {chips.length > 0 && <div className="pf-chips" aria-label="Active changes">{chips.map((c) => <span key={c} className="pf-chip act">{c}</span>)}</div>}
            <form className="pf-in" onSubmit={(e) => { e.preventDefault(); run(input); }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. HR FARHA is 8 hours late and one quay crane is down" aria-label="Command for the copilot" disabled={busy} />
              <button className="pf-btn on" type="submit" disabled={busy || !input.trim()}>Send</button>
            </form>
            <div className="pf-chips">{QUICK.slice(0, 6).map((q) => <button key={q} className="pf-chip" disabled={busy} onClick={() => run(q)}>{q}</button>)}</div>
            <div className="pf-tag" style={{ marginTop: 2 }}>Solver log</div>
            <div className="pf-term" ref={termEnd}>{log.map((l, i) => <div key={i} className={i === log.length - 1 ? 'cur' : ''}>{l}</div>)}</div>
          </div>
        </section>

        <section className="pf-panel">
          <div className="pf-kpis">
            <Kpi label="Average turnaround" v={k.turnaround} unit="days" d={2} base={baseK.turnaround} nom={nominal.kpis.turnaround} flash={flash} />
            <Kpi label="Anchorage wait" v={k.wait} unit="h" d={0} base={baseK.wait} nom={nominal.kpis.wait} flash={flash} />
            <Kpi label="Peak yard occupancy" v={k.peak} unit="%" d={1} base={baseK.peak} nom={nominal.kpis.peak} flash={flash} />
            <Kpi label="Quay slowdown from yard" v={k.beta} unit="×" d={2} base={baseK.beta} nom={nominal.kpis.beta} flash={flash} />
            <Kpi label="Gate truck wait" v={k.gateWait} unit="min" d={0} base={baseK.gateWait} nom={nominal.kpis.gateWait} flash={flash} />
            <Kpi label="Held for tide or daylight" v={k.hold} unit="h" d={0} base={baseK.hold} nom={nominal.kpis.hold} flash={flash} />
          </div>
          <p className="pf-note">FCFS baseline: ships berth in arrival order with every crane they can take and no off-dock evacuation. Nominal plan: the Python engine (CP-SAT with simulation cuts) at {Math.round(cfg.icd_ratio * 100)}% evacuation. Re-plans made here use the in-page planner; it matched CP-SAT exactly on {data.validation.filter((v) => Math.abs(v.gap_pct) < 0.05).length} of {data.validation.length} test cases and was within {fmt(Math.max(...data.validation.map((v) => Math.abs(v.gap_pct))))}% on the rest.</p>
        </section>

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Quay against time</div><h2>Berth plan, tide and night bands</h2></div>
            <div className="pf-seg"><button className={`pf-btn${ghost ? ' on' : ''}`} onClick={() => setGhost(!ghost)}>{ghost ? 'Hide' : 'Show'} FCFS baseline</button></div></div>
          <Gantt data={data} site={site} schedule={plan.schedule} ghost={ghost ? data.baseline.schedule : null} t={t} sel={sel} onSel={setSel} tMax={tMax} />
          <p className="pf-note">Solid bar: working cargo. Hatched: cargo finished, ship held until the tide and daylight allow it to sail. Teal stubs: the {cfg.transit_hrs}-hour pilotage in and out. Dark bands: night, when ships over {cfg.night_max_loa_m} m or deeper than {fmt(cfg.night_max_draught_m)} m may not move. Green ticks: hours when the selected ship may transit.</p>
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

        <SidePanels trace={trace} R={R} cfg={cfg} />

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Queue</div><h2>Ships in the plan</h2></div>
            <div className="pf-stats" style={{ marginTop: 0 }}><div className="pf-stat"><div className="l">Stability check, {hy.vessel_id}</div><div className="v num">GM {fmt(hy.GM_metacentric_height_m, 2)} m · list {fmt(hy.heeling_list_angle_deg, 2)}° · {hy.imo_stability_compliant ? 'pass' : 'FAIL'}</div></div></div></div>
          <div className="pf-scroll"><table className="pf-table"><thead><tr><th>Vessel</th><th>IMO</th><th>MMSI</th><th>LOA m</th><th>Draught m</th><th className="tl">Reported status</th><th className="tl">Arrival basis</th><th>Berth m</th><th>Alongside</th><th>Sails</th><th>QGC</th><th>Wait h</th><th>Hold h</th></tr></thead>
            <tbody>{plan.schedule.map((r) => { const v = vmap[r.vessel_id]; return (
              <tr key={r.vessel_id} className={sel === r.vessel_id ? 'sel' : ''} onClick={() => setSel(r.vessel_id)}>
                <td>{r.vessel_id}</td><td>{v.imo}</td><td>{v.mmsi}</td><td>{fmt(v.loa_m, 2)}</td><td>{v.draught_reported_m == null ? '—' : fmt(v.draught_reported_m)} / {fmt(r.draft_m)}</td><td className="tl">{v.status}</td><td className="tl" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.eta_basis}>{v.eta_basis}</td>
                <td>{r.berth_start_m}–{r.berth_end_m}</td><td>{planClock(data.live.plan_epoch_local, r.berth_start_hr).label}</td><td>{planClock(data.live.plan_epoch_local, r.tidal_depart_hr).label}</td><td>{r.assigned_qcs}</td><td>{r.anchorage_wait_hrs}</td><td>{r.tide_departure_hold_hrs}</td>
              </tr>); })}</tbody></table></div>
          <p className="pf-note">Draught: reported by the ship / used in the plan (capped at the {fmt(cfg.max_draught_m)} m limit). Box counts per call are estimates from deadweight; terminals are not published, so every ship is treated as an NCT call.</p>
        </section>
      </div>

      <details className="pf-foot"><summary>What is measured, what is assumed</summary><ul>
        <li>Read from public sources on {data.live.retrieved}: {data.live.what_is_live}</li>
        <li>Not available: {data.live.what_is_not_live}</li>
        <li>Sources: {Object.values(data.live.sources).join(' · ')}</li>
        <li>Assumed: channel depth {fmt(cfg.channel_depth_m)} m below datum, under-keel clearance {fmt(cfg.ukc_m)} m, {cfg.pilot_tug_sets} pilot and tug sets, yard starting {fmt(cfg.initial_yard_occupancy_pct, 0)}% full, {fmt(cfg.qgc_gmph)} moves per crane-hour, {cfg.qgc_total} quay cranes. The quay-crane, yard-crane and reefer-plug counts are the ones supplied for this model; published figures for NCT differ.</li>
        <li>{data.live.tide_note}</li>
      </ul></details>
    </div>
  );
}
