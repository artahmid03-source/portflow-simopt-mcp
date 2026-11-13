"""Pre-computes the disruption scenarios the HMI copilot can answer from and writes
scenario_library.json.  Usage:  python build_scenario_library.py   (about 5 minutes)"""
import json
import time

import portflow_mcp as p

V1, V3 = "V1_GEARLESS_MEGA", "V3_GEARLESS_MAIN"
SCENARIOS = [("NOMINAL", "Nominal operation", "No disruption. ICD ratio 24%, yard starts at 84%.", {})]
for n in (1, 2, 4):
    for h in (12, 24):
        SCENARIOS.append((f"RTG{n}_{h}H", f"{n} RTG out for {h} h", f"{n} of 8 yard cranes (RTG) out of service for {h} h from the start of the night shift.", {"rtg_out": n, "rtg_out_hours": h}))
for n in (1, 2, 3):
    for h in (24, 48):
        SCENARIOS.append((f"QC{n}_{h}H", f"{n} quay crane{'s' if n > 1 else ''} out for {h} h", f"{n} of 10 quay cranes (STS) out of service for {h} h from plan hour 0.", {"qc_out": n, "qc_out_hours": h}))
for r in (0.0, 0.06, 0.12, 0.18, 0.30):
    SCENARIOS.append((f"ICD_{int(round(r * 100)):02d}", f"ICD valve at {int(round(r * 100))}%", f"Off-dock ICD evacuation ratio set to {int(round(r * 100))}% instead of 24%.", {"icd_evacuation_ratio": r}))
for occ in (76, 80, 88, 92):
    SCENARIOS.append((f"YARD_{occ}", f"Yard starts at {occ}%", f"Yard occupancy at the start of the night shift is {occ}% instead of 84%.", {"initial_yard_occupancy_pct": float(occ)}))
for vid, short in ((V1, "V1"), (V3, "V3")):
    for h in (6, 12):
        SCENARIOS.append((f"{short}_LATE_{h}H", f"{short} arrives {h} h late", f"Vessel {vid} arrives {h} h after its ETA.", {"delayed_vessel": vid, "delay_hours": h}))
SCENARIOS.append(("RTG2_24H_ICD_12", "2 RTG out for 24 h with ICD at 12%", "2 yard cranes out for 24 h while the ICD ratio is only 12%.", {"rtg_out": 2, "rtg_out_hours": 24, "icd_evacuation_ratio": 0.12}))
SCENARIOS.append(("QC2_24H_V3_LATE_6H", "2 quay cranes out for 24 h and V3 6 h late", "2 quay cranes out for 24 h while vessel V3 arrives 6 h late.", {"qc_out": 2, "qc_out_hours": 24, "delayed_vessel": V3, "delay_hours": 6}))

if __name__ == "__main__":
    t0 = time.time()
    p._generate_and_parse_baplie("V1_GEARLESS_MEGA", 180)
    p._optimize_3d_yard_and_reefers(True, 45)
    keep = ("vessel_id", "berth_start_m", "berth_end_m", "eta_hr", "berth_start_hr", "cargo_done_hr", "tidal_depart_hr",
            "tide_departure_hold_hrs", "assigned_qcs", "anchorage_wait_hrs", "turnaround_hrs", "draft_m", "virtual_arrival_hfo_saved_tonnes")
    library = []
    for sid, label, desc, params in SCENARIOS:
        res = json.loads(p._simulate_disruption(**params))
        entry = {"id": sid, "label": label, "description": desc, "inputs": params,
                 "convergence_status": res["convergence_status"], "iterations_run": res["iterations_run"], "cuts": res["cuts"]}
        if "kpis" in res:
            entry["kpis"] = res["kpis"]
            entry["schedule"] = [{k: v[k] for k in keep} for v in res["schedule"]]
        library.append(entry)
        print(f"{sid:22s} {res['convergence_status']:10s} {entry.get('kpis', {}).get('avg_turnaround_days')}")
    with open("scenario_library.json", "w") as f:
        json.dump({"sim_replications": 10, "scenarios": library}, f)
    print(f"done in {time.time() - t0:.0f}s  ->  scenario_library.json")
