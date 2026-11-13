"""Parser and merge logic of the AIS ingester, offline. The frames below are FORMAT FIXTURES built
from the AISStream schema to exercise the parser; they are not observations of any ship."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ingest"))
import aisstream_ingest as ai  # noqa: E402

LIVE = json.loads((ROOT / "data" / "live_chattogram_2026-11-13.json").read_text())
FARHA = next(v for v in LIVE["vessels"] if v["name"] == "HR FARHA")
NOW = datetime(2026, 11, 13, 6, 0, tzinfo=timezone.utc)


def frame(kind, body, meta=None):
    return json.dumps({"MessageType": kind, "MetaData": meta or {"MMSI": FARHA["mmsi"], "ShipName": "FIXTURE"}, "Message": {kind: body}}).encode()


def test_position_report_parses_and_drops_unavailable_heading():
    r = ai.parse_frame(frame("PositionReport", {"Latitude": 20.0, "Longitude": 91.0, "Sog": 12.5, "Cog": 20.0, "TrueHeading": 511, "NavigationalStatus": 0}))
    assert r["mmsi"] == FARHA["mmsi"] and r["sog_kn"] == 12.5 and r["heading_deg"] is None


def test_static_data_draught_units_and_length():
    r = ai.parse_frame(frame("ShipStaticData", {"ImoNumber": 1, "Dimension": {"A": 150, "B": 34, "C": 14, "D": 14}, "MaximumStaticDraught": 96,
                                                 "Destination": "CHITTAGONG", "Eta": {"Month": 11, "Day": 13, "Hour": 23, "Minute": 0}, "Name": "X"}))
    assert r["length_m"] == 184 and r["ais_draught_m"] == 9.6 and r["eta"]["Day"] == 13


def test_area_classification():
    assert ai.area_of(22.05, 91.75, 0.2) == "ANCHORAGE"
    assert ai.area_of(22.30, 91.80, 0.0) == "BERTH"
    assert ai.area_of(5.9, 80.5, 14.0) == "BAY_FAR"


def test_merge_sets_position_area_and_time_to_go():
    recs = [ai.parse_frame(frame("PositionReport", {"Latitude": 21.0, "Longitude": 91.0, "Sog": 12.0, "Cog": 10.0, "TrueHeading": 10}))]
    out = ai.merge(LIVE, recs, NOW)
    v = next(v for v in out["vessels"] if v["name"] == "HR FARHA")
    assert v["area"] == "BAY_NEAR" and v["sog_kn"] == 12.0 and v["eta_basis"].startswith("AIS")
    assert 0 <= v["eta_hr"] < 24
    assert out["ais_merged"] == ["HR FARHA"]
    assert LIVE["vessels"][2].get("lat") is None            # the input is not modified
