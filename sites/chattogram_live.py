"""
Live input for the Chattogram NCT model, rebuilt every day without manual research.

Vessels
  1. AIS: the collector (ingest/collect.py --also chattogram) follows cargo ships that declare Chattogram as their
     destination while they pass Singapore, the Malacca Strait, Port Klang or Colombo, where AISStream's volunteer
     stations hear them. Their declared ETA is used; when it is missing or stale the arrival is dead-reckoned
     along the sea route from the last position.
  2. The carrier schedule read on 13 Nov 2026 (data/live_chattogram_2026-11-13.json) for ships whose published
     ETA is still ahead and that AIS has not picked up.
  AIS cannot say whether a cargo ship carries containers, so a ship counts as an NCT call when it declares
  Chattogram and fits the NCT limits (length and draught); larger ships are listed as excluded.

Tide
  Open-Meteo's marine API gives an hourly sea-level forecast (global tide model plus weather) for the grid cell off
  the Karnaphuli mouth, free and without a key. It is converted to the Chittagong chart datum with a linear map and
  a time lag fitted to the 35 published highs and lows of 13-23 Nov 2026 (fit RMSE 0.11 m, half-split holdout 0.20 m).
  If the API cannot be reached, a five-constituent harmonic fit to the same published table is used instead.
  The two are compared every day and the difference is published.

Box counts, berth occupancy at the plan start and the yard level are not observable and stay estimates.
"""
from __future__ import annotations

import json
import math
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

import chattogram_nct as nct
import tides

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "data" / "live_chattogram_2026-11-13.json"
DHAKA = timezone(timedelta(hours=6))

ANCHORAGE = (22.05, 91.75)
SEA_POINT = (22.18, 91.78)            # Open-Meteo request point off the Karnaphuli mouth (grid cell 22.208 N, 91.792 E)
OPEN_METEO = "https://marine-api.open-meteo.com/v1/marine"

# Open-Meteo sea level (m, MSL, model grid) -> Chittagong tide table (m above MLLW): h(t) = offset + scale * m(t - lag)
TIDE_CAL = {"offset_m": 1.219, "scale": 1.303, "lag_h": 0.65, "rmse_m": 0.11, "holdout_rmse_m": 0.20,
            "fitted_on": "35 published highs and lows for Chittagong, 13-23 Nov 2026 (tide-forecast.com, datum MLLW)"}
HARMONICS = ["M2", "S2", "K1", "O1", "M4"]   # what a 10-day table can separate

TEU_A, TEU_B = 0.00132, 1.65          # TEU ~ a (L x B)^b, fitted to typical feeder and mainline ships (1,700 TEU at 180 x 28 m ...
                                      # ... to 23,000 TEU at 400 x 61 m); an estimate, nothing more
MOVES_PER_TEU = 0.85                  # boxes per call per TEU of capacity at Chattogram (calibrated on the 2025 CPA TOS snapshots)
SPEED_DEFAULT_KN = 13.0
STALE_DAYS = 4.0                      # a ship whose ETA passed this long ago is assumed served and gone
NAV = {0: "under way using engine", 1: "at anchor", 2: "not under command", 3: "restricted manoeuvrability", 5: "moored", 8: "under way sailing", 15: "undefined"}


# ----------------------------------------------------------------------------------------- geometry and routing
def nm(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    p1, p2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.acos(max(-1.0, min(1.0, c)))) * 60.0


def route_nm(lat: float, lon: float) -> Tuple[float, str]:
    """Sea distance to the Chattogram anchorage along the usual route, and the region the position lies in."""
    if lon >= 97.0 and lat < 6.5:                                   # Singapore Strait or the Malacca Strait
        wps, region = [(5.9, 97.6), (6.0, 94.6)], "Singapore Strait" if lon > 103.0 else "Malacca Strait"
    elif lon >= 94.0 and lat < 6.5:
        wps, region = [(6.0, 94.6)], "off northern Sumatra"
    elif lon < 82.0 and lat < 10.0:                                 # Colombo and the south of Sri Lanka
        wps, region = ([(5.85, 80.6)] if lon < 80.6 else []), "off Colombo, Sri Lanka"
    else:
        wps, region = [], "Bay of Bengal"
    pts, d = [(lat, lon)] + wps + [ANCHORAGE], 0.0
    for a, b in zip(pts, pts[1:]):
        d += nm(a, b)
    return d, region


def teu_estimate(loa: float, beam: float) -> int:
    return int(round(TEU_A * (loa * beam) ** TEU_B))


