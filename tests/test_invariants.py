"""Physical invariants the engine must satisfy. Run:  pytest -q"""
import json

import pytest

import portflow_mcp as p


@pytest.fixture(scope="module")
def chain():
    baplie = json.loads(p._generate_and_parse_baplie("V1_GEARLESS_MEGA", 180))
    yard = json.loads(p._optimize_3d_yard_and_reefers(True, 45))
    return baplie, yard


def test_manifest_is_reproducible():
    a = p._generate_and_parse_baplie("V1_GEARLESS_MEGA", 180)
    assert a == p._generate_and_parse_baplie("V1_GEARLESS_MEGA", 180)


def test_stability_limits(chain):
    h = chain[0]["hydrostatics"]
    assert h["GM_metacentric_height_m"] >= p.GM_MIN_M
    assert abs(h["heeling_list_angle_deg"]) <= p.LIST_MAX_DEG
    assert h["imo_stability_compliant"]


def test_every_box_is_stacked_and_grooming_never_hurts(chain):
    y = chain[1]
    assert y["containers_unplaced"] == 0
    assert y["post_premarshal_blocking_inversions"] <= y["initial_blocking_inversions"]
    assert y["initial_blocking_inversions"] - y["post_premarshal_blocking_inversions"] == y["night_premarshal_relocations_executed"]


def test_reefer_cold_chain_and_peak(chain):
    r = chain[1]["reefer_rc_thermodynamics"]
    assert r["cold_chain_breaches"] == 0
    assert r["max_box_temp_degC"] <= r["cold_chain_limit_degC"]
    assert r["smart_weekly_max_kw"] <= r["unmanaged_peak_demand_kw"]
    # the cap cannot beat the steady-state energy balance by more than a few percent
    assert r["smart_energy_kwh_per_day"] > 0.9 * r["unmanaged_energy_kwh_per_day"]


@pytest.mark.parametrize("icd", [0.0, 0.12, 0.24])
def test_yard_never_exceeds_capacity_and_beta_is_a_slowdown(chain, icd):
    s = json.loads(p._run_simpy_terminal_simulation(84.0, icd, 0.14))
    assert s["peak_yard_occupancy_pct"] <= 100.0
    assert s["computed_cpsat_backpressure_beta"] >= 1.0
    assert all(0.0 <= u <= 1.0 + 1e-9 for u in s["rtg_utilisation_by_hour"])


def test_more_icd_relief_never_raises_backpressure(chain):
    betas = [p._simulate_replicated(10, 84.0, r, 0.14)["computed_cpsat_backpressure_beta"] for r in (0.0, 0.10, 0.16, 0.24)]
    assert all(b2 <= b1 + 0.02 for b1, b2 in zip(betas, betas[1:]))


def test_berth_plan_is_feasible_and_respects_tide(chain):
    sea = json.loads(p._solve_seaside_berth_and_cranes(yard_backpressure_factor=1.0))
    assert sea["feasible"]
    for v in sea["schedule"]:
        assert v["berth_start_hr"] >= v["eta_hr"] and v["berth_end_m"] <= 1050
        if v["draft_m"] >= 9.2:
            assert p.tide_height_m(v["berth_start_hr"]) >= p.TIDE_GATE_M
            assert p.tide_height_m(v["tidal_depart_hr"]) >= p.TIDE_GATE_M
    sched = sea["schedule"]
    for i, a in enumerate(sched):
        for b in sched[i + 1:]:
            apart_in_time = a["tidal_depart_hr"] <= b["berth_start_hr"] or b["tidal_depart_hr"] <= a["berth_start_hr"]
            apart_in_space = a["berth_end_m"] + 25 <= b["berth_start_m"] or b["berth_end_m"] + 25 <= a["berth_start_m"]
            assert apart_in_time or apart_in_space


def test_failure_cdf_is_a_cdf():
    import numpy as np
    t = np.arange(0, 400.0)
    F = p._gamma_failure_cdf(0.07, 0.8, 90.0, t)
    assert F[0] == 0.0 and np.all(np.diff(F) >= -1e-12) and F[-1] <= 1.0


