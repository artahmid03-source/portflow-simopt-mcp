// PortFlow in-browser engine: a JavaScript port of the NCT site model so the HMI can
// re-plan and re-simulate on the spot. The Python engine (CP-SAT + SimPy) stays the reference;
// this port is checked against it case by case (see validate.mjs).
//   - tide and daylight gates on the river transit
//   - berth planner: serial schedule generation over a bounded set of berthing orders
//   - yard discrete-event simulation (process-based kernel, same logic as the SimPy model)
//   - two-way loop: the planner's crane modes are simulated and returned as cuts

// ---------------------------------------------------------------- random numbers
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, exp: (mean) => -mean * Math.log(1 - u()), uni: (lo, hi) => lo + (hi - lo) * u() };
}

// ---------------------------------------------------------------- DES kernel
class Env {
  constructor() { this.now = 0; this.h = []; this.n = 0; }
  at(t, fn) { const e = { t, n: this.n++, fn }; const h = this.h; let i = h.push(e) - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p].t < e.t || (h[p].t === e.t && h[p].n < e.n)) break; h[i] = h[p]; i = p; } h[i] = e; }
  pop() { const h = this.h, top = h[0], last = h.pop(); if (h.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= h.length) break; if (c + 1 < h.length && (h[c + 1].t < h[c].t || (h[c + 1].t === h[c].t && h[c + 1].n < h[c].n))) c++; if (last.t < h[c].t || (last.t === h[c].t && last.n < h[c].n)) break; h[i] = h[c]; i = c; } h[i] = last; } return top; }
  timeout(d) { return (cb) => this.at(this.now + d, cb); }
  process(gen) { const step = () => { const r = gen.next(); if (!r.done) r.value(step); }; step(); }
  run() { while (this.h.length) { const e = this.pop(); this.now = e.t; e.fn(); } }
}
class Resource {
  constructor(env, cap) { this.env = env; this.cap = cap; this.users = 0; this.q = []; this.n = 0; }
  request(prio = 0) { return (cb) => { if (this.users < this.cap) { this.users++; cb(); } else this.q.push({ prio, n: this.n++, cb }); }; }
  release() {
    this.users--;
    if (!this.q.length) return;
    let k = 0; for (let i = 1; i < this.q.length; i++) if (this.q[i].prio < this.q[k].prio || (this.q[i].prio === this.q[k].prio && this.q[i].n < this.q[k].n)) k = i;
    const w = this.q.splice(k, 1)[0]; this.users++; this.env.at(this.env.now, w.cb);
  }
}

export function rtgCycle(occ, blocking) {
  const o = Math.min(Math.max(occ, 0.15), 0.95), base = 2.6 + blocking * 3.5;
  return o <= 0.78 ? base * (1 + 0.25 * o) : Math.min(base * (1 + 0.42 * Math.pow(o / (1 - o), 1.32)), 20);
}

