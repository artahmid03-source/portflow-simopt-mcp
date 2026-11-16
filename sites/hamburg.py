"""
PortFlow site model: the container terminals of the Port of Hamburg and the Lower Elbe.

The same CP-SAT berth plan and Benders loop as Chattogram NCT (sites/chattogram_nct.py), with Hamburg's rules:
  * five quay segments on four terminals (HHLA Burchardkai on two basins, Eurogate, HHLA Tollerort, HHLA Altenwerder),
    their geometry taken from the OpenStreetMap terminal outlines, each terminal with its own quay-crane pool;
  * the Elbe fairway rule of the 2019-2022 deepening: a ship up to 13.80 m (13.10 m for the largest class) may sail
    at any state of tide; deeper ships ride the tide, up to 16.10 m inbound and 14.80 m outbound (15.40 / 14.10 m for
    the largest class), less 0.20 m because the channel does not yet give the full design depth;
  * a tide-dependent ship needs, at every hour it spends between Waltershof and Brunsbuettel, the forecast water level
    at its position along the river to be above mean low water by its extra draught plus the forecast error at that
    lead time. The forecast is
    the harmonic + surge forecast from the six PEGELONLINE gauges (run_daily.py), interpolated by Elbe kilometre.

What is live: ships declaring Hamburg on AIS, their size, draught and ETA, ships moored at each terminal and where
along the quay (projected from their AIS position), and the gauge forecasts. Assumed: crane counts for Eurogate,
crane productivity, box counts per call, the carrier-to-terminal map, yard figures.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import advice
import chattogram_nct as nct

UTC = timezone.utc

# Quay segments (lat, lon) along the water side of the OSM terminal polygons (Nominatim, read 16 Nov 2026).
QUAY_GEOM: Dict[str, Dict[str, Any]] = {
    "CTB-W": {"terminal": "CTB", "name": "Burchardkai, Waltershofer Hafen", "line": [(53.5348, 9.9090), (53.5273, 9.9271)]},
    "CTB-P": {"terminal": "CTB", "name": "Burchardkai, Parkhafen", "line": [(53.5259, 9.9291), (53.5276, 9.9312), (53.5301, 9.9316), (53.5327, 9.9310), (53.5355, 9.9295), (53.5367, 9.9282)]},
    "CTH": {"terminal": "CTH", "name": "Eurogate Container Terminal Hamburg", "line": [(53.5247, 9.9268), (53.5352, 9.9007)]},
    "CTT": {"terminal": "CTT", "name": "Tollerort", "line": [(53.5284, 9.9536), (53.5349, 9.9504), (53.5388, 9.9472)]},
    "CTA": {"terminal": "CTA", "name": "Altenwerder", "line": [(53.4975, 9.9379), (53.5115, 9.9368)]},
}
TERMINALS = {"CTB": "HHLA Container Terminal Burchardkai", "CTH": "Eurogate Container Terminal Hamburg",
             "CTT": "HHLA Container Terminal Tollerort", "CTA": "HHLA Container Terminal Altenwerder"}
STS = {"CTB": 23, "CTA": 14, "CTT": 14, "CTH": 20}   # HHLA terminal pages; Eurogate's count is an ASSUMPTION (not confirmed)
AXIS_GAP_M = 200                                      # gap between segments on the planner's single quay axis

# Fairway: Elbe-1 to Waltershof, and the approach legs inside the port (for the map)
ELBE_ROUTE = [(54.00, 8.11), (53.93, 8.48), (53.89, 8.70), (53.89, 9.14), (53.80, 9.37), (53.70, 9.47), (53.63, 9.53),
              (53.575, 9.66), (53.556, 9.78), (53.545, 9.86), (53.541, 9.90)]
APPROACH = {"CTB-W": [(53.536, 9.905)], "CTB-P": [(53.543, 9.928), (53.538, 9.934)], "CTH": [(53.536, 9.905)],
            "CTT": [(53.543, 9.935), (53.540, 9.958)], "CTA": [(53.543, 9.928), (53.530, 9.938), (53.515, 9.940)]}
KM_SEA, KM_PORT = 755.0, 627.0                         # Elbe kilometre at Elbe-1 and at Waltershof
BOX_KM = (636.0, 644.0)                                # passing box (Begegnungsbox) between Wedel and Blankenese, Elbe km (approximate)
MEET_FREE_BEAM_M, MEET_BOX_BEAM_M = 90.0, 104.0       # combined beam: up to 90 m ships may meet anywhere, up to 104 m only in the
                                                       # passing box, above that not at all (ASSUMPTION from the published box design)
BIG_SHIP = (330.0, 45.0)                               # HPA: "aussergewoehnlich grosse Fahrzeuge", over 330 m long or 45 m wide
KOEHLBRAND_MAX_BEAM_M = 51.0                           # ASSUMPTION: ships for Altenwerder pass under the Koehlbrand bridge; wider ships use CTB
CRITICAL_REACH = (627.0, 690.0)                        # ASSUMPTION: the tide check applies from Waltershof to Brunsbuettel, where the
                                                       # deepened channel is shallowest; seaward of it the fairway is deeper

CARRIER_TERMINAL = [                                   # ASSUMPTION, from public alliance and shareholder news; AIS names only
    (re.compile(r"EXPRESS$|^SFL |HAPAG", re.I), "CTA"),     # Hapag-Lloyd holds a stake in Altenwerder; its ships are named "<city> EXPRESS"
    (re.compile(r"^COSCO|^OOCL|^CSCL", re.I), "CTT"),       # COSCO holds a stake in Tollerort
    (re.compile(r"MAERSK|^SEALAND|^SAFMARINE", re.I), "CTH"),  # Maersk calls at Eurogate (observed on AIS)
    (re.compile(r"^EVER |^MSC |^ONE |^HMM |^YM |^YANG MING|^CMA CGM|^APL |^ZIM", re.I), "CTB"),
]

HAM: Dict[str, Any] = {
    "horizon_hrs": 120, "berth_tail_hrs": 12, "transit_hrs": 6, "berth_gap_m": 30, "pilot_tug_sets": 8,   # pilots: not a binding limit at Hamburg (ASSUMPTION)
    "qgc_gmph": 28.0, "qgc_total": sum(STS.values()), "crane_pools": dict(STS),      # 28 moves per crane-hour: ASSUMPTION
    "rtg_per_berth_cluster": 24, "yard_cluster_teu": 14000.0, "ref_boxes_per_hr": 160.0,   # one berth's yard cluster: ASSUMPTION
    "icd_ratio": 0.25, "initial_yard_occupancy_pct": 72.0,                          # night rail/barge evacuation share, start level: ASSUMPTION
    "draught_indep_m": 13.8, "draught_indep_mega_m": 13.1, "draught_max_in_m": 16.1, "draught_max_in_mega_m": 15.4,
    "draught_max_out_m": 14.8, "draught_max_out_mega_m": 14.1, "deepening_shortfall_m": 0.20, "mega_loa_m": 366.0, "mega_beam_m": 52.0,
    "wind_limit_ms": 13.9,                            # ASSUMPTION: big ships do not move at Beaufort 7 or more (HPA sets a wind cap, value not published)
    "objective": "cost", "yard_model": "per_ship",
    "reefer_plugs": 1600, "yard_bays": 40, "daylight_hours": [0, 24], "night_max_loa_m": 9999, "night_max_draught_m": 99.0,
    "max_draught_m": 16.1, "ukc_m": 0.0, "channel_depth_m": 0.0, "spring_max_draught_m": 99.0, "spring_tide_min_m": 0.0, "max_loa_m": 400.0,
    "teu_a": 0.00132, "teu_b": 1.65, "boxes_per_teu": 1 / 1.6, "exchange_mainline": 0.35, "exchange_feeder": 0.7,
}


# ----------------------------------------------------------------------------------------- geometry
def _xy(p: Tuple[float, float], lat0: float = 53.53) -> Tuple[float, float]:
    return p[1] * 111320.0 * math.cos(math.radians(lat0)), p[0] * 110540.0


def seg_length(line: Sequence[Tuple[float, float]]) -> float:
    return sum(math.dist(_xy(a), _xy(b)) for a, b in zip(line, line[1:]))


def project(line: Sequence[Tuple[float, float]], p: Tuple[float, float]) -> Tuple[float, float]:
    """Distance along the quay line of the point nearest to p, and p's distance from the line (metres)."""
    best, run = (0.0, 1e12), 0.0
    P = _xy(p)
    for a, b in zip(line, line[1:]):
        A, B = _xy(a), _xy(b)
        L = math.dist(A, B)
        u = max(0.0, min(1.0, ((P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1])) / (L * L)))
        d = math.dist(P, (A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])))
        if d < best[1]:
            best = (run + u * L, d)
        run += L
    return best


