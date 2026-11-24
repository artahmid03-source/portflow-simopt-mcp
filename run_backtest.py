"""Plan against reality, every day (Hamburg).

Each daily run of run_tower.py archives its plan in <store>/hamburg/plans/DATE.json. This script compares every
archived plan with what AIS later saw: when each planned ship was first moored at a container quay, at which
terminal, and when it left. It does the same for the port's own expected-vessel lists (HVCC), as a benchmark.

    python run_backtest.py --store store         # -> <store>/hamburg/backtest.json

Resolution: the collector logs a moored ship again only when it moves or every 6 hours, and GitHub runs the
collector every 1-7 hours, so observed times are good to a few hours. The report states this.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "sites"))
import hamburg as hh  # noqa: E402

UTC = timezone.utc


def _utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _jsonl(path: Path) -> List[Dict[str, Any]]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()] if path.exists() else []


def observed_calls(site: Path, since: datetime, until: datetime) -> Dict[str, List[Dict[str, Any]]]:
    """Per MMSI: the container-quay calls AIS saw (first moored report, terminal, first report after leaving)."""
    rows: Dict[str, List[Dict[str, Any]]] = {}
    d = since.date()
    while d <= until.date():
        for r in _jsonl(site / "positions" / f"{d.isoformat()}.jsonl"):
            rows.setdefault(str(r["mmsi"]), []).append(r)
        d += timedelta(days=1)
    calls: Dict[str, List[Dict[str, Any]]] = {}
    for m, rs in rows.items():
        rs.sort(key=lambda r: r["t"])
        cur = None
        for r in rs:
            at = hh.locate(r["lat"], r["lon"]) if (r.get("sog") or 0) <= 0.6 and r.get("zone") == "PORT" else None
            if at and cur is None:
                cur = {"alongside_utc": r["t"], "terminal": hh.QUAY_GEOM[at[0]]["terminal"], "quay": at[0], "left_utc": None}
            elif not at and cur is not None and (r.get("sog") or 0) > 2.0:
                cur["left_utc"] = r["t"]
                calls.setdefault(m, []).append(cur)
                cur = None
        if cur is not None:
            calls.setdefault(m, []).append(cur)
    return calls


def _match(calls: List[Dict[str, Any]], planned: datetime, window_h: float = 72.0, made: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The observed call nearest the planned time. A call that began before the plan was made (minus 2 h of AIS lag)
    is an earlier visit, not the outcome of this plan."""
    best = None
    for c in calls:
        if made is not None and _utc(c["alongside_utc"]) < made - timedelta(hours=2):
            continue
        dt = abs((_utc(c["alongside_utc"]) - planned).total_seconds()) / 3600.0
        if dt <= window_h and (best is None or dt < best[0]):
            best = (dt, c)
    return best[1] if best else None


