import fs from 'fs';
import { solve, simulateReplicated, makeSite } from './src/engine.js';
const data = JSON.parse(fs.readFileSync('../nct_control_tower_data.json', 'utf8'));
const map = (kw) => ({ etaShift: kw.eta_shift_hrs, qgcOutages: kw.qgc_outages, rtgOutages: kw.rtg_outages, icd: kw.icd_ratio, occ: kw.initial_yard_occupancy_pct, tugSets: kw.pilot_tug_sets, reps: 10 });
const J = process.argv.includes('--json'), out = [];
if (!J) console.log('case | CP-SAT obj | JS obj | gap% | turnaround py/js | beta py/js | peak py/js | ms');
for (const c of data.reference_cases) {
  const t = Date.now(), r = solve(data, map(c.inputs)), k = c.kpis;
  out.push({ case: c.case, cpsat_objective: k.objective, js_objective: r.kpis.objective, gap_pct: +(100 * (r.kpis.objective / k.objective - 1)).toFixed(1), cpsat_turnaround: k.avg_turnaround_days, js_turnaround: r.kpis.turnaround });
  if (!J) console.log(`${c.case} | ${k.objective} | ${r.kpis.objective} | ${(100 * (r.kpis.objective / k.objective - 1)).toFixed(1)} | ${k.avg_turnaround_days}/${r.kpis.turnaround} | ${k.backpressure_beta_max}/${r.kpis.beta} | ${k.peak_yard_occupancy_pct}/${r.kpis.peak} | ${Date.now() - t}`);
}
const b = solve(data, { icd: 0, fcfs: true, forceMax: true, reps: 10 }), pb = data.baseline.kpis;
if (J) console.log(JSON.stringify(out)); else console.log('baseline FCFS', pb.objective, b.kpis.objective, pb.avg_turnaround_days, b.kpis.turnaround, pb.total_anchorage_wait_hrs, b.kpis.wait);