def quays() -> Dict[str, Dict[str, Any]]:
    """Each segment's place on the planner's quay axis."""
    out, x = {}, 0
    for qid, q in QUAY_GEOM.items():
        L = int(round(seg_length(q["line"])))
        out[qid] = {"id": qid, "terminal": q["terminal"], "name": q["name"], "length_m": L, "axis_lo": x, "axis_hi": x + L,
                    "line": [list(p) for p in q["line"]], "approach": [list(p) for p in APPROACH[qid]]}
        x += L + AXIS_GAP_M
    return out


QUAYS = quays()
HAM["quay_ocean_m"] = max(q["axis_hi"] for q in QUAYS.values())


def locate(lat: float, lon: float, max_off_m: float = 160.0) -> Optional[Tuple[str, float]]:
    """Which quay segment a moored ship lies at, and where along it (metres from the segment start)."""
    best = None
    for qid, q in QUAY_GEOM.items():
        s, d = project(q["line"], (lat, lon))
        if d <= max_off_m and (best is None or d < best[2]):
            best = (qid, s, d)
    return (best[0], best[1]) if best else None


def terminal_for(name: str, beam: Optional[float] = None) -> Optional[str]:
    for rx, t in CARRIER_TERMINAL:
        if rx.search(name or ""):
            return "CTB" if t == "CTA" and (beam or 0) > KOEHLBRAND_MAX_BEAM_M else t
    return None


