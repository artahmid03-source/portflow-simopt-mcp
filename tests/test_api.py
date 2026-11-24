"""v6.5: the planning API (api/app.py) that the tower pages call for a server-side CP-SAT re-plan."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "api")]
import app  # noqa: E402

FIX = ROOT / "web" / "fixtures"


def loader(key):
    if key.endswith(":last_ok"):
        raise FileNotFoundError(key)
    return json.loads((FIX / f"{key}_tower.json").read_text(encoding="utf-8"))


def test_scenario_is_clamped_and_unknown_ships_dropped():
    doc = loader("hamburg")
    name = doc["live"]["vessels"][0]["name"]
    a = app.clean({"etaShift": {name: 500, "NOT A SHIP": 5}, "qgcOutages": [[0, 9999, 99, "CTB"], [5, 2, 1]] + [[0, 1, 1]] * 10,
                   "icd": 3, "occ": 5, "tugSets": 0}, doc)
    assert a["eta_shift_hrs"] == {name: 96}
    assert a["qgc_outages"][0] == [0, doc["config"]["horizon_hrs"], 12, "CTB"] and len(a["qgc_outages"]) == 5   # 6 kept, the empty one dropped
    assert a["icd_ratio"] == 0.6 and a["initial_yard_occupancy_pct"] == 30.0 and a["pilot_tug_sets"] == 1


def test_unknown_site_is_rejected():
    with pytest.raises(ValueError):
        app.plan("rotterdam", {}, loader=loader)


@pytest.mark.parametrize("site", ["hamburg"])
def test_nominal_server_plan_matches_the_daily_reference(site):
    doc = loader(site)
    app._cache.pop(site, None)
    r = app.plan(site, {}, loader=loader)
    assert r["feasible"] and r["engine"] == "server CP-SAT"
    assert r["kpis"]["turnaround"] == doc["optimised"]["kpis"]["avg_turnaround_days"]
    assert {"objective", "wait", "hold", "beta", "peak"} <= set(r["kpis"])
    assert len(r["schedule"]) == len(doc["optimised"]["schedule"])


def test_server_only_plans_the_plan_on_the_page():
    app._cache.clear()
    doc = loader("hamburg")
    with pytest.raises(app.PlanMismatch):
        app.plan("hamburg", {}, loader=loader, want="2026-01-01T00:00:00+00:00")
    assert app.plan("hamburg", {}, loader=loader, want=doc["generated_utc"])["feasible"]


def test_empty_live_run_falls_back_to_the_last_good_plan():
    app._cache.clear()
    good = loader("hamburg")
    empty = {"status": "no_queue", "site_kind": "hamburg", "generated_utc": "2026-11-22T03:28:10+00:00", "live": {}}
    ld = lambda key: good if key.endswith(":last_ok") else empty  # noqa: E731
    assert app.plan("hamburg", {}, loader=ld, want=good["generated_utc"])["feasible"]
    app._cache.clear()
    with pytest.raises(app.PlanMismatch):
        app.plan("hamburg", {}, loader=lambda key: empty if not key.endswith(":last_ok") else (_ for _ in ()).throw(FileNotFoundError()))
    app._cache.clear()


def test_retired_site_is_rejected():
    with pytest.raises(ValueError):
        app.plan("chattogram", {}, loader=loader)
