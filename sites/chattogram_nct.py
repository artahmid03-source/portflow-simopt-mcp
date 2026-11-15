"""
PortFlow site model: New Mooring Container Terminal (NCT), Chattogram Port.

Adds to the generic engine (portflow_mcp.py):
  * a real vessel queue and real tide predictions read from data/live_*.json,
  * the Karnaphuli navigation rules: tide-dependent draught, daylight-only
    transits for large or deep ships, and
  * v6-NEW: a limited number of pilot-and-tug sets on the river transit,
    modelled as a cumulative resource in CP-SAT.

What is real and what is assumed is spelled out in NCT below and in the data
file. Site figures marked USER are the project owner's specification; where a
public source read on 13 Nov 2026 disagrees, the source value is in the comment.
"""
import json
import math
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from ortools.sat.python import cp_model

import portflow_mcp as eng

ROOT = Path(__file__).resolve().parent.parent
LIVE_FILE = Path(os.environ.get("PORTFLOW_LIVE_FILE", ROOT / "data" / "live_chattogram_2026-11-13.json"))

NCT: Dict[str, Any] = {
    "quay_ocean_m": 820,              # USER: 4 ocean berths on 820 m of a 1,000 m quay (operator page: 1,000 m, 5 berths)
    "quay_barge_m": 180,              # USER: one inland/barge berth (operator page calls NCT-1 the Pangaon berth)
    "berth_gap_m": 20,
    "qgc_total": 14,                  # USER (operator page: 10 QGC + 1 mobile harbour crane)
    "qgc_gmph": 18.5,                 # USER; no public source found
    "rtg_total": 28,                  # USER (operator page: 23 RTG, 12 straddle carriers)
    "rtg_per_berth_cluster": 7,       # 28 RTG over 4 ocean berths
    "yard_blocks": 14, "yard_bays": 40, "yard_rows": 6, "yard_tiers": 5,
    "yard_cluster_teu": 4200.0,       # 3.5 blocks x 1,200 slots behind each ocean berth (USER's 28,000 TEU total does not match 14 x 1,200)
    "reefer_plugs": 400,              # USER (operator page: 700)
    "icd_ratio": 0.33,                # USER; no public source found for the share
    "initial_yard_occupancy_pct": 78.0,   # ASSUMPTION: live yard inventory is not published
    "max_loa_m": 200.0,               # USER (operator page and port agent blog: 186 m by day)
    "max_draught_m": 9.5,             # USER and operator page: standard draught limit
    "spring_max_draught_m": 10.0,     # USER: up to 10.0 m on spring high tides
    "spring_tide_min_m": 3.0,         # ASSUMPTION: an hour counts as a spring high when the predicted tide is >= 3.0 m above MLLW
    "night_max_loa_m": 170.0,         # USER range 153-170 m (operator page: 175 m)
    "night_max_draught_m": 9.0,       # both
    "daylight_hours": (6, 17),        # sunrise 06:05, sunset 17:09 -> transit hours 06:00-16:59
    "channel_depth_m": 7.5,           # ASSUMPTION: controlling depth below tide datum on the river bar
    "ukc_m": 0.6,                     # ASSUMPTION: under-keel clearance
    "transit_hrs": 2,                 # ASSUMPTION: outer bar to berth along the river
    "pilot_tug_sets": 2,              # ASSUMPTION: simultaneous river transits the pilots and tugs can serve
    "horizon_hrs": 192,
    "ref_boxes_per_hr": 48.0,         # discharge rate the DES yard cluster treats as intensity 1.0
}


# ----------------------------------------------------------------------------
# Live data, tide curve and navigation gates
# ----------------------------------------------------------------------------
def load_live(path: Path = LIVE_FILE) -> Dict[str, Any]:
    return json.loads(Path(path).read_text())