def test_cbm_beats_both_reference_policies(chain):
    p._run_closed_loop_simopt_benders(4, sim_replications=5)
    m = json.loads(p._optimize_rtg_predictive_maintenance(mc_paths=3000, des_replications=5))
    pol = m["policies"]
    assert pol["GAMMA_CBM_CPSAT"]["expected_cost_usd"] < pol["RUN_TO_FAILURE"]["expected_cost_usd"]
    assert pol["GAMMA_CBM_CPSAT"]["expected_cost_usd"] < pol["TIME_BASED_PM"]["expected_cost_usd"]
    # no window may breach the crew or the fleet-availability constraint
    for h in range(m["horizon_hrs"]):
        out = sum(1 for w in pol["GAMMA_CBM_CPSAT"]["pm_windows"] if w["start_hr"] <= h < w["end_hr"])
        assert out <= min(m["crew_capacity"], 8 - m["rtg_required"][h])


def test_wind_profile_of_ones_reproduces_the_calm_plan(chain):
    calm = json.loads(p._solve_seaside_berth_and_cranes(yard_backpressure_factor=1.0))
    same = json.loads(p._solve_seaside_berth_and_cranes(yard_backpressure_factor=1.0, wind_rate_profile=[1.0] * 168))
    assert calm["objective_value"] == same["objective_value"]


def test_wind_never_shortens_a_plan_and_replay_never_beats_calm(chain):
    import numpy as np
    calm = json.loads(p._solve_seaside_berth_and_cranes(yard_backpressure_factor=1.0))
    phi = [1.0] * 14 + [0.0] * 6 + [1.0] * 148
    windy = json.loads(p._solve_seaside_berth_and_cranes(yard_backpressure_factor=1.0, wind_rate_profile=phi))
    assert windy["feasible"] and windy["objective_value"] >= calm["objective_value"]
    for v in windy["schedule"]:           # no vessel may finish inside a suspended hour
        assert phi[v["cargo_done_hr"] - 1] > 0.0
    still = p._replay_berth_plan(calm["schedule"], np.zeros(72), 31.5)
    gale = np.zeros(72); gale[14:20] = 25.0
    blown = p._replay_berth_plan(calm["schedule"], gale, 31.5)
    assert abs(still["turn"] - calm["avg_turnaround_days"]) < 0.006 and still["late"] == 0
    assert blown["turn"] >= still["turn"]


def test_event_log_does_not_change_the_simulation(chain):
    a = json.loads(p._run_simpy_terminal_simulation(84.0, 0.24, 0.14))
    b = json.loads(p._run_simpy_terminal_simulation(84.0, 0.24, 0.14, log_events=True))
    events = b.pop("event_log")
    assert a == b and len(events) > 1000


@pytest.fixture(scope="module")
def cut_loops(chain):
    return {r: json.loads(p._run_logic_benders_simopt(icd_evacuation_ratio=r, sim_replications=10)) for r in (0.24, 0.0)}


def test_benders_master_is_a_rising_lower_bound(cut_loops):
    for res in cut_loops.values():
        objs = [row["master_objective"] for row in res["trace"]]
        assert res["convergence_status"] == "CONVERGED"
        assert all(b >= a for a, b in zip(objs, objs[1:]))
        assert res["trace"][-1]["cuts_added"] == {} and res["plan"]["objective"] == objs[-1]
        assert res["iterations_run"] <= 7                     # at most one cut round per crane mode


def test_cut_plan_is_no_worse_than_the_scalar_plan(cut_loops):
    for res in cut_loops.values():
        assert res["plan"]["objective"] <= res["scalar_loop_plan"]["realised_objective"] + 1e-9


def test_uncongested_yard_gives_the_same_plan_under_both_loops(cut_loops):
    res = cut_loops[0.24]
    assert all(abs(b - 1.0) < 0.01 for b in res["cuts"].values())
    assert res["plan"]["objective"] == res["scalar_loop_plan"]["believed_objective"]


def test_fewer_cranes_never_raise_backpressure(chain):
    betas = [p._simulate_replicated(10, 84.0, 0.12, 0.14, qc_intensity=x)["computed_cpsat_backpressure_beta"] for x in (1.0, 0.78, 0.54)]
    assert all(b2 <= b1 + 0.02 for b1, b2 in zip(betas, betas[1:]))


def test_quay_crane_outage_and_late_vessel_never_improve_the_plan(chain):
    calm = json.loads(p._solve_seaside_berth_and_cranes())
    out = json.loads(p._solve_seaside_berth_and_cranes(crane_outages=[[0, 24, 3]]))
    late = json.loads(p._solve_seaside_berth_and_cranes(eta_shift_hrs={"V3_GEARLESS_MAIN": 6}))
    assert out["feasible"] and out["objective_value"] >= calm["objective_value"]
    assert late["feasible"]
    assert [v for v in late["schedule"] if v["vessel_id"] == "V3_GEARLESS_MAIN"][0]["berth_start_hr"] >= 12