// One night shift and one discharge wave on a berth's yard cluster.
export function simulateYard(p) {
  const env = new Env(), R = rng(p.seed);
  const rtg = new Resource(env, p.rtgFleet), xray = new Resource(env, 2), shuttle = new Resource(env, 3), trucks = new Resource(env, 12);
  const cap = p.yardCap, NIGHT = 360, N_DIS = p.nDis || 750, N_GATE = Math.round(0.56 * N_DIS), qcCycle = 1.25 / Math.max(p.intensity, 0.05);
  const st = { teu: (p.occ / 100) * cap, peak: 0, waveStart: null, waits: [], gate: [], icdN: 0, icdD: 0, rehandle: 0, nominal: 0, doneAt: null, blocked: 0, trace: [] };
  const cyc = () => rtgCycle(st.teu / cap, p.blocking);
  const note = () => { if (env.now >= NIGHT) st.peak = Math.max(st.peak, (st.teu / cap) * 100); };
  function* outage(start, dur) { yield env.timeout(start); yield rtg.request(-1); yield env.timeout(dur); rtg.release(); }
  function* premarshal() { yield rtg.request(1); yield env.timeout(cyc()); rtg.release(); }
  function* nightIcd() { yield rtg.request(1); yield env.timeout(cyc() * 0.85); st.teu -= 1; rtg.release(); yield shuttle.request(); yield env.timeout(1.4); st.icdN++; shuttle.release(); }
  function* icdDirect() { yield shuttle.request(); yield env.timeout(1.4); st.icdD++; shuttle.release(); }
  function* stack() {
    const t0 = env.now; yield rtg.request(0); st.waits.push(env.now - t0);
    const occ = st.teu / cap, c = rtgCycle(occ, p.blocking); if (occ > 0.8) st.rehandle += c - 2.6;
    yield env.timeout(c); st.teu += 1; note(); rtg.release();
    yield env.timeout(1.5); trucks.release();
    if (R.u() < 0.14) { yield xray.request(); yield env.timeout(R.uni(3.5, 6.5)); xray.release(); }
  }
  function* discharge() {
    yield env.timeout(NIGHT); st.waveStart = (st.teu / cap) * 100; note();
    for (let i = 0; i < N_DIS; i++) {
      const c = R.exp(qcCycle); st.nominal += c; yield env.timeout(c);
      if (R.u() < p.icd) { env.process(icdDirect()); continue; }
      const tb = env.now;
      while (st.teu + trucks.users >= cap && env.now - tb < 2880) yield env.timeout(1);
      if (st.teu + trucks.users >= cap) { st.blocked += env.now - tb; continue; }   // blocked 48 h: overflow storage
      yield trucks.request(); st.blocked += env.now - tb; env.process(stack());
    }
    st.doneAt = env.now;
  }
  function* pickup(tArr) { yield rtg.request(1); st.gate.push(env.now - tArr); yield env.timeout(cyc() * 0.85); st.teu -= 1; rtg.release(); }
  function* gate() { yield env.timeout(NIGHT); for (let i = 0; i < N_GATE; i++) { yield env.timeout(R.exp(2.1)); if (st.teu > 1000) env.process(pickup(env.now)); } }
  function* sampler() { for (let t = 0; t <= 1500; t += 10) { st.trace.push([t, +(st.teu / cap * 100).toFixed(2), rtg.users, rtg.q.length]); yield env.timeout(10); } }
  for (const [s, d] of p.rtgOutages || []) env.process(outage(s, d));
  if (p.icd > 0) { for (let i = 0; i < p.premarshalJobs; i++) env.process(premarshal()); const n = Math.round(p.icd * st.teu); for (let i = 0; i < n; i++) env.process(nightIcd()); }
  env.process(discharge()); env.process(gate()); if (p.trace) env.process(sampler());
  env.run();
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { beta: Math.max(1, (st.doneAt - NIGHT) / st.nominal), waveStart: st.waveStart, peak: st.peak, gateWait: mean(st.gate), rtgWait: mean(st.waits),
    rehandleHrs: st.rehandle / 60, icdBoxes: st.icdN + st.icdD, blockedHrs: st.blocked / 60, makespanHrs: (st.doneAt - NIGHT) / 60, trace: st.trace };
}

export function simulateReplicated(p, reps) {
  const runs = []; for (let k = 0; k < reps; k++) runs.push(simulateYard({ ...p, seed: 2026 + k, trace: p.trace && k === 0 }));
  const avg = (f) => runs.reduce((s, r) => s + r[f], 0) / runs.length;
  return { beta: +avg('beta').toFixed(3), waveStart: +avg('waveStart').toFixed(1), peak: +avg('peak').toFixed(1), gateWait: +avg('gateWait').toFixed(1), rtgWait: +avg('rtgWait').toFixed(2),
    rehandleHrs: +avg('rehandleHrs').toFixed(1), icdBoxes: Math.round(avg('icdBoxes')), blockedHrs: +avg('blockedHrs').toFixed(2), trace: runs[0].trace, reps };
}

