"""v6.4: the port's own lists, newer river rules, Elbe meeting and wind rules, money/fuel/risk figures and the backtest."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT / "ingest"), str(ROOT)]
import advice  # noqa: E402
import chattogram_live as cl  # noqa: E402
import chattogram_nct as nct  # noqa: E402
import hamburg as hh  # noqa: E402
import hamburg_expected as he  # noqa: E402
import run_backtest  # noqa: E402

PAGE = (ROOT / "tests" / "fixtures_hamburg_expected.html").read_text(encoding="utf-8-sig")
NOW = datetime(2026, 11, 15, 14, 30, tzinfo=timezone.utc)


def _store(tmp: Path) -> Path:
    import shutil
    shutil.copytree(ROOT / "tests" / "fixtures_hamburg_store", tmp / "s")
    he.save(tmp / "s", he.parse(PAGE), datetime(2026, 11, 15, 14, 0, tzinfo=timezone.utc))
    return tmp / "s"


def test_expected_list_is_parsed_with_terminals_and_utc_times():
    ships = he.parse(PAGE)
    assert len(ships) == 19
    ava = next(s for s in ships if s["name"] == "Ava D")
    assert ava["terminal"] == "CTA" and ava["time_utc"] == "2026-11-16T22:00Z" and ava["imo"] == 9306225 and ava["draught_m"] == 10.2
    assert {s["terminal"] for s in ships if s["terminal"]} <= {"CTA", "CTB", "CTH", "CTT"}


def test_port_list_overrides_guesses_and_adds_feeders(tmp_path):
    lv = hh.build_live(_store(tmp_path), NOW)
    by = {v["name"]: v for v in lv["vessels"]}
    assert by["ISTANBUL EXPRESS"]["terminal"] == "CTA" and "expected-vessel list" in by["ISTANBUL EXPRESS"]["terminal_basis"]
    assert by["BJORG"]["terminal"] == "CTB" and by["BJORG"]["mmsi"] is None          # a feeder AIS never heard declaring Hamburg
    assert all(v["w_wait"] >= v["w_occ"] >= 1 for v in lv["vessels"])


def test_passing_box_offsets_and_wide_pairs():
    assert hh.box_deltas(6) == [5]                       # inbound and outbound meet between Wedel and Blankenese only then
    rules = hh.meeting_rules({"fixed_occupants": []}, [{"id": "A", "beam": 61}, {"id": "B", "beam": 48}, {"id": "C", "beam": 32}])
    pairs = {(a, b): allowed for a, b, allowed in rules}
    assert pairs[("A", "B")] == [] and pairs[("A", "C")] == [5] and ("B", "C") not in pairs


def test_plan_keeps_wide_ships_apart_and_holds_big_ships_in_wind(tmp_path):
    lv = hh.build_live(_store(tmp_path), NOW)
    lv["wind_ms_hourly"] = [20.0 if 30 <= h < 40 else 5.0 for h in range(123)]
    r = nct.run_nct_benders(lv, cfg=hh.HAM, rules=hh, sim_replications=2)
    assert r["convergence_status"] == "CONVERGED"
    T, rows = hh.HAM["transit_hrs"], {x["vessel_id"]: x for x in r["schedule"]}
    rel = {o["name"]: o["release_hr"] for o in lv["fixed_occupants"]}
    for a, b, allowed in hh.meeting_rules(lv, hh.planning_vessels(lv)):
        if a in rows and (b in rows or b in rel):
            d = (rows[b]["tidal_depart_hr"] if b in rows else rel[b]) - (rows[a]["berth_start_hr"] - T)
            assert abs(d) >= T or d in allowed, (a, b, d)
    for x in r["schedule"]:
        v = next(v for v in lv["vessels"] if v["name"] == x["vessel_id"])
        if v["big_ship"]:
            for h in list(range(x["berth_start_hr"] - T, x["berth_start_hr"])) + list(range(x["tidal_depart_hr"], x["tidal_depart_hr"] + T)):
                assert not 30 <= h < 40, (x["vessel_id"], h)


def test_koehlbrand_sends_wide_hapag_ships_to_burchardkai():
    assert hh.terminal_for("BERLIN EXPRESS", 61.0) == "CTB" and hh.terminal_for("LAEM CHABANG EXPRESS", 48.0) == "CTA"


def test_chattogram_movements_only_around_high_water():
    series = [(datetime(2026, 11, 13, 0, tzinfo=cl.DHAKA) + timedelta(hours=i), 1.2 * __import__("math").sin(i * 2 * 3.14159 / 12.42)) for i in range(400)]
    lv = cl.build_live(Path("/tmp/none"), datetime(2026, 11, 13, 5, 30, tzinfo=timezone.utc), fetch=lambda: series)
    assert lv["rules"]["max_draught_m"] == 10.0 and lv["hw_windows"]
    tide = nct.tide_curve(lv, 192)
    for h in range(192):
        if nct.transit_ok(lv, tide, h, 150.0, 7.0):
            assert any(a <= h < b for a, b in lv["hw_windows"])


def test_due_list_is_used_while_fresh(tmp_path, monkeypatch):
    csv = tmp_path / "due.csv"
    csv.write_text("list_date,name,imo,length_m,beam_m,draught_m,arrival_date,last_port,agent,anchorage\n"
                   "2026-11-13,TEST FEEDER,9000001,172,27,9.6,2026-11-14,Colombo,Agent Ltd,B\n"
                   "2026-11-01,OLD SHIP,9000002,172,27,9.6,2026-11-02,Colombo,Agent Ltd,B\n")
    monkeypatch.setattr(cl, "DUE_CSV", csv)
    lv = cl.build_live(Path("/tmp/none"), datetime(2026, 11, 13, 5, 30, tzinfo=timezone.utc), fetch=lambda: [])
    names = [v["name"] for v in lv["vessels"]]
    assert "TEST FEEDER" in names and "OLD SHIP" not in names
    assert next(v for v in lv["vessels"] if v["name"] == "TEST FEEDER")["source"] == "port due list"


def test_just_in_time_advice_saves_fuel_and_risk_is_a_probability():
    live = {"vessels": [{"name": "X", "teu_est": 1700, "sog_kn": 14.0}]}
    cfg = {"transit_hrs": 2, "horizon_hrs": 192}
    row = {"vessel_id": "X", "eta_hr": 40, "transit_in_hr": 70, "berth_start_hr": 72, "tidal_depart_hr": 100, "anchorage_wait_hrs": 30}
    f = advice.plan_figures(live, [row], cfg, {"X": list(range(70, 76)) + list(range(90, 96))}, {"X": 560.0})
    s = f["ships"][0]
    assert s["jit"]["speed_advised_kn"] < 14.0 and s["jit"]["fuel_saved_t"] > 0
    assert 0.0 <= s["risk"]["p_miss"] <= 1.0 and s["risk"]["next_window_hr"] == 90
    assert advice.cost_weights(20000)["w_occ"] > advice.cost_weights(1500)["w_occ"]


def test_backtest_matches_plans_with_ais_moorings(tmp_path):
    site = tmp_path / "hamburg"
    (site / "plans").mkdir(parents=True)
    (site / "positions").mkdir()
    (site / "plans" / "2026-11-14.json").write_text(json.dumps({"generated_utc": "2026-11-14T04:00:00+00:00", "rows": [
        {"vessel_id": "TEST SHIP", "mmsi": 211000001, "terminal": "CTA", "berth_start_m": 7000, "berth_start_utc": "2026-11-15T06:00Z", "depart_utc": "2026-11-16T06:00Z"}]}))
    rows = [{"t": "2026-11-15T09:00:00Z", "mmsi": 211000001, "lat": 53.5027, "lon": 9.938, "sog": 0.0, "nav": 5, "zone": "PORT"},
            {"t": "2026-11-16T10:00:00Z", "mmsi": 211000001, "lat": 53.53, "lon": 9.85, "sog": 9.0, "nav": 0, "zone": "ELBE"}]
    for d in ("2026-11-15", "2026-11-16"):
        (site / "positions" / f"{d}.jsonl").write_text("\n".join(json.dumps(r) for r in rows if r["t"].startswith(d)) + "\n")
    doc = run_backtest.run(tmp_path, datetime(2026, 11, 17, tzinfo=timezone.utc))
    rec = doc["records"][0]
    assert rec["berth_err_h"] == 3.0 and rec["depart_err_h"] == 4.0 and rec["terminal_ok"] is True
    assert doc["plan"]["n"] == 1 and doc["plan"]["mae_h"] == 3.0