def is_big(loa: float, beam: Optional[float]) -> bool:
    return loa > BIG_SHIP[0] or (beam or 0) > BIG_SHIP[1]


def box_deltas(T: int) -> List[int]:
    """Whole-hour offsets (outbound start minus inbound start) for which two ships meet inside the passing box."""
    v = (KM_SEA - KM_PORT) / T
    mid = (KM_SEA + KM_PORT) / 2.0
    return [d for d in range(-T + 1, T) if BOX_KM[0] <= mid - v * d / 2.0 <= BOX_KM[1]]


def meeting_rules(live: Dict[str, Any], vessels: List[Dict[str, Any]]) -> List[Any]:
    """(inbound ship, outbound ship, allowed offsets) for every pair too wide to meet freely on the river."""
    T = HAM["transit_hrs"]
    beams = {v["id"]: float(v.get("beam") or 0) for v in vessels}
    beams.update({o["name"]: float(o.get("beam_m") or 0) for o in live.get("fixed_occupants", []) if o["name"] not in beams})
    out, box = [], box_deltas(T)
    for v in vessels:
        for b_id, bb in beams.items():
            if b_id == v["id"]:
                continue
            cb = beams[v["id"]] + bb
            if cb > MEET_BOX_BEAM_M:
                out.append((v["id"], b_id, []))
            elif cb > MEET_FREE_BEAM_M:
                out.append((v["id"], b_id, box))
    return out


# ----------------------------------------------------------------------------------------- ship figures
def is_mega(loa: float, beam: Optional[float]) -> bool:
    return loa > HAM["mega_loa_m"] or (beam or 0) > HAM["mega_beam_m"]


def limits(loa: float, beam: Optional[float]) -> Tuple[float, float, float]:
    """(tide-independent draught, inbound maximum, outbound maximum) for this ship's class."""
    m, s = is_mega(loa, beam), HAM["deepening_shortfall_m"]
    return ((HAM["draught_indep_mega_m"] if m else HAM["draught_indep_m"]),
            (HAM["draught_max_in_mega_m"] if m else HAM["draught_max_in_m"]) - s,
            (HAM["draught_max_out_mega_m"] if m else HAM["draught_max_out_m"]) - s)


