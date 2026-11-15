"""Live AIS ingestion for the Chattogram queue (AISStream websocket).

Adds latitude, longitude, speed, course, heading and the AIS draught/ETA to the
vessels in a live_chattogram_*.json file, and re-derives each ship's area and,
for ships under way inside the approach box, its hours to the anchorage.

    export AISSTREAM_API_KEY=...            # free key from https://aisstream.io (sign in with GitHub)
    uv run python ingest/aisstream_ingest.py --minutes 10
    PORTFLOW_LIVE_FILE=data/live_chattogram_<date>_ais.json uv run python run_nct_pipeline.py

Message format (AISStream docs, checked 13 Nov 2026): send the subscription within
3 s of connecting; BoundingBoxes are [[lat, lon], [lat, lon]] corner pairs;
FiltersShipMMSI takes up to 200 nine-digit strings; frames arrive as UTF-8 JSON
with MessageType / MetaData / Message.<MessageType>. AISStream asks clients to
use permessage-deflate, which the `websockets` library negotiates by default.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

ROOT = Path(__file__).resolve().parent.parent
URL = "wss://stream.aisstream.io/v0/stream"

# Boxes as [[lat_south, lon_west], [lat_north, lon_east]]
ANCHORAGE_BOX = [[21.75, 91.65], [22.35, 91.85]]      # outer anchorage and bar, as specified for this project
APPROACH_BOX = [[19.50, 89.50], [22.60, 92.30]]       # northern Bay of Bengal approach, to catch inbound ships
RIVER_POINT = (22.3015, 91.7972)                      # Karnaphuli channel reference point, as specified
ANCHORAGE_POINT = (22.05, 91.75)                      # centre of the anchorage box, used for time-to-go


def in_box(lat: float, lon: float, box) -> bool:
    (s, w), (n, e) = box
    return s <= lat <= n and w <= lon <= e


def nm_between(a, b) -> float:
    """Great-circle distance in nautical miles."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 3440.065 * 2 * math.asin(math.sqrt(h))


def area_of(lat: float, lon: float, sog: Optional[float]) -> str:
    """Map a position to the area codes the planner and HMI use."""
    if nm_between((lat, lon), RIVER_POINT) <= 3.0 and lat > 22.2:
        return "RIVER" if (sog or 0) >= 1.0 else "BERTH"
    if in_box(lat, lon, ANCHORAGE_BOX):
        return "ANCHORAGE" if (sog or 0) < 1.5 else "BAY_NEAR"
    d = nm_between((lat, lon), ANCHORAGE_POINT)
    return "BAY_NEAR" if d < 150 else "BAY_MID" if d < 600 else "BAY_FAR"


