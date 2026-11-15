"""The scheduled collector, tested offline against a stand-in for the AISStream server.
The frames are FORMAT FIXTURES built from the AISStream schema; they are not observations of any ship."""
import asyncio
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ingest"))
import build_db  # noqa: E402
import collect as col  # noqa: E402

websockets = pytest.importorskip("websockets")
KEY = "test-key"


def frame(kind, mmsi, body):
    return json.dumps({"MessageType": kind, "MetaData": {"MMSI": mmsi, "ShipName": "FIXTURE"}, "Message": {kind: body}}).encode()


POS_NEAR = frame("PositionReport", 111000111, {"Latitude": 22.05, "Longitude": 91.75, "Sog": 0.1, "Cog": 0.0, "TrueHeading": 511, "NavigationalStatus": 1})
STATIC_NEAR = frame("ShipStaticData", 111000111, {"ImoNumber": 1, "Name": "FIXTURE ANCHORED", "Type": 71, "Dimension": {"A": 100, "B": 40, "C": 10, "D": 10},
                                                   "MaximumStaticDraught": 8.5, "Destination": "CHITTAGONG", "Eta": {"Month": 11, "Day": 20, "Hour": 6, "Minute": 0}})
STATIC_BOUND = frame("ShipStaticData", 222000222, {"ImoNumber": 2, "Name": "FIXTURE BOUND", "Type": 71, "Dimension": {"A": 120, "B": 50, "C": 12, "D": 12},
                                                    "MaximumStaticDraught": 9.1, "Destination": "BD CGP", "Eta": {"Month": 11, "Day": 22, "Hour": 3, "Minute": 30}})
STATIC_OTHER = frame("ShipStaticData", 333000333, {"ImoNumber": 3, "Name": "FIXTURE ELSEWHERE", "Type": 80, "Dimension": {"A": 90, "B": 30, "C": 8, "D": 8},
                                                    "MaximumStaticDraught": 7.0, "Destination": "SINGAPORE", "Eta": {"Month": 11, "Day": 18, "Hour": 0, "Minute": 0}})
POS_BOUND = frame("PositionReport", 222000222, {"Latitude": 5.0, "Longitude": 98.0, "Sog": 13.2, "Cog": 320.0, "TrueHeading": 321, "NavigationalStatus": 0})


async def fake_aisstream(ws):
    """Behaves as the AISStream docs describe: first subscription within 3 s, a later one replaces it, frames are binary JSON."""
    subs = []
    try:
        first = await asyncio.wait_for(ws.recv(), timeout=3.0)
    except asyncio.TimeoutError:
        await ws.close()
        return
    pending = first
    while True:
        sub = json.loads(pending)
        subs.append(sub)
        if sub.get("APIKey") != KEY:
            await ws.send(json.dumps({"error": "Api Key Is Not Valid"}).encode())
            await ws.close()
            return
        types, mmsi_filter = sub.get("FilterMessageTypes", []), sub.get("FiltersShipMMSI")
        if mmsi_filter:                                            # tracking phase: positions of the listed ships only
            assert all(len(m) == 9 for m in mmsi_filter)
            if "222000222" in mmsi_filter and "PositionReport" in types:
                await ws.send(POS_BOUND)
        elif len(sub["BoundingBoxes"]) >= 3:                       # coverage probe over candidate ports
            await ws.send(frame("PositionReport", 444000444, {"Latitude": 53.54, "Longitude": 9.95, "Sog": 6.0, "Cog": 100.0, "TrueHeading": 100, "NavigationalStatus": 0}))
            await ws.send(frame("PositionReport", 555000555, {"Latitude": 53.53, "Longitude": 9.90, "Sog": 0.0, "Cog": 0.0, "TrueHeading": 511, "NavigationalStatus": 5}))
            await ws.send(json.dumps({"MessageType": "ShipStaticData", "MetaData": {"MMSI": 555000555, "latitude": 53.53, "longitude": 9.90},
                                      "Message": {"ShipStaticData": {"Type": 71, "Dimension": {"A": 200, "B": 100, "C": 20, "D": 20}, "Destination": "HAMBURG"}}}).encode())
            await ws.send(frame("PositionReport", 666000666, {"Latitude": 10.0, "Longitude": 10.0, "Sog": 9.0, "Cog": 0.0, "TrueHeading": 0}))   # outside every box
        elif types == ["ShipStaticData"]:                          # discovery phase
            await ws.send(STATIC_BOUND)
            await ws.send(STATIC_OTHER)
        else:                                                      # near box
            await ws.send(POS_NEAR)
            await ws.send(STATIC_NEAR)
        try:
            pending = await ws.recv()
        except websockets.ConnectionClosed:
            return