// ---------------------------------------------------------------- site model
export const craneEffect = (q) => Math.pow(q, 0.88);
export const modeKey = (q) => craneEffect(q).toFixed(3);
const YARD_CLASSES = [800, 1600, 3200], CLASS_DISCHARGE = [500, 1000, 2000, 3000];
const yardClass = (moves) => YARD_CLASSES.filter((b) => moves >= b).length;
// Benders cut key: crane mode, plus the ship's size class under the per-ship yard model (same as chattogram_nct.yard_key)
export const yardKey = (C, q, v) => (C.yard_model === 'per_ship' ? `${modeKey(q)}|c${yardClass(v.moves)}` : modeKey(q));

export function makeSite(data) {
  const C = data.config, live = data.live, tide = data.tide_hourly, epochHour = Number(live.plan_epoch_local.slice(11, 13));
  const clock = (h) => (((epochHour + h) % 24) + 24) % 24;
  const transitOk = (h, loa, draft) => {
    if (h < 0 || h >= tide.length) return false;
    if (live.hw_windows && !live.hw_windows.some(([a, b]) => h >= a && h < b)) return false;   // live rule: movements around high water
    if (loa > C.max_loa_m || draft > C.spring_max_draught_m) return false;
    if (tide[h] < draft + C.ukc_m - C.channel_depth_m + (live.tide_margin_m || 0)) return false;   // margin: tide forecast error (live runs)
    if (draft > C.max_draught_m && tide[h] < C.spring_tide_min_m) return false;
    const c = clock(h); if (c >= C.daylight_hours[0] && c < C.daylight_hours[1]) return true;
    return loa <= C.night_max_loa_m && draft <= C.night_max_draught_m;
  };
  const pools = C.crane_pools || { all: C.qgc_total }, firstPool = Object.keys(pools)[0];
  const vessels = (shift = {}) => live.vessels.map((v) => ({ id: v.name, imo: v.imo, mmsi: v.mmsi, len: Math.ceil(v.loa_m), loa: v.loa_m, draft: v.draught_used_m,
    eta: v.eta_hr + (shift[v.name] || 0), moves: v.moves_est ?? Math.round(0.85 * (v.teu_est ?? v.dwt_t / 14)), minQc: 1, maxQc: v.max_qc ?? (v.loa_m >= 160 ? 3 : 2),
    ranges: v.quay_ranges || [[0, C.quay_ocean_m]], pool: v.terminal || firstPool, quay: v.terminal,
    wWait: C.objective === 'cost' ? (v.w_wait ?? 18) : 18, wOcc: C.objective === 'cost' ? (v.w_occ ?? 6) : 6 }));
  // pairs too wide to meet freely on the river: [inbound ship, outbound ship, allowed offsets] (Hamburg)
  const meet = {}; for (const [a, b, allowed] of data.meeting || []) (meet[a] = meet[a] || []).push([b, new Set(allowed)]);
  // Gates: a site may ship precomputed hour masks (Hamburg: the Elbe tide rule over six gauges); otherwise the Karnaphuli rule above.
  const G = data.gates;
  const inOk = (v, ts) => (G && G[v.id] ? G[v.id].in[ts] === '1' : (() => { for (let k = 1; k <= C.transit_hrs; k++) if (!transitOk(ts - k, v.loa, v.draft)) return false; return true; })());
  const outOk = (v, td) => (G && G[v.id] ? G[v.id].out[td] === '1' : (() => { for (let k = 0; k < C.transit_hrs; k++) if (!transitOk(td + k, v.loa, v.draft)) return false; return true; })());
  const gateNow = (id, h) => { const v = vessels().find((x) => x.id === id); return v ? inOk(v, h) : false; };
  return { C, live, tide, clock, transitOk, vessels, pools, firstPool, inOk, outOk, gateNow, meet };
}