def daylight_hours(day: datetime, lat: float = 22.33, lon: float = 91.83) -> Tuple[int, int, str, str]:
    """Sunrise and sunset (NOAA approximation) and the whole hours a daylight-only ship may be in the river."""
    n = day.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1)
    eq = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    dec = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    ha = math.degrees(math.acos(math.cos(math.radians(90.833)) / (math.cos(math.radians(lat)) * math.cos(dec)) - math.tan(math.radians(lat)) * math.tan(dec)))
    rise = 720 - 4 * (lon + ha) - eq + 360               # minutes, local time UTC+6
    sset = 720 - 4 * (lon - ha) - eq + 360
    fmt = lambda m: f"{int(m // 60):02d}:{int(m % 60):02d}"
    return int(round(rise / 60.0)), int(sset // 60), fmt(rise), fmt(sset)


# ----------------------------------------------------------------------------------------- tide
def fetch_open_meteo(now: datetime, days: int = 10, timeout: float = 30.0) -> List[Tuple[datetime, float]]:
    url = (f"{OPEN_METEO}?latitude={SEA_POINT[0]}&longitude={SEA_POINT[1]}&hourly=sea_level_height_msl"
           f"&timezone=Asia%2FDhaka&past_days=1&forecast_days={days}")
    req = urllib.request.Request(url, headers={"User-Agent": "PortFlow-SimOpt (github.com/artahmid03-source/portflow-simopt-mcp)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        h = json.loads(r.read().decode())["hourly"]
    return [(datetime.fromisoformat(t).replace(tzinfo=DHAKA), float(v)) for t, v in zip(h["time"], h["sea_level_height_msl"]) if v is not None]


def calibrated(series: Sequence[Tuple[datetime, float]], times: Sequence[datetime]) -> List[Optional[float]]:
    """Chart-datum tide at each time from the model series; None outside the series."""
    t0 = series[0][0]
    xs = np.array([(t - t0).total_seconds() / 3600.0 for t, _ in series])
    ys = np.array([v for _, v in series])
    out: List[Optional[float]] = []
    for t in times:
        x = (t - t0).total_seconds() / 3600.0 - TIDE_CAL["lag_h"]
        out.append(None if x < xs[0] or x > xs[-1] else round(TIDE_CAL["offset_m"] + TIDE_CAL["scale"] * float(np.interp(x, xs, ys)), 3))
    return out


def harmonic_model(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Five-constituent fit to the published table (its hourly half-cosine curve), in cm."""
    live = dict(snapshot, tide_hourly_m=None)
    epoch = datetime.fromisoformat(live["plan_epoch_local"])
    first, last = (datetime.fromisoformat(live["tides"][i][0]).replace(tzinfo=DHAKA) for i in (0, -1))
    h0, n = int((first - epoch).total_seconds() // 3600) + 1, int((last - first).total_seconds() // 3600) - 1
    curve = nct.tide_curve(live, h0 + n + 2)
    levels = [((epoch + timedelta(hours=h + 0.5)).astimezone(timezone.utc), 100.0 * curve[h]) for h in range(max(h0, 0), h0 + n)]
    return tides.fit(levels, HARMONICS, huber_cm=1e9, iterations=1)


def tide_block(epoch: datetime, hours: int, fetch: Optional[Callable[[], List[Tuple[datetime, float]]]], snapshot: Dict[str, Any]) -> Dict[str, Any]:
    grid = [epoch + timedelta(hours=h + 0.5) for h in range(hours)]           # mid-hour, as tide_curve uses
    hm = harmonic_model(snapshot)
    harm = [round(float(x) / 100.0, 3) for x in tides.predict(hm, [t.astimezone(timezone.utc) for t in grid])]
    model: List[Optional[float]] = [None] * hours
    error = None
    if fetch is not None:
        try:
            model = calibrated(fetch(), grid)
        except Exception as e:                                               # the plan must still run without the API
            error = f"{type(e).__name__}: {e}"[:160]
    n_model = sum(1 for x in model if x is not None)
    hourly = [m if m is not None else h for m, h in zip(model, harm)]
    both = [(m, h) for m, h in zip(model, harm) if m is not None]
    diff = round(float(np.sqrt(np.mean([(m - h) ** 2 for m, h in both]))), 2) if both else None
    src = (f"Open-Meteo marine sea-level forecast, calibrated to the Chittagong table, for {n_model} of {hours} h"
           + (f"; harmonic fit to the published table for the remaining {hours - n_model} h" if n_model < hours else "")) if n_model else \
          f"harmonic fit ({', '.join(HARMONICS)}) to the published table; Open-Meteo unavailable ({error or 'not requested'})"
    return {"hourly_m": hourly, "harmonic_m": harm, "model_hours": n_model, "source": src, "error": error,
            "rms_difference_model_vs_harmonic_m": diff, "calibration": TIDE_CAL, "harmonic_amplitudes_m": {k: round(v / 100.0, 3) for k, v in hm["amplitude_cm"].items()}}


def turning_points(epoch: datetime, hourly: Sequence[float]) -> List[List[Any]]:
    out = []
    for h in range(1, len(hourly) - 1):
        a, b, c = hourly[h - 1], hourly[h], hourly[h + 1]
        if (b > a and b >= c) or (b < a and b <= c):
            den = a - 2 * b + c
            off = 0.5 * (a - c) / den if den else 0.0                            # parabolic vertex between the three hours
            t = epoch + timedelta(hours=h + 0.5 + off)
            out.append([t.strftime("%Y-%m-%dT%H:%M"), "H" if b > a else "L", round(b - 0.25 * (a - c) * off, 2)])
    return out


# ----------------------------------------------------------------------------------------- vessels
def _jsonl(path: Path) -> List[Dict[str, Any]]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()] if path.exists() else []


def _utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def ais_vessels(store: Path, now: datetime, days: int = 21) -> List[Dict[str, Any]]:
    """Ships the collector tracked as bound for Chattogram, with their latest position and static data."""
    ships = json.loads((store / "ships.json").read_text()) if (store / "ships.json").exists() else {}
    tracked = json.loads((store / "tracked.json").read_text()) if (store / "tracked.json").exists() else {}
    latest: Dict[str, Dict[str, Any]] = {}
    for d in range(days, -1, -1):
        for row in _jsonl(store / "positions" / f"{(now - timedelta(days=d)).strftime('%Y-%m-%d')}.jsonl"):
            latest[str(row["mmsi"])] = row
    out = []
    for m, t in tracked.items():
        s = ships.get(m, {})
        out.append({"mmsi": int(m), "name": (t.get("name") or s.get("name") or "").strip(), "imo": t.get("imo") or s.get("imo"),
                    "len": s.get("len") or t.get("len"), "beam": s.get("beam"), "draught": t.get("draught"), "dest": t.get("dest"),
                    "eta_utc": t.get("eta_utc"), "first_seen": t.get("first_seen"), "last_seen": t.get("last_seen"), "pos": latest.get(m)})
    return out


def from_ais(a: Dict[str, Any], epoch: datetime) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """One AIS-tracked ship -> a vessel record in the live schema, or the reason it is left out."""
    if not a["name"]:
        return None, "no name in AIS"
    loa = float(a["len"] or 0)
    if loa < 100:
        return None, "length not reported"
    beam = float(a["beam"] or round(loa / 7.0, 1))
    rep = a["draught"]
    used = min(float(rep), nct.NCT["max_draught_m"]) if rep else 9.0
    if loa > nct.NCT["max_loa_m"]:
        return None, f"{loa:.0f} m exceeds the NCT length limit (likely a bulk carrier for the outer anchorage)"
    pos, eta, basis = a["pos"], None, ""
    if a["eta_utc"]:
        e = _utc(a["eta_utc"])
        if e >= epoch - timedelta(days=STALE_DAYS):
            eta, basis = e, f"ETA declared on AIS ({a['eta_utc']})"
    region, sog = "unknown", None
    if pos:
        dist, region = route_nm(pos["lat"], pos["lon"])
        sog = pos.get("sog")
        heard = _utc(pos["t"])
        spd = sog if sog and sog >= 6.0 else SPEED_DEFAULT_KN
        dr = heard + timedelta(hours=dist / spd)
        if eta is None or eta < dr - timedelta(hours=12):                      # declared ETA missing, stale or not reachable
            eta, basis = dr, f"dead reckoning: {dist:,.0f} nm from {region} at {spd:.1f} kn, last heard {pos['t'][:16]}Z"
    if eta is None:
        return None, "no ETA and no position"
    if eta < epoch - timedelta(days=STALE_DAYS):
        return None, "ETA passed more than 4 days ago; assumed served"
    eta_hr = max(0, int(round((eta - epoch).total_seconds() / 3600.0)))
    teu = teu_estimate(loa, beam)
    return {
        "name": a["name"], "imo": a["imo"], "mmsi": a["mmsi"], "flag": None, "built": None, "loa_m": loa, "beam_m": beam, "gt": None, "dwt_t": None,
        "teu_est": teu, "moves_est": int(round(MOVES_PER_TEU * teu)), "draught_reported_m": rep, "draught_used_m": round(used, 1),
        "status": NAV.get(pos["nav"], "under way") + f", heard {region}" if pos else "declared Chattogram on AIS (no position kept)",
        "area": "ANCHORAGE" if eta_hr == 0 else "BAY_NEAR" if eta_hr < 24 else "BAY_MID" if eta_hr < 72 else "BAY_FAR",
        "last_port": f"AIS: last heard {region}" + (f" {pos['t'][:16].replace('T', ' ')}Z" if pos else ""),
        "eta_hr": eta_hr, "waited_before_epoch_hr": round(max(0.0, (epoch - eta).total_seconds() / 3600.0), 1),
        "eta_basis": basis + ("; ETA already passed, assumed waiting at the anchorage" if eta < epoch else ""),
        "sog_kn": sog, "cog_deg": pos.get("cog") if pos else None, "ais_time_utc": pos["t"] if pos else None,
        "lat": pos["lat"] if pos else None, "lon": pos["lon"] if pos else None, "declared_destination": a["dest"], "source": "AIS",
    }, None


def from_snapshot(v: Dict[str, Any], epoch: datetime, snap_retrieved: str) -> Optional[Dict[str, Any]]:
    eta = datetime.fromisoformat(v["carrier_eta_local"]).replace(tzinfo=DHAKA)
    if eta < epoch - timedelta(days=1):
        return None
    eta_hr = max(0, int(round((eta - epoch).total_seconds() / 3600.0)))
    return dict(v, eta_hr=eta_hr, waited_before_epoch_hr=0.0, source="carrier schedule",
                status=f"per the carrier schedule read {snap_retrieved}", area="BAY_FAR" if eta_hr >= 72 else "BAY_MID" if eta_hr >= 24 else "BAY_NEAR",
                eta_basis=f"carrier ETA {v['carrier_eta_local'].replace('T', ' ')} from the schedule read {snap_retrieved}")


def build_live(store: Path, now: Optional[datetime] = None, fetch: Optional[Callable[[], List[Tuple[datetime, float]]]] = None,
               snapshot_path: Path = SNAPSHOT, max_ships: int = 10) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    epoch = now.astimezone(DHAKA).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    snap = json.loads(snapshot_path.read_text())
    H = nct.NCT["horizon_hrs"]
    vessels, excluded, seen = [], [], set()
    for a in ais_vessels(store, now):
        v, why = from_ais(a, epoch)
        if v:
            vessels.append(v)
            seen.update({str(a["mmsi"]), str(a["imo"]), a["name"].upper()})
        else:
            excluded.append({"name": a["name"], "mmsi": a["mmsi"], "reason": why})
    for sv in snap["vessels"]:
        if {str(sv["mmsi"]), str(sv["imo"]), sv["name"].upper()} & seen:
            continue
        v = from_snapshot(sv, epoch, snap["retrieved"])
        if v:
            vessels.append(v)
    vessels = [v for v in vessels if v["eta_hr"] < H - 72]                   # the ship must be able to finish inside the horizon
    vessels.sort(key=lambda v: (v["eta_hr"], v["name"]))
    vessels = vessels[:max_ships]
    tb = tide_block(epoch, H + 3, fetch, snap)
    d0, d1, rise, sset = daylight_hours(epoch)
    n_ais = sum(1 for v in vessels if v["source"] == "AIS")
    return {
        "port": "Chattogram (BDCGP)", "retrieved": now.strftime("%Y-%m-%d %H:%MZ"), "plan_epoch_local": epoch.isoformat(),
        "what_is_live": f"{n_ais} of {len(vessels)} ships from AIS (name, IMO, MMSI, size, draught, destination, ETA, last position); "
                        f"tide from {tb['source']}; sunrise and sunset computed for the plan date.",
        "what_is_not_live": "AISStream has no receiver at Chattogram, so ships are heard in Singapore, the Malacca Strait or Colombo and dead-reckoned from there; "
                            "berth occupancy at the plan start, terminal assignment, box counts and the yard level are not published and are estimated or assumed.",
        "sources": {"ais": "AISStream.io websocket, collected hourly by GitHub Actions", "tide": "Open-Meteo marine API (sea_level_height_msl), calibrated to the Chittagong tide table",
                    "carrier_schedule": f"CNC / CMA CGM schedule for BDCGP read {snap['retrieved']} (ships AIS has not picked up)"},
        "estimates": {"teu_capacity": f"{TEU_A} x (LOA x beam)^{TEU_B}", "moves_per_call": f"{MOVES_PER_TEU} x estimated TEU", "draught_used": "AIS draught capped at 9.5 m; 9.0 m if not reported",
                      "berth_occupancy": "quay assumed free at the plan start (not observable)"},
        "fixed_occupants": [], "also_in_port_not_modelled": [], "excluded": excluded[:30],
        "vessels": vessels, "tides": turning_points(epoch, tb["hourly_m"]), "tide_hourly_m": tb["hourly_m"], "tide_margin_m": TIDE_CAL["rmse_m"],
        "tide_detail": {k: v for k, v in tb.items() if k != "hourly_m"},
        "sun_local": {"sunrise": rise, "sunset": sset}, "daylight_hours": [d0, d1],
        "tide_note": f"Tide: {tb['source']}. Gates keep a {TIDE_CAL['rmse_m']:.2f} m margin for the calibration error. "
                     + (f"The calibrated model and the harmonic fit differ by {tb['rms_difference_model_vs_harmonic_m']:.2f} m RMS over the plan." if tb["rms_difference_model_vs_harmonic_m"] is not None else ""),
    }
