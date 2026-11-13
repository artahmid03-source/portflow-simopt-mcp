"""Runs the PortFlow v5.0 tool chain end to end and writes control_tower_data.json,
the payload the Control Tower dashboard reads.  Usage:  python run_pipeline.py"""
import json
import time

import portflow_mcp as p

t0 = time.time()
baplie = json.loads(p._generate_and_parse_baplie("V1_GEARLESS_MEGA", 180))
yard = json.loads(p._optimize_3d_yard_and_reefers(enable_weibull_stacking=True, max_night_premarshal_moves=45))
loop = json.loads(p._run_closed_loop_simopt_benders(max_iterations=4))
schedule_beta = p.PORT_STATE["last_seaside_schedule"]["yard_backpressure_input"]
maint = json.loads(p._optimize_rtg_predictive_maintenance())
maint_proxy = json.loads(p._optimize_rtg_predictive_maintenance(use_des_utilisation=False))
wind = json.loads(p._optimize_wind_aware_berth_plan(yard_backpressure_factor=schedule_beta))
# one logged DES replication for the HMI ticker (seed 2026, optimised scenario)
logged = json.loads(p._run_simpy_terminal_simulation(84.0, 0.24, 0.14, seed=2026, log_events=True))["event_log"]
night = [e for e in logged if e[0] < 360.0]
ticker = [e for e in night if e[1] == "PREMARSHAL"][:12] + [e for e in night if e[1] == "ICD_LIFT"][:48]
ticker += [e for e in logged if e[0] >= 360.0][:240]
ticker.sort(key=lambda e: e[0])
# v5.0: two-way coupling by simulation-generated Benders cuts, at three levels of yard relief
benders = {f"ICD_{int(round(r * 100)):02d}": json.loads(p._run_logic_benders_simopt(icd_evacuation_ratio=r)) for r in (0.24, 0.12, 0.0)}
for b in benders.values():
    b["plan"].pop("schedule", None)
sweep = json.loads(p._sweep_icd_evacuation_valve())
stress = json.loads(p._run_closed_loop_simopt_benders(max_iterations=8, icd_evacuation_ratio=0.12))
# ablation: yard decongested but single-cycling cranes
ablation = json.loads(p._solve_seaside_berth_and_cranes(enable_dual_cycling=False, yard_backpressure_factor=1.0))

payload = {
    "engine_version": "5.0",
    "hydrostatics": {"vessel_id": baplie["vessel_id"], "containers_parsed": baplie["containers_parsed"],
                     "total_mass_tonnes": baplie["total_mass_tonnes"], "displacement_tonnes": baplie["displacement_tonnes"],
                     **baplie["hydrostatics"]},
    "yard": {k: v for k, v in yard.items() if k != "reefer_rc_thermodynamics"},
    "reefer": yard["reefer_rc_thermodynamics"],
    "convergence_status": loop["convergence_status"], "iterations_run": loop["iterations_run"],
    "tolerance": loop["tolerance"], "sim_replications": loop["sim_replications"], "scenario": loop["scenario"],
    "baseline_unoptimized_kpis": loop["baseline_unoptimized_kpis"],
    "simopt_converged_kpis": loop["simopt_converged_kpis"],
    "convergence_trace": loop["convergence_trace"],
    "final_vessel_schedule": loop["final_vessel_schedule"],
    "ablation_no_dual_cycling": {"avg_turnaround_days": ablation["avg_turnaround_days"],
                                 "total_anchorage_wait_hrs": ablation["total_anchorage_wait_hrs"]},
    "icd_sweep": sweep,
    "stress_case": {"scenario": stress["scenario"], "convergence_status": stress["convergence_status"],
                    "iterations_run": stress["iterations_run"], "convergence_trace": stress["convergence_trace"],
                    "kpis": stress["simopt_converged_kpis"]},
    "maintenance": maint,
    "wind": wind,
    "benders": benders,
    "event_log": {"source": "SimPy replication, seed 2026, optimised scenario", "events_total": len(logged), "events": ticker},
    "maintenance_static_proxy_ablation": {
        "pm_windows": maint_proxy["policies"]["GAMMA_CBM_CPSAT"]["pm_windows"],
        "des_gate_truck_wait_mins": maint_proxy["policies"]["GAMMA_CBM_CPSAT"]["des_gate_truck_wait_mins"],
        "des_gate_truck_wait_ci95": maint_proxy["policies"]["GAMMA_CBM_CPSAT"]["des_gate_truck_wait_ci95"],
        "expected_cost_usd": maint_proxy["policies"]["GAMMA_CBM_CPSAT"]["expected_cost_usd"],
    },
}
with open("control_tower_data.json", "w") as f:
    json.dump(payload, f)
with open("tool_outputs_raw.json", "w") as f:
    json.dump({"generate_and_parse_baplie": baplie, "optimize_3d_yard_and_reefers": yard,
               "run_closed_loop_simopt_benders": loop, "optimize_rtg_predictive_maintenance": maint,
               "sweep_icd_evacuation_valve": sweep,
               "optimize_wind_aware_berth_plan": wind, "run_logic_benders_simopt": benders}, f, indent=1)
print(f"done in {time.time() - t0:.0f}s  ->  control_tower_data.json")