// Serial schedule generation: place vessels one by one in a given order.
function buildPlan(site, vs, order, o) {
  const { C } = site, H = C.horizon_hrs, T = C.transit_hrs, gap = C.berth_gap_m, K = o.tugSets;
  const cranes = Object.fromEntries(Object.keys(site.pools).map((p) => [p, new Int16Array(H + 4)])), tugs = new Int16Array(H + 8), placed = [];
  const pool = (h, p) => { let d = 0; for (const [a, b, n, q] of o.qgcOutages) if (a <= h && h < b && (q ?? site.firstPool) === p) d += n; return Math.max(0, site.pools[p] - d); };
  for (const f of site.live.fixed_occupants || []) { placed.push({ id: f.name, b0: f.berth_start_m, b1: f.berth_start_m + Math.ceil(f.loa_m) + gap, ts: 0, td: f.release_hr, sIn: null }); for (let k = 0; k < T; k++) tugs[f.release_hr + k]++; }
  const meetOk = (v, sIn, td) => {                     // offsets between an inbound and an outbound passage of two wide ships
    for (const p of placed) {
      for (const [b, allowed] of site.meet[v.id] || []) if (b === p.id) { const d = p.td - sIn; if (Math.abs(d) < T && !allowed.has(d)) return false; }
      if (p.sIn != null) for (const [b, allowed] of site.meet[p.id] || []) if (b === v.id) { const d = td - p.sIn; if (Math.abs(d) < T && !allowed.has(d)) return false; }
    }
    return true;
  };
  const rows = []; let cost = 0;
  for (const idx of order) {
    const v = vs[idx]; let best = null;
    const qs = o.forceMax ? [v.maxQc] : Array.from({ length: v.maxQc - v.minQc + 1 }, (_, i) => v.minQc + i);
    for (const q of qs) {
      const beta = o.cuts[yardKey(C, q, v)] ?? 1, dur = Math.ceil(v.moves / (C.qgc_gmph / Math.max(beta, 0.5) * craneEffect(q)));
      let tried = 0;
      for (let ts = Math.max(v.eta + T, o.minStart); ts < H - (C.berth_tail_hrs ?? 30) && tried < 14; ts++) {
        if (!site.inOk(v, ts)) continue;
        let ok = true; for (let k = 1; k <= T; k++) if (tugs[ts - k] >= K) { ok = false; break; }
        if (!ok) continue;
        const cr = cranes[v.pool];
        for (let h = ts; h < ts + dur; h++) if (cr[h] + q > pool(h, v.pool)) { ok = false; break; }
        if (!ok) continue;
        let td = -1; for (let h = ts + dur; h < H - T; h++) { if (!site.outOk(v, h)) continue; let g = true; for (let k = 0; k < T; k++) if (tugs[h + k] >= K) { g = false; break; } if (g && meetOk(v, ts - T, h)) { td = h; break; } }
        if (td < 0) continue;
        const busy = placed.filter((p) => p.ts < td && ts < p.td).sort((a, b) => a.b0 - b.b0);
        let b = -1;
        for (const [lo, hi] of v.ranges) {
          const cands = [lo, ...busy.map((p) => p.b1).filter((x) => x > lo && x < hi)];
          for (const c of cands) { if (c + v.len > hi) continue; if (busy.every((p) => c + v.len + gap <= p.b0 || p.b1 <= c)) { b = c; break; } }
          if (b >= 0) break;
        }
        if (b < 0) continue;
        tried++;
        const c = v.wWait * (ts - T - v.eta) + v.wOcc * (td - ts);
        if (!best || c < best.c) best = { c, q, ts, td, dur, b };
      }
    }
    if (!best) return { fail: v.id };
    for (let h = best.ts; h < best.ts + best.dur; h++) cranes[v.pool][h] += best.q;
    for (let k = 1; k <= T; k++) tugs[best.ts - k]++;
    for (let k = 0; k < T; k++) tugs[best.td + k]++;
    placed.push({ id: v.id, b0: best.b, b1: best.b + v.len + gap, ts: best.ts, td: best.td, sIn: best.ts - T });
    cost += best.c; o.minStart = o.fcfs ? best.ts : 0;
    rows.push({ vessel_id: v.id, imo: v.imo, mmsi: v.mmsi, loa_m: v.loa, draft_m: v.draft, moves: v.moves, berth_start_m: best.b, berth_end_m: best.b + v.len, eta_hr: v.eta,
      transit_in_hr: best.ts - T, berth_start_hr: best.ts, cargo_done_hr: best.ts + best.dur, tidal_depart_hr: best.td, tide_departure_hold_hrs: best.td - best.ts - best.dur,
      assigned_qcs: best.q, crane_intensity: yardKey(C, best.q, v), anchorage_wait_hrs: best.ts - T - v.eta, turnaround_hrs: best.td + T - v.eta,
      night_restricted: v.loa > C.night_max_loa_m || v.draft > C.night_max_draught_m, tide_needed_m: tideNeeded(site, v), ...(v.quay ? { quay: v.quay, pool: v.pool } : {}) });
  }
  return { cost, rows };
}

