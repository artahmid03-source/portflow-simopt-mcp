"""Daily control-tower plan for one site, from live data.

    uv run python run_tower.py --site chattogram --store store      # AIS + Open-Meteo tide -> store/chattogram/tower.json
    uv run python run_tower.py --site hamburg --store store         # AIS + Elbe gauge forecast -> store/hamburg/tower.json

The output is what the Control Tower page loads at runtime (docs/tower/<site>.html). It holds the live queue, the
CP-SAT + yard-simulation plan (optimised, FCFS baseline and plan-only), the yard block and reefer runs, and the
reference cases the in-page engine is checked against (node web/validate.mjs --data <file> --write adds the check).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "sites"))
import portflow_mcp as eng  # noqa: E402
import chattogram_nct as nct  # noqa: E402

N_PARCEL = 360


def site_setup(site: str, store: Path, now: Optional[datetime] = None):
    if site == "chattogram":
        import chattogram_live as cl
        live = cl.build_live(store / "chattogram", now, fetch=lambda: cl.fetch_open_meteo(now or datetime.now(timezone.utc)))
        cfg = dict(nct.NCT, daylight_hours=list(live["daylight_hours"]))
        return live, cfg, nct
    if site == "hamburg":
        import hamburg as hh
        return hh.build_live(store, now), dict(hh.HAM), hh
    raise SystemExit(f"unknown site {site}")


def slim(p: Dict[str, Any]) -> Dict[str, Any]:
    return {k: p.get(k) for k in ("kpis", "schedule", "cuts", "iterations_run", "convergence_status", "trace")}


def plan_site(site: str, live: Dict[str, Any], cfg: Dict[str, Any], rules: Any, reps: int = 20) -> Dict[str, Any]:
    """Everything the Control Tower page shows, for one live queue."""
    t0 = time.time()
    H = cfg["horizon_hrs"]
    vs = rules.planning_vessels(live)
    lead = max(live["vessels"], key=lambda v: v["loa_m"])
    run = lambda **kw: nct.run_nct_benders(live, cfg=cfg, rules=rules, **kw)  # noqa: E731

    # stability of the largest ship in the queue, with particulars derived from its dimensions (as run_nct_pipeline.py)
    L, B, T = lead["loa_m"], lead["beam_m"], lead["draught_used_m"]
    eng.KB_M, eng.BM_M = round(0.53 * T, 2), round(0.085 * B * B / T, 2)
    eng.SHIP_BASE_MASS_T, eng.SHIP_BASE_KG_M = round(0.65 * L * B * T * 1.025 - N_PARCEL * 19.0, 0), max(8.4, round(0.3 * B, 1))  # lightship KG ~ 0.6 x depth, depth ~ B / 2
    baplie = json.loads(eng._generate_and_parse_baplie(lead["name"], N_PARCEL))
    eng.YARD_BAYS = cfg["yard_bays"]
    yard_base = json.loads(eng._optimize_3d_yard_and_reefers(False, 0, vessel_id=lead["name"]))
    yard = json.loads(eng._optimize_3d_yard_and_reefers(True, 90, vessel_id=lead["name"]))
    reefer = eng._simulate_reefer_block(cfg["reefer_plugs"], seed=99)

    optimised = run(sim_replications=reps)
    baseline = run(icd_ratio=0.0, fcfs=True, force_max_cranes=True, sim_replications=reps)
    baseline_rule = "arrival order, every crane each ship can take, no off-dock evacuation"
    if not baseline.get("kpis"):                      # strict FCFS with all cranes may not fit the horizon on a tight tide
        baseline = run(icd_ratio=0.0, fcfs=True, sim_replications=reps)
        baseline_rule = "arrival order, no off-dock evacuation (with every crane forced, no plan fits the horizon)"
    if not baseline.get("kpis"):
        baseline = dict(optimised)
        baseline_rule = "no first-come-first-served plan fits the horizon; the optimised plan is shown in its place"
    plan_only = run(icd_ratio=0.0, sim_replications=reps)
    tug = {k: run(pilot_tug_sets=k, sim_replications=10).get("kpis") for k in (1, 2, 3)} if site == "chattogram" else {}

    first = next((v for v in sorted(vs, key=lambda x: x["eta"]) if v["eta"] > 0), vs[0])
    big_pool = max((cfg.get("crane_pools") or {"all": cfg["qgc_total"]}).items(), key=lambda kv: kv[1])[0]
    cases = [("nominal", {}), (f"{first['id']} 6 h late", {"eta_shift_hrs": {first["id"]: 6}}),
             ("6 quay cranes out 48 h", {"qgc_outages": [[0, 48, 6] + ([big_pool] if cfg.get("crane_pools") else [])]}),
             ("3 yard cranes out 24 h", {"rtg_outages": [[0.0, 1440.0]] * 3}), ("evacuation 10%", {"icd_ratio": 0.10}),
             ("evacuation 0%", {"icd_ratio": 0.0}), ("yard starts 86%", {"initial_yard_occupancy_pct": 86.0})]
    if site == "chattogram":
        cases.append(("one pilot/tug set", {"pilot_tug_sets": 1}))
    reference = []
    for name, kw in cases:
        r = run(sim_replications=10, **kw)
        reference.append({"case": name, "inputs": kw, "status": r["convergence_status"], "cuts": r["cuts"], "kpis": r.get("kpis")})

    draught_check = []
    if site == "chattogram":
        tide = nct.tide_curve(live, H)
        for v in vs:
            src = next(x for x in live["vessels"] if x["name"] == v["id"])
            rep = src["draught_reported_m"]
            w_plan = rules.gate_windows(live, tide, v, H, cfg["transit_hrs"])[0]
            w_rep = rules.gate_windows(live, tide, dict(v, draft=min(rep, 99.0)), H, cfg["transit_hrs"])[0] if rep is not None else None
            draught_check.append({"vessel": v["id"], "reported_m": rep, "planned_m": v["draft"], "inbound_starts_planned": len(w_plan),
                                  "first_start_planned": w_plan[0] if w_plan else None, "inbound_starts_reported": None if w_rep is None else len(w_rep),
                                  "first_start_reported": (w_rep[0] if w_rep else None) if w_rep is not None else None})

    payload: Dict[str, Any] = {
        "status": "ok" if optimised.get("schedule") else "no_plan", "site_kind": site, "engine_version": "6.3",
        "site": "Chattogram NCT" if site == "chattogram" else "Port of Hamburg container terminals",
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "config": {k: (list(v) if isinstance(v, tuple) else v) for k, v in cfg.items()}, "live": live, "tide_hourly": nct.tide_curve(live, H),
        "hydrostatics": {"vessel_id": baplie["vessel_id"], "containers_parsed": baplie["containers_parsed"], "total_mass_tonnes": baplie["total_mass_tonnes"],
                         "displacement_tonnes": baplie["displacement_tonnes"], **baplie["hydrostatics"]},
        "yard": {k: v for k, v in yard.items() if k not in ("yard_tensor_after", "reefer_rc_thermodynamics")},
        "yard_baseline": {k: v for k, v in yard_base.items() if not k.startswith("yard_") and k not in ("premarshal_moves", "reefer_rc_thermodynamics")},
        "reefer": reefer, "baseline": slim(baseline), "plan_only": {"kpis": plan_only.get("kpis")}, "optimised": slim(optimised),
        "pilot_tug_sensitivity": tug, "draught_check": draught_check, "reference_cases": reference, "baseline_rule": baseline_rule,
        "runtime_s": None,
    }
    if site == "hamburg":
        payload["gates"] = rules.gates_bitmap(live, H, cfg["transit_hrs"])
    payload["runtime_s"] = round(time.time() - t0, 1)
    return payload


def empty_payload(site: str, live: Dict[str, Any], why: str) -> Dict[str, Any]:
    return {"status": "no_queue", "site_kind": site, "reason": why, "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "live": {k: live.get(k) for k in ("port", "retrieved", "plan_epoch_local", "what_is_live", "what_is_not_live", "excluded", "fixed_occupants")}}


def summary(p: Dict[str, Any]) -> str:
    if p["status"] != "ok":
        return f"### {p['site_kind'].title()} tower: {p['status']} ({p.get('reason', '')})\n"
    k, b, lv = p["optimised"]["kpis"], p["baseline"]["kpis"], p["live"]
    rows = [f"### {p['site']} control tower, plan from {lv['plan_epoch_local'][:16]}", "",
            f"{len(lv['vessels'])} ships planned, {len(lv.get('fixed_occupants', []))} alongside at the start, {len(lv.get('excluded', []))} left out. Runtime {p['runtime_s']} s.", "",
            "| | FCFS baseline | Optimised |", "|---|---:|---:|",
            f"| Average turnaround, days | {b and b['avg_turnaround_days']} | {k['avg_turnaround_days']} |",
            f"| Waiting before the passage, h | {b and b['total_anchorage_wait_hrs']} | {k['total_anchorage_wait_hrs']} |",
            f"| Held for tide, h | {b and b['total_tide_hold_hrs']} | {k['total_tide_hold_hrs']} |",
            f"| Peak yard occupancy, % | {b and b['peak_yard_occupancy_pct']} | {k['peak_yard_occupancy_pct']} |", "",
            "| Ship | Berth | Alongside h | Sails h | Cranes |", "|---|---|---:|---:|---:|"]
    rows += [f"| {r['vessel_id']} | {r.get('quay', 'NCT')} {r['berth_start_m']} m | {r['berth_start_hr']} | {r['tidal_depart_hr']} | {r['assigned_qcs']} |" for r in p["optimised"]["schedule"]]
    return "\n".join(rows) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", required=True, choices=["chattogram", "hamburg"])
    ap.add_argument("--store", default="store")
    ap.add_argument("--out", default=None, help="default: <store>/<site>/tower.json")
    ap.add_argument("--reps", type=int, default=20)
    a = ap.parse_args()
    store = Path(a.store)
    out = Path(a.out) if a.out else store / a.site / "tower.json"
    live, cfg, rules = site_setup(a.site, store)
    if len(live["vessels"]) == 0:
        p = empty_payload(a.site, live, "no ship in the live queue")
    else:
        p = plan_site(a.site, live, cfg, rules, a.reps)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(p, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    md = summary(p)
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
