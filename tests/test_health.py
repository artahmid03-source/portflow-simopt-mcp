"""Health check: freshness grades, self-healing restarts and the alert issue."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "tools")]
import health  # noqa: E402

NOW = datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc)
OK_NET = lambda u: (True, "HTTP 200")  # noqa: E731


def _store(tmp: Path, collector_h: float = 1.0, plan_h: float = 2.0, status: str = "ok") -> Path:
    t = lambda h: (NOW - timedelta(hours=h)).isoformat(timespec="seconds")  # noqa: E731
    (tmp / "hamburg" / "expected").mkdir(parents=True)
    (tmp / "hamburg" / "runs.jsonl").write_text(json.dumps({"t_end": t(collector_h), "near_msgs": 2000, "tracked_total": 100, "errors": []}) + "\n")
    tower = {"status": "ok", "generated_utc": t(plan_h), "live": {"vessels": [{}] * 5}, "optimised": {"kpis": {"avg_turnaround_days": 1.3}}}
    (tmp / "hamburg" / "tower.json").write_text(json.dumps(tower if status == "ok" else {"status": "no_queue", "generated_utc": t(plan_h), "reason": "no ship"}))
    (tmp / "hamburg" / "latest.json").write_text(json.dumps({"generated_utc": t(plan_h), "tide": {"gauges": [{}] * 6}}))
    (tmp / "hamburg" / "expected" / "latest.json").write_text(json.dumps({"fetched_utc": t(collector_h), "ships": [{}] * 20}))
    return tmp


def _state(st, name):
    return next(c["state"] for c in st["checks"] if c["name"] == name)


def test_all_fresh_is_ok(tmp_path):
    st = health.check(_store(tmp_path), NOW, net=OK_NET)
    assert st["overall"] == "ok" and {c["name"] for c in st["checks"]} >= {"collector", "plan_hamburg", "tide_forecast", "port_list", "planning_api", "page_hamburg", "page_live"}


def test_stale_data_and_down_pages_are_graded(tmp_path):
    st = health.check(_store(tmp_path, collector_h=5, plan_h=20), NOW, net=lambda u: (not u.endswith(".html"), "x"))
    assert _state(st, "collector") == "warn" and _state(st, "plan_hamburg") == "fail" and _state(st, "page_hamburg") == "fail"
    assert st["overall"] == "fail"


def test_empty_queue_is_a_warning_not_an_outage(tmp_path):
    st = health.check(_store(tmp_path, status="no_queue"), NOW, net=OK_NET)
    assert _state(st, "plan_hamburg") == "warn" and st["overall"] == "warn"


def test_missing_files_do_not_crash(tmp_path):
    st = health.check(tmp_path, NOW, net=lambda u: (False, "down"))
    assert st["overall"] == "fail" and _state(st, "planning_api") == "warn"


class FakeGh:
    def __init__(self, running=False, issues=()):
        self.calls, self.running, self.issues = [], running, list(issues)

    def __call__(self, *a):
        self.calls.append(a)
        if a[:2] == ("run", "list"):
            return 0, json.dumps([{"status": "in_progress" if self.running else "completed"}])
        if a[:2] == ("issue", "list"):
            return 0, json.dumps(self.issues)
        return 0, "https://github.com/x/y/issues/7"


def test_heal_restarts_stale_workflows_once_per_two_hours(tmp_path):
    st = health.check(_store(tmp_path, collector_h=3, plan_h=7), NOW, net=OK_NET)
    g = FakeGh()
    done = health.heal(st, None, NOW, g)
    assert any("collect.yml" in d for d in done) and any("daily.yml" in d for d in done)
    again = health.heal(st, {"last_dispatch": st["last_dispatch"]}, NOW + timedelta(minutes=30), FakeGh())
    assert again == []                                                     # not again within 2 h
    assert health.heal(st, None, NOW, FakeGh(running=True)) == []          # never while a run is going


def test_alert_needs_two_failing_checks_in_a_row_and_closes_when_clear(tmp_path):
    bad = health.check(_store(tmp_path, plan_h=30), NOW, net=OK_NET)
    g = FakeGh()
    assert health.alert(bad, None, g) == "no alert"                        # one bad check: maybe a blip
    assert health.alert(bad, {"overall": "fail"}, g).startswith("opened issue")
    g2 = FakeGh(issues=[{"number": 7, "title": "PortFlow health alert: plan_hamburg"}])
    assert health.alert(bad, {"overall": "fail"}, g2) == "updated issue #7"
    good = health.check(_store(tmp_path / "g"), NOW, net=OK_NET)
    assert health.alert(good, {"overall": "fail"}, g2) == "closed 1 issue(s)"