async def run_against_fake(key, minutes=0.07, tracked=(), probe_ports=None):
    async with websockets.serve(fake_aisstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        return await col.collect(key, minutes, tracked, url=f"ws://127.0.0.1:{port}", discover_frac=0.4, probe_ports=probe_ports, site="chattogram")


def test_destination_patterns():
    ctg, ham = col.SITES["chattogram"]["dest_re"], col.SITES["hamburg"]["dest_re"]
    for d in ("CHITTAGONG", "Chattogram", "BD CGP", "BDCGP", "CTG ANCH", "CGP"):
        assert ctg.search(d), d
    for d in ("SINGAPORE", "COLOMBO", "CGPORT", ""):
        assert not ctg.search(d), d
    for d in ("HAMBURG", "DEHAM", "DE HAM", "NLRTM>DEHAM", "Hamburg CTA"):
        assert ham.search(d), d
    for d in ("BREMERHAVEN", "DEBRV", "HAMINA", "SOUTHAMPTON", ""):
        assert not ham.search(d), d


def test_from_to_destinations_count_only_the_port_the_ship_is_going_to():
    ham = col.SITES["hamburg"]["dest_re"]
    for d in ("NLRTM>DEHAM", "NL RTM > DE HAM", "GBFXT>DEHAM", "CA HAL>DE HAM", "DEHAM", "BEANR->DEHAM"):
        assert ham.search(col.declared_port(d)), d
    for d in ("DEHAM>CNTA0", "DEHAM>>DEBRV", "DE HAM > NL RTM", None, ""):
        assert not ham.search(col.declared_port(d)), d


def test_hamburg_zones():
    z = col.zone_hamburg
    assert z(53.54, 9.95, 0.0) == "PORT" and z(53.80, 9.40, 12.0) == "ELBE" and z(53.95, 8.60, 12.0) == "ESTUARY"
    assert z(53.56, 8.56, 0.0) == "WESER" and z(54.10, 7.90, 10.0) == "BIGHT" and z(51.0, 2.0, 15.0) == "SEA"


def test_collects_near_ships_discovers_bound_ships_then_follows_them(tmp_path):
    got = asyncio.run(run_against_fake(KEY))
    assert set(got["near_pos"]) == {111000111} and set(got["near_static"]) == {111000111}
    assert set(got["feeder_static"]) == {222000222}                 # the Singapore-bound ship is ignored
    assert set(got["track_pos"]) == {222000222}                     # heard only after the MMSI-filtered resubscription
    assert got["stats"]["feeder_resubscribed"] == 1 and not got["stats"]["errors"]

    run = col.write_store(tmp_path, got)
    assert run["rows_positions"] == 2 and run["rows_static"] == 2 and run["tracked_total"] == 2
    site = tmp_path / "chattogram"
    pos = [json.loads(x) for x in next((site / "positions").glob("*.jsonl")).read_text().splitlines()]
    assert {(p["mmsi"], p["zone"], p["src"]) for p in pos} == {(111000111, "ANCHORAGE", "near"), (222000222, "BAY_FAR", "track")}
    tracked = json.loads((site / "tracked.json").read_text())
    assert json.loads((site / "ships.json").read_text())["111000111"] == {"name": "FIXTURE ANCHORED", "imo": 1, "type": 71, "len": 140, "beam": 20}
    assert tracked["222000222"]["dest"] == "BD CGP" and tracked["222000222"]["eta_utc"].endswith("-11-22T03:30Z")

    counts = build_db.build(site, tmp_path / "t.sqlite")
    assert counts == {"positions": 2, "static": 2, "runs": 1}
    con = sqlite3.connect(tmp_path / "t.sqlite")
    assert con.execute("SELECT name, draught FROM vessels WHERE mmsi = 222000222").fetchone() == ("FIXTURE BOUND", 9.1)


def test_coverage_probe_counts_ships_per_port(tmp_path):
    ports = json.loads(col.PROBE_FILE.read_text())
    assert len(ports) >= 3 and all(p["box"][0][0] < p["box"][1][0] and p["box"][0][1] < p["box"][1][1] for p in ports)   # south < north, west < east
    got = asyncio.run(run_against_fake(KEY, probe_ports=ports))
    assert got["coverage"]["Hamburg"] == {"msgs": 3, "ships": 2, "moving": 1, "cargo": 1}
    assert all(c["ships"] == 0 for n, c in got["coverage"].items() if n != "Hamburg")
    assert set(got["near_pos"]) == {111000111}                       # the probe does not leak into the Chattogram store
    col.write_store(tmp_path, got)
    row = json.loads((tmp_path / "coverage.jsonl").read_text())
    assert row["ports"]["Hamburg"]["ships"] == 2 and row["listen_s"] > 0
    assert "Coverage probe" in col.summary_markdown({"near_msgs": 0, "feeder_msgs": 0, "near_ships": 0, "tracked_total": 0, "tracked_heard": 0,
                                                      "rows_positions": 0, "rows_static": 0, "errors": []}, {}, got["coverage"])


def test_a_wrong_key_is_reported_not_retried():
    got = asyncio.run(run_against_fake("wrong"))
    assert got["stats"].get("fatal") and "Api Key Is Not Valid" in " ".join(got["stats"]["errors"])
    assert not got["near_pos"]


def _got(t, lat, nav=1):
    rx = col.iso(t)
    return {"near_pos": {5: {"rx": rx, "lat": lat, "lon": 91.75, "sog_kn": 0.0, "cog_deg": 0.0, "heading_deg": None, "nav_status": nav}},
            "near_static": {5: {"rx": rx, "name": "FIXTURE", "imo": 5, "ship_type": 70, "length_m": 150, "beam_m": 25, "destination": "ELSEWHERE", "eta": None}},
            "feeder_static": {}, "track_pos": {}, "stats": {}, "started": t, "ended": t, "site": "hamburg"}


def test_a_ship_that_has_not_moved_is_logged_once_until_the_heartbeat(tmp_path):
    t0 = datetime(2026, 11, 15, 0, 0, tzinfo=timezone.utc)
    assert col.write_store(tmp_path, _got(t0, 22.05))["rows_positions"] == 1
    assert col.write_store(tmp_path, _got(t0 + timedelta(hours=1), 22.05))["rows_positions"] == 0           # still at anchor
    assert col.write_store(tmp_path, _got(t0 + timedelta(hours=2), 22.05, nav=0))["rows_positions"] == 1    # status changed
    assert col.write_store(tmp_path, _got(t0 + timedelta(hours=3), 22.20, nav=0))["rows_positions"] == 1    # moved
    assert col.write_store(tmp_path, _got(t0 + timedelta(hours=10), 22.20, nav=0))["rows_positions"] == 1   # heartbeat
    assert len((tmp_path / "hamburg" / "runs.jsonl").read_text().splitlines()) == 5


def test_small_craft_and_unidentified_ships_are_not_logged(tmp_path):
    t0 = datetime(2026, 11, 15, 0, 0, tzinfo=timezone.utc)
    got = _got(t0, 53.54)
    got["near_static"][5]["ship_type"] = 52                                # a tug
    got["near_pos"][6] = dict(got["near_pos"][5])                          # a ship whose static data has not been heard yet
    run = col.write_store(tmp_path, got)
    assert run["rows_positions"] == 0 and run["not_cargo_or_unknown"] == 2


def test_tracked_ships_are_forgotten_after_two_weeks(tmp_path):
    t0 = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
    got = _got(t0, 22.05)
    got["feeder_static"] = {9: {"rx": col.iso(t0), "destination": "HAMBURG", "eta": None, "name": "X", "imo": 9, "ais_draught_m": 8.0, "length_m": 150, "beam_m": 25, "ship_type": 71}}
    assert col.write_store(tmp_path, got)["tracked_total"] == 1
    assert col.write_store(tmp_path, _got(t0 + timedelta(days=15), 22.05))["tracked_total"] == 0


def test_without_a_key_the_collector_skips_cleanly(monkeypatch, capsys):
    monkeypatch.delenv("AISSTREAM_API_KEY", raising=False)
    monkeypatch.setattr(sys, "argv", ["collect.py"])
    assert col.main() == 0 and "not set" in capsys.readouterr().out
