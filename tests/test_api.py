"""v6.5: the planning API (api/app.py) that the tower pages call for a server-side CP-SAT re-plan."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "api")]
import app  # noqa: E402

FIX = ROOT / "web" / "fixtures"


def loader(site):
    return json.loads((FIX / f"{site}_tower.json").read_text(encoding="utf-8"))


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


@pytest.mark.parametrize("site", ["hamburg", "chattogram"])
def test_nominal_server_plan_matches_the_daily_reference(site):
    doc = loader(site)
    app._cache.pop(site, None)
    r = app.plan(site, {}, loader=loader)
    assert r["feasible"] and r["engine"] == "server CP-SAT"
    assert r["kpis"]["turnaround"] == doc["optimised"]["kpis"]["avg_turnaround_days"]
    assert {"objective", "wait", "hold", "beta", "peak"} <= set(r["kpis"])
    assert len(r["schedule"]) == len(doc["optimised"]["schedule"])
