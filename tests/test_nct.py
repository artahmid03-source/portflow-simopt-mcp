"""Invariants of the Chattogram NCT site model, checked on the plans the pipeline wrote.
Run `python run_nct_pipeline.py` first; these tests read nct_control_tower_data.json."""
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "sites"))
import chattogram_nct as nct  # noqa: E402

D = json.loads((ROOT / "nct_control_tower_data.json").read_text())
LIVE, C, TIDE = D["live"], D["config"], D["tide_hourly"]
PLANS = ["baseline", "plan_only", "optimised"]
T = C["transit_hrs"]


def test_tide_curve_reproduces_published_turning_points():
    epoch = datetime.fromisoformat(LIVE["plan_epoch_local"]).replace(tzinfo=None)
    for stamp, _, height in LIVE["tides"]:
        hrs = (datetime.fromisoformat(stamp) - epoch).total_seconds() / 3600
        if 1 <= hrs <= C["horizon_hrs"] - 1:
            near = TIDE[int(round(hrs))]
            assert abs(near - height) < 0.35, (stamp, near, height)   # hourly sampling of a half-cosine


@pytest.mark.parametrize("plan", PLANS)
def test_every_transit_hour_is_tide_and_daylight_legal(plan):
    for r in D[plan]["schedule"]:
        hours = list(range(r["berth_start_hr"] - T, r["berth_start_hr"])) + list(range(r["tidal_depart_hr"], r["tidal_depart_hr"] + T))
        for h in hours:
            assert nct.transit_ok(LIVE, TIDE, h, r["loa_m"], r["draft_m"]), (plan, r["vessel_id"], h)


@pytest.mark.parametrize("plan", PLANS)
def test_night_restricted_ships_only_move_in_daylight(plan):
    lo, hi = C["daylight_hours"]
    for r in D[plan]["schedule"]:
        if r["loa_m"] > C["night_max_loa_m"] or r["draft_m"] > C["night_max_draught_m"]:
            for h in list(range(r["berth_start_hr"] - T, r["berth_start_hr"])) + list(range(r["tidal_depart_hr"], r["tidal_depart_hr"] + T)):
                assert lo <= nct.clock_hour(LIVE, h) < hi, (plan, r["vessel_id"], h)


@pytest.mark.parametrize("plan", PLANS)
def test_no_two_ships_share_quay_and_time(plan):
    gap = C["berth_gap_m"]
    rects = [(r["berth_start_m"], r["berth_end_m"], r["berth_start_hr"], r["tidal_depart_hr"], r["vessel_id"]) for r in D[plan]["schedule"]]
    for f in LIVE["fixed_occupants"]:
        rects.append((f["berth_start_m"], f["berth_start_m"] + f["loa_m"], 0, f["release_hr"], f["name"]))
    for i, a in enumerate(rects):
        assert a[1] <= C["quay_ocean_m"], a
        for b in rects[i + 1:]:
            time_overlap = a[2] < b[3] and b[2] < a[3]
            space_clear = a[1] + gap <= b[0] + 1 or b[1] + gap <= a[0] + 1
            assert not time_overlap or space_clear, (plan, a, b)


@pytest.mark.parametrize("plan", PLANS)
def test_pilot_tug_sets_and_crane_pool_never_exceeded(plan):
    H = C["horizon_hrs"] + 8
    tugs, cranes = [0] * H, [0] * H
    for f in LIVE["fixed_occupants"]:
        for k in range(T):
            tugs[f["release_hr"] + k] += 1
    for r in D[plan]["schedule"]:
        for k in range(1, T + 1):
            tugs[r["berth_start_hr"] - k] += 1
        for k in range(T):
            tugs[r["tidal_depart_hr"] + k] += 1
        for h in range(r["berth_start_hr"], r["cargo_done_hr"]):
            cranes[h] += r["assigned_qcs"]
    assert max(tugs) <= C["pilot_tug_sets"]
    assert max(cranes) <= C["qgc_total"]


@pytest.mark.parametrize("plan", PLANS)
def test_no_ship_berths_before_it_arrives(plan):
    for r in D[plan]["schedule"]:
        assert r["transit_in_hr"] >= r["eta_hr"] and r["cargo_done_hr"] <= r["tidal_depart_hr"]


@pytest.mark.parametrize("plan", PLANS)
def test_benders_bound_never_falls_and_loop_converges(plan):
    objs = [t["master_objective"] for t in D[plan]["trace"]]
    assert all(b >= a - 1e-6 for a, b in zip(objs, objs[1:]))
    assert D[plan]["convergence_status"] == "CONVERGED"


def test_fewer_pilot_tug_sets_never_improves_the_plan():
    s = D["pilot_tug_sensitivity"]
    assert s["1"]["objective"] >= s["2"]["objective"] >= s["3"]["objective"]


def test_plan_ordering_baseline_worst_optimised_best():
    assert D["baseline"]["kpis"]["objective"] >= D["plan_only"]["kpis"]["objective"] >= D["optimised"]["kpis"]["objective"]


def test_yard_grooming_reduces_inversions_and_moves_no_dangerous_goods():
    y = D["yard"]
    assert y["post_premarshal_blocking_inversions"] < y["initial_blocking_inversions"] < D["yard_baseline"]["initial_blocking_inversions"]
    for b, r, t, *_ in y["premarshal_moves"]:
        assert y["yard_imdg_before"][b - 1][r - 1][t - 1] == 0


def test_stability_and_cold_chain_limits_hold():
    assert D["hydrostatics"]["GM_metacentric_height_m"] >= 1.20 and abs(D["hydrostatics"]["heeling_list_angle_deg"]) <= 3.0
    assert D["reefer"]["cold_chain_breaches"] == 0 and D["reefer"]["max_box_temp_degC"] <= D["reefer"]["cold_chain_limit_degC"]


def test_spring_draught_rule():
    hi = max(range(len(TIDE)), key=lambda h: TIDE[h])
    lo = min(range(len(TIDE)), key=lambda h: TIDE[h])
    assert not nct.transit_ok(LIVE, TIDE, lo, 120, 9.7)                    # never at low water
    assert not nct.transit_ok(LIVE, TIDE, hi, 120, 10.2)                   # never above 10.0 m
    for h in range(len(TIDE) - 3):
        if nct.transit_ok(LIVE, TIDE, h, 120, 9.8):
            assert TIDE[h] >= C["spring_tide_min_m"]


def test_draught_check_reports_fewer_windows_at_reported_draught():
    for d in D["draught_check"]:
        if d["inbound_starts_reported"] is not None and (d["reported_m"] or 0) > d["planned_m"]:
            assert d["inbound_starts_reported"] <= d["inbound_starts_planned"]
