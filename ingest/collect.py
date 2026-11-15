"""Scheduled AIS collector (default site: Hamburg; Chattogram is kept as a site, but AISStream hears nothing there).

Listens to AISStream for a few minutes and appends what it heard to a plain-text store:

    store/<site>/positions/YYYY-MM-DD.jsonl   one row per ship per run, skipped while a ship has not moved
    store/<site>/static/YYYY-MM-DD.jsonl    destination, ETA and draught each time a ship changes them
    store/<site>/tracked.json          ships that have declared the port as their destination
    store/<site>/runs.jsonl            one row per run: messages heard, ships seen, errors
    store/coverage.jsonl               ships heard at each port listed in ingest/probe_ports.json (only while that file exists)

Up to three connections run side by side (AISStream allows three per account):

    near    the port and its approaches: positions of cargo ships 100 m or longer, static data of every ship
    feeder  the wider sea region: first static data only, to find ships declaring the port as destination,
            then positions of just those ships (MMSI filter)
    probe   optional: counts the ships heard in the box of each candidate port, to measure where AISStream has coverage

    export AISSTREAM_API_KEY=...        # never commit the key; in GitHub Actions it is a repository secret
    uv run python ingest/collect.py --store store --minutes 8
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aisstream_ingest import URL, area_of, eta_to_datetime, nm_between, parse_frame  # noqa: E402

def zone_hamburg(lat: float, lon: float, sog: Optional[float]) -> str:
    """Coarse position classes along the route German Bight -> Elbe -> Port of Hamburg."""
    if lon >= 9.78 and 53.45 <= lat <= 53.58:
        return "PORT"
    if lon >= 8.95 and 53.50 <= lat <= 53.95:
        return "ELBE"
    if 8.20 <= lon < 8.95 and 53.80 <= lat <= 54.10:
        return "ESTUARY"
    if 8.30 <= lon <= 8.70 and 53.45 <= lat <= 53.75:
        return "WESER"
    return "BIGHT" if 53.40 <= lat <= 54.30 and 7.60 <= lon <= 10.15 else "SEA"


# One entry per port. Boxes are [[lat_south, lon_west], [lat_north, lon_east]]; AIS destinations are free text.
SITES: Dict[str, Dict[str, Any]] = {
    "hamburg": {"near_box": [[53.40, 7.60], [54.30, 10.15]],            # German Bight, Elbe and Weser approaches, Port of Hamburg
                "feeder_box": [[48.0, -6.0], [58.5, 9.0]],             # Channel and North Sea
                "dest_re": re.compile(r"HAMBURG|\bDE\s?HAM\b", re.I), "zone": zone_hamburg},
    "chattogram": {"near_box": [[19.5, 89.5], [22.7, 92.4]], "feeder_box": [[0.5, 78.0], [19.5, 105.0]],
                   "dest_re": re.compile(r"CHITT?AGON|CHATT?OGRA|\bBD\s?CGP\b|\bCGP\b|\bCTG\b", re.I), "zone": area_of},
}
DEFAULT_SITE = os.environ.get("PORTFLOW_SITE", "hamburg")                # AISStream hears nothing at Chattogram (measured 15 Nov 2026)
MIN_LEN_M = 100.0                                # positions are kept for cargo ships (AIS type 70-79) at least this long
TRACK_DAYS = 14                                  # forget a ship this long after it last declared Chattogram
STILL_NM, HEARTBEAT_HRS = 0.05, 6.0              # a ship that has not moved is re-logged only every 6 h
MAX_MMSI_FILTER = 200                            # AISStream limit per subscription
PROBE_FILE = Path(__file__).resolve().parent / "probe_ports.json"


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ----------------------------------------------------------------------------- listening
async def stream(name: str, url: str, key: str, phases: List, t_end: float, on_record: Callable, stats: Dict[str, Any]) -> None:
    """One connection. `phases` is [(start_time, subscription_builder), ...]; a builder may return None to keep the current subscription."""
    import websockets  # optional dependency: uv sync --extra ais

    loop, backoff, idx = asyncio.get_running_loop(), 1.0, 0
    while loop.time() < t_end:
        try:
            async with websockets.connect(url, open_timeout=10, max_size=2 ** 20) as ws:      # permessage-deflate is on by default
                await ws.send(json.dumps({"APIKey": key, **phases[idx][1]()}))                 # must arrive within 3 s
                stats[f"{name}_connects"] += 1
                backoff = 1.0
                while loop.time() < t_end:
                    if idx + 1 < len(phases) and loop.time() >= phases[idx + 1][0]:
                        idx += 1
                        sub = phases[idx][1]()
                        if sub:
                            await ws.send(json.dumps({"APIKey": key, **sub}))                  # replaces the subscription
                            stats[f"{name}_resubscribed"] += 1
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    msg = json.loads(raw)
                    if isinstance(msg, dict) and "error" in msg:
                        stats["errors"].append(f"{name}: server said: {str(msg['error'])[:120]}")
                        stats["fatal"] = True
                        return
                    rec = parse_frame(msg)
                    if rec:                                          # counts AIS messages only, not the server's subscription confirmation
                        stats[f"{name}_msgs"] += 1
                        on_record(name, idx, rec)
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as e:
            if len(stats["errors"]) < 10:
                stats["errors"].append(f"{name}: {type(e).__name__}: {e}"[:160])
            await asyncio.sleep(max(0.0, min(backoff, t_end - loop.time())))                   # exponential backoff, as AISStream advises
            backoff = min(backoff * 2, 30.0)


def port_of(lat: Optional[float], lon: Optional[float], ports: List[Dict[str, Any]]) -> Optional[str]:
    if lat is None or lon is None:
        return None
    for p in ports:
        (s, w), (n, e) = p["box"]
        if s <= lat <= n and w <= lon <= e:
            return p["name"]
    return None


async def collect(key: str, minutes: float, tracked: Iterable[int] = (), url: str = URL, discover_frac: float = 0.55,
                  probe_ports: Optional[List[Dict[str, Any]]] = None, probe_frac: float = 0.45, site: str = DEFAULT_SITE) -> Dict[str, Any]:
    NEAR_BOX, FEEDER_BOX, DEST_RE = SITES[site]["near_box"], SITES[site]["feeder_box"], SITES[site]["dest_re"]
    near_pos, near_static, feeder_static, track_pos = {}, {}, {}, {}
    probe = {p["name"]: {"msgs": 0, "ships": set(), "moving": set(), "cargo": set()} for p in probe_ports or []}
    stats: Dict[str, Any] = Counter()
    stats["errors"] = []
    known = {int(m) for m in tracked}

    def on_record(name: str, phase: int, rec: Dict[str, Any]) -> None:
        rec["rx"] = iso(datetime.now(timezone.utc))
        if name == "probe":
            is_pos = rec["kind"] == "PositionReport"
            port = port_of(rec["lat"] if is_pos else rec.get("meta_lat"), rec["lon"] if is_pos else rec.get("meta_lon"), probe_ports)
            if port:
                c = probe[port]
                c["msgs"] += 1
                c["ships"].add(rec["mmsi"])
                if is_pos and (rec["sog_kn"] or 0) >= 0.5:
                    c["moving"].add(rec["mmsi"])
                if not is_pos and 70 <= (rec.get("ship_type") or 0) <= 79 and (rec.get("length_m") or 0) >= 120:
                    c["cargo"].add(rec["mmsi"])                     # AIS type 70-79 = cargo ship; 120 m or longer
        elif name == "near":
            (near_pos if rec["kind"] == "PositionReport" else near_static)[rec["mmsi"]] = rec
        elif rec["kind"] == "ShipStaticData":
            if DEST_RE.search(declared_port(rec.get("destination"))) and is_cargo({"type": rec.get("ship_type"), "len": rec.get("length_m"), "imo": rec.get("imo")}):
                feeder_static[rec["mmsi"]] = rec
        else:
            track_pos[rec["mmsi"]] = rec

    def track_subscription() -> Optional[Dict[str, Any]]:
        mmsis = sorted(known | set(feeder_static))[:MAX_MMSI_FILTER]
        if not mmsis:
            return None                                             # nobody to follow yet: keep discovering
        return {"BoundingBoxes": [FEEDER_BOX, NEAR_BOX], "FiltersShipMMSI": [str(m).zfill(9) for m in mmsis], "FilterMessageTypes": ["PositionReport"]}

    loop = asyncio.get_running_loop()
    t0 = loop.time()
    t_end = t0 + minutes * 60.0
    started = datetime.now(timezone.utc)
    jobs = []
    if probe_ports:
        jobs.append(stream("probe", url, key, [(t0, lambda: {"BoundingBoxes": [p["box"] for p in probe_ports], "FilterMessageTypes": ["PositionReport", "ShipStaticData"]})],
                           t0 + probe_frac * minutes * 60.0, on_record, stats))
    await asyncio.gather(
        *jobs,
        stream("near", url, key, [(t0, lambda: {"BoundingBoxes": [NEAR_BOX], "FilterMessageTypes": ["PositionReport", "ShipStaticData"]})], t_end, on_record, stats),
        stream("feeder", url, key, [(t0, lambda: {"BoundingBoxes": [FEEDER_BOX], "FilterMessageTypes": ["ShipStaticData"]}),
                                    (t0 + discover_frac * minutes * 60.0, track_subscription)], t_end, on_record, stats),
    )
    coverage = {n: {"msgs": c["msgs"], "ships": len(c["ships"]), "moving": len(c["moving"]), "cargo": len(c["cargo"])} for n, c in probe.items()}
    return {"near_pos": near_pos, "near_static": near_static, "feeder_static": feeder_static, "track_pos": track_pos, "coverage": coverage, "site": site,
            "probe_seconds": round(probe_frac * minutes * 60.0) if probe_ports else 0, "stats": dict(stats), "started": started, "ended": datetime.now(timezone.utc)}


# ----------------------------------------------------------------------------- storing
def _load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def _append(path: Path, rows: List[Dict[str, Any]]) -> None:
    if rows:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")


def declared_port(dest: Optional[str]) -> str:
    """Crews often write "FROM>TO" (also ">>" or "->"): the port a ship is going to is the last part."""
    return re.split(r"-?>+", dest or "")[-1].strip()


def is_cargo(s: Dict[str, Any]) -> bool:
    """Sea-going cargo ship: AIS type 70-79, long enough, and with an IMO number (inland vessels have none)."""
    return 70 <= (s.get("type") or 0) <= 79 and (s.get("len") or 0) >= MIN_LEN_M and (s.get("imo") or 0) > 0


def write_store(root: Path, got: Dict[str, Any]) -> Dict[str, Any]:
    """Append this run to <root>/<site>/ and return the run summary row. The coverage log stays at the root."""
    site = got.get("site", DEFAULT_SITE)
    DEST_RE, zone_of = SITES[site]["dest_re"], SITES[site]["zone"]
    store = root / site
    store.mkdir(parents=True, exist_ok=True)
    now: datetime = got["ended"]
    day = now.astimezone(timezone.utc).strftime("%Y-%m-%d")
    last = _load(store / "last.json", {})                 # mmsi -> [time, lat, lon, nav] of the last row written
    seen_static = _load(store / "static_seen.json", {})   # mmsi -> fingerprint of the last static row written
    tracked = _load(store / "tracked.json", {})
    ships = _load(store / "ships.json", {})               # mmsi -> name, imo, type, len, beam: what kind of ship each MMSI is
    for recs in (got["near_static"], got["feeder_static"]):
        for mmsi, s in recs.items():
            ships[str(mmsi)] = {"name": s.get("name"), "imo": s.get("imo"), "type": s.get("ship_type"), "len": s.get("length_m"), "beam": s.get("beam_m")}

    for recs in (got["near_static"], got["feeder_static"]):                          # ships declaring the port this run count as tracked at once
        for mmsi, s in recs.items():
            if DEST_RE.search(declared_port(s.get("destination"))) and is_cargo(ships[str(mmsi)]):
                tracked.setdefault(str(mmsi), {"first_seen": s["rx"], "last_seen": s["rx"]})

    pos_rows, skipped = [], 0
    for src, recs in (("track", got["track_pos"]), ("near", got["near_pos"])):      # a ship heard on both is logged as near
        for mmsi, p in recs.items():
            if src == "track" and mmsi in got["near_pos"]:
                continue
            if src == "near" and str(mmsi) not in tracked and not is_cargo(ships.get(str(mmsi), {})):
                skipped += 1                                      # tugs, barges, ferries, and ships not yet identified
                continue
            prev = last.get(str(mmsi))
            if prev:
                age_h = (datetime.fromisoformat(p["rx"].replace("Z", "+00:00")) - datetime.fromisoformat(prev[0].replace("Z", "+00:00"))).total_seconds() / 3600.0
                if nm_between((p["lat"], p["lon"]), (prev[1], prev[2])) < STILL_NM and prev[3] == p["nav_status"] and age_h < HEARTBEAT_HRS:
                    continue
            sog = p["sog_kn"]
            pos_rows.append({"t": p["rx"], "mmsi": mmsi, "lat": round(p["lat"], 5), "lon": round(p["lon"], 5), "sog": None if sog is None else round(sog, 1),
                             "cog": None if p["cog_deg"] is None else round(p["cog_deg"], 1), "hdg": p["heading_deg"], "nav": p["nav_status"],
                             "zone": zone_of(p["lat"], p["lon"], sog), "src": src})
            last[str(mmsi)] = [p["rx"], round(p["lat"], 5), round(p["lon"], 5), p["nav_status"]]

    static_rows = []
    for src, recs in (("near", got["near_static"]), ("feeder", got["feeder_static"])):
        for mmsi, s in recs.items():
            eta = eta_to_datetime(s["eta"], now) if s.get("eta") else None
            bound = bool(DEST_RE.search(declared_port(s.get("destination")))) and is_cargo(ships[str(mmsi)])
            fp = f"{s.get('destination')}|{s.get('eta')}|{s.get('ais_draught_m')}"
            if seen_static.get(str(mmsi)) != fp:
                static_rows.append({"t": s["rx"], "mmsi": mmsi, "imo": s.get("imo"), "name": s.get("name"), "type": s.get("ship_type"), "len": s.get("length_m"),
                                    "beam": s.get("beam_m"), "draught": s.get("ais_draught_m"), "dest": s.get("destination"),
                                    "eta_utc": eta.strftime("%Y-%m-%dT%H:%MZ") if eta else None, "bound": bound, "src": src})
                seen_static[str(mmsi)] = fp
            if bound:
                t = tracked.setdefault(str(mmsi), {"first_seen": s["rx"]})
                t.update(name=s.get("name"), imo=s.get("imo"), dest=s.get("destination"), draught=s.get("ais_draught_m"), len=s.get("length_m"),
                         eta_utc=eta.strftime("%Y-%m-%dT%H:%MZ") if eta else None, last_seen=s["rx"])

    cutoff = iso(now - timedelta(days=TRACK_DAYS))
    tracked = {m: t for m, t in tracked.items() if t["last_seen"] >= cutoff}

    st = got["stats"]
    run = {"t_start": iso(got["started"]), "t_end": iso(now), "near_msgs": st.get("near_msgs", 0), "feeder_msgs": st.get("feeder_msgs", 0),
           "near_ships": len(got["near_pos"]), "near_static": len(got["near_static"]), "bound_static": len(got["feeder_static"]),
           "tracked_heard": len(got["track_pos"]), "tracked_total": len(tracked), "rows_positions": len(pos_rows), "rows_static": len(static_rows),
           "not_cargo_or_unknown": skipped, "errors": st.get("errors", [])}
    _append(store / "positions" / f"{day}.jsonl", pos_rows)
    _append(store / "static" / f"{day}.jsonl", static_rows)
    _append(store / "runs.jsonl", [run])
    (store / "ships.json").write_text(json.dumps(ships, separators=(",", ":"), ensure_ascii=False))
    if got.get("coverage"):
        _append(root / "coverage.jsonl", [{"t": iso(got["started"]), "listen_s": got["probe_seconds"], "ports": got["coverage"]}])
    (store / "last.json").write_text(json.dumps(last, separators=(",", ":")))
    (store / "static_seen.json").write_text(json.dumps(seen_static, separators=(",", ":"), ensure_ascii=False))
    (store / "tracked.json").write_text(json.dumps(dict(sorted(tracked.items())), indent=1, ensure_ascii=False))
    return run


def summary_markdown(run: Dict[str, Any], tracked: Dict[str, Any], coverage: Optional[Dict[str, Any]] = None) -> str:
    lines = ["### AIS collection", "", "| Messages (near / feeder) | Ships heard near the port | Ships bound for the port | Rows written |", "|---|---|---|---|",
             f"| {run['near_msgs']} / {run['feeder_msgs']} | {run['near_ships']} | {run['tracked_total']} ({run['tracked_heard']} positions this run) | {run['rows_positions']} positions, {run['rows_static']} static |"]
    if run["errors"]:
        lines += ["", "Errors: " + "; ".join(run["errors"])]
    if tracked:
        lines += ["", "| Ship | MMSI | Declared destination | ETA (UTC) | Draught m |", "|---|---|---|---|---|"]
        lines += [f"| {t.get('name') or ''} | {m} | {t.get('dest') or ''} | {t.get('eta_utc') or ''} | {t.get('draught') or ''} |" for m, t in list(tracked.items())[:40]]
    if coverage:
        lines += ["", "### Coverage probe", "", "| Port | Ships heard | Moving | Cargo ships 120 m+ (static data) | Messages |", "|---|---|---|---|---|"]
        lines += [f"| {n} | {c['ships']} | {c['moving']} | {c['cargo']} | {c['msgs']} |" for n, c in sorted(coverage.items(), key=lambda kv: -kv[1]["ships"])]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    ap.add_argument("--minutes", type=float, default=8.0)
    ap.add_argument("--url", default=os.environ.get("AISSTREAM_URL", URL))
    ap.add_argument("--site", default=DEFAULT_SITE, choices=sorted(SITES))
    ap.add_argument("--require-key", action="store_true", help="fail instead of skipping when AISSTREAM_API_KEY is not set")
    a = ap.parse_args()
    key = os.environ.get("AISSTREAM_API_KEY", "").strip()
    if not key:
        print("::warning::AISSTREAM_API_KEY is not set, so nothing was collected. Add it as a repository secret.")
        return 2 if a.require_key else 0
    store = Path(a.store)
    got = asyncio.run(collect(key, a.minutes, _load(store / a.site / "tracked.json", {}).keys(), a.url, probe_ports=_load(PROBE_FILE, None), site=a.site))
    run = write_store(store, got)
    md = f"Site: {a.site}\n\n" + summary_markdown(run, _load(store / a.site / "tracked.json", {}), got.get("coverage"))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    if got["stats"].get("fatal"):
        print("::error::AISStream refused the connection: " + "; ".join(run["errors"]))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