def _first(d: Dict[str, Any], *keys):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def parse_frame(raw: bytes | str | Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """One AISStream frame (raw or already decoded) -> a flat record, or None for messages we do not use."""
    msg = raw if isinstance(raw, dict) else json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    kind, meta = msg.get("MessageType"), msg.get("MetaData") or {}
    body = (msg.get("Message") or {}).get(kind) or {}
    mmsi = _first(meta, "MMSI", "mmsi") or body.get("UserID")
    if mmsi is None:
        return None
    rec: Dict[str, Any] = {"mmsi": int(mmsi), "kind": kind, "time_utc": _first(meta, "time_utc", "TimeUtc", "Time")}
    if kind == "PositionReport":
        lat, lon = _first(body, "Latitude") or _first(meta, "latitude", "Latitude"), _first(body, "Longitude") or _first(meta, "longitude", "Longitude")
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            return None
        hdg = body.get("TrueHeading")
        rec.update(lat=float(lat), lon=float(lon), sog_kn=body.get("Sog"), cog_deg=body.get("Cog"),
                   heading_deg=None if hdg in (None, 511) else hdg, nav_status=body.get("NavigationalStatus"))
        return rec
    if kind == "ShipStaticData":
        dim, eta = body.get("Dimension") or {}, body.get("Eta") or {}
        draught = body.get("MaximumStaticDraught")
        if draught is not None and draught > 25:          # guard: raw AIS units are 0.1 m
            draught = draught / 10.0
        rec.update(imo=body.get("ImoNumber"), ship_type=body.get("Type"), name=(body.get("Name") or "").strip(), destination=(body.get("Destination") or "").strip(),
                   length_m=(dim.get("A", 0) + dim.get("B", 0)) or None, beam_m=(dim.get("C", 0) + dim.get("D", 0)) or None,
                   ais_draught_m=draught, eta=eta if eta.get("Month") else None)
        return rec
    return None


def eta_to_datetime(eta: Dict[str, int], now: datetime) -> Optional[datetime]:
    """AIS ETA has no year: take the next occurrence after `now` minus 30 days."""
    try:
        for year in (now.year, now.year + 1):
            t = datetime(year, eta["Month"], eta["Day"], eta.get("Hour", 0) % 24, eta.get("Minute", 0) % 60, tzinfo=timezone.utc)
            if t >= now - timedelta(days=30):
                return t
    except (KeyError, ValueError):
        return None
    return None


def merge(live: Dict[str, Any], records: Iterable[Dict[str, Any]], now: datetime) -> Dict[str, Any]:
    """Fold the latest position and static record for each MMSI into the live file."""
    latest_pos, latest_static = {}, {}
    for r in records:
        (latest_pos if r["kind"] == "PositionReport" else latest_static)[r["mmsi"]] = r
    epoch = datetime.fromisoformat(live["plan_epoch_local"])
    out = json.loads(json.dumps(live))
    seen = []
    for v in out["vessels"] + out.get("fixed_occupants", []) + out.get("also_in_port_not_modelled", []):
        p, s = latest_pos.get(int(v["mmsi"])), latest_static.get(int(v["mmsi"]))
        if p:
            v.update(lat=round(p["lat"], 5), lon=round(p["lon"], 5), sog_kn=p["sog_kn"], cog_deg=p["cog_deg"], heading_deg=p["heading_deg"],
                     ais_time_utc=p["time_utc"] or now.strftime("%Y-%m-%d %H:%M UTC"))
            v["area"] = area_of(p["lat"], p["lon"], p["sog_kn"])
            if "eta_hr" in v and v["area"].startswith("BAY") and (p["sog_kn"] or 0) >= 3.0:
                hrs = nm_between((p["lat"], p["lon"]), ANCHORAGE_POINT) / p["sog_kn"]
                v["eta_hr"] = max(0, int(round(((now + timedelta(hours=hrs)) - epoch).total_seconds() / 3600)))
                v["eta_basis"] = f"AIS: {hrs:.1f} h to the anchorage at {p['sog_kn']:.1f} kn"
            elif "eta_hr" in v and v["area"] == "ANCHORAGE":
                v["eta_hr"] = 0
                v["eta_basis"] = "AIS: at the anchorage"
            seen.append(v["name"])
        if s:
            if s.get("ais_draught_m"):
                v["draught_reported_m"] = s["ais_draught_m"]
                if "draught_used_m" in v:
                    v["draught_used_m"] = min(s["ais_draught_m"], 9.5)
            if s.get("destination"):
                v["ais_destination"] = s["destination"]
            t = eta_to_datetime(s["eta"], now) if s.get("eta") else None
            if t:
                v["ais_eta_utc"] = t.strftime("%Y-%m-%d %H:%M")
    out["what_is_live"] = out["what_is_live"] + f" AISStream positions merged for {len(seen)} ships at {now:%Y-%m-%d %H:%M} UTC."
    out["ais_merged"] = seen
    return out


async def collect(api_key: str, mmsis, minutes: float):
    import websockets  # optional dependency: uv sync --extra ais
    sub = {"APIKey": api_key, "BoundingBoxes": [ANCHORAGE_BOX, APPROACH_BOX],
           "FiltersShipMMSI": [str(m).zfill(9) for m in mmsis][:200], "FilterMessageTypes": ["PositionReport", "ShipStaticData"]}
    records, deadline, backoff = [], asyncio.get_event_loop().time() + minutes * 60, 1.0
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with websockets.connect(URL, compression="deflate", open_timeout=10) as ws:
                await ws.send(json.dumps(sub))                     # must arrive within 3 s
                backoff = 1.0
                while asyncio.get_event_loop().time() < deadline:
                    left = deadline - asyncio.get_event_loop().time()
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(1.0, left))
                    rec = parse_frame(raw)
                    if rec:
                        records.append(rec)
                        print(f"{rec['kind']:15s} {rec['mmsi']}  {rec.get('lat', '')} {rec.get('lon', '')} {rec.get('sog_kn', '')}", file=sys.stderr)
        except asyncio.TimeoutError:
            break
        except Exception as e:                                    # reconnect with exponential backoff, as AISStream advises
            print(f"connection dropped ({e}); retrying in {backoff:.0f} s", file=sys.stderr)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
    return records


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", default=str(ROOT / "data" / "live_chattogram_2026-11-13.json"))
    ap.add_argument("--minutes", type=float, default=10.0)
    args = ap.parse_args()
    key = os.environ.get("AISSTREAM_API_KEY")
    if not key:
        sys.exit("Set AISSTREAM_API_KEY (free key at https://aisstream.io).")
    live = json.loads(Path(args.live).read_text())
    mmsis = [v["mmsi"] for v in live["vessels"] + live.get("fixed_occupants", []) + live.get("also_in_port_not_modelled", [])]
    now = datetime.now(timezone.utc)
    recs = asyncio.run(collect(key, mmsis, args.minutes))
    merged = merge(live, recs, now)
    out = Path(args.live).with_name(f"live_chattogram_{now:%Y-%m-%d}_ais.json")
    out.write_text(json.dumps(merged, indent=1))
    print(f"{len(recs)} messages, positions for {len(merged['ais_merged'])} of {len(mmsis)} ships -> {out}")
    print(f"next: PORTFLOW_LIVE_FILE={out} uv run python run_nct_pipeline.py")


if __name__ == "__main__":
    main()
