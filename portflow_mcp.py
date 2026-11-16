"""
PortFlow-SimOpt-MCP v6.0
========================
Maritime terminal digital twin: CP-SAT berth/crane scheduling, a 3D yard tensor,
a reefer RC thermal model, a SimPy discrete-event yard simulation, Gamma-process
RTG prognostics with CP-SAT maintenance windows (v3.0), wind-aware berth
planning with time-dependent crane productivity (v4.0) and two-way coupling of
plan and yard through simulation-generated Benders cuts (v5.0).

Pure software: every input is a data feed (stowage message, vessel calls, a wind
forecast ensemble, inspection logs). Nothing here needs a sensor, PLC or
hardware in the loop.

All scenario data are SYNTHETIC. Parameters marked [ASSUMPTION] are plausible
engineering values chosen for the case study, not measurements from a terminal.

Changes against v2.0 are tagged in-line as  # v3-FIX n  (defect corrections) and
# v3-NEW / v4-NEW (the upgrades).  See CHANGELOG.md for the rationale of each.
"""
import json
import os
import math
import zlib
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import simpy
from fastmcp import FastMCP
from ortools.sat.python import cp_model
from scipy.special import gammaincc
from scipy.stats import gamma as gamma_dist
from scipy.stats import weibull_min

mcp = FastMCP("PortFlow-SimOpt-Engine-v6")

PORT_STATE: Dict[str, Any] = {
    "baplie_manifests": {},
    "vessels": [
        {"id": "V1_GEARLESS_MEGA", "len": 260, "eta": 2,  "moves": 1350, "draft": 9.6, "geared": False, "min_qc": 2, "max_qc": 4, "pref_berth": 120},
        {"id": "V2_GEARED_FEEDER", "len": 170, "eta": 4,  "moves": 800,  "draft": 8.4, "geared": True,  "min_qc": 1, "max_qc": 3, "pref_berth": 450},
        {"id": "V3_GEARLESS_MAIN", "len": 240, "eta": 6,  "moves": 1200, "draft": 9.5, "geared": False, "min_qc": 2, "max_qc": 4, "pref_berth": 680},
        {"id": "V4_REEFER_EXPRESS", "len": 195, "eta": 11, "moves": 920,  "draft": 9.3, "geared": False, "min_qc": 2, "max_qc": 3, "pref_berth": 200},
        {"id": "V5_GEARED_SHUTTLE", "len": 155, "eta": 15, "moves": 650,  "draft": 8.2, "geared": True,  "min_qc": 1, "max_qc": 2, "pref_berth": 800},
    ],
    "last_seaside_schedule": None,
    "last_yard_metrics": None,
    "last_simpy_metrics": None,
    "last_maintenance_plan": None,
    "last_wind_plan": None,
}

# ----------------------------------------------------------------------------
# Shared physical constants
# ----------------------------------------------------------------------------
KB_M, BM_M = 5.45, 6.85                 # hydrostatic particulars at the arrival draft
SHIP_BASE_MASS_T = 32000.0              # [ASSUMPTION] lightship + bunkers + ballast + retained cargo
SHIP_BASE_KG_M = 10.15                  # [ASSUMPTION] VCG of that base condition
ROW_PITCH_M = 2.45                      # transverse stack pitch
GM_MIN_M, LIST_MAX_DEG = 1.20, 3.0

TIDE_MEAN_M, TIDE_AMP_M, TIDE_PERIOD_H, TIDE_GATE_M = 8.85, 1.45, 12.42, 9.55

YARD_BAYS, YARD_ROWS, YARD_TIERS = 20, 6, 5
CHANNEL_MIX = (("GREEN", 0.52, 1.9, 40.0), ("YELLOW", 0.30, 2.2, 105.0), ("RED", 0.18, 2.5, 210.0))

# v4-NEW: quay-crane productivity factor by gust band (m/s). [ASSUMPTION]
# Sway slows the cycle before the operating limit; at the limit cranes are secured.
WIND_BANDS = ((12.0, 1.00), (16.0, 0.85), (20.0, 0.60))
WIND_SHUTDOWN_MS = 20.0

# One worker makes CP-SAT fully deterministic: with several, ties between equally
# good plans are broken by thread timing and the replay statistics move with them.
CPSAT_WORKERS = 1

# v5-NEW: crane intensity. A vessel worked by q cranes lands boxes at a rate
# proportional to e(q) = q**0.88 (+0.55 for ship's gear). The yard cluster in
# the DES is sized for the reference gang of four shore cranes.
E_REF = 4 ** 0.88


def crane_effect(q: int, geared: bool) -> float:
    return (q ** 0.88) + (0.55 if geared else 0.0)


def mode_key(q: int, geared: bool) -> str:
    return f"{crane_effect(q, geared):.3f}"

CLIFF_KNEE = 0.78                       # occupancy where the rehandle regime starts
RTG_BASE_CYCLE_MIN = 2.6


def _stable_seed(text: str, mod: int = 10000) -> int:
    """v3-FIX 1: Python's hash() is salted per process, so v2.0 produced a
    different manifest on every server launch. CRC32 is stable."""
    return zlib.crc32(text.encode("utf-8")) % mod


def tide_height_m(hour: float) -> float:
    return TIDE_MEAN_M + TIDE_AMP_M * math.sin(2.0 * math.pi * hour / TIDE_PERIOD_H)


def wind_rate_factor(gust_ms: float) -> float:
    """Fraction of calm-weather quay-crane productivity available at a given gust."""
    for limit, factor in WIND_BANDS:
        if gust_ms < limit:
            return factor
    return 0.0


def rtg_cycle_minutes(occupancy: float, blocking_ratio: float = 0.0) -> float:
    """Phenomenological RTG cycle time versus block occupancy (unchanged from v2.0).
    Below the knee: productive moves only. Above it: a rho/(1-rho) rehandle term."""
    occ = min(max(occupancy, 0.15), 0.95)
    base = RTG_BASE_CYCLE_MIN + blocking_ratio * 3.5
    if occ <= CLIFF_KNEE:
        return base * (1.0 + 0.25 * occ)
    return min(base * (1.0 + 0.42 * ((occ / (1.0 - occ)) ** 1.32)), 20.0)


