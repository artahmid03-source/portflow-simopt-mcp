"""Daily Hamburg update: tide forecast from the official gauges plus the vessel picture from the collected AIS.

Reads the collector's store, fetches 31 days of water levels for six Elbe gauges from PEGELONLINE, and writes

    <store>/hamburg/daily/YYYY-MM-DD.json    and    <store>/hamburg/latest.json

    uv run python run_daily.py --store store
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "sites"))
import tides  # noqa: E402

# Elbe gauges from the estuary to the port, with their Elbe kilometre (PEGELONLINE station names)
GAUGES = [("CUXHAVEN STEUBENHÖFT", 724.0), ("BRUNSBÜTTEL MPM", 695.2), ("GLÜCKSTADT", 674.0), ("STADERSAND", 654.9), ("SCHULAU", 641.0), ("HAMBURG ST. PAULI", 623.1)]
SEEN_HOURS = 6.0            # a ship counts as present if heard this recently


def tide_block(fetch: Callable[[str], List], now: datetime, days_ahead: float = 8.0) -> Dict[str, Any]:
    out: Dict[str, Any] = {"source": "PEGELONLINE (WSV), water level W in cm above gauge zero", "gauges": {}, "errors": []}
    grid = [now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=h) for h in range(int(days_ahead * 24) + 1)]
    for name, km in GAUGES:
        try:
            lv = fetch(name)
            model = tides.fit(lv)
            fine = [lv[-1][0] + timedelta(minutes=10 * i) for i in range(int(days_ahead * 144))]
            out["gauges"][name] = {
                "elbe_km": km, "record_from": model["from"], "record_to": model["to"], "last_observed_cm": lv[-1][1],
                "mean_low_water_cm": round(tides.mean_low_water(lv), 1), "m2_amplitude_cm": round(model["amplitude_cm"]["M2"], 1),
                "forecast_rmse_cm_by_lead": tides.skill_by_horizon(lv),
                "hourly_utc_start": grid[0].astimezone(timezone.utc).isoformat(), "hourly_cm": [round(float(v), 1) for v in tides.forecast(lv, grid, model)],
                "turning_points": [[t.astimezone(timezone.utc).isoformat(timespec="minutes"), k, round(h)] for t, k, h in tides.turning_points(fine, tides.forecast(lv, fine, model))],
            }
        except Exception as e:                                   # one gauge failing must not lose the others
            out["errors"].append(f"{name}: {type(e).__name__}: {e}"[:160])
    return out


def _jsonl(path: Path) -> List[Dict[str, Any]]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()] if path.exists() else []


def vessel_block(site_store: Path, now: datetime) -> Dict[str, Any]:
    ships = json.loads((site_store / "ships.json").read_text()) if (site_store / "ships.json").exists() else {}
    tracked = json.loads((site_store / "tracked.json").read_text()) if (site_store / "tracked.json").exists() else {}
    latest: Dict[int, Dict[str, Any]] = {}
    for d in range(2, -1, -1):                                   # the last three days of position files, oldest first
        for row in _jsonl(site_store / "positions" / f"{(now - timedelta(days=d)).strftime('%Y-%m-%d')}.jsonl"):
            latest[row["mmsi"]] = row
    runs = _jsonl(site_store / "runs.jsonl")
    day_runs = [r for r in runs if r["t_end"] >= (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")]

    def describe(mmsi: int, row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        s, t = ships.get(str(mmsi), {}), tracked.get(str(mmsi), {})
        return {"mmsi": mmsi, "name": s.get("name") or t.get("name"), "imo": s.get("imo"), "len_m": s.get("len"), "beam_m": s.get("beam"),
                "draught_m": t.get("draught"), "declared_destination": t.get("dest"), "eta_utc": t.get("eta_utc"),
                **({"last_heard": row["t"], "zone": row["zone"], "lat": row["lat"], "lon": row["lon"], "sog_kn": row["sog"], "cog_deg": row.get("cog"), "nav_status": row["nav"]} if row else {})}

    fresh = (now - timedelta(hours=SEEN_HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    bound = [describe(int(m), latest.get(int(m))) for m in tracked]
    in_port = [describe(m, r) for m, r in latest.items() if r["zone"] == "PORT" and r["t"] >= fresh]
    on_river = [describe(m, r) for m, r in latest.items() if r["zone"] in ("ELBE", "ESTUARY") and r["t"] >= fresh]
    return {"last_run_end": runs[-1]["t_end"] if runs else None, "runs_last_24h": len(day_runs), "runs_with_errors_last_24h": sum(1 for r in day_runs if r["errors"]),
            "mean_ships_heard_per_run": round(sum(r["near_ships"] for r in day_runs) / len(day_runs), 1) if day_runs else None,
            "bound_for_hamburg": sorted(bound, key=lambda v: v.get("eta_utc") or "9"), "in_port": in_port, "on_the_elbe": on_river,
            "moored_in_port": sum(1 for v in in_port if v.get("nav_status") == 5)}


def summary(doc: Dict[str, Any]) -> str:
    v, t = doc["vessels"], doc["tide"]
    lines = [f"### Hamburg daily update, {doc['generated_utc'][:16]}Z", "",
             f"Collector: {v['runs_last_24h']} runs in the last 24 h ({v['runs_with_errors_last_24h']} with errors), {v['mean_ships_heard_per_run']} ships heard per run on average.",
             f"Cargo ships 100 m+: {len(v['bound_for_hamburg'])} declaring Hamburg, {len(v['on_the_elbe'])} on the Elbe, {len(v['in_port'])} in port ({v['moored_in_port']} moored).", ""]
    if t["gauges"]:
        lines += ["| Gauge | Elbe km | Last level cm | Mean low water cm | Forecast error cm (6 h / 24 h / 96 h) | Next high water (UTC) |", "|---|---|---|---|---|---|"]
        for name, g in t["gauges"].items():
            hw = next((p for p in g["turning_points"] if p[1] == "H"), None)
            e = g["forecast_rmse_cm_by_lead"]
            lines.append(f"| {name.title()} | {g['elbe_km']} | {g['last_observed_cm']:.0f} | {g['mean_low_water_cm']:.0f} | {e.get('6h')} / {e.get('24h')} / {e.get('96h')} | {hw[0][5:16].replace('T', ' ') + f' ({hw[2]} cm)' if hw else ''} |")
    if t["errors"]:
        lines += ["", "Tide errors: " + "; ".join(t["errors"])]
    return "\n".join(lines) + "\n"


def build(store: Path, now: Optional[datetime] = None, fetch: Callable[[str], List] = tides.fetch_levels) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    site_store = store / "hamburg"
    doc = {"site": "hamburg", "generated_utc": now.isoformat(timespec="seconds"), "tide": tide_block(fetch, now), "vessels": vessel_block(site_store, now)}
    (site_store / "daily").mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    (site_store / "daily" / f"{now.strftime('%Y-%m-%d')}.json").write_text(text, encoding="utf-8")
    (site_store / "latest.json").write_text(text, encoding="utf-8")
    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    a = ap.parse_args()
    doc = build(Path(a.store))
    md = summary(doc)
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    sys.exit(1 if not doc["tide"]["gauges"] else 0)             # fail loudly only if every gauge failed