def tide_curve(live: Dict[str, Any], horizon_hrs: int) -> List[float]:
    """Hourly tide height (m above datum) from the predicted highs and lows,
    joined by half-cosine segments, the standard harmonic interpolation.
    A live file may instead carry an hourly series from the plan epoch ("tide_hourly_m"), which is used as is."""
    if live.get("tide_hourly_m"):
        hz = [float(x) for x in live["tide_hourly_m"]]
        return (hz + [hz[-1]] * (horizon_hrs + 3))[:horizon_hrs + 3]
    epoch = datetime.fromisoformat(live["plan_epoch_local"][:19])
    pts = [((datetime.fromisoformat(t) - epoch).total_seconds() / 3600.0, h) for t, _, h in live["tides"]]
    out = []
    for hr in range(horizon_hrs + 3):
        x = hr + 0.5                                    # mid-hour
        prev = max((p for p in pts if p[0] <= x), default=pts[0])
        nxt = min((p for p in pts if p[0] > x), default=pts[-1])
        if nxt[0] == prev[0]:
            out.append(prev[1])
            continue
        f = (x - prev[0]) / (nxt[0] - prev[0])
        out.append(round(prev[1] + (nxt[1] - prev[1]) * (1.0 - math.cos(math.pi * f)) / 2.0, 3))
    return out


def clock_hour(live: Dict[str, Any], hr: int) -> int:
    epoch = datetime.fromisoformat(live["plan_epoch_local"][:19])
    return (epoch + timedelta(hours=hr)).hour


def transit_ok(live: Dict[str, Any], tide: List[float], hr: int, loa: float, draught: float) -> bool:
    """May a ship of this size be in the river during plan hour `hr`?"""
    if hr < 0 or hr >= len(tide):
        return False
    if loa > NCT["max_loa_m"] or draught > NCT["spring_max_draught_m"]:
        return False
    need = draught + NCT["ukc_m"] - NCT["channel_depth_m"] + float(live.get("tide_margin_m", 0.0))   # margin: tide forecast error
    if tide[hr] < need:
        return False
    if draught > NCT["max_draught_m"] and tide[hr] < NCT["spring_tide_min_m"]:
        return False                                   # 9.5-10.0 m only on a spring high
    d0, d1 = live.get("daylight_hours") or NCT["daylight_hours"]    # a live file may carry the day's sunrise and sunset hours
    if d0 <= clock_hour(live, hr) < d1:
        return True
    return loa <= NCT["night_max_loa_m"] and draught <= NCT["night_max_draught_m"]


def planning_vessels(live: Dict[str, Any], eta_shift_hrs: Optional[Dict[str, int]] = None) -> List[Dict[str, Any]]:
    out = []
    for v in live["vessels"]:
        teu = float(v["teu_est"]) if v.get("teu_est") else v["dwt_t"] / 14.0
        out.append({
            "id": v["name"], "imo": v["imo"], "len": int(math.ceil(v["loa_m"])), "loa": v["loa_m"],
            "draft": v["draught_used_m"], "eta": int(v["eta_hr"]) + int((eta_shift_hrs or {}).get(v["name"], 0)),
            "moves": int(v["moves_est"]) if v.get("moves_est") else int(round(0.85 * teu)), "teu_est": int(round(teu)),
            "min_qc": 1, "max_qc": int(v.get("max_qc") or (3 if v["loa_m"] >= 160 else 2)), "geared": False,
        })
    return out


def gate_windows(live: Dict[str, Any], tide: List[float], v: Dict[str, Any], H: int, T: int) -> Any:
    """Hours a ship may come alongside (its inbound transit ends then) and hours it may cast off (outbound transit starts)."""
    ok_in = [h for h in range(v["eta"] + T, H - 30) if all(transit_ok(live, tide, h - k, v["loa"], v["draft"]) for k in range(1, T + 1))]
    ok_out = [h for h in range(v["eta"] + T + 1, H - T) if all(transit_ok(live, tide, h + k, v["loa"], v["draft"]) for k in range(T))]
    return ok_in, ok_out


def tide_needed(v: Dict[str, Any]) -> float:
    return round(max(0.0, v["draft"] + NCT["ukc_m"] - NCT["channel_depth_m"]), 2)


def night_restricted(v: Dict[str, Any]) -> bool:
    return bool(v["loa"] > NCT["night_max_loa_m"] or v["draft"] > NCT["night_max_draught_m"])


