import fs from 'fs';
import { solve, simulateReplicated, makeSite } from './src/engine.js';
// node validate.mjs [--json] [--check] [--data <file>] [--write]   (--write stores the comparison in the file as "validation")
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const file = arg('--data') || new URL('../nct_control_tower_data.json', import.meta.url).pathname;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!data.reference_cases) { console.log(`no reference cases in ${file} (status ${data.status}); nothing to check`); process.exit(0); }
const map = (kw) => ({ etaShift: kw.eta_shift_hrs, qgcOutages: kw.qgc_outages, rtgOutages: kw.rtg_outages, icd: kw.icd_ratio, occ: kw.initial_yard_occupancy_pct, tugSets: kw.pilot_tug_sets, reps: 10 });
const J = process.argv.includes('--json'), out = [];
if (!J) console.log('case | CP-SAT obj | JS obj | gap% | turnaround py/js | beta py/js | peak py/js | ms');
for (const c of data.reference_cases) {
  if (!c.kpis) continue;
  const t = Date.now(), r = solve(data, map(c.inputs)), k = c.kpis;
  if (!r.feasible) { out.push({ case: c.case, cpsat_objective: k.objective, js_objective: null, gap_pct: null, infeasible_in_page: true }); continue; }
  out.push({ case: c.case, cpsat_objective: k.objective, js_objective: r.kpis.objective, gap_pct: +(100 * (r.kpis.objective / k.objective - 1)).toFixed(1), cpsat_turnaround: k.avg_turnaround_days, js_turnaround: r.kpis.turnaround });
  if (!J) console.log(`${c.case} | ${k.objective} | ${r.kpis.objective} | ${(100 * (r.kpis.objective / k.objective - 1)).toFixed(1)} | ${k.avg_turnaround_days}/${r.kpis.turnaround} | ${k.backpressure_beta_max}/${r.kpis.beta} | ${k.peak_yard_occupancy_pct}/${r.kpis.peak} | ${Date.now() - t}`);
}
const b = solve(data, { icd: 0, fcfs: true, forceMax: true, reps: 10 }), pb = data.baseline.kpis;
if (process.argv.includes('--check')) {
  // the five cases the in-page planner must reproduce exactly, and a ceiling on the rest
  const exact = out.slice(0, 5).filter((r) => r.gap_pct !== 0), worst = Math.max(...out.map((r) => (r.gap_pct == null ? 99 : Math.abs(r.gap_pct))));
  if (exact.length || worst > 7) { console.error('FAIL: in-page engine drifted from CP-SAT', JSON.stringify({ exact, worst })); process.exit(1); }
  console.log(`OK: ${out.length - 3} of ${out.length} cases identical to CP-SAT, worst gap ${worst}%`);
}
if (J) console.log(JSON.stringify(out)); else if (pb && b.feasible) console.log('baseline FCFS', pb.objective, b.kpis.objective, pb.avg_turnaround_days, b.kpis.turnaround, pb.total_anchorage_wait_hrs, b.kpis.wait);
if (process.argv.includes('--write')) { data.validation = out; fs.writeFileSync(file, JSON.stringify(data)); }
