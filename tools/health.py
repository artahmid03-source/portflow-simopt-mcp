"""Health check for the live PortFlow system, run by .github/workflows/health.yml after every collector and planning
run and once an hour.

It checks that each data source arrived and is fresh, that both control-tower plans were made, that the planning
API answers and that the public pages are up. It writes <store>/status.json (read by the tower pages), and with
--act it heals what it can and reports what it cannot:

  * a stale collector or plan -> starts that workflow again (at most once per 2 h each, never while one is running);
  * a failure that lasts      -> opens (or updates) a GitHub issue labelled health-alert, so the owner gets an email;
  * all clear again           -> closes that issue.

    python tools/health.py --store store [--act]

Only the standard library and the gh CLI (preinstalled on GitHub runners) are used. Network checks never raise.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

UTC = timezone.utc
PAGES = "https://artahmid03-source.github.io/portflow-simopt-mcp/"
API = os.environ.get("PORTFLOW_API_URL", "https://portflow-api.onrender.com")
# hours: (ok up to, warn up to); beyond is a failure
LIMITS = {"collector": (3, 8), "plans": (6, 12), "tide": (6, 14), "port_list": (6, 14)}
WORKFLOWS = {"collector": "collect.yml", "plans": "daily.yml"}
ISSUE_TITLE = "PortFlow health alert"


def _utc(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def _load(p: Path) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except ValueError:
        return None


def _last_jsonl(p: Path) -> Optional[Dict[str, Any]]:
    if not p.exists():
        return None
    for line in reversed(p.read_text(encoding="utf-8").splitlines()):
        if line.strip():
            try:
                return json.loads(line)
            except ValueError:
                return None
    return None


def http_ok(url: str, timeout: float = 90.0) -> Tuple[bool, str]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "portflow-health"}), timeout=timeout) as r:  # noqa: S310
            body = r.read(4096).decode("utf-8", "replace")
            return 200 <= r.status < 300, f"HTTP {r.status}" + (f" {body[:80]}" if url.endswith("/health") else "")
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {str(e)[:100]}"


def grade(age_h: Optional[float], limits: Tuple[float, float]) -> str:
    if age_h is None:
        return "fail"
    return "ok" if age_h <= limits[0] else "warn" if age_h <= limits[1] else "fail"


def check(store: Path, now: datetime, net: Callable[[str], Tuple[bool, str]] = http_ok) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []

    def add(name: str, state: str, detail: str, age_h: Optional[float] = None) -> None:
        checks.append({"name": name, "state": state, "detail": detail, **({"age_h": round(age_h, 1)} if age_h is not None else {})})

    run = _last_jsonl(store / "hamburg" / "runs.jsonl")
    if run:
        age = (now - _utc(run["t_end"])).total_seconds() / 3600.0
        st = grade(age, LIMITS["collector"])
        if st == "ok" and run.get("near_msgs", 0) < 100:
            st = "warn"                                        # the run happened but heard almost nothing
        off = sum((run.get("offline_s") or {}).values()) if isinstance(run.get("offline_s"), dict) else 0
        add("collector", st, f"last AIS run ended {run['t_end']}: {run.get('near_msgs', 0)} messages near Hamburg, "
                             f"{run.get('tracked_total', 0)} ships tracked, {len(run.get('errors') or [])} connection errors, {off:.0f} s offline", age)
    else:
        add("collector", "fail", "no collector run recorded")

    for site in ("hamburg", "chattogram"):
        t = _load(store / site / "tower.json")
        if not t:
            add(f"plan_{site}", "fail", "no tower.json")
            continue
        age = (now - _utc(t["generated_utc"])).total_seconds() / 3600.0
        st = grade(age, LIMITS["plans"])
        if t.get("status") == "ok":
            k = t["optimised"]["kpis"]
            add(f"plan_{site}", st, f"{len(t['live']['vessels'])} ships planned at {t['generated_utc'][:16]}, {k['avg_turnaround_days']} days average turnaround", age)
        else:
            last = _load(store / site / "tower_last_ok.json")
            st = "warn" if st == "ok" else st                     # an empty queue is reported, not an outage of the system
            add(f"plan_{site}", st, f"{t.get('status')}: {t.get('reason', '')[:220]}"
                                    + (f"; pages show the last plan with ships, from {last['generated_utc'][:16]}" if last else "; pages show the saved 13 Nov plan"), age)

    lat = _load(store / "hamburg" / "latest.json")
    if lat:
        age = (now - _utc(lat["generated_utc"])).total_seconds() / 3600.0
        g = len((lat.get("tide") or {}).get("gauges") or [])
        st = grade(age, LIMITS["tide"])
        add("tide_forecast", st if g >= 4 else "warn", f"Elbe tide forecast from {g} gauges, made {lat['generated_utc'][:16]}", age)
    else:
        add("tide_forecast", "fail", "no hamburg/latest.json")

    exp = _load(store / "hamburg" / "expected" / "latest.json")
    if exp:
        age = (now - _utc(exp["fetched_utc"])).total_seconds() / 3600.0
        add("port_list", grade(age, LIMITS["port_list"]) if exp.get("ships") else "warn", f"{len(exp.get('ships') or [])} ships on the Port of Hamburg's expected list", age)
    else:
        add("port_list", "warn", "no expected-vessel list stored")

    sched = _load(store / "chattogram" / "schedule" / "last_attempt.json")
    if sched is None or sched.get("status") == "off":
        add("carrier_schedule", "info", "Chattogram carrier schedule not set up (needs the MAERSK_CONSUMER_KEY secret)")
    else:
        add("carrier_schedule", {"ok": "ok", "partial": "warn"}.get(sched.get("status"), "warn"),
            f"{sched.get('status')} at {str(sched.get('fetched_utc'))[:16]}" + (f": {sched['errors'][0]}" if sched.get("errors") else ""))

    ok, why = net(API.rstrip("/") + "/health")
    add("planning_api", "ok" if ok else "warn", why)              # a free host can be slow to wake: warn, do not alarm
    for page in ("tower/hamburg.html", "tower/chattogram.html", ""):
        ok, why = net(PAGES + page)
        add(f"page_{page.split('/')[-1].split('.')[0] or 'live'}", "ok" if ok else "fail", why)

    order = {"fail": 3, "warn": 2, "ok": 1, "info": 0}
    overall = max((c["state"] for c in checks), key=lambda s: order[s])
    return {"checked_utc": now.isoformat(timespec="seconds"), "overall": "ok" if overall == "info" else overall, "checks": checks}


def markdown(st: Dict[str, Any]) -> str:
    icon = {"ok": "OK", "warn": "WARN", "fail": "FAIL", "info": "info"}
    rows = "\n".join(f"| {c['name']} | {icon[c['state']]} | {c['detail']} |" for c in st["checks"])
    return f"### PortFlow health: {st['overall'].upper()} ({st['checked_utc'][:16]} UTC)\n\n| Check | State | Detail |\n|---|---|---|\n{rows}\n"


# ------------------------------------------------------------------------------------------------------- acting on it
def gh(*args: str) -> Tuple[int, str]:
    p = subprocess.run(["gh", *args], capture_output=True, text=True)
    return p.returncode, (p.stdout or p.stderr).strip()


def busy(workflow: str, run_gh: Callable[..., Tuple[int, str]] = gh) -> bool:
    code, out = run_gh("run", "list", "--workflow", workflow, "--limit", "5", "--json", "status")
    if code != 0:
        return True                                            # unknown: do not start another
    return any(r.get("status") in ("queued", "in_progress", "waiting", "pending", "requested") for r in json.loads(out or "[]"))


def heal(st: Dict[str, Any], prev: Optional[Dict[str, Any]], now: datetime, run_gh: Callable[..., Tuple[int, str]] = gh) -> List[str]:
    """Start a stale workflow again, at most once per 2 h each. Returns what was done."""
    done, last = [], dict((prev or {}).get("last_dispatch") or {})
    stale = {"collector": next((c for c in st["checks"] if c["name"] == "collector"), {}),
             "plans": next((c for c in st["checks"] if c["name"] == "plan_hamburg"), {})}
    limits = {"collector": 1.5, "plans": 5.0}                 # hours since the last run before a nudge
    for key, c in stale.items():
        age = c.get("age_h")
        if age is None or age < limits[key]:
            continue
        if key in last and now - _utc(last[key]) < timedelta(hours=2):
            continue
        if busy(WORKFLOWS[key], run_gh):
            continue
        code, out = run_gh("workflow", "run", WORKFLOWS[key])
        if code == 0:
            last[key] = now.isoformat(timespec="seconds")
            done.append(f"started {WORKFLOWS[key]} (last {key} run {age:.1f} h ago)")
        else:
            done.append(f"could not start {WORKFLOWS[key]}: {out[:120]}")
    st["last_dispatch"] = last
    return done


def alert(st: Dict[str, Any], prev: Optional[Dict[str, Any]], run_gh: Callable[..., Tuple[int, str]] = gh) -> str:
    """Open or update one issue while something has failed in two checks running; close it when all is well."""
    code, out = run_gh("issue", "list", "--state", "open", "--search", f"{ISSUE_TITLE} in:title", "--json", "number,title")
    issues = [i for i in json.loads(out or "[]") if i.get("title", "").startswith(ISSUE_TITLE)] if code == 0 else []
    failing = [c for c in st["checks"] if c["state"] == "fail"]
    was_failing = bool(prev and prev.get("overall") == "fail")
    if failing and was_failing:
        owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "")
        body = (f"@{owner} " if owner else "") + "a check has failed twice in a row.\n\n" + markdown(st) + \
            "\n\nThis issue is opened by the health workflow and closed by it when every check passes again."
        if issues:
            run_gh("issue", "comment", str(issues[0]["number"]), "--body", body)
            return f"updated issue #{issues[0]['number']}"
        run_gh("label", "create", "health-alert", "--color", "D93F0B", "--force")
        code, out = run_gh("issue", "create", "--title", f"{ISSUE_TITLE}: " + ", ".join(c["name"] for c in failing), "--label", "health-alert", "--body", body)
        return f"opened issue: {out[-80:]}" if code == 0 else f"could not open an issue: {out[:120]}"
    if not failing and issues:
        for i in issues:
            run_gh("issue", "close", str(i["number"]), "--comment", "All checks pass again:\n\n" + markdown(st))
        return f"closed {len(issues)} issue(s)"
    return "no alert"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    ap.add_argument("--act", action="store_true", help="restart stale workflows and manage the alert issue (needs gh and a token)")
    a = ap.parse_args()
    store, now = Path(a.store), datetime.now(UTC)
    prev = _load(store / "status.json")
    st = check(store, now)
    st["last_dispatch"] = (prev or {}).get("last_dispatch") or {}
    if a.act:
        st["actions"] = heal(st, prev, now)
        st["alert"] = alert(st, prev)
    (store / "status.json").write_text(json.dumps(st, indent=1, ensure_ascii=False), encoding="utf-8")
    md = markdown(st) + "".join(f"\n- {x}" for x in st.get("actions") or []) + (f"\n- {st['alert']}" if st.get("alert") else "")
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