# ----------------------------------------------------------------------------
# CP-SAT berth plan for NCT
# ----------------------------------------------------------------------------
def solve_nct_plan(
    live: Dict[str, Any], mode_beta: Optional[Dict[str, float]] = None,
    force_qcs: Optional[Dict[str, int]] = None, fcfs: bool = False,
    qgc_outages: Optional[List[List[int]]] = None, eta_shift_hrs: Optional[Dict[str, int]] = None,
    pilot_tug_sets: Optional[int] = None, scalar_beta: float = 1.0,
    cfg: Optional[Dict[str, Any]] = None, rules: Any = None
) -> Dict[str, Any]:
    """cfg and rules default to NCT and this module. Another site passes its own configuration and a module with
    planning_vessels, gate_windows, tide_needed and night_restricted (see sites/hamburg.py). Vessels may carry
    quay_ranges (the quay segments, on one axis, they may lie on) and pool (the crane pool they draw from)."""
    cfg = cfg or NCT
    rules = rules or sys.modules[__name__]
    H, Q, gap, T = cfg["horizon_hrs"], cfg["quay_ocean_m"], cfg["berth_gap_m"], cfg["transit_hrs"]
    K = cfg["pilot_tug_sets"] if pilot_tug_sets is None else int(pilot_tug_sets)
    pools = cfg.get("crane_pools") or {"all": cfg["qgc_total"]}
    tide = tide_curve(live, H)
    vessels = rules.planning_vessels(live, eta_shift_hrs)
    model = cp_model.CpModel()
    xs, ys, transits, vv, obj = [], [], [], {}, []

    def beta_for(q: int) -> float:
        return scalar_beta if mode_beta is None else mode_beta.get(eng.mode_key(q, False), 1.0)

    # ships already alongside: a fixed rectangle in quay-time and one outbound transit
    for i, occ in enumerate(live.get("fixed_occupants", [])):
        ln, rel = int(math.ceil(occ["loa_m"])) + gap, int(occ["release_hr"])
        xs.append(model.NewIntervalVar(int(occ["berth_start_m"]), ln, int(occ["berth_start_m"]) + ln, f"fx_{i}"))
        ys.append(model.NewIntervalVar(0, rel, rel, f"fy_{i}"))
        transits.append(model.NewIntervalVar(rel, T, rel + T, f"ft_{i}"))

    for v in vessels:
        vid = v["id"].replace(" ", "_")
        ok_in, ok_out = rules.gate_windows(live, tide, v, H, T)
        if not ok_in or not ok_out:
            return {"feasible": False, "solver_status": "NO_TIDAL_WINDOW", "blocked_vessel": v["id"], "schedule": []}
        t_start = model.NewIntVarFromDomain(cp_model.Domain.FromValues(ok_in), f"ts_{vid}")
        t_depart = model.NewIntVarFromDomain(cp_model.Domain.FromValues(ok_out), f"td_{vid}")
        spans = [[int(a), int(b) - v["len"]] for a, b in (v.get("quay_ranges") or [[0, Q]]) if int(b) - int(a) >= v["len"]]
        if not spans:
            return {"feasible": False, "solver_status": "QUAY_TOO_SHORT", "blocked_vessel": v["id"], "schedule": []}
        b_start = model.NewIntVarFromDomain(cp_model.Domain.FromIntervals(spans), f"b_{vid}")
        size = v["len"] + gap
        b_end = model.NewIntVar(0, Q + gap, f"be_{vid}")
        model.Add(b_end == b_start + size)
        dur = model.NewIntVar(1, H, f"dur_{vid}")
        t_done = model.NewIntVar(0, H, f"done_{vid}")
        model.Add(t_done == t_start + dur)
        model.Add(t_depart >= t_done)
        occ = model.NewIntVar(1, H, f"occ_{vid}")
        model.Add(occ == t_depart - t_start)
        qc = model.NewIntVar(v["min_qc"], v["max_qc"], f"qc_{vid}")
        modes = []
        for q in range(v["min_qc"], v["max_qc"] + 1):
            z = model.NewBoolVar(f"z_{vid}_{q}")
            rate = cfg["qgc_gmph"] / max(beta_for(q), 0.5) * eng.crane_effect(q, False)
            model.Add(dur == int(math.ceil(v["moves"] / rate))).OnlyEnforceIf(z)
            model.Add(qc == q).OnlyEnforceIf(z)
            modes.append(z)
        model.AddExactlyOne(modes)
        if force_qcs and v["id"] in force_qcs:
            model.Add(qc == int(force_qcs[v["id"]]))
        xs.append(model.NewIntervalVar(b_start, size, b_end, f"xi_{vid}"))
        ys.append(model.NewIntervalVar(t_start, occ, t_depart, f"yi_{vid}"))
        # v6-NEW: each river transit holds one pilot-and-tug set for T hours
        t_in = model.NewIntVar(0, H, f"tin_{vid}")
        model.Add(t_in == t_start - T)
        t_out_end = model.NewIntVar(0, H + T, f"tout_{vid}")
        model.Add(t_out_end == t_depart + T)
        transits.append(model.NewIntervalVar(t_in, T, t_start, f"in_{vid}"))
        transits.append(model.NewIntervalVar(t_depart, T, t_out_end, f"out_{vid}"))
        wait = model.NewIntVar(0, H, f"w_{vid}")
        model.Add(wait == t_start - T - v["eta"])
        hold = model.NewIntVar(0, H, f"h_{vid}")
        model.Add(hold == t_depart - t_done)
        obj.append(18 * wait + 6 * occ)
        vv[v["id"]] = dict(v=v, b=b_start, ts=t_start, done=t_done, td=t_depart, qc=qc, wait=wait, hold=hold)

    model.AddNoOverlap2D(xs, ys)
    model.AddCumulative(transits, [1] * len(transits), K)
    if fcfs:                                   # baseline rule: berth strictly in order of arrival
        order = sorted(vessels, key=lambda x: (x["eta"], x["id"]))
        for a, b in zip(order, order[1:]):
            model.Add(vv[a["id"]]["ts"] <= vv[b["id"]]["ts"])
    for h in range(H):
        terms: Dict[str, List[Any]] = {p: [] for p in pools}
        for vid, d in vv.items():
            act = model.NewBoolVar(f"a_{vid}_{h}".replace(" ", "_"))
            st = model.NewBoolVar(f"s_{vid}_{h}".replace(" ", "_"))
            nd = model.NewBoolVar(f"n_{vid}_{h}".replace(" ", "_"))
            model.Add(d["ts"] <= h).OnlyEnforceIf(st)
            model.Add(d["ts"] > h).OnlyEnforceIf(st.Not())
            model.Add(d["done"] > h).OnlyEnforceIf(nd)
            model.Add(d["done"] <= h).OnlyEnforceIf(nd.Not())
            model.AddBoolAnd([st, nd]).OnlyEnforceIf(act)
            model.AddBoolOr([st.Not(), nd.Not()]).OnlyEnforceIf(act.Not())
            qh = model.NewIntVar(0, d["v"]["max_qc"], f"q_{vid}_{h}".replace(" ", "_"))
            model.Add(qh == d["qc"]).OnlyEnforceIf(act)
            model.Add(qh == 0).OnlyEnforceIf(act.Not())
            terms[d["v"].get("pool", next(iter(pools)))].append(qh)
        for p, cap in pools.items():               # an outage [start, end, count] hits the first pool unless it names one: [start, end, count, pool]
            down = sum(int(o[2]) for o in (qgc_outages or []) if o[0] <= h < o[1] and (o[3] if len(o) > 3 else next(iter(pools))) == p)
            if terms[p]:
                model.Add(sum(terms[p]) <= max(0, int(cap) - down))

    model.Minimize(sum(obj))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60.0
    solver.parameters.num_workers = eng.CPSAT_WORKERS
    solver.parameters.random_seed = 7
    status = solver.Solve(model)
    ok = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    sched = []
    if ok:
        for vid, d in vv.items():
            v = d["v"]
            st, dn, dp, q = (solver.Value(d[k]) for k in ("ts", "done", "td", "qc"))
            sched.append({
                "vessel_id": vid, "imo": v["imo"], "loa_m": v["loa"], "draft_m": v["draft"], "moves": v["moves"],
                "berth_start_m": solver.Value(d["b"]), "berth_end_m": solver.Value(d["b"]) + v["len"],
                "eta_hr": v["eta"], "transit_in_hr": st - T, "berth_start_hr": st, "cargo_done_hr": dn, "tidal_depart_hr": dp,
                "tide_departure_hold_hrs": solver.Value(d["hold"]), "assigned_qcs": q,
                "crane_intensity": eng.mode_key(q, False), "anchorage_wait_hrs": solver.Value(d["wait"]),
                "turnaround_hrs": dp + T - v["eta"],
                "night_restricted": rules.night_restricted(v), "tide_needed_m": rules.tide_needed(v),
                **({"quay": v["quay"], "pool": v.get("pool")} if v.get("quay") else {}),
                "virtual_arrival_hfo_saved_tonnes": round(solver.Value(d["wait"]) * 1.85, 1)
            })
        sched.sort(key=lambda r: r["berth_start_hr"])
    n = len(vessels)
    return {
        "feasible": ok, "solver_status": solver.StatusName(status),
        "objective_value": solver.ObjectiveValue() if ok else None, "lower_bound": solver.BestObjectiveBound() if ok else None,
        "avg_turnaround_days": round(sum(r["turnaround_hrs"] for r in sched) / n / 24.0, 2) if ok else None,
        "total_anchorage_wait_hrs": sum(r["anchorage_wait_hrs"] for r in sched) if ok else None,
        "total_tide_hold_hrs": sum(r["tide_departure_hold_hrs"] for r in sched) if ok else None,
        "schedule": sched
    }