function tideNeeded(site, v) {
  const C = site.C;
  if (!site.live.vessels.some((x) => x.terminal)) return +Math.max(0, v.draft + C.ukc_m - C.channel_depth_m).toFixed(2);
  const mega = v.loa > C.mega_loa_m || (site.live.vessels.find((x) => x.name === v.id)?.beam_m || 0) > C.mega_beam_m;
  const indep = mega ? C.draught_indep_mega_m : C.draught_indep_m, maxIn = (mega ? C.draught_max_in_mega_m : C.draught_max_in_m) - C.deepening_shortfall_m;
  return +Math.max(0, Math.min(v.draft, maxIn) - indep).toFixed(2);
}

function ordersNear(n, maxShift) {              // permutations where no vessel moves more than maxShift places from arrival order
  const out = [], used = new Array(n).fill(false), cur = [];
  (function rec(pos) { if (pos === n) { out.push(cur.slice()); return; } for (let i = 0; i < n; i++) { if (used[i] || Math.abs(i - pos) > maxShift) continue; if (i > pos && false) continue; used[i] = true; cur.push(i); rec(pos + 1); cur.pop(); used[i] = false; } })(0);
  return out;
}

export function planBerths(site, opt) {
  const vs = site.vessels(opt.etaShift).sort((a, b) => a.eta - b.eta || (a.id < b.id ? -1 : 1));
  const base = { cuts: opt.cuts || {}, tugSets: opt.tugSets ?? site.C.pilot_tug_sets, qgcOutages: opt.qgcOutages || [], forceMax: !!opt.forceMax, fcfs: !!opt.fcfs };
  const orders = opt.fcfs ? [vs.map((_, i) => i)] : ordersNear(vs.length, vs.length > 9 ? 1 : 2);
  if (!opt.fcfs) {                                   // also try the most constrained ships first, and a fixed set of shuffles
    const H = site.C.horizon_hrs, free = vs.map((v) => { let n = 0; for (let h = 0; h < H; h++) if (site.inOk(v, h)) n++; return n; });
    const wide = (v) => Object.keys(site.meet).includes(v.id) ? 1 : 0;
    orders.push(vs.map((_, i) => i).sort((a, b) => free[a] - free[b] || vs[a].eta - vs[b].eta));
    orders.push(vs.map((_, i) => i).sort((a, b) => wide(vs[b]) - wide(vs[a]) || vs[a].eta - vs[b].eta));
    const R = rng(7); for (let k = 0; k < (vs.length > 9 ? 120 : 0); k++) { const o = vs.map((_, i) => i); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(R.u() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } orders.push(o); }
  }
  let best = null;
  const fails = {};
  for (const order of orders) { const r = buildPlan(site, vs, order, { ...base, minStart: 0 }); if (r.fail) { fails[r.fail] = (fails[r.fail] || 0) + 1; continue; } if (!best || r.cost < best.cost) best = r; }
  if (!best) { const blocker = Object.entries(fails).sort((a, b) => b[1] - a[1])[0]; return { feasible: false, ordersTried: orders.length, schedule: [], blocker: blocker && blocker[0] }; }
  const rows = best.rows.sort((a, b) => a.berth_start_hr - b.berth_start_hr), n = rows.length;
  return { feasible: true, ordersTried: orders.length, objective: best.cost, avgTurnaroundDays: +(rows.reduce((s, r) => s + r.turnaround_hrs, 0) / n / 24).toFixed(2),
    totalWaitHrs: rows.reduce((s, r) => s + r.anchorage_wait_hrs, 0), totalHoldHrs: rows.reduce((s, r) => s + r.tide_departure_hold_hrs, 0), schedule: rows };
}

