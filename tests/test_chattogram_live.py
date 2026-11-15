"""Chattogram live input: routing, AIS -> vessel records, calibrated tide, fallback, and a plan on the result."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT)]
import chattogram_live as cl  # noqa: E402
import chattogram_nct as nct  # noqa: E402

FIX = json.loads((ROOT / "tests" / "fixtures_open_meteo_chattogram.json").read_text())
SERIES = [(datetime.fromisoformat(FIX["start_local"]).replace(tzinfo=cl.DHAKA) + timedelta(hours=i), v) for i, v in enumerate(FIX["hourly_m"])]
NOW = datetime(2026, 11, 13, 5, 30, tzinfo=timezone.utc)          # plan epoch 13 Nov 12:00 Dhaka, the snapshot's epoch


def _store(tmp: Path, rows):
    s = tmp / "chattogram"
    (s / "positions").mkdir(parents=True)
    ships, tracked, pos = {}, {}, []
    for r in rows:
        ships[str(r["mmsi"])] = {"name": r["name"], "imo": r["imo"], "type": 70, "len": r["len"], "beam": r["beam"]}
        tracked[str(r["mmsi"])] = {"first_seen": "2026-11-12T00:00:00Z", "last_seen": "2026-11-13T04:00:00Z", "name": r["name"], "imo": r["imo"],
                                   "dest": "CHITTAGONG", "draught": r.get("draught"), "len": r["len"], "eta_utc": r.get("eta")}
        if "lat" in r:
            pos.append({"t": "2026-11-13T04:00:00Z", "mmsi": r["mmsi"], "lat": r["lat"], "lon": r["lon"], "sog": r.get("sog"), "cog": 315.0, "hdg": 315, "nav": 0, "zone": "BAY_FAR", "src": "track"})
    (s / "ships.json").write_text(json.dumps(ships))
    (s / "tracked.json").write_text(json.dumps(tracked))
    (s / "positions" / "2026-11-13.jsonl").write_text("\n".join(json.dumps(p) for p in pos) + "\n")
    return s


def test_route_from_singapore_goes_through_malacca():
    d, region = cl.route_nm(1.25, 103.9)
    assert region == "Singapore Strait"
    assert 1500 < d < 1800                                          # published Singapore-Chittagong distance is about 1,650 nm


def test_route_from_colombo_rounds_sri_lanka():
    d, region = cl.route_nm(6.95, 79.8)
    assert "Colombo" in region and 1150 < d < 1350


def test_teu_estimate_is_in_a_sensible_range():
    assert 1200 < cl.teu_estimate(182.5, 25.2) < 2000                 # a typical Chattogram feeder
    assert 18000 < cl.teu_estimate(400, 61) < 26000


def test_calibrated_model_reproduces_the_published_extremes():
    epoch = datetime(2026, 11, 13, 12, tzinfo=cl.DHAKA)
    tb = cl.tide_block(epoch, 195, lambda: SERIES, json.loads(cl.SNAPSHOT.read_text()))
    assert tb["model_hours"] == 195
    pub = json.loads(cl.SNAPSHOT.read_text())["tides"]
    errs = []
    for t, _, h in pub:
        x = (datetime.fromisoformat(t).replace(tzinfo=cl.DHAKA) - epoch).total_seconds() / 3600.0
        if 0 <= x < 194:
            errs.append(abs(cl.calibrated(SERIES, [epoch + timedelta(hours=x)])[0] - h))
    assert len(errs) > 25 and max(errs) < 0.3 and sum(e * e for e in errs) / len(errs) < 0.15 ** 2


def test_tide_falls_back_to_the_harmonic_fit_when_the_api_fails():
    def boom():
        raise OSError("network down")
    tb = cl.tide_block(datetime(2026, 11, 13, 12, tzinfo=cl.DHAKA), 50, boom, json.loads(cl.SNAPSHOT.read_text()))
    assert tb["model_hours"] == 0 and tb["hourly_m"] == tb["harmonic_m"] and "network down" in tb["error"]
    assert 0.9 < tb["harmonic_amplitudes_m"]["M2"] < 1.5


def test_ais_ships_dead_reckoned_excluded_and_merged_with_the_schedule(tmp_path):
    _store(tmp_path, [
        {"mmsi": 563000001, "imo": 9000001, "name": "TEST FEEDER", "len": 172, "beam": 27, "draught": 9.8, "lat": 1.25, "lon": 103.9, "sog": 14.0},
        {"mmsi": 563000002, "imo": 9000002, "name": "BIG BULKER", "len": 229, "beam": 32, "draught": 12.0, "eta": "2026-11-15T06:00Z"},
        {"mmsi": int(json.loads(cl.SNAPSHOT.read_text())["vessels"][0]["mmsi"]), "imo": 9354648, "name": "HAIAN ZETA", "len": 183, "beam": 25, "draught": 8.8, "eta": "2026-11-14T03:00Z"},
    ])
    live = cl.build_live(tmp_path / "chattogram", NOW, fetch=lambda: SERIES)
    by = {v["name"]: v for v in live["vessels"]}
    f = by["TEST FEEDER"]
    assert f["source"] == "AIS" and f["draught_used_m"] == 9.5 and "dead reckoning" in f["eta_basis"]
    assert 100 < f["eta_hr"] < 130                                   # about 1,650 nm at 14 kn
    assert by["HAIAN ZETA"]["source"] == "AIS" and by["HAIAN ZETA"]["eta_hr"] == 21
    assert "BIG BULKER" not in by and any(e["name"] == "BIG BULKER" for e in live["excluded"])
    assert sum(1 for v in live["vessels"] if v["name"] == "HAIAN ZETA") == 1
    assert by["HR FARHA"]["source"] == "carrier schedule"


def test_the_live_queue_plans_and_keeps_its_gates(tmp_path):
    live = cl.build_live(tmp_path / "empty", NOW, fetch=lambda: SERIES)
    r = nct.run_nct_benders(live, sim_replications=3)
    assert r["convergence_status"] == "CONVERGED"
    tide = nct.tide_curve(live, nct.NCT["horizon_hrs"])
    for row in r["schedule"]:
        for k in range(1, nct.NCT["transit_hrs"] + 1):
            assert nct.transit_ok(live, tide, row["berth_start_hr"] - k, row["loa_m"], row["draft_m"])
        need = row["draft_m"] + nct.NCT["ukc_m"] - nct.NCT["channel_depth_m"] + live["tide_margin_m"]
        assert tide[row["tidal_depart_hr"]] >= need
