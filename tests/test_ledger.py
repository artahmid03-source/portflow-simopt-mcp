"""v6.5: the yard ledger carried across the plan, its feedback into the planner, and the 'why it waits' text."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT)]
import advice  # noqa: E402

CFG = {"horizon_hrs": 120, "icd_ratio": 0.0, "initial_yard_occupancy_pct": 60.0, "yard_teu_total": 10000,
       "import_dwell_days": 3.0, "teu_per_box": 1.0, "yard_cluster_teu": 2500}
LIVE = {"vessels": [{"name": "A"}, {"name": "B"}]}


def _row(name, s, e, moves):
    return {"vessel_id": name, "berth_start_hr": s, "cargo_done_hr": e, "moves": moves, "tidal_depart_hr": e, "assigned_qcs": 4}


def test_cycle_curve_is_continuous_and_rising():
    xs = [i / 100 for i in range(20, 95)]
    ys = [advice.rtg_cycle(x) for x in xs]
    assert all(b >= a for a, b in zip(ys, ys[1:]))
    k = advice.LEDGER["knee"]
    assert abs(advice.rtg_cycle(k + 1e-6) - advice.rtg_cycle(k - 1e-6)) < 1e-3   # no jump at the knee


def test_empty_plan_keeps_the_opening_level():
    led = advice.yard_ledger(LIVE, [], CFG)
    assert set(led["pools"]["all"]) == {60.0}
    assert led["peak_pct"] == 60.0 and led["ships"] == []


def test_imports_raise_the_yard_and_leave_after_the_dwell():
    led = advice.yard_ledger(LIVE, [_row("A", 10, 20, 2000)], CFG)
    s = led["pools"]["all"]
    assert s[25] > s[5]                       # imports landed (exports loaded out at the same time)
    assert s[-1] < s[25]                      # imports left after 3 days, background flows continue
    assert led["ships"][0]["ledger_beta"] >= 1.0


def test_evacuation_lowers_the_peak():
    rows = [_row("A", 10, 30, 3000), _row("B", 20, 40, 3000)]
    full = advice.yard_ledger(LIVE, rows, CFG, icd=0.0)
    evac = advice.yard_ledger(LIVE, rows, CFG, icd=0.4)
    assert evac["peak_pct"] < full["peak_pct"]


def test_a_fuller_yard_slows_each_ship_more():
    rows = [_row("A", 10, 30, 3000)]
    lo = advice.yard_ledger(LIVE, rows, CFG, occ0=55.0)["ships"][0]["ledger_beta"]
    hi = advice.yard_ledger(LIVE, rows, CFG, occ0=85.0)["ships"][0]["ledger_beta"]
    assert hi > lo >= 1.0


def test_per_terminal_pools_are_kept_apart():
    cfg = dict(CFG, yard_teu_by_pool={"CTA": 5000, "CTB": 5000})
    live = {"vessels": [{"name": "A", "terminal": "CTA"}, {"name": "B", "terminal": "CTB"}]}
    led = advice.yard_ledger(live, [_row("A", 10, 30, 3000)], cfg)
    assert led["ships"][0]["pool"] == "CTA"
    assert set(led["pools"]["CTB"]) == {60.0}


def test_why_text_names_the_gate_or_the_conflict():
    row = {"eta_hr": 10, "berth_start_hr": 20, "anchorage_wait_hrs": 8, "cargo_done_hr": 40, "tidal_depart_hr": 44, "tide_departure_hold_hrs": 4}
    gates = [20, 21, 22]
    txt = advice.explain(row, gates, [44, 45], 2)
    assert "for the tide or daylight gate (first open hour 20)" in txt and "held 4 h" in txt
    txt2 = advice.explain(dict(row, berth_start_hr=30), gates, [44], 2)
    assert "quay space, cranes or passage slots" in txt2
    assert advice.explain(dict(row, anchorage_wait_hrs=0, tide_departure_hold_hrs=0), gates, None, 2) == "berths on arrival"


def test_ledger_refine_damps_and_reports_status():
    import run_tower as rt
    calls = []

    def run(**kw):
        calls.append(kw["ship_beta"])
        return {"schedule": [_row("A", 10, 30, 3000)], "kpis": {"avg_turnaround_days": 1.5}}

    opt = {"schedule": [_row("A", 10, 30, 3000)], "kpis": {"avg_turnaround_days": 1.2}}
    out = rt.ledger_refine(LIVE, dict(CFG, initial_yard_occupancy_pct=78.0), run, opt, reps=4)
    assert out["status"] == "converged" and calls
    target = advice.yard_ledger(LIVE, opt["schedule"], dict(CFG, initial_yard_occupancy_pct=78.0))["ships"][0]["ledger_beta"]
    assert abs(calls[0]["A"] - (0.5 + 0.5 * target)) < 1e-3          # first step is half way
    out2 = rt.ledger_refine(LIVE, dict(CFG, initial_yard_occupancy_pct=78.0), lambda **kw: {"schedule": []}, opt, reps=4)
    assert out2["status"].startswith("infeasible") and out2["refined_kpis"] is None