// Two-way loop: plan -> simulate the crane modes the plan uses -> cut -> re-plan.
export function solve(data, opt = {}, onLog = () => {}) {
  const site = makeSite(data), C = site.C;
  const icd = opt.icd ?? C.icd_ratio, occ = opt.occ ?? C.initial_yard_occupancy_pct, reps = opt.reps ?? 8;
  const cuts = {}, sims = {}, trace = []; let plan = null, converged = false;
  onLog(`scenario: off-dock evacuation ${Math.round(icd * 100)}%, yard ${occ}%, ${opt.tugSets ?? C.pilot_tug_sets} pilot/tug sets, ${(opt.qgcOutages || []).length} quay-crane outage(s), ${(opt.rtgOutages || []).length} yard-crane outage(s)`);
  for (let it = 1; it <= 8; it++) {
    plan = planBerths(site, { ...opt, cuts });
    if (!plan.feasible) { onLog(`iteration ${it}: no feasible berth plan inside the ${C.horizon_hrs} h horizon${plan.blocker ? `; ${plan.blocker} cannot finish and sail on a legal tide before it ends` : ''}`); break; }
    const fresh = [...new Set(plan.schedule.map((r) => r.crane_intensity))].filter((k) => !(k in cuts)).sort();
    onLog(`iteration ${it}: planner searched ${plan.ordersTried} berthing orders, cost ${plan.objective}, turnaround ${plan.avgTurnaroundDays} d`);
    for (const k of fresh) {
      sims[k] = simulateReplicated({ occ, icd, intensity: C.qgc_gmph * Number(k.split('|')[0]) / C.ref_boxes_per_hr, nDis: k.includes('|c') ? CLASS_DISCHARGE[Number(k.split('|c')[1])] : 750, rtgFleet: C.rtg_per_berth_cluster, yardCap: C.yard_cluster_teu,
        blocking: data.yard.blocking_ratio, premarshalJobs: data.yard.night_premarshal_relocations_executed, rtgOutages: opt.rtgOutages, trace: true }, reps);
      cuts[k] = sims[k].beta;
      onLog(`  yard DES, crane effect ${k}: ${reps} replications, backpressure ${sims[k].beta.toFixed(3)}, peak occupancy ${sims[k].peak}%  -> cut added`);
    }
    trace.push({ iteration: it, objective: plan.objective, cuts: { ...cuts } });
    if (!fresh.length) { converged = true; onLog(`iteration ${it}: plan uses only simulated crane modes, bound attained`); break; }
  }
  if (!plan || !plan.feasible) return { feasible: false, trace, blocker: plan && plan.blocker };
  const worst = plan.schedule.map((r) => r.crane_intensity).sort((a, b) => Number(b.split('|')[0]) - Number(a.split('|')[0]) || cuts[b] - cuts[a])[0], y = sims[worst];
  return { feasible: true, converged, iterations: trace.length, cuts, trace, schedule: plan.schedule,
    kpis: { objective: plan.objective, turnaround: plan.avgTurnaroundDays, wait: plan.totalWaitHrs, hold: plan.totalHoldHrs,
      beta: Math.max(...plan.schedule.map((r) => cuts[r.crane_intensity])), waveStart: y.waveStart, peak: y.peak, gateWait: y.gateWait, rtgWait: y.rtgWait,
      rehandle: y.rehandleHrs, icdBoxes: y.icdBoxes, hfo: +(plan.totalWaitHrs * 1.85).toFixed(1) }, yardTrace: y.trace };
}