def summarise(recs: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not recs:
        return {"n": 0}
    e = np.array([r["berth_err_h"] for r in recs], dtype=float)
    out = {"n": len(recs), "mae_h": round(float(np.mean(np.abs(e))), 1), "bias_h": round(float(np.mean(e)), 1),
           "p90_abs_h": round(float(np.percentile(np.abs(e), 90)), 1),
           "terminal_accuracy": round(float(np.mean([r["terminal_ok"] for r in recs if r["terminal_ok"] is not None] or [np.nan])), 2)}
    dep = [r["depart_err_h"] for r in recs if r.get("depart_err_h") is not None]
    if dep:
        out["depart_mae_h"] = round(float(np.mean(np.abs(dep))), 1)
    return out


def fit_sigma(recs: List[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    """|error| ~ a + b x lead, fitted once there are enough calls (used for the tide-window risk)."""
    if len(recs) < 12:
        return None
    x = np.array([r["lead_h"] for r in recs], dtype=float)
    y = np.abs(np.array([r["berth_err_h"] for r in recs], dtype=float)) * 1.2533   # mean |N(0,s)| = 0.798 s
    b, a = np.polyfit(x, y, 1)
    return {"a": round(max(float(a), 0.5), 2), "b": round(max(float(b), 0.0), 3), "n": len(recs), "basis": "fitted to plan-vs-AIS berthing errors"}


def run(store: Path, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or datetime.now(UTC)
    site = store / "hamburg"
    plans = sorted((site / "plans").glob("*.json")) if (site / "plans").exists() else []
    first_of_day: Dict[str, Path] = {}
    for p in plans:                              # plans run every 4 h: score the first plan of each day, so no day counts six times
        first_of_day.setdefault(p.stem[:10], p)
    scored = sorted(first_of_day.values())
    exp = sorted((site / "expected").glob("20*.json")) if (site / "expected").exists() else []
    since = now - timedelta(days=30)
    calls = observed_calls(site, since, now)
    by_name: Dict[str, str] = {}
    ships = json.loads((site / "ships.json").read_text()) if (site / "ships.json").exists() else {}
    for m, s in ships.items():
        if s.get("name"):
            by_name[hh._norm(s["name"])] = m
    plan_recs, hvcc_recs = [], []
    for p in scored:
        doc = json.loads(p.read_text())
        made = _utc(doc["generated_utc"])
        if made < since:
            continue
        for r in doc["rows"]:
            m = str(r.get("mmsi") or by_name.get(hh._norm(r["vessel_id"]), ""))
            planned = _utc(r["berth_start_utc"])
            if not m or planned > now - timedelta(hours=6):
                continue
            c = _match(calls.get(m, []), planned, made=made)
            if not c:
                continue
            dep_err = None
            if c.get("left_utc") and r.get("depart_utc"):
                dep_err = round((_utc(c["left_utc"]) - _utc(r["depart_utc"])).total_seconds() / 3600.0, 1)
            plan_recs.append({"plan": p.stem, "vessel": r["vessel_id"], "mmsi": m, "planned_alongside_utc": r["berth_start_utc"],
                              "observed_alongside_utc": c["alongside_utc"], "lead_h": round((planned - made).total_seconds() / 3600.0, 1),
                              "berth_err_h": round((_utc(c["alongside_utc"]) - planned).total_seconds() / 3600.0, 1), "depart_err_h": dep_err,
                              "planned_terminal": r.get("terminal"), "observed_terminal": c["terminal"],
                              "terminal_ok": (r.get("terminal") == c["terminal"]) if r.get("terminal") else None,
                              "terminal_basis": r.get("terminal_basis")})
    seen = set()
    for p in reversed(exp):                     # newest list first; one record per ship and announced time
        doc = json.loads(p.read_text())
        made = _utc(doc["fetched_utc"])
        if made < since:
            continue
        for e in doc["ships"]:
            if not e.get("terminal"):
                continue
            m = by_name.get(hh._norm(e["name"]))
            planned = _utc(e["time_utc"])
            key = (e["name"], e["time_utc"])
            if not m or key in seen or planned > now - timedelta(hours=6):
                continue
            c = _match(calls.get(m, []), planned, made=made)
            if not c:
                continue
            seen.add(key)
            hvcc_recs.append({"vessel": e["name"], "announced_utc": e["time_utc"], "observed_alongside_utc": c["alongside_utc"],
                              "lead_h": round((planned - made).total_seconds() / 3600.0, 1),
                              "berth_err_h": round((_utc(c["alongside_utc"]) - planned).total_seconds() / 3600.0, 1),
                              "terminal_ok": e["terminal"] == c["terminal"]})
    doc = {"generated_utc": now.isoformat(timespec="seconds"), "window_days": 30, "plans_archived": len(plans), "expected_lists": len(exp),
           "observed_calls": sum(len(v) for v in calls.values()),
           "resolution_note": "Observed times come from hourly-to-7-hourly AIS runs and 6-hourly heartbeats, so they are good to a few hours.",
           "plan": summarise(plan_recs), "port_list": summarise(hvcc_recs), "eta_sigma_fit": fit_sigma(plan_recs),
           "records": plan_recs[-200:], "port_list_records": hvcc_recs[-200:]}
    (site / "backtest.json").write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    a = ap.parse_args()
    doc = run(Path(a.store))
    md = (f"### Plan against reality (Hamburg, last {doc['window_days']} days)\n\n{doc['plans_archived']} plans archived, "
          f"{doc['observed_calls']} container-quay calls seen on AIS.\n\n| | Calls matched | Mean abs. error, alongside | Bias | 90th pct | Terminal right |\n"
          f"|---|---:|---:|---:|---:|---:|\n")
    for k, lab in (("plan", "PortFlow plan"), ("port_list", "Port's expected-vessel list")):
        s = doc[k]
        md += f"| {lab} | {s['n']} | {s.get('mae_h', '—')} h | {s.get('bias_h', '—')} h | {s.get('p90_abs_h', '—')} h | {s.get('terminal_accuracy', '—')} |\n"
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
