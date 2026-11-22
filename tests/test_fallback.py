"""Empty live queues: the reason is stated, the last plan with ships is kept, and the destination match is checkable."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT / "ingest"), str(ROOT)]
import collect  # noqa: E402
import run_tower  # noqa: E402


def test_chattogram_destination_spellings():
    rx = collect.SITES["chattogram"]["dest_re"]
    for d in ("BDCGP", "BD CGP", "CHITTAGONG", "CHITAGONG", "CHATTOGRAM", "BDCTG", "BD CTG", "CTG", "SGSIN>BDCGP"):
        assert rx.search(collect.declared_port(d)), d
    for d in ("SGSIN", "CNSHA", "BDMGL", "COLOMBO"):
        assert not rx.search(collect.declared_port(d)), d


def test_destinations_seen_accumulate(tmp_path):
    now = datetime(2026, 11, 22, tzinfo=timezone.utc)
    collect.note_destinations(tmp_path, {"SGSIN": 3, "BDCGP": 1}, now)
    collect.note_destinations(tmp_path, {"SGSIN": 2}, now)
    doc = json.loads((tmp_path / "destinations_seen.json").read_text())
    assert doc["counts"] == {"SGSIN": 5, "BDCGP": 1}
    collect.note_destinations(tmp_path, {}, now)                      # nothing heard: file untouched
    assert json.loads((tmp_path / "destinations_seen.json").read_text())["counts"]["SGSIN"] == 5


def test_empty_queue_reason_names_the_sources():
    r = run_tower.empty_reason("chattogram", {})
    assert "AIS" in r and "due list" in r and "schedule" in r
    p = run_tower.empty_payload("chattogram", {"port": "x"}, r)
    assert p["status"] == "no_queue" and p["reason"] == r


def test_last_good_plan_is_kept(tmp_path, monkeypatch):
    store = tmp_path / "store"
    (store / "chattogram").mkdir(parents=True)
    good = {"status": "ok", "site_kind": "chattogram", "generated_utc": "2026-11-16T03:00:00+00:00", "live": {"vessels": [{}]}}
    monkeypatch.setattr(run_tower, "site_setup", lambda site, st: ({"vessels": [{"name": "A"}]}, {}, None))
    monkeypatch.setattr(run_tower, "plan_site", lambda *a, **k: good)
    monkeypatch.setattr(run_tower, "archive_plan", lambda *a, **k: None)
    monkeypatch.setattr(run_tower, "summary", lambda p: "")
    monkeypatch.setattr(sys, "argv", ["run_tower.py", "--site", "chattogram", "--store", str(store)])
    run_tower.main()
    assert json.loads((store / "chattogram" / "tower_last_ok.json").read_text())["generated_utc"] == good["generated_utc"]
    monkeypatch.setattr(run_tower, "site_setup", lambda site, st: ({"vessels": []}, {}, None))
    run_tower.main()
    assert json.loads((store / "chattogram" / "tower.json").read_text())["status"] == "no_queue"
    assert json.loads((store / "chattogram" / "tower_last_ok.json").read_text())["status"] == "ok"      # kept