// ---------------------------------------------------------------- money, fuel and risk (mirror of sites/advice.py)
const CO2_PER_T = 3.114, FUEL_USD_T = 600, IDLE_T_DAY = 3, SPEED_MIN = 9;
export const charterUsdDay = (teu) => 90 * Math.pow(Math.max(teu, 100), 0.68);
const fuelTDay = (teu, v) => 0.19 * Math.pow(Math.max(teu, 100), 2 / 3) * Math.pow(v / 14, 3);
const phi = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2); return 0.5 * (1 + (x >= 0 ? y : -y)); };
export function planFigures(data, schedule) {
  const C = data.config, vmap = Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), gates = data.inbound_gates || {}, dist = data.dist_nm || {};
  const fit = (data.backtest && data.backtest.eta_sigma_fit) || { a: 2, b: 0.06 };
  const tot = { cost_usd: 0, fuel_saved_t: 0, co2_saved_t: 0, wait_cost_usd: 0 }, ships = [];
  for (const r of schedule) {
    const v = vmap[r.vessel_id] || {}, teu = v.teu_est || 1000, chH = charterUsdDay(teu) / 24, wait = r.anchorage_wait_hrs, stay = r.tidal_depart_hr - r.berth_start_hr;
    const waitCost = wait * (chH + IDLE_T_DAY * FUEL_USD_T / 24), cost = waitCost + (stay + 2 * C.transit_hrs) * chH;
    let jit = null; const d = dist[r.vessel_id], sog = v.sog_kn;
    if (d && d > 5 && sog && sog >= 6 && wait > 0 && r.eta_hr > 0) {
      const need = r.transit_in_hr, vj = Math.max(SPEED_MIN, Math.min(sog, d / Math.max(need, 0.1)));
      const fNow = fuelTDay(teu, sog) * (d / sog) / 24 + IDLE_T_DAY * Math.max(0, need - d / sog) / 24, fJit = fuelTDay(teu, vj) * (d / vj) / 24 + IDLE_T_DAY * Math.max(0, need - d / vj) / 24, saved = Math.max(0, fNow - fJit);
      jit = { distance_nm: Math.round(d), speed_now_kn: +sog.toFixed(1), speed_advised_kn: +vj.toFixed(1), fuel_saved_t: +saved.toFixed(1), co2_saved_t: +(saved * CO2_PER_T).toFixed(1) };
      tot.fuel_saved_t += saved; tot.co2_saved_t += saved * CO2_PER_T;
    }
    let risk = null; const ok = gates[r.vessel_id] || [];
    if (ok.length && ok.includes(r.berth_start_hr) && r.eta_hr > 0) {
      const s = new Set(ok); let end = r.berth_start_hr; while (s.has(end + 1)) end++;
      if (end < C.horizon_hrs - 30) {
        const slack = end - r.berth_start_hr + r.anchorage_wait_hrs, sig = fit.a + fit.b * Math.max(r.eta_hr, 0), nxt = ok.filter((h) => h > end).sort((a, b) => a - b)[0];
        risk = { window_closes_hr: end, slack_h: slack, sigma_h: +sig.toFixed(1), p_miss: +(1 - phi(slack / sig)).toFixed(3), next_window_hr: nxt ?? null, extra_wait_if_missed_h: nxt != null ? nxt - end : null };
      }
    }
    ships.push({ vessel_id: r.vessel_id, cost_usd: Math.round(cost), wait_cost_usd: Math.round(waitCost), jit, risk });
    tot.cost_usd += cost; tot.wait_cost_usd += waitCost;
  }
  return { ships, totals: Object.fromEntries(Object.entries(tot).map(([k, x]) => [k, +x.toFixed(1)])) };
}
