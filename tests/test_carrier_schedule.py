"""Carrier port schedule (DCSA Commercial Schedules 1.0) as the automatic source of Chattogram's queue."""
import json
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT / "ingest"), str(ROOT)]
import carrier_schedule as cs  # noqa: E402
import chattogram_live as cl  # noqa: E402

NOW = datetime(2026, 11, 24, 6, 0, tzinfo=timezone.utc)
PORT_SCHEDULE = [{"port": {"UNLocationCode": "BDCGP", "portName": "Chittagong"}, "vesselSchedules": [
    {"vessel": {"vesselIMONumber": "9334791", "vesselName": "Maersk Example", "isDummyVessel": False},
     "servicePartners": [{"carrierCode": "MAEU", "carrierServiceCode": "CGX", "carrierImportVoyageNumber": "447N"}],
     "timestamps": [{"eventTypeCode": "ARRI", "eventClassifierCode": "PLN", "eventDateTime": "2026-11-25T02:00:00Z"},
                    {"eventTypeCode": "ARRI", "eventClassifierCode": "EST", "eventDateTime": "2026-11-25T06:00:00Z"},
                    {"eventTypeCode": "DEPA", "eventClassifierCode": "EST", "eventDateTime": "2026-11-26T18:00:00Z"}]},
    {"vessel": {"vesselName": "TBN", "isDummyVessel": True}, "timestamps": [{"eventTypeCode": "ARRI", "eventClassifierCode": "PLN", "eventDateTime": "2026-11-27T00:00:00Z"}]},
    {"vessel": {"vesselIMONumber": "9100002", "vesselName": "Sealand Other"}, "timestamps": []}]}]


def test_parse_takes_the_best_timestamp_and_skips_placeholders():
    calls = cs.parse(PORT_SCHEDULE)
    assert len(calls) == 1
    c = calls[0]
    assert c["name"] == "MAERSK EXAMPLE" and c["imo"] == 9334791 and c["eta_utc"] == "2026-11-25T06:00:00Z" and c["eta_kind"] == "EST"
    assert c["service"] == "CGX" and c["etd_utc"] == "2026-11-26T18:00:00Z"
    assert cs.parse({"unexpected": True}) == [] and cs.parse(None) == []


def test_no_key_means_off_not_failure(tmp_path):
    doc = cs.run(tmp_path, NOW, key="")
    assert doc["status"] == "off" and doc["ships"] == []
    assert json.loads((tmp_path / "chattogram" / "schedule" / "last_attempt.json").read_text())["status"] == "off"


def test_fetch_errors_are_recorded_and_good_days_kept(tmp_path):
    calls = {"n": 0}

    def get(url, key):
        calls["n"] += 1
        if calls["n"] == 2:
            raise urllib.error.HTTPError(url, 503, "busy", {}, None)
        return PORT_SCHEDULE
    doc = cs.run(tmp_path, NOW, key="k", days=3, get=get)
    assert doc["status"] == "partial" and len(doc["ships"]) == 1 and len(doc["errors"]) == 1
    bad = cs.run(tmp_path / "b", NOW, key="k", days=2, get=lambda u, k: (_ for _ in ()).throw(OSError("down")))
    assert bad["status"] == "failed"


def test_a_failed_read_keeps_the_last_good_schedule(tmp_path):
    cs.run(tmp_path, NOW, key="k", days=1, get=lambda u, k: PORT_SCHEDULE)
    cs.run(tmp_path, NOW, key="k", days=1, get=lambda u, k: (_ for _ in ()).throw(OSError("down")))
    kept = json.loads((tmp_path / "chattogram" / "schedule" / "latest.json").read_text())
    assert kept["status"] == "ok" and len(kept["ships"]) == 1
    assert json.loads((tmp_path / "chattogram" / "schedule" / "last_attempt.json").read_text())["status"] == "failed"


def test_schedule_ships_enter_the_chattogram_queue(tmp_path):
    cs.run(tmp_path, NOW, key="k", days=1, get=lambda u, k: PORT_SCHEDULE)
    live = cl.build_live(tmp_path, NOW, fetch=lambda: (_ for _ in ()).throw(OSError("offline")))
    names = [v["name"] for v in live["vessels"]]
    assert "MAERSK EXAMPLE" in names
    v = next(v for v in live["vessels"] if v["name"] == "MAERSK EXAMPLE")
    assert v["source"] == "carrier port schedule" and "size assumed" in v["eta_basis"] and v["eta_hr"] > 0
    assert live["carrier_schedule_status"].startswith("ok")
    old = cl.build_live(tmp_path, datetime(2026, 11, 27, 6, 0, tzinfo=timezone.utc), fetch=lambda: (_ for _ in ()).throw(OSError("offline")))
    assert "MAERSK EXAMPLE" not in [v["name"] for v in old["vessels"]]           # a schedule older than 36 h is not used