def teu_estimate(loa: float, beam: float) -> int:
    return int(round(HAM["teu_a"] * (loa * beam) ** HAM["teu_b"]))


def moves_estimate(loa: float, teu: int) -> int:
    share = HAM["exchange_mainline"] if loa >= 300 else HAM["exchange_feeder"]
    return int(round(teu * HAM["boxes_per_teu"] * share))


def max_cranes(loa: float, terminal: str) -> int:
    return int(min(8, max(2, loa // 50), STS[terminal] // 2))


# ----------------------------------------------------------------------------------------- the rules the planner calls
def planning_vessels(live: Dict[str, Any], eta_shift_hrs: Optional[Dict[str, int]] = None) -> List[Dict[str, Any]]:
    out = []
    for v in live["vessels"]:
        out.append({
            "id": v["name"], "imo": v["imo"], "len": int(math.ceil(v["loa_m"])), "loa": v["loa_m"], "beam": v["beam_m"],
            "draft": v["draught_used_m"], "eta": int(v["eta_hr"]) + int((eta_shift_hrs or {}).get(v["name"], 0)),
            "moves": int(v["moves_est"]), "teu_est": int(v["teu_est"]), "min_qc": 1, "max_qc": int(v["max_qc"]), "geared": False,
            "quay": v["terminal"], "pool": v["terminal"], "quay_ranges": [list(r) for r in v["quay_ranges"]],
            **{k: v.get(k) or advice.cost_weights(float(v["teu_est"]))[k] for k in ("w_wait", "w_occ")},
        })
    return out


def _above_mlw(live: Dict[str, Any], km: float, hr: int) -> Optional[float]:
    """Forecast water level above mean low water (m) at an Elbe kilometre and plan hour, interpolated between gauges."""
    g = live["gauges"]
    pts = []
    for x in g:
        if 0 <= hr < len(x["above_mlw_m"]) and x["above_mlw_m"][hr] is not None:
            pts.append((x["km"], x["above_mlw_m"][hr]))
    if not pts:
        return None
    pts.sort()
    if km <= pts[0][0]:
        return pts[0][1]
    if km >= pts[-1][0]:
        return pts[-1][1]
    for (k0, v0), (k1, v1) in zip(pts, pts[1:]):
        if k0 <= km <= k1:
            return v0 + (v1 - v0) * (km - k0) / (k1 - k0)
    return None


def margin_m(live: Dict[str, Any], hr: int) -> float:
    """Forecast error (RMSE, m) at this lead time, from the gauges' back-tests."""
    bands = live.get("forecast_rmse_m_by_lead") or {}
    if not bands:
        return 0.15
    pts = sorted((int(k.rstrip("h")), v) for k, v in bands.items())
    if hr <= pts[0][0]:
        return pts[0][1]
    for (a, va), (b, vb) in zip(pts, pts[1:]):
        if a <= hr <= b:
            return va + (vb - va) * (hr - a) / (b - a)
    return pts[-1][1]


def passage_ok(live: Dict[str, Any], start_hr: int, T: int, need_m: float, inbound: bool, big: bool = False) -> bool:
    wind = live.get("wind_ms_hourly") or []
    if big and any(0 <= start_hr + k < len(wind) and (wind[start_hr + k] or 0) >= HAM["wind_limit_ms"] for k in range(T)):
        return False                                  # big ships do not move in strong wind
    if need_m <= 0:
        return True
    for k in range(T):
        hr = start_hr + k
        if hr < 0:
            continue                                          # already past this reach at the plan start
        f = (k + 0.5) / T
        km = KM_SEA - (KM_SEA - KM_PORT) * f if inbound else KM_PORT + (KM_SEA - KM_PORT) * f
        if not CRITICAL_REACH[0] <= km <= CRITICAL_REACH[1]:
            continue
        lvl = _above_mlw(live, km, hr)
        if lvl is None or lvl < need_m + margin_m(live, hr):
            return False
    return True


def gate_windows(live: Dict[str, Any], tide: List[float], v: Dict[str, Any], H: int, T: int) -> Tuple[List[int], List[int]]:
    indep, max_in, max_out = limits(v["loa"], v.get("beam"))
    d_in, d_out = min(v["draft"], max_in), min(v["draft"], max_out)
    big = is_big(v["loa"], v.get("beam"))
    ok_in = [h for h in range(v["eta"] + T, H - HAM["berth_tail_hrs"]) if passage_ok(live, h - T, T, d_in - indep, True, big)]
    ok_out = [h for h in range(v["eta"] + T + 1, H - T) if passage_ok(live, h, T, d_out - indep, False, big)]
    return ok_in, ok_out


def tide_needed(v: Dict[str, Any]) -> float:
    indep, max_in, _ = limits(v["loa"], v.get("beam"))
    return round(max(0.0, min(v["draft"], max_in) - indep), 2)


def night_restricted(v: Dict[str, Any]) -> bool:
    return False


def gates_bitmap(live: Dict[str, Any], H: int, T: int, eta_shift: Optional[Dict[str, int]] = None) -> Dict[str, Dict[str, str]]:
    """Per ship, '1' for every hour it may come alongside / cast off, regardless of ETA (the in-page planner reads this)."""
    out = {}
    for v in planning_vessels(live, eta_shift):
        w = dict(v, eta=-T)
        a, b = gate_windows(live, [], w, H, T)
        sa, sb = set(a), set(b)
        out[v["id"]] = {"in": "".join("1" if h in sa else "0" for h in range(H)), "out": "".join("1" if h in sb else "0" for h in range(H))}
    return out


# ----------------------------------------------------------------------------------------- live input
def _jsonl(path: Path) -> List[Dict[str, Any]]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()] if path.exists() else []


def _norm(name: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (name or "").upper())


def _utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def gauges_from_daily(daily: Dict[str, Any], epoch: datetime, hours: int) -> Tuple[List[Dict[str, Any]], Dict[str, float]]:
    out, rm = [], {}
    for name, g in (daily.get("tide") or {}).get("gauges", {}).items():
        t0 = _utc(g["hourly_utc_start"])
        off = int(round((epoch - t0).total_seconds() / 3600.0))
        vals = g["hourly_cm"][max(off, 0):]
        mlw = g["mean_low_water_cm"]
        series = [round((x - mlw) / 100.0, 3) for x in vals][:hours]
        out.append({"name": name, "km": g["elbe_km"], "mean_low_water_cm": mlw, "above_mlw_m": series + [None] * (hours - len(series))})
        for k, v in (g.get("forecast_rmse_cm_by_lead") or {}).items():
            rm.setdefault(k, []).append(v / 100.0)
    return sorted(out, key=lambda x: -x["km"]), {k: round(sum(v) / len(v), 3) for k, v in rm.items()}


def build_live(store: Path, now: Optional[datetime] = None, max_ships: int = 14) -> Dict[str, Any]:
    """Live input for the Hamburg plan from the collector store and the daily gauge forecast (store/hamburg/latest.json)."""
    now = now or datetime.now(UTC)
    site = store / "hamburg"
    daily = json.loads((site / "latest.json").read_text()) if (site / "latest.json").exists() else {}
    epoch = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    H = HAM["horizon_hrs"]
    gauges, rmse = gauges_from_daily(daily, epoch, H + 3)
    ships = json.loads((site / "ships.json").read_text()) if (site / "ships.json").exists() else {}
    tracked = json.loads((site / "tracked.json").read_text()) if (site / "tracked.json").exists() else {}

    hist: Dict[str, List[Dict[str, Any]]] = {}
    for d in range(21, -1, -1):
        for row in _jsonl(site / "positions" / f"{(now - timedelta(days=d)).strftime('%Y-%m-%d')}.jsonl"):
            if _utc(row["t"]) <= now:
                hist.setdefault(str(row["mmsi"]), []).append(row)
    fresh = now - timedelta(hours=8)

    def static(m: str) -> Dict[str, Any]:
        s, t = ships.get(m, {}), tracked.get(m, {})
        return {"name": (s.get("name") or t.get("name") or "").strip(), "imo": s.get("imo") or t.get("imo"), "len": s.get("len") or t.get("len"),
                "beam": s.get("beam"), "draught": t.get("draught"), "dest": t.get("dest"), "eta_utc": t.get("eta_utc")}

    occupants, vessels, excluded, used = [], [], [], set()
    for m, rows in hist.items():                              # ships moored at a container quay now
        last = rows[-1]
        if _utc(last["t"]) < fresh or (last.get("sog") or 0) > 0.6 or last.get("zone") != "PORT":
            continue
        where = locate(last["lat"], last["lon"])
        if not where:
            continue
        s = static(m)
        if not s["name"] or not s["len"]:
            continue
        qid, along = where
        q = QUAYS[qid]
        since = last["t"]
        for r in reversed(rows):                              # first report at this spot
            if locate(r["lat"], r["lon"]) and abs(locate(r["lat"], r["lon"])[1] - along) < 80 and (r.get("sog") or 0) <= 0.6:
                since = r["t"]
            else:
                break
        beam = s["beam"] or round(s["len"] / 7.0, 1)
        teu = teu_estimate(s["len"], beam)
        moves = moves_estimate(s["len"], teu)
        work = moves / (HAM["qgc_gmph"] * nct.eng.crane_effect(min(4, max_cranes(s["len"], q["terminal"])), False))
        rel = int(round((_utc(since) - epoch).total_seconds() / 3600.0 + work + 4))
        L = int(math.ceil(s["len"]))
        b0 = int(max(q["axis_lo"], min(q["axis_hi"] - L, q["axis_lo"] + along - L / 2)))
        occupants.append({"name": s["name"], "imo": s["imo"], "mmsi": int(m), "loa_m": float(s["len"]), "beam_m": beam, "terminal": q["terminal"], "quay": qid,
                          "berth_start_m": b0, "release_hr": max(2, rel), "status": f"moored at {q['name']} since {since[:16].replace('T', ' ')}Z (AIS)",
                          "release_basis": f"arrival + {work:.0f} h for ~{moves:,} estimated moves + 4 h, an estimate", "lat": last["lat"], "lon": last["lon"],
                          "draught_reported_m": s["draught"]})
        used.add(m)

    # AIS gives the antenna's position, not the hull's centre, so neighbours can appear to overlap: pack each quay
    # left to right with the berth gap, then back from the quay end if the row runs over it.
    gap = HAM["berth_gap_m"]
    for qid, q in QUAYS.items():
        row = sorted((o for o in occupants if o["quay"] == qid), key=lambda o: o["berth_start_m"])
        for o in row:
            o["ais_berth_start_m"] = o["berth_start_m"]
        end = q["axis_lo"] - gap
        for o in row:
            o["berth_start_m"] = max(o["berth_start_m"], end + gap)
            end = o["berth_start_m"] + int(math.ceil(o["loa_m"]))
        nxt = q["axis_hi"] + gap
        for o in reversed(row):
            o["berth_start_m"] = min(o["berth_start_m"], nxt - gap - int(math.ceil(o["loa_m"])))
            nxt = o["berth_start_m"]
        for o in row:
            if o["berth_start_m"] < q["axis_lo"]:
                occupants.remove(o)                               # more ships reported than the quay holds: drop the overflow from the plan
                excluded.append({"name": o["name"], "mmsi": o["mmsi"], "reason": f"reported at {q['name']}, which is full in the model"})
            elif o["berth_start_m"] != o["ais_berth_start_m"]:
                o["status"] += f"; placed {abs(o['berth_start_m'] - o['ais_berth_start_m'])} m from its AIS position to keep the berth gap"

    seen_at: Dict[str, str] = {}                              # terminal a ship was seen moored at in the last three weeks
    for m, rows in hist.items():
        for r in rows:
            if (r.get("sog") or 0) <= 0.6 and r.get("zone") == "PORT":
                w = locate(r["lat"], r["lon"])
                if w:
                    seen_at[m] = QUAY_GEOM[w[0]]["terminal"]

    # the port's own plan for the next two days (HVCC, via hafen-hamburg.de): terminal, berth and arrival time
    exp_doc = json.loads((site / "expected" / "latest.json").read_text()) if (site / "expected" / "latest.json").exists() else {}
    expected = {}
    if exp_doc and now - _utc(exp_doc["fetched_utc"]) <= timedelta(hours=36):
        for e in exp_doc["ships"]:
            if e.get("terminal") and ((e.get("length_m") or 0) >= 120 or (e.get("teu") or 0) >= 300):
                expected[_norm(e["name"])] = e
    T = HAM["transit_hrs"]

    def add_vessel(name, imo, mmsi, loa, beam, rep, term, eta, basis, tbasis, last, dest):
        eta_hr = max(0, int(round((eta - epoch).total_seconds() / 3600.0)))
        if eta_hr > H - 48:
            return
        indep, max_in, _ = limits(loa, beam)
        used_d = min(float(rep), max_in) if rep else min(indep, 11.0)
        teu = teu_estimate(loa, beam)
        vessels.append({
            "name": name, "imo": imo, "mmsi": mmsi, "loa_m": float(loa), "beam_m": beam, "dwt_t": None, "teu_est": teu,
            "moves_est": moves_estimate(loa, teu), "max_qc": max_cranes(loa, term), "terminal": term, **advice.cost_weights(teu),
            "quay_ranges": [[q["axis_lo"], q["axis_hi"]] for q in QUAYS.values() if q["terminal"] == term], "terminal_basis": tbasis,
            "draught_reported_m": rep, "draught_used_m": round(used_d, 2), "tide_dependent": used_d > indep, "big_ship": is_big(loa, beam),
            "status": f"{last.get('zone', '').lower()} {last['t'][5:16].replace('T', ' ')}Z" if last else tbasis,
            "declared_destination": dest, "eta_hr": eta_hr, "eta_basis": basis, "last_port": f"AIS destination: {dest}" if dest else "not on AIS",
            "area": (last or {}).get("zone") or "SEA", "lat": (last or {}).get("lat"), "lon": (last or {}).get("lon"),
            "sog_kn": (last or {}).get("sog"), "cog_deg": (last or {}).get("cog"), "ais_time_utc": (last or {}).get("t"),
        })

    done_names = {_norm(o["name"]) for o in occupants}
    for m, t in tracked.items():                               # ships declaring Hamburg on AIS
        if m in used:
            continue
        s = static(m)
        if not s["name"] or not s["len"] or s["len"] < 120:
            continue
        beam = s["beam"] or round(s["len"] / 7.0, 1)
        e = expected.get(_norm(s["name"]))
        last = hist.get(m, [None])[-1]
        if e:                                                  # the port's plan wins over guesses
            term, tbasis = e["terminal"], f"port's expected-vessel list: {e['berth']}"
            eta = _utc(e["time_utc"]) - timedelta(hours=T)
            basis = f"alongside {e['time_utc'][5:16].replace('T', ' ')}Z per the port's expected-vessel list (HVCC), minus the {T} h passage"
        else:
            term = seen_at.get(m) or terminal_for(s["name"], beam)
            tbasis = "seen moored there on AIS" if m in seen_at else "carrier-to-terminal assumption from the ship's name"
            if not term:
                excluded.append({"name": s["name"], "mmsi": int(m), "reason": "not identified as a container ship (no carrier name, never seen at a container quay)"})
                continue
            if last and last.get("zone") == "PORT" and _utc(last["t"]) >= fresh:
                excluded.append({"name": s["name"], "mmsi": int(m), "reason": "already in port, not at a container quay"})
                continue
            if last and last.get("zone") in ("ELBE", "ESTUARY") and _utc(last["t"]) >= fresh and 45 < (last.get("cog") or 0) < 135:
                eta, basis = epoch, f"on the Elbe inbound at the plan start (AIS {last['t'][11:16]}Z, {last.get('sog')} kn)"
            elif s["eta_utc"]:
                eta, basis = _utc(s["eta_utc"]), f"ETA declared on AIS ({s['eta_utc']})"
                if eta < epoch - timedelta(hours=36):
                    excluded.append({"name": s["name"], "mmsi": int(m), "reason": f"declared ETA {s['eta_utc']} passed and the ship is not in port"})
                    continue
            else:
                excluded.append({"name": s["name"], "mmsi": int(m), "reason": "no ETA declared"})
                continue
        done_names.add(_norm(s["name"]))
        add_vessel(s["name"], s["imo"], int(m), s["len"], beam, s["draught"] or (e or {}).get("draught_m"), term, eta, basis, tbasis, last, s["dest"])
    for key, e in expected.items():                            # on the port's list but not (yet) heard declaring Hamburg on AIS
        if key in done_names:
            continue
        loa = e.get("length_m") or (e.get("beam_m") or 20) * 7.0
        beam = e.get("beam_m") or round(loa / 7.0, 1)
        add_vessel(e["name"].upper(), e.get("imo"), None, loa, beam, e.get("draught_m"), e["terminal"], _utc(e["time_utc"]) - timedelta(hours=T),
                   f"alongside {e['time_utc'][5:16].replace('T', ' ')}Z per the port's expected-vessel list (HVCC), minus the {T} h passage",
                   f"port's expected-vessel list: {e['berth']}", None, None)
    vessels.sort(key=lambda v: (v["eta_hr"], v["name"]))
    vessels = vessels[:max_ships]
    wind = [None] * (H + 3)
    wb = (daily.get("wind") or {})
    if wb.get("hourly_utc_start"):
        off = int(round((epoch - _utc(wb["hourly_utc_start"])).total_seconds() / 3600.0))
        for h in range(H + 3):
            if 0 <= h + off < len(wb["speed_ms"]):
                wind[h] = wb["speed_ms"][h + off]
    stpauli = next((g for g in gauges if "PAULI" in g["name"]), gauges[-1] if gauges else None)
    tide_hourly = [x if x is not None else 0.0 for x in (stpauli["above_mlw_m"] if stpauli else [0.0] * (H + 3))]
    return {
        "port": "Hamburg (DEHAM)", "retrieved": now.strftime("%Y-%m-%d %H:%MZ"), "plan_epoch_local": epoch.isoformat(), "plan_clock": "UTC",
        "what_is_live": f"{len(vessels)} container ships declaring Hamburg on AIS and {len(occupants)} moored at a container quay (position along the quay from AIS); "
                        f"water-level forecasts for {len(gauges)} Elbe gauges from PEGELONLINE.",
        "what_is_not_live": "Terminal assignments of inbound ships, crane allocations, box counts per call and yard levels are not published; "
                            "they are estimated or assumed. AIS does not say whether a cargo ship carries containers; ships without a carrier name "
                            "that have not been seen at a container quay are left out.",
        "sources": {"ais": "AISStream.io websocket, collected hourly by GitHub Actions", "tide": "PEGELONLINE (WSV) gauges, harmonic + surge forecast (sites/tides.py)",
                    "terminals": "OpenStreetMap terminal outlines via Nominatim (quay lines)", "fairway": "Elbe fairway adjustment: tide-independent and tide-dependent draughts"},
        "estimates": {"teu_capacity": f"{HAM['teu_a']} x (LOA x beam)^{HAM['teu_b']}", "moves_per_call": "TEU / 1.6 x 35% (300 m and over) or 70%",
                      "terminal": "seen on AIS, else carrier-to-terminal assumption", "release_of_moored_ships": "arrival + estimated working time + 4 h"},
        "quays": QUAYS, "terminals": TERMINALS, "elbe_route": [list(p) for p in ELBE_ROUTE],
        "fixed_occupants": sorted(occupants, key=lambda o: o["berth_start_m"]), "also_in_port_not_modelled": [], "excluded": excluded[:40],
        "vessels": vessels, "gauges": gauges, "wind_ms_hourly": wind, "wind_source": wb.get("source"),
        "expected_list": {"fetched_utc": exp_doc.get("fetched_utc"), "ships_at_container_terminals": len(expected)} if exp_doc else None, "forecast_rmse_m_by_lead": rmse, "tide_hourly_m": tide_hourly, "tides": [],
        "tide_note": "Tide strip: forecast water level at Hamburg St. Pauli above its mean low water. A tide-dependent ship needs, at every hour it "
                     "spends between Waltershof and Brunsbuettel, the level at its position (interpolated between the six gauges by Elbe kilometre) above mean low water by its draught "
                     "beyond the tide-independent limit plus the forecast error at that lead time.",
        "daylight_hours": [0, 24],
    }