# ----------------------------------------------------------------------------
# Tool 1: BAPLIE stowage + hydrostatics
# ----------------------------------------------------------------------------
def _generate_and_parse_baplie(vessel_id: str = "V1_GEARLESS_MEGA", num_containers: int = 180) -> str:
    rng = np.random.default_rng(_stable_seed(vessel_id))
    edifact_lines = [
        "UNB+UNOA:2+CARRIER+PORTFLOW_TOS+261112:0600+0001'",
        "UNH+1+BAPLIE:D:09A:UN:SMDG22'",
        f"BGM++{vessel_id}+9'",
        f"TDT+20+VOY2026++1+++++{vessel_id}'",
    ]
    containers = []
    vertical_moment, transverse_moment, parcel_mass_t = 0.0, 0.0, 0.0

    for i in range(num_containers):
        bay = int(rng.choice([2, 6, 10, 14, 18, 22, 26]))
        row = int(rng.integers(1, 9))
        tier = int(rng.choice([2, 4, 6, 8, 82, 84, 86]))
        weight_kg = int(rng.integers(7500, 30500))
        cntr_id = f"TGHU{200000 + i}"
        is_reefer = bool(rng.random() < 0.14)
        imdg_class = str(rng.choice(["NONE", "NONE", "NONE", "NONE", "3", "2.1", "5.1"]))
        channel = str(rng.choice(["GREEN", "YELLOW", "RED"], p=[0.52, 0.30, 0.18]))

        if channel == "GREEN":
            dwell_hrs = float(weibull_min.rvs(1.9, scale=40.0, random_state=rng))
        elif channel == "YELLOW":
            dwell_hrs = float(weibull_min.rvs(2.2, scale=105.0, random_state=rng))
        else:
            dwell_hrs = float(weibull_min.rvs(2.5, scale=210.0, random_state=rng))

        edifact_lines.append(f"LOC+147+{bay:03d}{row:02d}{tier:02d}::5'")
        edifact_lines.append(f"MEA+WT++KGM:{weight_kg}'")
        edifact_lines.append(f"EQD+CN+{cntr_id}+45G1'")

        z_m = (tier * 1.3) if tier < 50 else ((tier - 70) * 1.3)
        # v3-FIX 2a: ISO 9711 row numbering is odd = starboard, even = port, in
        # mirrored pairs. v2.0 used (-1)**row * (row//2), which left row 08 with
        # no counterpart and gave every stow a built-in ~1.2 m starboard offset.
        side = 1.0 if row % 2 == 1 else -1.0
        y_m = side * (((row + 1) // 2) - 0.5) * ROW_PITCH_M
        mass_t = weight_kg / 1000.0
        vertical_moment += mass_t * z_m
        transverse_moment += mass_t * y_m
        parcel_mass_t += mass_t

        containers.append({
            "id": cntr_id, "ship_bay": bay, "ship_row": row, "ship_tier": tier,
            "weight_t": round(mass_t, 2), "is_reefer": is_reefer,
            "imdg": 0 if imdg_class == "NONE" else 1, "imdg_class": imdg_class,
            "channel": channel, "predicted_dwell_hrs": round(dwell_hrs, 1)
        })

    # v3-FIX 2b: stability is a property of the whole ship. v2.0 divided the
    # parcel's moments by the parcel's own mass, i.e. treated 3,400 t of boxes
    # as the entire displacement, which is why GM came out near zero.
    displacement_t = SHIP_BASE_MASS_T + parcel_mass_t
    parcel_vcg_m = vertical_moment / max(parcel_mass_t, 1.0)
    kg_m = (SHIP_BASE_MASS_T * SHIP_BASE_KG_M + vertical_moment) / displacement_t
    tcg_m = transverse_moment / displacement_t
    gm_m = round(KB_M + BM_M - kg_m, 3)
    list_angle_deg = round(math.degrees(math.atan2(tcg_m, max(gm_m, 0.1))), 2)
    PORT_STATE["baplie_manifests"][vessel_id] = containers

    return json.dumps({
        "vessel_id": vessel_id, "containers_parsed": num_containers,
        "edifact_segments": len(edifact_lines),
        "total_mass_tonnes": round(parcel_mass_t, 1),
        "displacement_tonnes": round(displacement_t, 1),
        "hydrostatics": {
            "KG_vertical_cog_m": round(kg_m, 3),
            "parcel_VCG_m": round(parcel_vcg_m, 3),
            "TCG_transverse_cog_m": round(tcg_m, 4),
            "KM_m": round(KB_M + BM_M, 2),
            "GM_metacentric_height_m": gm_m,
            "heeling_list_angle_deg": list_angle_deg,
            "imo_stability_compliant": bool(gm_m >= GM_MIN_M and abs(list_angle_deg) <= LIST_MAX_DEG)
        }
    }, indent=2)


# ----------------------------------------------------------------------------
# Tool 2: integrated berth allocation + quay crane assignment (CP-SAT)
# ----------------------------------------------------------------------------
def _solve_seaside_berth_and_cranes(
    quay_length_m: int = 1050, total_quay_cranes: int = 10,
    enable_dual_cycling: bool = True, yard_backpressure_factor: float = 1.0,
    horizon_hrs: int = 168, wind_rate_profile: Optional[List[float]] = None,
    mode_beta: Optional[Dict[str, float]] = None, force_qcs: Optional[Dict[str, int]] = None,
    crane_outages: Optional[List[List[int]]] = None, eta_shift_hrs: Optional[Dict[str, int]] = None
) -> str:
    """wind_rate_profile[h] in [0, 1] scales quay-crane productivity in hour h.
    When given, service time depends on WHEN a vessel works (v4-NEW).

    v5-NEW: mode_beta maps a crane-intensity key (see mode_key) to the yard
    backpressure simulated for that intensity. Modes without an entry use 1.0,
    the optimistic bound, which makes the model a relaxation of the true problem.
    force_qcs fixes crane counts; crane_outages = [[start_hr, end_hr, n], ...]
    removes n quay cranes from the pool; eta_shift_hrs delays named vessels."""
    model = cp_model.CpModel()
    phi = None
    if wind_rate_profile is not None:
        phi = [float(x) for x in wind_rate_profile][:horizon_hrs]
        phi += [1.0] * (horizon_hrs - len(phi))
    safety_gap_m = 25
    high_tide_hours = [t for t in range(horizon_hrs) if tide_height_m(t) >= TIDE_GATE_M]
    tide_domain = cp_model.Domain.FromValues(high_tide_hours)

    base_gmph = 31.5 if enable_dual_cycling else 25.0   # [ASSUMPTION] dual-cycling uplift
    eff_gmph = base_gmph / max(yard_backpressure_factor, 0.5)
    x_intervals, y_intervals, v_vars, objective_terms = [], [], {}, []

    def rate_for(q: int, geared: bool) -> float:
        if mode_beta is None:
            return eff_gmph * crane_effect(q, geared)
        return base_gmph / max(mode_beta.get(mode_key(q, geared), 1.0), 0.5) * crane_effect(q, geared)

    for v0 in PORT_STATE["vessels"]:
        v = dict(v0)
        v["eta"] = v0["eta"] + int((eta_shift_hrs or {}).get(v0["id"], 0))
        vid = v["id"]
        b_start = model.NewIntVar(0, quay_length_m - v["len"], f"b_{vid}")
        b_size = v["len"] + safety_gap_m
        b_end = model.NewIntVar(0, quay_length_m + safety_gap_m, f"bend_{vid}")
        model.Add(b_end == b_start + b_size)

        b_diff = model.NewIntVar(-quay_length_m, quay_length_m, f"bdiff_{vid}")
        b_abs_dev = model.NewIntVar(0, quay_length_m, f"bdev_{vid}")
        model.Add(b_diff == b_start - v["pref_berth"])
        model.AddAbsEquality(b_abs_dev, b_diff)

        if v["draft"] >= 9.2:
            valid_arr = [t for t in high_tide_hours if v["eta"] <= t < horizon_hrs - 15]
            t_start = model.NewIntVarFromDomain(cp_model.Domain.FromValues(valid_arr), f"ts_{vid}")
            t_depart = model.NewIntVarFromDomain(tide_domain, f"td_{vid}")
        else:
            t_start = model.NewIntVar(v["eta"], horizon_hrs - 15, f"ts_{vid}")
            t_depart = model.NewIntVar(v["eta"] + 2, horizon_hrs, f"td_{vid}")

        t_service_dur = model.NewIntVar(1, horizon_hrs, f"sdur_{vid}")
        t_service_done = model.NewIntVar(v["eta"] + 1, horizon_hrs, f"sdone_{vid}")
        model.Add(t_service_done == t_start + t_service_dur)
        model.Add(t_depart >= t_service_done)
        t_berth_occ = model.NewIntVar(1, horizon_hrs, f"bocc_{vid}")
        model.Add(t_berth_occ == t_depart - t_start)

        qc_assigned = model.NewIntVar(v["min_qc"], v["max_qc"], f"qc_{vid}")
        mode_bools = []
        if phi is not None:
            # v4-NEW: time-dependent processing times as a table constraint.
            # p_v(q, s) = min{ d : sum_{h=s}^{s+d-1} g/beta * phi_h * e(q) >= M_v }
            tuples = []
            for q in range(v["min_qc"], v["max_qc"] + 1):
                rate = rate_for(q, v["geared"])
                for s in range(v["eta"], horizon_hrs - 15):
                    done, h = 0.0, s
                    while done < v["moves"] - 1e-9 and h < horizon_hrs:
                        done += rate * phi[h]
                        h += 1
                    if done >= v["moves"] - 1e-9:
                        tuples.append((s, q, h - s))
            model.AddAllowedAssignments([t_start, qc_assigned, t_service_dur], tuples)
        for q in range(v["min_qc"], v["max_qc"] + 1) if phi is None else []:
            z_q = model.NewBoolVar(f"z_{vid}_{q}")
            mode_bools.append(z_q)
            dur_hrs = int(math.ceil(v["moves"] / rate_for(q, v["geared"])))
            # v3-FIX 3: a mode longer than the horizon used to make the whole
            # model infeasible without any message; forbid that mode instead.
            if dur_hrs > horizon_hrs - 1:
                model.Add(z_q == 0)
                continue
            model.Add(t_service_dur == dur_hrs).OnlyEnforceIf(z_q)
            model.Add(qc_assigned == q).OnlyEnforceIf(z_q)
        if phi is None:
            model.AddExactlyOne(mode_bools)
        if force_qcs and vid in force_qcs:
            model.Add(qc_assigned == int(force_qcs[vid]))

        x_intervals.append(model.NewIntervalVar(b_start, b_size, b_end, f"xi_{vid}"))
        y_intervals.append(model.NewIntervalVar(t_start, t_berth_occ, t_depart, f"yi_{vid}"))

        wait_hrs = model.NewIntVar(0, horizon_hrs, f"wait_{vid}")
        model.Add(wait_hrs == t_start - v["eta"])
        tide_hold_hrs = model.NewIntVar(0, horizon_hrs, f"thold_{vid}")
        model.Add(tide_hold_hrs == t_depart - t_service_done)

        w_wait = 18 if not v["geared"] else 10
        objective_terms.append(wait_hrs * w_wait + t_berth_occ * 6 + b_abs_dev * 1)
        v_vars[vid] = {
            "b_start": b_start, "b_dev": b_abs_dev, "t_start": t_start,
            "t_service_done": t_service_done, "t_depart": t_depart,
            "qc": qc_assigned, "wait": wait_hrs, "tide_hold": tide_hold_hrs, "meta": v
        }

    model.AddNoOverlap2D(x_intervals, y_intervals)
    for h in range(horizon_hrs):
        qcs_in_hour = []
        for vid, vv in v_vars.items():
            active = model.NewBoolVar(f"act_{vid}_{h}")
            started = model.NewBoolVar(f"st_{vid}_{h}")
            not_done = model.NewBoolVar(f"nd_{vid}_{h}")
            model.Add(vv["t_start"] <= h).OnlyEnforceIf(started)
            model.Add(vv["t_start"] > h).OnlyEnforceIf(started.Not())
            model.Add(vv["t_service_done"] > h).OnlyEnforceIf(not_done)
            model.Add(vv["t_service_done"] <= h).OnlyEnforceIf(not_done.Not())
            model.AddBoolAnd([started, not_done]).OnlyEnforceIf(active)
            model.AddBoolOr([started.Not(), not_done.Not()]).OnlyEnforceIf(active.Not())
            q_h = model.NewIntVar(0, vv["meta"]["max_qc"], f"qh_{vid}_{h}")
            model.Add(q_h == vv["qc"]).OnlyEnforceIf(active)
            model.Add(q_h == 0).OnlyEnforceIf(active.Not())
            qcs_in_hour.append(q_h)
        down = sum(int(n) for (a, b, n) in (crane_outages or []) if a <= h < b)
        model.Add(sum(qcs_in_hour) <= max(0, total_quay_cranes - down))

    model.Minimize(sum(objective_terms))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0
    solver.parameters.num_workers = CPSAT_WORKERS
    solver.parameters.random_seed = 7
    status = solver.Solve(model)
    feasible = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)

    schedule, total_turnaround, total_wait = [], 0, 0
    if feasible:
        for vid, vv in v_vars.items():
            st, sd, dp = solver.Value(vv["t_start"]), solver.Value(vv["t_service_done"]), solver.Value(vv["t_depart"])
            wt, th, qc = solver.Value(vv["wait"]), solver.Value(vv["tide_hold"]), solver.Value(vv["qc"])
            bp, bdev = solver.Value(vv["b_start"]), solver.Value(vv["b_dev"])
            turnaround = dp - vv["meta"]["eta"]
            total_turnaround += turnaround
            total_wait += wt
            schedule.append({
                "vessel_id": vid, "berth_start_m": bp, "berth_end_m": bp + vv["meta"]["len"],
                "pref_berth_m": vv["meta"]["pref_berth"],
                "yard_deviation_m": bdev, "eta_hr": vv["meta"]["eta"], "berth_start_hr": st,
                "cargo_done_hr": sd, "tidal_depart_hr": dp, "tide_departure_hold_hrs": th,
                "assigned_qcs": qc, "crane_intensity": mode_key(qc, vv["meta"]["geared"]),
                "anchorage_wait_hrs": wt, "turnaround_hrs": turnaround,
                "draft_m": vv["meta"]["draft"], "geared": vv["meta"]["geared"],
                # [ASSUMPTION] linear proxy: 1.85 t HFO per hour of anchorage wait
                # converted into slow steaming under a Virtual Arrival clause.
                "virtual_arrival_hfo_saved_tonnes": round(wt * 1.85, 1)
            })

    # v3-FIX 3: v2.0 reported 0.0 days / objective 0 when the solve failed.
    result = {
        "solver_status": solver.StatusName(status), "feasible": feasible,
        "yard_backpressure_input": yard_backpressure_factor,
        "wind_aware": phi is not None,
        "effective_gmph": round(eff_gmph, 2),
        "objective_value": solver.ObjectiveValue() if feasible else None,
        "lower_bound": solver.BestObjectiveBound() if feasible else None,
        "avg_turnaround_days": round((total_turnaround / len(PORT_STATE["vessels"])) / 24.0, 2) if feasible else None,
        "total_anchorage_wait_hrs": total_wait if feasible else None,
        "schedule": schedule
    }
    PORT_STATE["last_seaside_schedule"] = result
    return json.dumps(result, indent=2)


# ----------------------------------------------------------------------------
# Tool 3: 3D yard tensor, pre-marshalling, reefer RC model
# ----------------------------------------------------------------------------
def _draw_dwell(rng: np.random.Generator) -> float:
    u, acc = rng.random(), 0.0
    for _, p, shape, scale in CHANNEL_MIX:
        acc += p
        if u <= acc:
            return float(weibull_min.rvs(shape, scale=scale, random_state=rng))
    return float(weibull_min.rvs(CHANNEL_MIX[-1][2], scale=CHANNEL_MIX[-1][3], random_state=rng))


def _count_blocking(grid: np.ndarray) -> int:
    """A box is 'blocking' when some box beneath it is due out earlier."""
    blocks = 0
    for b in range(grid.shape[0]):
        for r in range(grid.shape[1]):
            col = [val for val in grid[b, r, :] if val > 0]
            for idx in range(1, len(col)):
                if col[idx] > min(col[:idx]):
                    blocks += 1
    return blocks


def _simulate_reefer_block(n_reefers: int = 60, seed: int = 99) -> Dict[str, Any]:
    """24 h lumped-capacitance (1R1C) model of a reefer stack.

        C_i dT_i/dt = UA (T_amb - T_i) - Q_cool u_i ,   u_i in {0, 1}

    v3-FIX 5: v2.0 used 0.045 /h heat gain against 1.65 K/h cooling. At a 48 K
    lift the gain is 2.2 K/h, so the box warmed even with the compressor always
    on (equilibrium -6.7 C) and every box breached. Parameters are now derived
    from UA, cargo thermal mass and evaporator capacity.
    """
    rng = np.random.default_rng(seed)
    UA_KW_PER_K = 0.045                       # [ASSUMPTION] 40' HC envelope, ~45 W/K
    C_KWH_PER_K = rng.uniform(8.0, 13.0, n_reefers)   # [ASSUMPTION] 15-25 t frozen cargo
    Q_COOL_KW, P_ELEC_KW = 6.0, 7.5           # [ASSUMPTION] capacity and draw at -18 C
    a, b = UA_KW_PER_K / C_KWH_PER_K, Q_COOL_KW / C_KWH_PER_K
    T_ON, T_OFF = -18.5, -19.5                # thermostat band (unmanaged)
    T_FLOOR, T_MUST, T_LIMIT = -21.5, -18.3, -18.0
    DT, DAYS = 0.25, 7                        # day 1 is warm-up; KPIs cover days 2-7
    STEPS, DAY_STEPS = 96 * DAYS, 96
    TOU_START, TOU_END = 17.0, 22.0

    T0 = rng.uniform(T_OFF, T_ON, n_reefers)
    on0 = rng.random(n_reefers) < 0.40

    def ambient(hr: float) -> float:
        return 30.0 + 5.0 * math.sin(2.0 * math.pi * (hr - 9.0) / 24.0)

    def run(cap_off: Optional[int], cap_on: Optional[int]) -> Dict[str, Any]:
        T, on = T0.copy(), on0.copy()
        kw, tmax, tmean, peak_tou, energy = [], [], [], 0.0, 0.0
        breached = np.zeros(n_reefers, dtype=bool)
        overrides = 0
        for step in range(STEPS):
            hr = (step * DT) % 24.0
            if cap_off is None:               # unmanaged hysteresis thermostat
                on = np.where(T >= T_ON, True, np.where(T <= T_OFF, False, on))
                u = on.astype(float)
            else:                             # priority-stack dispatch under a cap
                cap = cap_on if TOU_START <= hr < TOU_END else cap_off
                u = np.zeros(n_reefers)
                order = np.argsort(-T)
                chosen = [i for i in order if T[i] > T_FLOOR][:cap]
                u[chosen] = 1.0
                must = T >= T_MUST            # safety override, outside the cap
                overrides += int(np.sum(must & (u == 0)))
                u[must] = 1.0
            T = T + DT * (a * (ambient(hr) - T) - b * u)
            breached |= T > T_LIMIT
            p = float(np.sum(u) * P_ELEC_KW)
            kw.append(p)
            tmax.append(float(np.max(T)))
            tmean.append(float(np.mean(T)))
            energy += p * DT
            if TOU_START <= hr < TOU_END:
                peak_tou = max(peak_tou, p)
        last, ev = slice(STEPS - DAY_STEPS, STEPS), slice(DAY_STEPS, STEPS)
        tou = [p for k, p in enumerate(kw) if k >= DAY_STEPS and TOU_START <= ((k * DT) % 24.0) < TOU_END]
        # A cap is admissible only if it holds the cold chain on all seven days,
        # so the controller cannot "pass" by spending the cargo's thermal inertia
        # once. The headline peak is the mean of the six daily peaks (days 2-7);
        # the weekly maximum, which a demand charge bills, is reported alongside.
        daily = [max(kw[d * DAY_STEPS:(d + 1) * DAY_STEPS]) for d in range(1, DAYS)]
        return {"kw": kw[last], "tmax": tmax[last], "tmean": tmean[last], "peak": max(kw[ev]),
                "peak_daily_mean": float(np.mean(daily)),
                "peak_tou": max(tou), "energy": float(sum(kw[ev]) * DT) / (DAYS - 1),
                "tmax_all": max(tmax[ev]),
                "breaches": int(np.sum(breached)), "overrides": overrides,
                "drift": tmean[-1] - tmean[STEPS - DAY_STEPS - 1]}

    unm = run(None, None)

    def ok(res: Dict[str, Any]) -> bool:
        return res["breaches"] == 0 and res["overrides"] == 0

    # Stage 1: smallest uniform compressor cap that holds the cold chain.
    lo, hi = 1, n_reefers
    while lo < hi:
        mid = (lo + hi) // 2
        if ok(run(mid, mid)):
            hi = mid
        else:
            lo = mid + 1
    k_star = lo
    # Stage 2: with that cap off-peak, smallest cap inside the tariff window.
    lo, hi = 0, k_star
    while lo < hi:
        mid = (lo + hi) // 2
        if ok(run(k_star, mid)):
            hi = mid
        else:
            lo = mid + 1
    k_tou = lo
    smt = run(k_star, k_tou)

    series = []
    for step in range(0, DAY_STEPS, 2):
        hr = step * DT
        series.append({
            "hour": round(hr, 1), "ambient_c": round(ambient(hr), 1),
            "unmanaged_kw": round(unm["kw"][step], 1), "smart_kw": round(smt["kw"][step], 1),
            "unmanaged_max_temp_c": round(unm["tmax"][step], 2), "smart_max_temp_c": round(smt["tmax"][step], 2),
            "smart_mean_temp_c": round(smt["tmean"][step], 2)
        })
    return {
        "n_reefers": n_reefers,
        "unmanaged_peak_demand_kw": round(unm["peak_daily_mean"], 1),
        "smart_shaved_peak_demand_kw": round(smt["peak_daily_mean"], 1),
        "peak_shaved_pct": round(100.0 * (1.0 - smt["peak_daily_mean"] / unm["peak_daily_mean"]), 1),
        "unmanaged_weekly_max_kw": round(unm["peak"], 1),
        "smart_weekly_max_kw": round(smt["peak"], 1),
        "unmanaged_tariff_window_peak_kw": round(unm["peak_tou"], 1),
        "smart_tariff_window_peak_kw": round(smt["peak_tou"], 1),
        "unmanaged_energy_kwh_per_day": round(unm["energy"], 0),
        "smart_energy_kwh_per_day": round(smt["energy"], 0),
        "compressor_cap_offpeak": k_star, "compressor_cap_tariff_window": k_tou,
        "max_box_temp_degC": round(smt["tmax_all"], 2),
        "unmanaged_max_box_temp_degC": round(unm["tmax_all"], 2),
        "cold_chain_limit_degC": T_LIMIT,
        "smart_mean_temp_drift_last_day_K": round(smt["drift"], 3),
        "cold_chain_breaches": smt["breaches"],
        "unmanaged_cold_chain_breaches": unm["breaches"],
        "series_30min": series
    }


def _optimize_3d_yard_and_reefers(
    enable_weibull_stacking: bool = True, max_night_premarshal_moves: int = 45,
    prefill_pct: float = 50.0, vessel_id: str = "V1_GEARLESS_MEGA"
) -> str:
    if vessel_id not in PORT_STATE["baplie_manifests"]:
        _generate_and_parse_baplie(vessel_id, 180)
    manifest = PORT_STATE["baplie_manifests"][vessel_id]
    BAYS, ROWS, TIERS = YARD_BAYS, YARD_ROWS, YARD_TIERS
    yard_dwell = np.zeros((BAYS, ROWS, TIERS), dtype=float)
    imdg_grid = np.zeros((BAYS, ROWS, TIERS), dtype=int)   # 0 = none, else IMDG class code
    imdg_code = {"NONE": 0, "3": 1, "2.1": 2, "5.1": 3}
    chan_grid = np.zeros((BAYS, ROWS, TIERS), dtype=int)   # 0 empty, 1 green, 2 yellow, 3 red, 4 inherited stock (channel not in the manifest)
    chan_code = {"GREEN": 1, "YELLOW": 2, "RED": 3}
    rng = np.random.default_rng(99)

    # v3-FIX 4a: the block now starts with inherited stock stacked without dwell
    # information. v2.0 dropped 180 boxes into an empty 600-slot block, so there
    # was nothing for night pre-marshalling to repair.
    n_prefill = int(round(BAYS * ROWS * TIERS * prefill_pct / 100.0))
    placed = 0
    while placed < n_prefill:
        b, r = int(rng.integers(0, BAYS)), int(rng.integers(0, ROWS))
        t = int(np.sum(yard_dwell[b, r, :] > 0))
        if t >= TIERS:
            continue
        yard_dwell[b, r, t] = max(1.0, _draw_dwell(rng))
        chan_grid[b, r, t] = 4
        placed += 1
    inherited_blocking = _count_blocking(yard_dwell)

    cur_bay, gantry_bays_traveled, stacked = 0, 0, 0
    for cntr in manifest:
        best_slot, best_cost = None, 1e9
        dwell, imdg = max(1.0, cntr["predicted_dwell_hrs"]), imdg_code[cntr["imdg_class"]]
        for b in range(BAYS):
            if imdg > 0:
                # v3-FIX 4c: segregate INCOMPATIBLE classes (2.1 / 3 / 5.1 are
                # mutually "separated from" in the IMDG table); the same class may
                # share a zone. v2.0 forbade any two DG boxes within one bay of
                # each other, which fits about 10 boxes, and silently dropped the
                # other ~70 of the manifest.
                b0, b1 = max(0, b - 1), min(BAYS - 1, b + 1)
                zone = imdg_grid[b0:b1 + 1, :, :]
                if np.any((zone > 0) & (zone != imdg)):
                    continue
            for r in range(ROWS):
                t = int(np.sum(yard_dwell[b, r, :] > 0))
                if t >= TIERS:
                    continue
                if not enable_weibull_stacking:
                    cost = rng.uniform(0, 80) + abs(b - cur_bay) * 3.0
                else:
                    # v3-FIX 4b: an empty ground slot can never be an inversion.
                    # v2.0 priced it at (9999 - dwell) * 0.25 ~ 2,450, above the
                    # 600 inversion penalty, so the policy preferred to bury boxes.
                    if t == 0:
                        inversion_pen = 0.0
                    else:
                        min_below = float(np.min(yard_dwell[b, r, :t]))
                        inversion_pen = 600.0 if dwell > min_below else (min_below - dwell) * 0.25
                    cost = inversion_pen + abs(b - cur_bay) * 1.6 + (t * 9.0)
                if cost < best_cost:
                    best_cost, best_slot = cost, (b, r, t)
        if best_slot:
            b, r, t = best_slot
            yard_dwell[b, r, t], imdg_grid[b, r, t] = dwell, imdg
            chan_grid[b, r, t] = chan_code[cntr["channel"]]
            gantry_bays_traveled += abs(b - cur_bay)
            cur_bay = b
            stacked += 1

    initial_blocking = _count_blocking(yard_dwell)
    tensor_before = np.round(yard_dwell, 1).tolist()      # one decimal, so the HMI counts the same inversions
    channel_before, imdg_before = chan_grid.tolist(), imdg_grid.tolist()

    # Greedy best-first pre-marshalling: move a blocking top box to the stack
    # where it fits most tightly without creating a new inversion.
    relocations, move_log = 0, []
    for _ in range(max_night_premarshal_moves):
        moved = False
        for b in range(BAYS):
            for r in range(ROWS):
                t_occ = int(np.sum(yard_dwell[b, r, :] > 0))
                if t_occ >= 2:
                    top_t = t_occ - 1
                    top_val = yard_dwell[b, r, top_t]
                    if top_val > float(np.min(yard_dwell[b, r, :top_t])):
                        best_dest, best_gap = None, 1e9
                        for b2 in range(BAYS):
                            for r2 in range(ROWS):
                                if b2 == b and r2 == r:
                                    continue
                                t2 = int(np.sum(yard_dwell[b2, r2, :] > 0))
                                if t2 < TIERS and imdg_grid[b, r, top_t] == 0:
                                    min_dest = float(np.min(yard_dwell[b2, r2, :t2])) if t2 > 0 else 9999.0
                                    if top_val <= min_dest:
                                        gap = (min_dest - top_val) + abs(b2 - b) * 2.0
                                        if gap < best_gap:
                                            best_gap, best_dest = gap, (b2, r2, t2)
                        if best_dest:
                            b2, r2, t2 = best_dest
                            yard_dwell[b2, r2, t2] = top_val
                            yard_dwell[b, r, top_t] = 0.0
                            move_log.append([b + 1, r + 1, top_t + 1, b2 + 1, r2 + 1, t2 + 1, int(round(top_val))])
                            relocations += 1
                            moved = True
                            break
            if moved:
                break
        if not moved:
            break

    final_blocking = _count_blocking(yard_dwell)
    boxes_in_block = int(np.sum(yard_dwell > 0))
    res = {
        "containers_stacked": stacked,
        "containers_unplaced": len(manifest) - stacked,
        "inherited_stock_boxes": n_prefill,
        "boxes_in_block": boxes_in_block,
        "block_fill_pct": round(100.0 * boxes_in_block / (BAYS * ROWS * TIERS), 1),
        "stacking_policy": "weibull_dwell_aware" if enable_weibull_stacking else "random_nearest",
        "inherited_blocking_inversions": inherited_blocking,
        "new_parcel_blocking_inversions": initial_blocking - inherited_blocking,
        "initial_blocking_inversions": initial_blocking,
        "night_premarshal_relocations_executed": relocations,
        "post_premarshal_blocking_inversions": final_blocking,
        "blocking_ratio": round(final_blocking / max(boxes_in_block, 1), 4),
        "rtg_gantry_travel_m": round(gantry_bays_traveled * 6.4, 1),
        "reefer_rc_thermodynamics": _simulate_reefer_block(60, seed=99),
        "premarshal_moves": move_log,
        "yard_tensor_before": tensor_before,
        "yard_channel_before": channel_before,
        "yard_imdg_before": imdg_before,
        "yard_tensor_after": np.round(yard_dwell, 1).tolist()
    }
    PORT_STATE["last_yard_metrics"] = res
    return json.dumps(res)


# ----------------------------------------------------------------------------
# Tool 4: SimPy discrete-event yard simulation
# ----------------------------------------------------------------------------
def _run_simpy_terminal_simulation(
    initial_yard_occupancy_pct: float = 83.0, icd_evacuation_ratio: float = 0.22,
    customs_xray_rate: float = 0.14, rtg_fleet: int = 8,
    rtg_outages: Optional[List[List[float]]] = None, seed: int = 2026,
    night_window_mins: float = 360.0, prime_movers: int = 12,
    log_events: bool = False, qc_intensity: float = 1.0, yard_cap_teu: float = 2400.0,
    trace_occupancy: bool = False, n_discharge: int = 750
) -> str:
    """One night shift followed by one discharge wave on a 2,400-TEU block cluster.

    rtg_outages: list of [start_minute, duration_minutes]; each takes one RTG out
    of service (planned maintenance or a breakdown).
    """
    env = simpy.Environment()
    rng = np.random.default_rng(seed)
    rtg_cranes = simpy.PriorityResource(env, capacity=rtg_fleet)
    xray_scanners = simpy.Resource(env, capacity=2)
    icd_shuttles = simpy.Resource(env, capacity=3)
    trucks = simpy.Resource(env, capacity=prime_movers)
    ym = PORT_STATE["last_yard_metrics"]
    # v3-FIX 6a: ratio is now inversions per box in the block (v2.0 divided by a
    # hard-coded 180).
    blocking_ratio = ym["blocking_ratio"] if ym else 0.08
    premarshal_jobs = ym["night_premarshal_relocations_executed"] if ym else 0
    PRIO_OUTAGE, PRIO_VESSEL, PRIO_LANDSIDE = -1, 0, 1
    # gate pickups scale with the wave (420 for the reference 750-box wave)
    N_DISCHARGE, QC_CYCLE_MIN, GATE_IAT_MIN = int(n_discharge), 1.25 / max(qc_intensity, 0.05), 2.1
    N_GATE = int(round(0.56 * N_DISCHARGE))

    state = {
        "yard_teu": (initial_yard_occupancy_pct / 100.0) * yard_cap_teu,
        "peak_occ_pct": 0.0, "wave_start_occ_pct": None,
        "rtg_waits": [], "xray_waits": [], "gate_waits": [],
        "icd_night": 0, "icd_direct": 0, "gate_picked_up": 0,
        "rehandle_crane_mins": 0.0, "nominal_qc_mins": 0.0, "discharge_done_at": None,
        "rtg_outage_mins": 0.0, "quay_blocked_mins": 0.0, "rtg_busy": {},
        "rtg_free": list(range(1, rtg_fleet + 1)), "truck_free": list(range(1, prime_movers + 1)),
        "events": [], "box": 0
    }

    def log(code: str, *vals):
        """v4-NEW: event trace for the HMI ticker. Draws no random numbers."""
        if log_events:
            state["events"].append([round(env.now, 2), code] + [round(float(x), 2) for x in vals])

    def occ_pct() -> float:
        return state["yard_teu"] / yard_cap_teu * 100.0

    def cycle(occ: float) -> float:
        return rtg_cycle_minutes(occ, blocking_ratio)

    def book(dur: float) -> float:
        """Log productive RTG minutes into hourly bins (v3-NEW: feeds maintenance)."""
        t, end = env.now, env.now + dur
        while t < end - 1e-9:
            h = int(t // 60)
            nxt = min(end, (h + 1) * 60.0)
            state["rtg_busy"][h] = state["rtg_busy"].get(h, 0.0) + (nxt - t)
            t = nxt
        return dur

    occ_trace: List[List[float]] = []

    def sampler():
        while True:
            occ_trace.append([round(env.now, 1), round(state["yard_teu"] / yard_cap_teu * 100.0, 2), rtg_cranes.count, len(rtg_cranes.queue)])
            yield env.timeout(10.0)

    def note_occ():
        if env.now >= night_window_mins:
            state["peak_occ_pct"] = max(state["peak_occ_pct"], state["yard_teu"] / yard_cap_teu * 100.0)

    def outage(start: float, dur: float):
        yield env.timeout(start)
        with rtg_cranes.request(priority=PRIO_OUTAGE) as req:
            yield req
            rid = state["rtg_free"].pop(0)
            t0 = env.now
            log("RTG_OUT", rid, dur)
            yield env.timeout(dur)
            state["rtg_outage_mins"] += env.now - t0
            log("RTG_BACK", rid)
            state["rtg_free"].append(rid)

    def premarshal_move():
        with rtg_cranes.request(priority=PRIO_LANDSIDE) as req:
            yield req
            rid = state["rtg_free"].pop(0)
            c = cycle(state["yard_teu"] / yard_cap_teu)
            log("PREMARSHAL", rid, c)
            yield env.timeout(book(c))
            state["rtg_free"].append(rid)

    def night_icd_evacuation():
        # v3-FIX 6b: the ICD valve now physically removes standing stock during
        # the night shift, and every lift-out costs an RTG cycle at the current
        # occupancy. v2.0 subtracted 0.9 TEU per diverted import with no crane
        # work, and could not bring an 84% yard below the knee.
        with rtg_cranes.request(priority=PRIO_LANDSIDE) as req:
            yield req
            rid = state["rtg_free"].pop(0)
            c = cycle(state["yard_teu"] / yard_cap_teu) * 0.85
            yield env.timeout(book(c))
            state["yard_teu"] -= 1.0
            log("ICD_LIFT", rid, c, occ_pct())
            state["rtg_free"].append(rid)
        with icd_shuttles.request() as sreq:
            yield sreq
            yield env.timeout(1.4)
            state["icd_night"] += 1

    def icd_direct():
        with icd_shuttles.request() as sreq:
            yield sreq
            yield env.timeout(1.4)
            state["icd_direct"] += 1

    def stack_import(truck_req, box: int, tid: int):
        t0 = env.now
        with rtg_cranes.request(priority=PRIO_VESSEL) as req:
            yield req
            rid = state["rtg_free"].pop(0)
            state["rtg_waits"].append(env.now - t0)
            occ = state["yard_teu"] / yard_cap_teu
            c_min = cycle(occ)
            if occ > 0.80:
                state["rehandle_crane_mins"] += (c_min - RTG_BASE_CYCLE_MIN)
            log("RTG_HANDSHAKE", rid, tid, box, env.now - t0, c_min, occ * 100.0)
            yield env.timeout(book(c_min))
            state["yard_teu"] += 1.0
            note_occ()
            state["rtg_free"].append(rid)
        yield env.timeout(1.5)                     # empty return leg to the quay
        trucks.release(truck_req)
        state["truck_free"].append(tid)
        if rng.random() < customs_xray_rate:
            tx = env.now
            with xray_scanners.request() as sreq:
                yield sreq
                state["xray_waits"].append(env.now - tx)
                log("XRAY", box, env.now - tx)
                yield env.timeout(float(rng.uniform(3.5, 6.5)))

    def discharge_gen():
        # v3-FIX 6c: closed prime-mover loop. The quay crane cannot land a box
        # until a terminal truck is free, so yard congestion throttles the quay
        # instead of building an unbounded queue (v2.0 was open-loop Poisson).
        yield env.timeout(night_window_mins)
        state["wave_start_occ_pct"] = state["yard_teu"] / yard_cap_teu * 100.0
        note_occ()
        for _ in range(N_DISCHARGE):
            c = float(rng.exponential(QC_CYCLE_MIN))
            state["nominal_qc_mins"] += c
            yield env.timeout(c)
            state["box"] += 1
            box = state["box"]
            if rng.random() < icd_evacuation_ratio:
                log("ICD_DIRECT", box)
                env.process(icd_direct())
                continue
            t_block = env.now
            # v3-FIX 6d: a full yard blocks the quay (v2.0 reached 115% of capacity).
            while state["yard_teu"] + trucks.count >= yard_cap_teu and env.now - t_block < 2880.0:
                yield env.timeout(1.0)
            if state["yard_teu"] + trucks.count >= yard_cap_teu:     # blocked for 48 h: the box goes to overflow storage
                state["quay_blocked_mins"] += env.now - t_block
                state["overflow_boxes"] = state.get("overflow_boxes", 0) + 1
                continue
            req = trucks.request()
            yield req
            state["quay_blocked_mins"] += env.now - t_block
            tid = state["truck_free"].pop(0)
            log("QC_LAND", box, tid, env.now - t_block)
            env.process(stack_import(req, box, tid))
        state["discharge_done_at"] = env.now

    def gate_pickup(t_arr: float):
        with rtg_cranes.request(priority=PRIO_LANDSIDE) as req:
            yield req
            rid = state["rtg_free"].pop(0)
            state["gate_waits"].append(env.now - t_arr)
            c = cycle(state["yard_teu"] / yard_cap_teu) * 0.85
            yield env.timeout(book(c))
            state["yard_teu"] -= 1.0
            state["gate_picked_up"] += 1
            log("GATE_OUT", rid, env.now - t_arr - c, occ_pct())
            state["rtg_free"].append(rid)

    def gate_pickup_gen():
        yield env.timeout(night_window_mins)
        for _ in range(N_GATE):
            yield env.timeout(float(rng.exponential(GATE_IAT_MIN)))
            if state["yard_teu"] > 1000.0:
                env.process(gate_pickup(env.now))

    for start, dur in (rtg_outages or []):
        env.process(outage(float(start), float(dur)))
    if icd_evacuation_ratio > 0:
        for _ in range(int(premarshal_jobs)):
            env.process(premarshal_move())
        for _ in range(int(round(icd_evacuation_ratio * state["yard_teu"]))):
            env.process(night_icd_evacuation())
    done = env.process(discharge_gen())
    gate = env.process(gate_pickup_gen())
    if trace_occupancy:
        env.process(sampler())
        env.run(until=simpy.AllOf(env, [done, gate]))
        env.run(until=env.now + 90.0)
    else:
        env.run()

    avg_rtg = round(float(np.mean(state["rtg_waits"])), 2) if state["rtg_waits"] else 0.0
    avg_xray = round(float(np.mean(state["xray_waits"])), 2) if state["xray_waits"] else 0.0
    avg_gate = round(float(np.mean(state["gate_waits"])), 1) if state["gate_waits"] else 0.0
    makespan = state["discharge_done_at"] - night_window_mins
    # v3-FIX 6e: beta is now measured, not mapped. It is the realised discharge
    # makespan over the makespan the quay cranes would have needed unobstructed,
    # which is exactly the factor CP-SAT divides its crane rate by.
    backpressure = round(max(1.0, makespan / state["nominal_qc_mins"]), 3)
    res = {
        "wave_start_yard_occupancy_pct": round(state["wave_start_occ_pct"], 1),
        "peak_yard_occupancy_pct": round(state["peak_occ_pct"], 1),
        "final_yard_occupancy_pct": round((state["yard_teu"] / yard_cap_teu) * 100.0, 1),
        "icd_evacuated_containers": state["icd_night"] + state["icd_direct"],
        "icd_night_evacuated": state["icd_night"], "icd_direct_from_quay": state["icd_direct"],
        "avg_rtg_handshake_wait_mins": avg_rtg,
        "avg_gate_truck_wait_mins": avg_gate,
        "avg_xray_scanner_wait_mins": avg_xray,
        "unproductive_rehandle_crane_hrs": round(state["rehandle_crane_mins"] / 60.0, 2),
        "discharge_makespan_hrs": round(makespan / 60.0, 2),
        "nominal_discharge_makespan_hrs": round(state["nominal_qc_mins"] / 60.0, 2),
        "quay_blocked_hrs": round(state["quay_blocked_mins"] / 60.0, 2),
        "rtg_outage_hrs": round(state["rtg_outage_mins"] / 60.0, 2),
        "rtg_utilisation_by_hour": [round(state["rtg_busy"].get(h, 0.0) / (60.0 * rtg_fleet), 3)
                                    for h in range(int(max(state["rtg_busy"]) + 1) if state["rtg_busy"] else 0)],
        "computed_cpsat_backpressure_beta": backpressure
    }
    if log_events:
        res["event_log"] = state["events"]
    if trace_occupancy:
        res["occupancy_trace"] = occ_trace
    PORT_STATE["last_simpy_metrics"] = res
    return json.dumps(res, indent=2)


# ----------------------------------------------------------------------------
# Tool 5: closed-loop coupling of CP-SAT and SimPy
# ----------------------------------------------------------------------------
def _one_replication(args: Tuple[Any, ...]) -> Dict[str, Any]:
    occ, icd, xray, rtg_fleet, rtg_outages, seed, qc_intensity, yard_cap_teu, n_discharge = args
    return json.loads(_run_simpy_terminal_simulation(occ, icd, xray, rtg_fleet=rtg_fleet, rtg_outages=rtg_outages, seed=seed,
                                                     qc_intensity=qc_intensity, yard_cap_teu=yard_cap_teu, n_discharge=n_discharge))


def _simulate_replicated(replications: int, occ: float, icd: float, xray: float,
                         rtg_outages: Optional[List[List[float]]] = None, qc_intensity: float = 1.0,
                         rtg_fleet: int = 8, yard_cap_teu: float = 2400.0, n_discharge: int = 750) -> Dict[str, Any]:
    """Mean of every DES output over independent seeds, with a 95% CI on beta.
    PORTFLOW_PROCS=n runs the replications in n processes (same seeds, so the same results)."""
    jobs = [(occ, icd, xray, rtg_fleet, rtg_outages, 2026 + k, qc_intensity, yard_cap_teu, n_discharge) for k in range(replications)]
    procs = int(os.environ.get("PORTFLOW_PROCS", "1"))
    if procs > 1 and replications >= 4 and hasattr(os, "fork"):
        import multiprocessing as mp
        with mp.get_context("fork").Pool(min(procs, replications)) as pool:
            runs = pool.map(_one_replication, jobs)
    else:
        runs = [_one_replication(j) for j in jobs]
    out = {k: round(float(np.mean([r[k] for r in runs])), 3) for k in runs[0] if k != "rtg_utilisation_by_hour"}
    n_h = max(len(r["rtg_utilisation_by_hour"]) for r in runs)
    out["rtg_utilisation_by_hour"] = [round(float(np.mean([r["rtg_utilisation_by_hour"][h] if h < len(r["rtg_utilisation_by_hour"]) else 0.0
                                                           for r in runs])), 3) for h in range(n_h)]
    betas = [r["computed_cpsat_backpressure_beta"] for r in runs]
    out["beta_ci95"] = round(1.96 * float(np.std(betas, ddof=1)) / math.sqrt(replications), 4) if replications > 1 else 0.0
    out["replications"] = replications
    PORT_STATE["last_simpy_metrics"] = out
    return out


def _run_closed_loop_simopt_benders(max_iterations: int = 4, tolerance: float = 0.03,
                                    sim_replications: int = 20,
                                    initial_yard_occupancy_pct: float = 84.0,
                                    icd_evacuation_ratio: float = 0.24) -> str:
    _generate_and_parse_baplie("V1_GEARLESS_MEGA", 180)
    _optimize_3d_yard_and_reefers(enable_weibull_stacking=False, max_night_premarshal_moves=0)
    base_yard = dict(PORT_STATE["last_yard_metrics"])
    base_sim = _simulate_replicated(sim_replications, initial_yard_occupancy_pct, 0.0, 0.14)
    base_sea = json.loads(_solve_seaside_berth_and_cranes(enable_dual_cycling=False, yard_backpressure_factor=base_sim["computed_cpsat_backpressure_beta"]))

    _optimize_3d_yard_and_reefers(enable_weibull_stacking=True, max_night_premarshal_moves=45)
    opt_yard = dict(PORT_STATE["last_yard_metrics"])
    beta, trace, converged = 1.0, [], False
    sea, sim = None, None
    for it in range(1, max_iterations + 1):
        sea = json.loads(_solve_seaside_berth_and_cranes(enable_dual_cycling=True, yard_backpressure_factor=beta))
        sim = _simulate_replicated(sim_replications, initial_yard_occupancy_pct, icd_evacuation_ratio, 0.14)
        new_beta = sim["computed_cpsat_backpressure_beta"]
        trace.append({
            "iteration": it, "input_beta": beta, "simpy_output_beta": new_beta,
            "residual": round(abs(new_beta - beta), 4), "cpsat_status": sea["solver_status"],
            "cpsat_objective": sea["objective_value"], "avg_turnaround_days": sea["avg_turnaround_days"],
            "peak_yard_occ_pct": sim["peak_yard_occupancy_pct"]
        })
        if abs(new_beta - beta) <= tolerance:
            converged = True
            break
        beta = round(0.5 * beta + 0.5 * new_beta, 3)

    # v3-FIX 7: the status is computed. v2.0 returned the literal "CONVERGED".
    status = "CONVERGED" if (converged and sea["feasible"]) else ("INFEASIBLE" if not sea["feasible"] else "MAX_ITERATIONS")
    b_th, o_th = base_yard["reefer_rc_thermodynamics"], opt_yard["reefer_rc_thermodynamics"]
    return json.dumps({
        "convergence_status": status, "iterations_run": len(trace), "tolerance": tolerance,
        "sim_replications": sim_replications,
        "scenario": {"initial_yard_occupancy_pct": initial_yard_occupancy_pct, "icd_evacuation_ratio": icd_evacuation_ratio},
        "baseline_unoptimized_kpis": {
            "avg_turnaround_days": base_sea["avg_turnaround_days"],
            "total_anchorage_wait_hrs": base_sea["total_anchorage_wait_hrs"],
            "cpsat_status": base_sea["solver_status"],
            "backpressure_beta": base_sim["computed_cpsat_backpressure_beta"],
            "backpressure_beta_ci95": base_sim["beta_ci95"],
            "wave_start_yard_occupancy_pct": base_sim["wave_start_yard_occupancy_pct"],
            "peak_yard_occupancy_pct": base_sim["peak_yard_occupancy_pct"],
            "avg_rtg_wait_mins": base_sim["avg_rtg_handshake_wait_mins"],
            "avg_gate_truck_wait_mins": base_sim["avg_gate_truck_wait_mins"],
            "unproductive_rehandle_hrs": base_sim["unproductive_rehandle_crane_hrs"],
            "discharge_makespan_hrs": base_sim["discharge_makespan_hrs"],
            "reefer_peak_kw": b_th["unmanaged_peak_demand_kw"],
            "blocking_inversions": base_yard["initial_blocking_inversions"]
        },
        "simopt_converged_kpis": {
            "avg_turnaround_days": sea["avg_turnaround_days"],
            "total_anchorage_wait_hrs": sea["total_anchorage_wait_hrs"],
            "cpsat_status": sea["solver_status"],
            "backpressure_beta": sim["computed_cpsat_backpressure_beta"],
            "backpressure_beta_ci95": sim["beta_ci95"],
            "wave_start_yard_occupancy_pct": sim["wave_start_yard_occupancy_pct"],
            "peak_yard_occupancy_pct": sim["peak_yard_occupancy_pct"],
            "avg_rtg_wait_mins": sim["avg_rtg_handshake_wait_mins"],
            "avg_gate_truck_wait_mins": sim["avg_gate_truck_wait_mins"],
            "unproductive_rehandle_hrs": sim["unproductive_rehandle_crane_hrs"],
            "discharge_makespan_hrs": sim["discharge_makespan_hrs"],
            "icd_evacuated_containers": sim["icd_evacuated_containers"],
            "reefer_peak_kw": o_th["smart_shaved_peak_demand_kw"],
            "blocking_inversions": opt_yard["post_premarshal_blocking_inversions"]
        },
        "convergence_trace": trace,
        "final_vessel_schedule": sea["schedule"]
    }, indent=2)


def _sweep_icd_evacuation_valve(ratios: Optional[List[float]] = None, initial_yard_occupancy_pct: float = 84.0,
                                sim_replications: int = 20) -> str:
    """What-if sweep of the off-dock ICD ratio: where does the yard cross the knee?
    Each point is the fixed point of the coupling loop for that ratio (the DES
    backpressure, and the CP-SAT plan re-solved at that backpressure)."""
    ratios = ratios or [0.0, 0.05, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.24, 0.30]
    if not PORT_STATE["last_yard_metrics"]:
        _optimize_3d_yard_and_reefers(True, 45)
    saved_sim, saved_sea = PORT_STATE["last_simpy_metrics"], PORT_STATE["last_seaside_schedule"]
    points = []
    for r in ratios:
        sim = _simulate_replicated(sim_replications, initial_yard_occupancy_pct, float(r), 0.14)
        beta = sim["computed_cpsat_backpressure_beta"]
        sea = json.loads(_solve_seaside_berth_and_cranes(enable_dual_cycling=True, yard_backpressure_factor=beta))
        points.append({
            "icd_evacuation_ratio": r, "backpressure_beta": beta, "beta_ci95": sim["beta_ci95"],
            "wave_start_yard_occupancy_pct": sim["wave_start_yard_occupancy_pct"],
            "peak_yard_occupancy_pct": sim["peak_yard_occupancy_pct"],
            "avg_gate_truck_wait_mins": sim["avg_gate_truck_wait_mins"],
            "quay_blocked_hrs": sim["quay_blocked_hrs"],
            "avg_turnaround_days": sea["avg_turnaround_days"], "cpsat_status": sea["solver_status"]
        })
    PORT_STATE["last_simpy_metrics"], PORT_STATE["last_seaside_schedule"] = saved_sim, saved_sea
    below = [p["icd_evacuation_ratio"] for p in points if p["peak_yard_occupancy_pct"] <= CLIFF_KNEE * 100.0]
    return json.dumps({
        "initial_yard_occupancy_pct": initial_yard_occupancy_pct, "knee_occupancy_pct": CLIFF_KNEE * 100.0,
        "min_ratio_keeping_peak_below_knee": min(below) if below else None, "points": points
    }, indent=2)


# ----------------------------------------------------------------------------
# v3-NEW  Tool 6: Gamma-process RTG prognostics + maintenance-window scheduling
# ----------------------------------------------------------------------------
RTG_FAILURE_THRESHOLD = 100.0          # wear index at which the hoist drive is unserviceable
# Synthetic ground truth of the fleet (hidden from the estimator). mean_rate is
# the expected wear per operating hour, rate is the Gamma rate parameter.
RTG_FLEET = [
    {"id": "RTG-01", "mean_rate": 0.050, "rate": 1.0, "age_h": 400,  "x0": 20.0},
    {"id": "RTG-02", "mean_rate": 0.062, "rate": 0.9, "age_h": 560,  "x0": 34.7},
    {"id": "RTG-03", "mean_rate": 0.055, "rate": 1.1, "age_h": 1210, "x0": 66.5},
    {"id": "RTG-04", "mean_rate": 0.085, "rate": 0.8, "age_h": 700,  "x0": 59.5},
    {"id": "RTG-05", "mean_rate": 0.070, "rate": 1.0, "age_h": 1150, "x0": 80.5},
    {"id": "RTG-06", "mean_rate": 0.095, "rate": 0.7, "age_h": 930,  "x0": 88.4},
    {"id": "RTG-07", "mean_rate": 0.080, "rate": 0.9, "age_h": 1175, "x0": 94.0},
    {"id": "RTG-08", "mean_rate": 0.110, "rate": 0.6, "age_h": 870,  "x0": 95.7},
]


def _gamma_failure_cdf(alpha: float, lam: float, x0: float, t: np.ndarray) -> np.ndarray:
    """P(first passage of L before t | X(0) = x0) for a stationary Gamma process.
    X(t) - x0 ~ Gamma(shape = alpha t, rate = lam), so F(t) = Q(alpha t, lam (L - x0))."""
    t = np.asarray(t, dtype=float)
    out = np.zeros_like(t)
    pos = t > 0
    out[pos] = gammaincc(alpha * t[pos], lam * max(RTG_FAILURE_THRESHOLD - x0, 1e-9))
    return out


def _workload_profile(horizon_hrs: int, night_hrs: int, des_util: List[float]) -> Dict[str, Any]:
    """RTG utilisation per maintenance hour. Maintenance hour 0 is the start of the
    night shift; the first vessel berths at maintenance hour `night_hrs`.

    Hours the DES covers use its measured utilisation. Later hours use the berth
    plan's working-QC count, rescaled so the two agree over their overlap."""
    sched = (PORT_STATE["last_seaside_schedule"] or {}).get("schedule", [])
    h0 = min(v["berth_start_hr"] for v in sched) if sched else 0
    qc = []
    for tau in range(horizon_hrs):
        h = h0 + (tau - night_hrs)
        qc.append(sum(v["assigned_qcs"] for v in sched if v["berth_start_hr"] <= h < v["cargo_done_hr"]) if tau >= night_hrs else 0)
    covered = min(len(des_util), horizon_hrs)
    # drop the DES tail (last two hours), where the wave is draining
    solid = max(night_hrs, covered - 2)
    overlap = [t for t in range(night_hrs, solid) if qc[t] > 0]
    kappa = (sum(des_util[t] for t in overlap) / sum(qc[t] for t in overlap)) if overlap else 0.06
    w, source = [], []
    for tau in range(horizon_hrs):
        if tau < solid:
            w.append(round(min(1.0, des_util[tau]), 3))
            source.append("DES")
        else:
            w.append(round(min(1.0, max(0.05, kappa * qc[tau])), 3))
            source.append("BERTH_PLAN")
    return {"w": w, "qc": qc, "source": source, "kappa_util_per_qc": round(kappa, 4), "des_hours": solid}


def _optimize_rtg_predictive_maintenance(
    horizon_hrs: int = 48, pm_duration_hrs: int = 4, cm_duration_hrs: int = 10,
    crew_capacity: int = 2, spare_rtg: int = 1,
    cost_pm: float = 1500.0, cost_failure: float = 9000.0, cost_rtg_hour: float = 650.0,
    tbm_interval_hrs: float = 1150.0, tbm_start_hr: int = 10,
    mc_paths: int = 5000, des_replications: int = 20, seed: int = 314,
    des_initial_occupancy_pct: float = 84.0, des_icd_ratio: float = 0.24,
    use_des_utilisation: bool = True
) -> str:
    """Gamma-process prognostics for the RTG fleet and a CP-SAT choice of
    preventive-maintenance windows against the berth plan's workload profile.
    Compares run-to-failure, calendar (time-based) and condition-based policies
    by Monte Carlo on the true degradation law, then replays sampled outages in
    the SimPy yard model to measure the effect on backpressure."""
    if not PORT_STATE["last_seaside_schedule"] or not PORT_STATE["last_seaside_schedule"].get("schedule"):
        _run_closed_loop_simopt_benders(4)
    H, D, DF, N, L = horizon_hrs, pm_duration_hrs, cm_duration_hrs, len(RTG_FLEET), RTG_FAILURE_THRESHOLD
    NIGHT_HRS, INSPECT_DT, N_INSPECT = 6, 12.0, 40
    rng = np.random.default_rng(seed)
    hours = np.arange(0, H + 1, dtype=float)
    # Simulation -> optimisation: the DES tells the scheduler how busy the fleet is.
    saved_sim0 = PORT_STATE["last_simpy_metrics"]
    nominal = _simulate_replicated(des_replications, des_initial_occupancy_pct, des_icd_ratio, 0.14)
    PORT_STATE["last_simpy_metrics"] = saved_sim0
    prof = _workload_profile(H, NIGHT_HRS, nominal["rtg_utilisation_by_hour"])
    qc_working = prof["qc"]
    if use_des_utilisation:
        w = prof["w"]
        # A crane may be released for PM only while the rest of the fleet can
        # carry the measured load with `spare_rtg` in hand.
        rtg_required = [min(N, int(math.ceil(N * x)) + spare_rtg) for x in w]
    else:
        # Ablation: static proxy that never consults the DES. The night shift is
        # assumed 60% loaded and each working QC is assumed to need 0.75 RTG.
        w = [0.60 if tau < NIGHT_HRS else round(max(0.10, q / 10.0), 3) for tau, q in enumerate(qc_working)]
        rtg_required = [min(N, int(math.ceil(0.75 * q))) for q in qc_working]
        prof["source"] = ["STATIC_PROXY"] * H
    W_fail = [sum(w[h:min(h + DF, H)]) for h in range(H)]      # workload lost by a breakdown in hour h
    W_pm = [sum(w[s:s + D]) for s in range(H - D + 1)]         # workload lost by PM starting at s

    # --- 1. Estimation: MLE of (alpha, lambda) from each crane's inspection log
    fleet = []
    for c in RTG_FLEET:
        alpha_true = c["mean_rate"] * c["rate"]
        inc = rng.gamma(shape=alpha_true * INSPECT_DT, scale=1.0 / c["rate"], size=N_INSPECT)
        inc = np.maximum(inc, 1e-9)
        k_hat, _, theta_hat = gamma_dist.fit(inc, floc=0)
        alpha_hat, lam_hat = k_hat / INSPECT_DT, 1.0 / theta_hat
        F = _gamma_failure_cdf(alpha_hat, lam_hat, c["x0"], hours)
        F_true = _gamma_failure_cdf(alpha_true, c["rate"], c["x0"], hours)
        grid = np.arange(1.0, 6001.0)
        surv = 1.0 - _gamma_failure_cdf(alpha_hat, lam_hat, c["x0"], grid)
        med_idx = int(np.argmax(surv <= 0.5)) if np.any(surv <= 0.5) else len(grid) - 1
        p10_idx = int(np.argmax(surv <= 0.9)) if np.any(surv <= 0.9) else len(grid) - 1
        fleet.append({
            "id": c["id"], "age_h": c["age_h"], "wear_index": c["x0"],
            "alpha_hat": round(alpha_hat, 4), "lambda_hat": round(lam_hat, 3),
            "mean_rate_hat": round(alpha_hat / lam_hat, 4), "mean_rate_true": c["mean_rate"],
            "rate_estimation_error_pct": round(100.0 * (alpha_hat / lam_hat - c["mean_rate"]) / c["mean_rate"], 1),
            "rul_median_h": float(grid[med_idx]), "rul_p10_h": float(grid[p10_idx]),
            "p_fail_horizon": round(float(F[H]), 4), "p_fail_horizon_true": round(float(F_true[H]), 4),
            "_F": F, "_alpha_true": alpha_true
        })

    # --- 2. Decision: CP-SAT assignment of PM start hours
    def exp_cost_pm(i: int, s: int) -> float:
        F = fleet[i]["_F"]
        pre = sum((F[h + 1] - F[h]) * (cost_failure + cost_rtg_hour * W_fail[h]) for h in range(s))
        return pre + (1.0 - F[s]) * (cost_pm + cost_rtg_hour * W_pm[s])

    def exp_cost_none(i: int) -> float:
        F = fleet[i]["_F"]
        return sum((F[h + 1] - F[h]) * (cost_failure + cost_rtg_hour * W_fail[h]) for h in range(H))

    model = cp_model.CpModel()
    z = {(i, s): model.NewBoolVar(f"z_{i}_{s}") for i in range(N) for s in range(H - D + 1)}
    for i in range(N):
        model.Add(sum(z[i, s] for s in range(H - D + 1)) <= 1)
    for h in range(H):
        in_pm = [z[i, s] for i in range(N) for s in range(max(0, h - D + 1), min(h, H - D) + 1)]
        model.Add(sum(in_pm) <= min(crew_capacity, N - rtg_required[h]))
    obj = []
    for i in range(N):
        none_c = int(round(exp_cost_none(i)))
        obj.append(none_c)
        for s in range(H - D + 1):
            obj.append((int(round(exp_cost_pm(i, s))) - none_c) * z[i, s])
    model.Minimize(sum(obj))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    solver.parameters.num_workers = CPSAT_WORKERS
    solver.parameters.random_seed = 7
    status = solver.Solve(model)
    cbm_plan = {}
    for i in range(N):
        for s in range(H - D + 1):
            if solver.Value(z[i, s]):
                cbm_plan[i] = s

    # --- Reference policies
    rtf_plan: Dict[int, int] = {}
    due = sorted([i for i in range(N) if fleet[i]["age_h"] >= tbm_interval_hrs], key=lambda i: -fleet[i]["age_h"])
    tbm_plan = {i: tbm_start_hr + (k // crew_capacity) * D for k, i in enumerate(due)}
    policies = {"RUN_TO_FAILURE": rtf_plan, "TIME_BASED_PM": tbm_plan, "GAMMA_CBM_CPSAT": cbm_plan}

    # --- 3. Monte Carlo on the TRUE degradation law (common random numbers)
    first_pass = np.full((mc_paths, N), H + 1, dtype=int)
    for i, c in enumerate(RTG_FLEET):
        inc = rng.gamma(shape=fleet[i]["_alpha_true"], scale=1.0 / c["rate"], size=(mc_paths, H))
        path = c["x0"] + np.cumsum(inc, axis=1)
        crossed = path >= L
        hit = np.where(crossed.any(axis=1), crossed.argmax(axis=1), H + 1)
        first_pass[:, i] = hit

    def evaluate(plan: Dict[int, int]) -> Dict[str, Any]:
        cost = np.zeros(mc_paths)
        fails = np.zeros(mc_paths)
        lost = np.zeros(mc_paths)
        lost_w = np.zeros(mc_paths)
        for i in range(N):
            s = plan.get(i, H + 1)
            fp = first_pass[:, i]
            failed = fp < min(s, H)
            fh = np.clip(fp, 0, H - 1)
            wf = np.array(W_fail)[fh]
            dur_f = np.minimum(DF, H - fh)
            cost += np.where(failed, cost_failure + cost_rtg_hour * wf, 0.0)
            fails += failed
            lost += np.where(failed, dur_f, 0.0)
            lost_w += np.where(failed, wf, 0.0)
            if i in plan:
                cost += np.where(~failed, cost_pm + cost_rtg_hour * W_pm[s], 0.0)
                lost += np.where(~failed, D, 0.0)
                lost_w += np.where(~failed, W_pm[s], 0.0)
        ci = 1.96 * float(np.std(cost, ddof=1)) / math.sqrt(mc_paths)
        return {
            "expected_cost_usd": round(float(np.mean(cost)), 0), "cost_ci95_usd": round(ci, 0),
            "expected_failures": round(float(np.mean(fails)), 3),
            "p_at_least_one_failure": round(float(np.mean(fails > 0)), 3),
            "expected_rtg_hours_lost": round(float(np.mean(lost)), 2),
            "expected_workload_weighted_hours_lost": round(float(np.mean(lost_w)), 2)
        }

    # --- 4. Replay sampled outages in the SimPy wave (same paths for each policy)
    def outages_for(plan: Dict[int, int], path_idx: int) -> List[List[float]]:
        out = []
        for i in range(N):
            s = plan.get(i, H + 1)
            fp = int(first_pass[path_idx, i])
            if fp < min(s, H):
                out.append([fp * 60.0, DF * 60.0])
            elif i in plan:
                out.append([s * 60.0, D * 60.0])
        return out

    saved_sim = PORT_STATE["last_simpy_metrics"]
    saved_sea = PORT_STATE["last_seaside_schedule"]
    plan_beta = saved_sea.get("yard_backpressure_input", 1.0)
    results = {}
    for name, plan in policies.items():
        betas, gate, rtgw, out_h = [], [], [], []
        for k in range(des_replications):
            sim = json.loads(_run_simpy_terminal_simulation(
                des_initial_occupancy_pct, icd_evacuation_ratio=des_icd_ratio, customs_xray_rate=0.14,
                rtg_outages=outages_for(plan, k), seed=2026 + k))
            betas.append(sim["computed_cpsat_backpressure_beta"])
            gate.append(sim["avg_gate_truck_wait_mins"])
            rtgw.append(sim["avg_rtg_handshake_wait_mins"])
            out_h.append(sim["rtg_outage_hrs"])
        beta_mean = float(np.mean(betas))
        # Re-plan the berths only if the outages actually moved the backpressure.
        if abs(beta_mean - plan_beta) > 0.03:
            sea = json.loads(_solve_seaside_berth_and_cranes(enable_dual_cycling=True, yard_backpressure_factor=round(beta_mean, 3)))
            turnaround = sea["avg_turnaround_days"]
        else:
            turnaround = saved_sea["avg_turnaround_days"]
        res = evaluate(plan)
        half = lambda xs: round(1.96 * float(np.std(xs, ddof=1)) / math.sqrt(len(xs)), 3)
        res.update({
            "pm_windows": [{"rtg": fleet[i]["id"], "start_hr": int(s), "end_hr": int(s + D)} for i, s in sorted(plan.items())],
            "des_beta_mean": round(beta_mean, 3), "des_beta_ci95": half(betas),
            "des_gate_truck_wait_mins": round(float(np.mean(gate)), 2), "des_gate_truck_wait_ci95": half(gate),
            "des_rtg_wait_mins": round(float(np.mean(rtgw)), 3),
            "des_rtg_outage_hrs_in_wave": round(float(np.mean(out_h)), 2),
            "cpsat_avg_turnaround_days": turnaround
        })
        results[name] = res
    PORT_STATE["last_simpy_metrics"] = saved_sim
    PORT_STATE["last_seaside_schedule"] = saved_sea

    for f in fleet:
        f.pop("_F")
        f.pop("_alpha_true")
        f["pm_start_hr"] = cbm_plan.get(RTG_FLEET.index(next(c for c in RTG_FLEET if c["id"] == f["id"])))
    out = {
        "model": "stationary Gamma process, first passage of L = 100",
        "horizon_hrs": H, "pm_duration_hrs": D, "cm_duration_hrs": DF, "crew_capacity": crew_capacity,
        "night_shift_hrs": NIGHT_HRS,
        "costs_usd": {"pm": cost_pm, "failure": cost_failure, "rtg_hour_at_full_load": cost_rtg_hour},
        "cpsat_status": solver.StatusName(status), "cpsat_objective_usd": solver.ObjectiveValue(),
        "use_des_utilisation": use_des_utilisation,
        "workload_weight": w, "workload_source": prof["source"], "kappa_util_per_qc": prof["kappa_util_per_qc"],
        "qc_working": qc_working, "rtg_required": rtg_required,
        "nominal_des": {"gate_truck_wait_mins": nominal["avg_gate_truck_wait_mins"], "beta": nominal["computed_cpsat_backpressure_beta"]},
        "fleet": fleet, "policies": results,
        "mc_paths": mc_paths, "des_replications": des_replications,
        "des_scenario": {"initial_yard_occupancy_pct": des_initial_occupancy_pct, "icd_evacuation_ratio": des_icd_ratio}
    }
    PORT_STATE["last_maintenance_plan"] = out
    return json.dumps(out, indent=2)


# ----------------------------------------------------------------------------
# v4-NEW  Tool 8: wind-aware berth planning (time-dependent crane productivity)
# ----------------------------------------------------------------------------
def _wind_forecast_ensemble(n_members: int, horizon_hrs: int, seed: int,
                            squall_center_hr: float, squall_peak_ms: float) -> np.ndarray:
    """Synthetic gust forecast ensemble (m/s), members x hours. A diurnal sea
    breeze with AR(1) error plus one frontal squall whose timing, width and
    strength differ between members. In production this array would come from a
    numerical weather prediction ensemble feed; no anemometer is assumed."""
    rng = np.random.default_rng(seed)
    h = np.arange(horizon_hrs, dtype=float)
    base = 7.0 + 2.5 * np.sin(2.0 * np.pi * (h - 14.0) / 24.0)
    out = np.zeros((n_members, horizon_hrs))
    for m in range(n_members):
        err, e = np.zeros(horizon_hrs), 0.0
        for t in range(horizon_hrs):
            e = 0.8 * e + rng.normal(0.0, 1.0)
            err[t] = e
        bg = np.maximum(base + err, 0.5)
        c = rng.normal(squall_center_hr, 2.0)
        width = rng.uniform(2.0, 3.5)
        peak = rng.normal(squall_peak_ms, 3.0)
        out[m] = bg + np.maximum(peak - bg, 0.0) * np.exp(-((h - c) / width) ** 2)
    return out


def _next_high_tide(hour: int) -> int:
    while tide_height_m(hour) < TIDE_GATE_M:
        hour += 1
    return hour


def _replay_berth_plan(schedule: List[Dict[str, Any]], gust: np.ndarray, eff_gmph: float,
                       total_quay_cranes: int = 10) -> Dict[str, float]:
    """Execute a committed berth plan under one realised gust trace with a
    right-shift policy: berth positions, crane counts and vessel order are kept;
    a vessel starts no earlier than planned, after every earlier vessel whose
    berth span it overlaps has sailed, and (deep draft) on a high tide."""
    meta = {v["id"]: v for v in PORT_STATE["vessels"]}
    placed, total = [], {"turn": 0.0, "wait": 0.0, "hold": 0.0, "late": 0.0, "idle": 0.0, "cost": 0.0}
    busy: Dict[int, int] = {}
    for v in sorted(schedule, key=lambda x: (x["berth_start_hr"], x["vessel_id"])):
        m = meta[v["vessel_id"]]
        deep = m["draft"] >= 9.2
        t = v["berth_start_hr"]
        for (b0, b1, dep) in placed:
            if not (v["berth_end_m"] + 25 <= b0 or b1 + 25 <= v["berth_start_m"]):
                t = max(t, dep)
        if deep:
            t = _next_high_tide(t)
        q = v["assigned_qcs"]
        rate = eff_gmph * ((q ** 0.88) + (0.55 if m["geared"] else 0.0))
        moved, h = 0.0, t
        while moved < m["moves"] - 1e-9:
            f = wind_rate_factor(float(gust[h])) if h < len(gust) else 1.0
            moved += rate * f
            if f == 0.0:
                total["idle"] += q
            busy[h] = busy.get(h, 0) + q
            h += 1
        depart = _next_high_tide(h) if deep else h
        placed.append((v["berth_start_m"], v["berth_end_m"], depart))
        total["turn"] += depart - m["eta"]
        total["wait"] += t - m["eta"]
        total["hold"] += depart - h
        total["late"] += max(0, depart - v["tidal_depart_hr"])
        total["cost"] += (18 if not m["geared"] else 10) * (t - m["eta"]) + 6 * (depart - t) + v["yard_deviation_m"]
    total["turn"] /= len(schedule) * 24.0
    total["pool_exceeded"] = float(max(busy.values()) > total_quay_cranes)
    return total


def _optimize_wind_aware_berth_plan(
    n_members: int = 300, risk_quantiles: Optional[List[float]] = None,
    squall_center_hr: float = 18.0, squall_peak_ms: float = 24.0,
    forecast_horizon_hrs: int = 72, seed: int = 2718,
    yard_backpressure_factor: Optional[float] = None
) -> str:
    """Plans berths and cranes against a gust forecast ensemble. For each risk
    quantile p the planner uses the hourly p-quantile gust, converts it to a crane
    productivity factor, and solves CP-SAT with time-dependent service times.
    Every plan, and the calm-weather plan, is then replayed on all members."""
    risk_quantiles = risk_quantiles or [0.5, 0.75, 0.9]
    last = PORT_STATE["last_seaside_schedule"]
    if yard_backpressure_factor is not None:
        beta = float(yard_backpressure_factor)
    else:
        beta = last["yard_backpressure_input"] if last and last.get("schedule") else 1.0
    eff_gmph = 31.5 / max(beta, 0.5)
    ens = _wind_forecast_ensemble(n_members, forecast_horizon_hrs, seed, squall_center_hr, squall_peak_ms)
    saved = PORT_STATE["last_seaside_schedule"]

    plans = {}
    calm = json.loads(_solve_seaside_berth_and_cranes(enable_dual_cycling=True, yard_backpressure_factor=beta))
    plans["CALM_WEATHER_PLAN"] = {"quantile": None, "sea": calm, "phi": [1.0] * forecast_horizon_hrs}
    for p in risk_quantiles:
        gq = np.quantile(ens, p, axis=0)
        phi = [wind_rate_factor(float(g)) for g in gq]
        sea = json.loads(_solve_seaside_berth_and_cranes(enable_dual_cycling=True, yard_backpressure_factor=beta,
                                                         wind_rate_profile=phi))
        plans[f"WIND_AWARE_P{int(round(p * 100))}"] = {"quantile": p, "sea": sea, "phi": phi}
    PORT_STATE["last_seaside_schedule"] = saved

    def stats(xs: List[float]) -> Dict[str, float]:
        a = np.asarray(xs, dtype=float)
        return {"mean": round(float(a.mean()), 3), "p90": round(float(np.quantile(a, 0.9)), 3),
                "ci95": round(1.96 * float(a.std(ddof=1)) / math.sqrt(len(a)), 3)}

    results = {}
    for name, pl in plans.items():
        sea = pl["sea"]
        if not sea["feasible"]:
            results[name] = {"feasible": False}
            continue
        runs = [_replay_berth_plan(sea["schedule"], ens[m], eff_gmph) for m in range(n_members)]
        results[name] = {
            "feasible": True, "risk_quantile": pl["quantile"], "cpsat_status": sea["solver_status"],
            "planned_objective": sea["objective_value"], "planned_avg_turnaround_days": sea["avg_turnaround_days"],
            "planned_suspended_hours": [h for h, f in enumerate(pl["phi"]) if f == 0.0],
            "realised_cost": stats([r["cost"] for r in runs]),
            "realised_avg_turnaround_days": stats([r["turn"] for r in runs]),
            "realised_anchorage_wait_hrs": stats([r["wait"] for r in runs]),
            "realised_tide_hold_hrs": stats([r["hold"] for r in runs]),
            "departure_slip_vs_plan_hrs": stats([r["late"] for r in runs]),
            "crane_hours_secured": stats([r["idle"] for r in runs]),
            "p_plan_kept": round(float(np.mean([r["late"] == 0 for r in runs])), 3),
            "p_crane_pool_exceeded_in_replay": round(float(np.mean([r["pool_exceeded"] for r in runs])), 3),
            "schedule": sea["schedule"]
        }
    feasible = {k: v for k, v in results.items() if v.get("feasible")}
    best = min(feasible, key=lambda k: feasible[k]["realised_cost"]["mean"])
    fastest = min(feasible, key=lambda k: feasible[k]["realised_avg_turnaround_days"]["mean"])
    steadiest = max(feasible, key=lambda k: feasible[k]["p_plan_kept"])
    out = {
        "model": "CP-SAT with time-dependent service times under a gust-quantile productivity profile",
        "wind_bands_ms": [[lim, fac] for lim, fac in WIND_BANDS], "shutdown_gust_ms": WIND_SHUTDOWN_MS,
        "n_members": n_members, "backpressure_beta": beta,
        "forecast": [{"hour": h, "gust_p10": round(float(np.quantile(ens[:, h], 0.1)), 1),
                      "gust_p50": round(float(np.quantile(ens[:, h], 0.5)), 1),
                      "gust_p90": round(float(np.quantile(ens[:, h], 0.9)), 1),
                      "p_shutdown": round(float(np.mean(ens[:, h] >= WIND_SHUTDOWN_MS)), 3)}
                     for h in range(forecast_horizon_hrs)],
        "replay_policy": "right-shift; no vessel berths before its planned time (Virtual Arrival commitment)",
        "plans": results, "lowest_realised_cost_plan": best,
        "lowest_realised_turnaround_plan": fastest, "most_reliable_plan": steadiest
    }
    PORT_STATE["last_wind_plan"] = out
    return json.dumps(out, indent=2)


# ----------------------------------------------------------------------------
# v5-NEW  Tools 9 and 10: two-way coupling by simulation-generated Benders cuts
# ----------------------------------------------------------------------------
def _run_logic_benders_simopt(
    initial_yard_occupancy_pct: float = 84.0, icd_evacuation_ratio: float = 0.24,
    enable_dual_cycling: bool = True, sim_replications: int = 20, max_iterations: int = 8,
    rtg_outages: Optional[List[List[float]]] = None, crane_outages: Optional[List[List[int]]] = None,
    eta_shift_hrs: Optional[Dict[str, int]] = None, compare_scalar: bool = True
) -> str:
    """Logic-based Benders loop in which the DES reads the plan.

    Master (CP-SAT): berth plan with service times p_v(q) = ceil(M_v / (g e_v(q) / B(q))).
    Subproblem (SimPy): for each crane intensity the master uses, simulate the
    yard cluster receiving a wave at that intensity and measure B(q).
    Cut: replace the optimistic B(q) = 1 by the simulated value.

    Unsimulated modes keep B = 1, the fastest they can ever be, so each master is
    a relaxation and its objective a lower bound. When the master's plan uses
    only simulated modes the bound is attained and the plan is optimal for the
    simulated response. At most one cut per mode, so the loop is finite.
    [ASSUMPTION] every berth feeds its own yard cluster of the same design."""
    if not PORT_STATE["last_yard_metrics"]:
        _generate_and_parse_baplie("V1_GEARLESS_MEGA", 180)
        _optimize_3d_yard_and_reefers(True, 45)
    saved_sim, saved_sea = PORT_STATE["last_simpy_metrics"], PORT_STATE["last_seaside_schedule"]
    cuts: Dict[str, float] = {}
    sims: Dict[str, Dict[str, Any]] = {}

    def simulate(key: str) -> float:
        if key not in sims:
            sims[key] = _simulate_replicated(sim_replications, initial_yard_occupancy_pct, icd_evacuation_ratio, 0.14,
                                             rtg_outages=rtg_outages, qc_intensity=float(key) / E_REF)
        return sims[key]["computed_cpsat_backpressure_beta"]

    def master(table: Dict[str, float], force: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        return json.loads(_solve_seaside_berth_and_cranes(
            enable_dual_cycling=enable_dual_cycling, mode_beta=table, force_qcs=force,
            crane_outages=crane_outages, eta_shift_hrs=eta_shift_hrs))

    trace, sea, converged = [], None, False
    for it in range(1, max_iterations + 1):
        sea = master(cuts)
        if not sea["feasible"]:
            break
        used = sorted({v["crane_intensity"] for v in sea["schedule"]})
        new = [k for k in used if k not in cuts]
        row = {"iteration": it, "master_objective": sea["objective_value"],
               "avg_turnaround_days": sea["avg_turnaround_days"],
               "cranes": {v["vessel_id"]: v["assigned_qcs"] for v in sea["schedule"]}, "cuts_added": {}}
        for k in new:
            cuts[k] = simulate(k)
            row["cuts_added"][k] = cuts[k]
        trace.append(row)
        if not new:
            converged = True
            break

    out: Dict[str, Any] = {
        "method": "logic-based Benders with simulation-generated cuts",
        "scenario": {"initial_yard_occupancy_pct": initial_yard_occupancy_pct, "icd_evacuation_ratio": icd_evacuation_ratio,
                     "rtg_outages": rtg_outages or [], "crane_outages": crane_outages or [], "eta_shift_hrs": eta_shift_hrs or {}},
        "convergence_status": "CONVERGED" if converged else ("INFEASIBLE" if not (sea and sea["feasible"]) else "MAX_ITERATIONS"),
        "iterations_run": len(trace), "cuts": dict(sorted(cuts.items())), "modes_simulated": len(sims), "trace": trace
    }
    if sea and sea["feasible"]:
        worst = max((v["crane_intensity"] for v in sea["schedule"]), key=float)
        y = sims.get(worst) or {}
        out["plan"] = {
            "objective": sea["objective_value"], "avg_turnaround_days": sea["avg_turnaround_days"],
            "total_anchorage_wait_hrs": sea["total_anchorage_wait_hrs"], "cpsat_status": sea["solver_status"],
            "backpressure_beta_max": max(cuts[v["crane_intensity"]] for v in sea["schedule"]),
            "peak_yard_occupancy_pct": y.get("peak_yard_occupancy_pct"),
            "wave_start_yard_occupancy_pct": y.get("wave_start_yard_occupancy_pct"),
            "avg_gate_truck_wait_mins": y.get("avg_gate_truck_wait_mins"),
            "avg_rtg_wait_mins": y.get("avg_rtg_handshake_wait_mins"),
            "unproductive_rehandle_hrs": y.get("unproductive_rehandle_crane_hrs"),
            "schedule": sea["schedule"]
        }
        if compare_scalar:
            # What the one-number loop would do: plan every mode at B(reference gang).
            beta_ref = simulate(f"{E_REF:.3f}")
            believed = json.loads(_solve_seaside_berth_and_cranes(
                enable_dual_cycling=enable_dual_cycling, yard_backpressure_factor=beta_ref,
                crane_outages=crane_outages, eta_shift_hrs=eta_shift_hrs))
            if believed["feasible"]:
                force = {v["vessel_id"]: v["assigned_qcs"] for v in believed["schedule"]}
                table = {mode_key(q, m["geared"]): simulate(mode_key(q, m["geared"]))
                         for m in PORT_STATE["vessels"] for q in [force[m["id"]]]}
                real = master(table, force)
                out["scalar_loop_plan"] = {
                    "beta_reference_gang": beta_ref, "cranes": force,
                    "believed_objective": believed["objective_value"],
                    "believed_avg_turnaround_days": believed["avg_turnaround_days"],
                    "realised_objective": real["objective_value"],
                    "realised_avg_turnaround_days": real["avg_turnaround_days"],
                    "realised_total_anchorage_wait_hrs": real["total_anchorage_wait_hrs"]
                }
    out["response_surface"] = {k: {"beta": v["computed_cpsat_backpressure_beta"], "beta_ci95": v["beta_ci95"],
                                   "peak_yard_occupancy_pct": v["peak_yard_occupancy_pct"],
                                   "effective_crane_effect": round(float(k) / v["computed_cpsat_backpressure_beta"], 3)}
                               for k, v in sorted(sims.items(), key=lambda kv: float(kv[0]))}
    PORT_STATE["last_simpy_metrics"], PORT_STATE["last_seaside_schedule"] = saved_sim, saved_sea
    return json.dumps(out, indent=2)


def _simulate_disruption(
    rtg_out: int = 0, rtg_out_hours: float = 0.0, qc_out: int = 0, qc_out_hours: int = 0,
    icd_evacuation_ratio: float = 0.24, initial_yard_occupancy_pct: float = 84.0,
    delayed_vessel: Optional[str] = None, delay_hours: int = 0, sim_replications: int = 10
) -> str:
    """One what-if run: yard cranes out from the start of the night shift, quay
    cranes out from plan hour 0, a different ICD ratio or starting occupancy, or
    a late vessel. Re-plans with the two-way loop and returns plan and yard KPIs."""
    rtg = [[0.0, float(rtg_out_hours) * 60.0] for _ in range(int(rtg_out))] if rtg_out and rtg_out_hours else None
    qc = [[0, int(qc_out_hours), int(qc_out)]] if qc_out and qc_out_hours else None
    shift = {delayed_vessel: int(delay_hours)} if delayed_vessel and delay_hours else None
    res = json.loads(_run_logic_benders_simopt(
        initial_yard_occupancy_pct=initial_yard_occupancy_pct, icd_evacuation_ratio=icd_evacuation_ratio,
        sim_replications=sim_replications, rtg_outages=rtg, crane_outages=qc, eta_shift_hrs=shift, compare_scalar=False))
    out = {"inputs": {"rtg_out": rtg_out, "rtg_out_hours": rtg_out_hours, "qc_out": qc_out, "qc_out_hours": qc_out_hours,
                      "icd_evacuation_ratio": icd_evacuation_ratio, "initial_yard_occupancy_pct": initial_yard_occupancy_pct,
                      "delayed_vessel": delayed_vessel, "delay_hours": delay_hours},
           "convergence_status": res["convergence_status"], "iterations_run": res["iterations_run"], "cuts": res["cuts"]}
    if "plan" in res:
        out["kpis"] = {k: v for k, v in res["plan"].items() if k != "schedule"}
        out["schedule"] = res["plan"]["schedule"]
    return json.dumps(out, indent=2)


# ----------------------------------------------------------------------------
# FastMCP tool endpoints
# ----------------------------------------------------------------------------
@mcp.tool()
def generate_and_parse_baplie(vessel_id: str = "V1_GEARLESS_MEGA", num_containers: int = 180) -> str:
    """Generates and parses a UN/EDIFACT BAPLIE stowage message and checks ship-level GM and list."""
    return _generate_and_parse_baplie(vessel_id, num_containers)


@mcp.tool()
def solve_seaside_berth_and_cranes(quay_length_m: int = 1050, total_quay_cranes: int = 10, enable_dual_cycling: bool = True, yard_backpressure_factor: float = 1.0, horizon_hrs: int = 168, wind_rate_profile: Optional[List[float]] = None, mode_beta: Optional[Dict[str, float]] = None, crane_outages: Optional[List[List[int]]] = None, eta_shift_hrs: Optional[Dict[str, int]] = None) -> str:
    """Integrated berth allocation and quay crane assignment in CP-SAT with tidal windows, optional hourly wind derating, mode-dependent backpressure, crane outages and vessel delays."""
    return _solve_seaside_berth_and_cranes(quay_length_m, total_quay_cranes, enable_dual_cycling, yard_backpressure_factor, horizon_hrs, wind_rate_profile, mode_beta, None, crane_outages, eta_shift_hrs)


@mcp.tool()
def optimize_3d_yard_and_reefers(enable_weibull_stacking: bool = True, max_night_premarshal_moves: int = 45, prefill_pct: float = 50.0, vessel_id: str = "V1_GEARLESS_MEGA") -> str:
    """3D yard stacking for a vessel's parcel, greedy night pre-marshalling and the 24 h reefer RC model."""
    return _optimize_3d_yard_and_reefers(enable_weibull_stacking, max_night_premarshal_moves, prefill_pct, vessel_id)


@mcp.tool()
def run_simpy_terminal_simulation(initial_yard_occupancy_pct: float = 83.0, icd_evacuation_ratio: float = 0.22, customs_xray_rate: float = 0.14, rtg_fleet: int = 8, rtg_outages: Optional[List[List[float]]] = None, seed: int = 2026, qc_intensity: float = 1.0) -> str:
    """SimPy DES of a night shift and discharge wave with a closed prime-mover loop, RTG outages and a crane-intensity input."""
    return _run_simpy_terminal_simulation(initial_yard_occupancy_pct, icd_evacuation_ratio, customs_xray_rate, rtg_fleet, rtg_outages, seed, qc_intensity=qc_intensity)


@mcp.tool()
def run_closed_loop_simopt_benders(max_iterations: int = 4, tolerance: float = 0.03, sim_replications: int = 20, initial_yard_occupancy_pct: float = 84.0, icd_evacuation_ratio: float = 0.24) -> str:
    """Damped fixed-point coupling of the CP-SAT seaside plan and the SimPy yard model."""
    return _run_closed_loop_simopt_benders(max_iterations, tolerance, sim_replications, initial_yard_occupancy_pct, icd_evacuation_ratio)


@mcp.tool()
def optimize_rtg_predictive_maintenance(horizon_hrs: int = 48, pm_duration_hrs: int = 4, crew_capacity: int = 2, mc_paths: int = 5000, des_replications: int = 20, use_des_utilisation: bool = True) -> str:
    """v3.0: Gamma-process RTG prognostics and CP-SAT maintenance-window scheduling against DES-measured RTG utilisation."""
    return _optimize_rtg_predictive_maintenance(horizon_hrs=horizon_hrs, pm_duration_hrs=pm_duration_hrs, crew_capacity=crew_capacity, mc_paths=mc_paths, des_replications=des_replications, use_des_utilisation=use_des_utilisation)


@mcp.tool()
def optimize_wind_aware_berth_plan(n_members: int = 300, risk_quantiles: Optional[List[float]] = None, squall_center_hr: float = 18.0, squall_peak_ms: float = 24.0, yard_backpressure_factor: Optional[float] = None) -> str:
    """v4.0: berth and crane plan against a gust forecast ensemble, with time-dependent crane productivity, replayed on every member."""
    return _optimize_wind_aware_berth_plan(n_members, risk_quantiles, squall_center_hr, squall_peak_ms, yard_backpressure_factor=yard_backpressure_factor)


@mcp.tool()
def sweep_icd_evacuation_valve(ratios: Optional[List[float]] = None, initial_yard_occupancy_pct: float = 84.0, sim_replications: int = 20) -> str:
    """What-if sweep of the off-dock ICD evacuation ratio against backpressure, peak occupancy and turnaround."""
    return _sweep_icd_evacuation_valve(ratios, initial_yard_occupancy_pct, sim_replications)


@mcp.tool()
def run_logic_benders_simopt(initial_yard_occupancy_pct: float = 84.0, icd_evacuation_ratio: float = 0.24, enable_dual_cycling: bool = True, sim_replications: int = 20) -> str:
    """v5.0: two-way plan and yard coupling. CP-SAT master, SimPy subproblem, one Benders cut per crane mode."""
    return _run_logic_benders_simopt(initial_yard_occupancy_pct, icd_evacuation_ratio, enable_dual_cycling, sim_replications)


@mcp.tool()
def simulate_disruption(rtg_out: int = 0, rtg_out_hours: float = 0.0, qc_out: int = 0, qc_out_hours: int = 0, icd_evacuation_ratio: float = 0.24, initial_yard_occupancy_pct: float = 84.0, delayed_vessel: Optional[str] = None, delay_hours: int = 0) -> str:
    """v5.0: what-if run for a disruption (yard or quay cranes out, ICD ratio, starting occupancy, late vessel), re-planned with the two-way loop."""
    return _simulate_disruption(rtg_out, rtg_out_hours, qc_out, qc_out_hours, icd_evacuation_ratio, initial_yard_occupancy_pct, delayed_vessel, delay_hours)


if __name__ == "__main__":
    mcp.run()
