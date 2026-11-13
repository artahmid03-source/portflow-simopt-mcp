"""Plans the live Chattogram NCT queue and writes nct_control_tower_data.json for the HMI.
Usage:  python run_nct_pipeline.py     (about 3 minutes)"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "sites"))
import portflow_mcp as eng
import chattogram_nct as nct

t0 = time.time()
live = nct.load_live()
H = nct.NCT["horizon_hrs"]
lead = live["vessels"][0]                      # first ship in the queue supplies the stowage parcel

# --- stability of the lead vessel, with particulars derived from its real dimensions
L, B, T = lead["loa_m"], lead["beam_m"], lead["draught_used_m"]
N_PARCEL = 360
eng.KB_M, eng.BM_M = round(0.53 * T, 2), round(0.085 * B * B / T, 2)            # [ASSUMPTION] standard form coefficients
displacement = 0.65 * L * B * T * 1.025                                           # [ASSUMPTION] block coefficient 0.65
eng.SHIP_BASE_MASS_T, eng.SHIP_BASE_KG_M = round(displacement - N_PARCEL * 19.0, 0), 8.4   # [ASSUMPTION]
baplie = json.loads(eng._generate_and_parse_baplie(lead["name"], N_PARCEL))

# --- one 40-bay RTG block: random stacking (baseline) and dwell-aware stacking + night grooming
eng.YARD_BAYS = nct.NCT["yard_bays"]
yard_base = json.loads(eng._optimize_3d_yard_and_reefers(False, 0, vessel_id=lead["name"]))
yard = json.loads(eng._optimize_3d_yard_and_reefers(True, 90, vessel_id=lead["name"]))
reefer = eng._simulate_reefer_block(nct.NCT["reefer_plugs"], seed=99)

# --- the live queue: baseline rule vs optimised plan
baseline = nct.run_nct_benders(live, icd_ratio=0.0, fcfs=True, force_max_cranes=True)
plan_only = nct.run_nct_benders(live, icd_ratio=0.0)
optimised = nct.run_nct_benders(live)
tug = {k: nct.run_nct_benders(live, pilot_tug_sets=k, sim_replications=10)["kpis"] for k in (1, 2, 3)}

# --- one logged DES replication for the telemetry ticker and the yard trace
logged = json.loads(eng._run_simpy_terminal_simulation(
    nct.NCT["initial_yard_occupancy_pct"], nct.NCT["icd_ratio"], 0.14, rtg_fleet=nct.NCT["rtg_per_berth_cluster"],
    seed=2026, qc_intensity=nct._intensity("2.629"), yard_cap_teu=nct.NCT["yard_cluster_teu"], log_events=True, trace_occupancy=True))
ev = logged.pop("event_log")
night = [e for e in ev if e[0] < 360.0]
ticker = [e for e in night if e[1] == "PREMARSHAL"][:12] + [e for e in night if e[1] == "ICD_LIFT"][:48] + [e for e in ev if e[0] >= 360.0][:240]
ticker.sort(key=lambda e: e[0])

# --- reference results the in-browser engine is checked against
CASES = [
    ("nominal", {}),
    ("HR FARHA 6 h late", {"eta_shift_hrs": {"HR FARHA": 6}}),
    ("6 QGC out 48 h", {"qgc_outages": [[0, 48, 6]]}),
    ("3 RTG out 24 h", {"rtg_outages": [[0.0, 1440.0]] * 3}),
    ("ICD 10%", {"icd_ratio": 0.10}),
    ("ICD 0%", {"icd_ratio": 0.0}),
    ("yard starts 86%", {"initial_yard_occupancy_pct": 86.0}),
    ("one pilot/tug set", {"pilot_tug_sets": 1}),
]
reference = []
for name, kw in CASES:
    r = nct.run_nct_benders(live, sim_replications=10, **kw)
    reference.append({"case": name, "inputs": kw, "status": r["convergence_status"], "cuts": r["cuts"], "kpis": r.get("kpis")})

# --- draught check: daylight bar windows at the planning draught vs the AIS-reported draught
def windows(v, d):
    return [h for h in range(v["eta_hr"], H) if all(nct.transit_ok(live, nct.tide_curve(live, H), h + k, v["loa_m"], d) for k in range(nct.NCT["transit_hrs"]))]
draught_check = []
for v in live["vessels"]:
    rep_d = v["draught_reported_m"]
    w_plan = windows(v, v["draught_used_m"])
    w_rep = windows(v, min(rep_d, 99.0)) if rep_d is not None else None
    draught_check.append({"vessel": v["name"], "reported_m": rep_d, "planned_m": v["draught_used_m"], "inbound_starts_planned": len(w_plan),
                          "first_start_planned": w_plan[0] if w_plan else None, "inbound_starts_reported": None if w_rep is None else len(w_rep),
                          "first_start_reported": (w_rep[0] if w_rep else None) if w_rep is not None else None})

# --- night rule check: transit cut-off at 18:00 (as specified) instead of the 17:09 sunset used in the plan
_dl = nct.NCT["daylight_hours"]
nct.NCT["daylight_hours"] = (6, 18)
try:
    night18 = nct.run_nct_benders(live, sim_replications=10)["kpis"]
finally:
    nct.NCT["daylight_hours"] = _dl

strip = lambda y: {k: v for k, v in y.items() if k != "reefer_rc_thermodynamics"}
payload = {
    "engine_version": "6.0", "site": "Chattogram NCT", "config": {k: (list(v) if isinstance(v, tuple) else v) for k, v in nct.NCT.items()},
    "live": live, "tide_hourly": nct.tide_curve(live, H),
    "hydrostatics": {"vessel_id": baplie["vessel_id"], "containers_parsed": baplie["containers_parsed"], "total_mass_tonnes": baplie["total_mass_tonnes"],
                     "displacement_tonnes": baplie["displacement_tonnes"], **baplie["hydrostatics"]},
    "yard": strip(yard), "yard_baseline": {k: v for k, v in strip(yard_base).items() if not k.startswith("yard_") and k != "premarshal_moves"},
    "reefer": reefer, "baseline": baseline, "plan_only": plan_only, "optimised": optimised, "pilot_tug_sensitivity": tug, "draught_check": draught_check, "night_cutoff_18h": night18,
    "des_logged": {"metrics": {k: v for k, v in logged.items() if k not in ("occupancy_trace", "rtg_utilisation_by_hour")},
                   "occupancy_trace": logged["occupancy_trace"], "events_total": len(ev), "events": ticker},
    "reference_cases": reference,
}
Path("nct_control_tower_data.json").write_text(json.dumps(payload))
print(f"done in {time.time() - t0:.0f}s  ->  nct_control_tower_data.json")
