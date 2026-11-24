"""Hamburg site model: quay geometry, terminal assignment, the Elbe tide rule and a plan on real collected data
(AIS and gauge forecasts collected on 15 Nov 2026, in tests/fixtures_hamburg_store)."""
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT)]
import chattogram_nct as nct  # noqa: E402
import hamburg as hh  # noqa: E402

STORE = ROOT / "tests" / "fixtures_hamburg_store"
NOW = datetime(2026, 11, 15, 14, 30, tzinfo=timezone.utc)
_LIVE = {}


def live():
    if "x" not in _LIVE:
        _LIVE["x"] = hh.build_live(STORE, NOW)
    return _LIVE["x"]


def test_quay_lengths_match_published_figures():
    q = hh.QUAYS
    ctb = q["CTB-W"]["length_m"] + q["CTB-P"]["length_m"]
    assert 2500 < ctb < 3100                    # HHLA: Burchardkai about 2,850 m
    assert 1300 < q["CTA"]["length_m"] < 1700   # Altenwerder about 1,400 m
    assert 1100 < q["CTT"]["length_m"] < 1400   # Tollerort about 1,240 m
    assert 1900 < q["CTH"]["length_m"] < 2300   # Eurogate Predoehlkai about 2,100 m


def test_moored_ships_are_placed_at_the_right_terminal():
    assert hh.locate(53.53091, 9.91705)[0] == "CTB-W"      # EVER APEX
    assert hh.locate(53.5309, 9.95278)[0] == "CTT"         # COSCO SHIPPING LEO
    assert hh.locate(53.5027, 9.93797)[0] == "CTA"         # LAEM CHABANG EXPRESS
    assert hh.locate(53.52566, 9.92557)[0] == "CTH"        # MAERSK MONTE LINZOR
    assert hh.locate(53.53092, 9.99919) is None            # GRANDE AFRICA, a ro-ro berth: not a container quay


def test_carrier_names_map_to_terminals():
    assert hh.terminal_for("QUEBEC EXPRESS") == "CTA" and hh.terminal_for("COSCO SHIPPING LEO") == "CTT"
    assert hh.terminal_for("SAN RAPHAEL MAERSK") == "CTH" and hh.terminal_for("MSC VIOLA") == "CTB"
    assert hh.terminal_for("ELBWIND") is None


def test_draught_limits_follow_the_fairway_rule():
    assert hh.limits(300, 48) == (13.8, 16.1 - 0.2, 14.8 - 0.2)
    assert hh.limits(400, 61) == (13.1, 15.4 - 0.2, 14.1 - 0.2)


def test_live_input_from_real_data():
    lv = live()
    assert len(lv["gauges"]) == 6 and len(lv["vessels"]) >= 4 and len(lv["fixed_occupants"]) >= 6
    for o in lv["fixed_occupants"]:                         # packed occupants never overlap on the quay axis
        for p in lv["fixed_occupants"]:
            if o is not p and o["quay"] == p["quay"]:
                assert o["berth_start_m"] + o["loa_m"] + hh.HAM["berth_gap_m"] <= p["berth_start_m"] + 1 or p["berth_start_m"] + p["loa_m"] + hh.HAM["berth_gap_m"] <= o["berth_start_m"] + 1
    assert all(v["terminal"] in hh.TERMINALS for v in lv["vessels"])
    assert any(e["name"] == "GRANDE AFRICA" for e in lv["excluded"]) or all(v["name"] != "GRANDE AFRICA" for v in lv["vessels"])


def test_tide_independent_ships_always_pass_and_deep_ships_need_water():
    lv = live()
    vs = {v["id"]: v for v in hh.planning_vessels(lv)}
    shallow = next(v for v in vs.values() if v["draft"] <= 13.0)
    a, b = hh.gate_windows(lv, [], shallow, 120, 6)
    assert len(a) == 120 - 12 - shallow["eta"] - 6
    deep = dict(shallow, draft=15.0, eta=0)
    a2, _ = hh.gate_windows(lv, [], deep, 120, 6)
    assert 0 < len(a2) < len(range(6, 108))
    for h in a2:                                            # every hour on the critical reach has the water
        for k in range(6):
            km = hh.KM_SEA - (hh.KM_SEA - hh.KM_PORT) * (k + 0.5) / 6
            if hh.CRITICAL_REACH[0] <= km <= hh.CRITICAL_REACH[1]:
                assert hh._above_mlw(lv, km, h - 6 + k) >= 15.0 - 13.8 + hh.margin_m(lv, h - 6 + k)


def test_plan_respects_terminals_pools_and_gates():
    lv = live()
    r = nct.run_nct_benders(lv, cfg=hh.HAM, rules=hh, sim_replications=3)
    assert r["convergence_status"] == "CONVERGED"
    gates = hh.gates_bitmap(lv, hh.HAM["horizon_hrs"], hh.HAM["transit_hrs"])
    ranges = {t: [(q["axis_lo"], q["axis_hi"]) for q in hh.QUAYS.values() if q["terminal"] == t] for t in hh.TERMINALS}
    for row in r["schedule"]:
        assert any(lo <= row["berth_start_m"] and row["berth_end_m"] <= hi for lo, hi in ranges[row["quay"]])
        assert gates[row["vessel_id"]]["in"][row["berth_start_hr"]] == "1" and gates[row["vessel_id"]]["out"][row["tidal_depart_hr"]] == "1"
    for t, cap in hh.STS.items():
        for h in range(hh.HAM["horizon_hrs"]):
            assert sum(x["assigned_qcs"] for x in r["schedule"] if x["quay"] == t and x["berth_start_hr"] <= h < x["cargo_done_hr"]) <= cap


def test_moored_ships_stay_alongside_between_sparse_ais_reports():
    """The collector runs irregularly: a ship heard moored 30 h ago is still alongside while its estimated working
    time lasts, and counted as sailed (not as a new arrival) once that time is over."""
    from datetime import timedelta
    later = hh.build_live(STORE, NOW + timedelta(hours=30))
    names = {o["name"] for o in later["fixed_occupants"]}
    assert "EVER APEX" in names                                    # long call: still working
    sailed = [e for e in later["excluded"] if "estimated to have sailed" in e["reason"]]
    assert sailed and not ({e["name"] for e in sailed} & {v["name"] for v in later["vessels"]})
    gone = hh.build_live(STORE, NOW + timedelta(hours=60))
    assert gone["fixed_occupants"] == []                           # beyond 48 h nothing is assumed