# ----------------------------------------------------------------------------
# Two-way Benders loop for NCT
# ----------------------------------------------------------------------------
def _intensity(key: str, cfg: Optional[Dict[str, Any]] = None) -> float:
    cfg = cfg or NCT
    return cfg["qgc_gmph"] * float(key) / cfg["ref_boxes_per_hr"]


def _yard_sim(key: str, occ: float, icd: float, reps: int, rtg_out: Optional[List[List[float]]] = None, cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or NCT
    return eng._simulate_replicated(reps, occ, icd, 0.14, rtg_outages=rtg_out, qc_intensity=_intensity(key, cfg),
                                    rtg_fleet=cfg["rtg_per_berth_cluster"], yard_cap_teu=cfg["yard_cluster_teu"])


def run_nct_benders(
    live: Optional[Dict[str, Any]] = None, icd_ratio: Optional[float] = None,
    initial_yard_occupancy_pct: Optional[float] = None, sim_replications: int = 20, fcfs: bool = False,
    force_max_cranes: bool = False, rtg_outages: Optional[List[List[float]]] = None,
    qgc_outages: Optional[List[List[int]]] = None, eta_shift_hrs: Optional[Dict[str, int]] = None,
    pilot_tug_sets: Optional[int] = None, max_iterations: int = 8,
    cfg: Optional[Dict[str, Any]] = None, rules: Any = None
) -> Dict[str, Any]:
    live = live or load_live()
    cfg = cfg or NCT
    rules = rules or sys.modules[__name__]
    icd = cfg["icd_ratio"] if icd_ratio is None else float(icd_ratio)
    occ = cfg["initial_yard_occupancy_pct"] if initial_yard_occupancy_pct is None else float(initial_yard_occupancy_pct)
    saved = (eng.PORT_STATE["last_simpy_metrics"], eng.PORT_STATE["last_seaside_schedule"])
    cuts: Dict[str, float] = {}
    sims: Dict[str, Dict[str, Any]] = {}
    force = {v["id"]: v["max_qc"] for v in rules.planning_vessels(live)} if force_max_cranes else None
    trace, sea, converged = [], None, False
    for it in range(1, max_iterations + 1):
        sea = solve_nct_plan(live, mode_beta=cuts, force_qcs=force, fcfs=fcfs, qgc_outages=qgc_outages,
                             eta_shift_hrs=eta_shift_hrs, pilot_tug_sets=pilot_tug_sets, cfg=cfg, rules=rules)
        if not sea["feasible"]:
            break
        new = sorted({r["crane_intensity"] for r in sea["schedule"]} - set(cuts))
        row = {"iteration": it, "master_objective": sea["objective_value"], "avg_turnaround_days": sea["avg_turnaround_days"],
               "cranes": {r["vessel_id"]: r["assigned_qcs"] for r in sea["schedule"]}, "cuts_added": {}}
        for k in new:
            sims[k] = _yard_sim(k, occ, icd, sim_replications, rtg_outages, cfg)
            cuts[k] = sims[k]["computed_cpsat_backpressure_beta"]
            row["cuts_added"][k] = cuts[k]
        trace.append(row)
        if not new:
            converged = True
            break
    eng.PORT_STATE["last_simpy_metrics"], eng.PORT_STATE["last_seaside_schedule"] = saved
    out: Dict[str, Any] = {
        "inputs": {"icd_ratio": icd, "initial_yard_occupancy_pct": occ, "fcfs": fcfs, "force_max_cranes": force_max_cranes,
                   "rtg_outages": rtg_outages or [], "qgc_outages": qgc_outages or [], "eta_shift_hrs": eta_shift_hrs or {},
                   "pilot_tug_sets": cfg["pilot_tug_sets"] if pilot_tug_sets is None else pilot_tug_sets},
        "convergence_status": "CONVERGED" if converged else (sea.get("solver_status", "INFEASIBLE") if sea and not sea["feasible"] else "MAX_ITERATIONS"),
        "iterations_run": len(trace), "cuts": dict(sorted(cuts.items())), "trace": trace
    }
    if sea and sea["feasible"]:
        worst = max((r["crane_intensity"] for r in sea["schedule"]), key=float)
        y = sims[worst]
        out["kpis"] = {
            "objective": sea["objective_value"], "avg_turnaround_days": sea["avg_turnaround_days"],
            "total_anchorage_wait_hrs": sea["total_anchorage_wait_hrs"], "total_tide_hold_hrs": sea["total_tide_hold_hrs"],
            "cpsat_status": sea["solver_status"], "backpressure_beta_max": max(cuts[r["crane_intensity"]] for r in sea["schedule"]),
            "wave_start_yard_occupancy_pct": y["wave_start_yard_occupancy_pct"], "peak_yard_occupancy_pct": y["peak_yard_occupancy_pct"],
            "avg_gate_truck_wait_mins": y["avg_gate_truck_wait_mins"], "avg_rtg_wait_mins": y["avg_rtg_handshake_wait_mins"],
            "unproductive_rehandle_hrs": y["unproductive_rehandle_crane_hrs"], "icd_evacuated_containers": y["icd_evacuated_containers"],
            "hfo_proxy_tonnes": round(sum(r["virtual_arrival_hfo_saved_tonnes"] for r in sea["schedule"]), 1)
        }
        out["schedule"] = sea["schedule"]
    return out


# ----------------------------------------------------------------------------
# MCP tools for the site
# ----------------------------------------------------------------------------
@eng.mcp.tool()
def nct_live_queue() -> str:
    """The vessel queue and tide table the NCT model plans against, with the source and retrieval date of every field."""
    return json.dumps(load_live(), indent=2)


@eng.mcp.tool()
def nct_plan_live_queue(icd_ratio: float = 0.33, initial_yard_occupancy_pct: float = 78.0, pilot_tug_sets: int = 2) -> str:
    """Plans the live NCT queue: CP-SAT berth plan under Karnaphuli tide, daylight and pilot/tug rules, coupled to the yard DES by Benders cuts."""
    return json.dumps(run_nct_benders(icd_ratio=icd_ratio, initial_yard_occupancy_pct=initial_yard_occupancy_pct, pilot_tug_sets=pilot_tug_sets), indent=2)


@eng.mcp.tool()
def nct_simulate_disruption(delayed_vessel: Optional[str] = None, delay_hours: int = 0, qgc_out: int = 0, qgc_out_hours: int = 0,
                            rtg_out: int = 0, rtg_out_hours: float = 0.0, icd_ratio: float = 0.33,
                            initial_yard_occupancy_pct: float = 78.0, pilot_tug_sets: int = 2) -> str:
    """Re-plans the live NCT queue under a disruption: a late vessel, quay or yard cranes out, a different ICD ratio, yard level or pilot/tug availability."""
    return json.dumps(run_nct_benders(
        icd_ratio=icd_ratio, initial_yard_occupancy_pct=initial_yard_occupancy_pct, sim_replications=10,
        rtg_outages=[[0.0, rtg_out_hours * 60.0] for _ in range(int(rtg_out))] if rtg_out and rtg_out_hours else None,
        qgc_outages=[[0, int(qgc_out_hours), int(qgc_out)]] if qgc_out and qgc_out_hours else None,
        eta_shift_hrs={delayed_vessel: int(delay_hours)} if delayed_vessel and delay_hours else None,
        pilot_tug_sets=pilot_tug_sets), indent=2)


if __name__ == "__main__":
    eng.mcp.run()
