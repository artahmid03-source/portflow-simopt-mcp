"""
Money, fuel and risk figures attached to a berth plan (both sites). Every coefficient is a stated assumption.

* Charter cost per day from ship size: 90 x TEU^0.68 USD (about 14,000 USD/day at 1,700 TEU, 42,000 at 8,500 TEU,
  76,000 at 20,000 TEU; order of magnitude of 2025-26 time-charter rates). Used for the "cost" objective.
* Main-engine fuel per day at speed v: 0.19 x TEU^(2/3) x (v / 14 kn)^3 t (about 25 t/day for a 1,700 TEU feeder at
  14 kn, 140 t/day for a 20,000 TEU ship). Fuel per nautical mile therefore scales with v^2.
* CO2: 3.114 t per t of heavy fuel oil (IMO emission factor for HFO). Fuel price 600 USD/t (assumption).
* Just-in-time arrival: if the plan holds a ship before its passage, it can sail slower and arrive when needed. The
  saving is the main-engine fuel difference between the current speed plus waiting and the slower speed; the IMO
  study of 339,390 containership voyages found 4-14% voyage savings from this.
* Tide-window risk: the arrival error grows with lead time. Until the backtest has fitted it, sigma = 2 h + 0.06 x
  lead (h), a deliberately simple assumption in line with published AIS ETA errors of 1.5-2 h near port.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

CO2_PER_T_HFO = 3.114
FUEL_USD_T = 600.0
IDLE_T_DAY = 3.0                # auxiliary fuel while waiting at anchor (assumption)
SPEED_MIN_KN = 9.0              # slowest sensible steaming speed


def charter_usd_day(teu: float) -> float:
    return 90.0 * max(teu, 100.0) ** 0.68


def fuel_t_day(teu: float, speed_kn: float) -> float:
    return 0.19 * max(teu, 100.0) ** (2.0 / 3.0) * (speed_kn / 14.0) ** 3


def cost_weights(teu: float) -> Dict[str, int]:
    """Objective weights in hundreds of USD per hour: waiting costs charter + idle fuel, time alongside costs charter."""
    ch = charter_usd_day(teu) / 24.0
    idle = IDLE_T_DAY * FUEL_USD_T / 24.0
    return {"w_wait": max(1, round((ch + idle) / 100.0)), "w_occ": max(1, round(ch / 100.0))}


def sigma_eta_h(lead_h: float, fit: Optional[Dict[str, float]] = None) -> float:
    a, b = (fit or {}).get("a", 2.0), (fit or {}).get("b", 0.06)
    return a + b * max(lead_h, 0.0)


def _phi(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def window_end(ok_in: List[int], start: int) -> int:
    """Last hour of the run of consecutive allowed berthing hours that contains `start`."""
    s, e = set(ok_in), start
    while e + 1 in s:
        e += 1
    return e


def plan_figures(live: Dict[str, Any], schedule: List[Dict[str, Any]], cfg: Dict[str, Any], gates: Dict[str, List[int]],
                 dist_nm: Dict[str, Optional[float]], eta_fit: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Per ship: cost of the call, just-in-time speed and fuel saving, risk of missing the planned tide window.
    gates: vessel -> allowed berthing hours; dist_nm: vessel -> sea distance still to sail before the passage starts."""
    vmap = {v["name"]: v for v in live["vessels"]}
    rows, tot = [], {"cost_usd": 0.0, "fuel_saved_t": 0.0, "co2_saved_t": 0.0, "wait_cost_usd": 0.0}
    for r in schedule:
        v = vmap.get(r["vessel_id"], {})
        teu = float(v.get("teu_est") or 1000)
        ch_h = charter_usd_day(teu) / 24.0
        wait, stay = r["anchorage_wait_hrs"], r["tidal_depart_hr"] - r["berth_start_hr"]
        wait_cost = wait * (ch_h + IDLE_T_DAY * FUEL_USD_T / 24.0)
        cost = wait_cost + (stay + 2 * cfg["transit_hrs"]) * ch_h
        jit = None
        d, sog = dist_nm.get(r["vessel_id"]), v.get("sog_kn")
        if d and d > 5 and sog and sog >= 6 and wait > 0 and r["eta_hr"] > 0:
            need_h = r["transit_in_hr"]                      # hours from now until the passage should start
            v_jit = max(SPEED_MIN_KN, min(sog, d / max(need_h, 0.1)))
            f_now = fuel_t_day(teu, sog) * (d / sog) / 24.0 + IDLE_T_DAY * max(0.0, need_h - d / sog) / 24.0
            f_jit = fuel_t_day(teu, v_jit) * (d / v_jit) / 24.0 + IDLE_T_DAY * max(0.0, need_h - d / v_jit) / 24.0
            saved = max(0.0, f_now - f_jit)
            jit = {"distance_nm": round(d, 0), "speed_now_kn": round(sog, 1), "speed_advised_kn": round(v_jit, 1),
                   "fuel_saved_t": round(saved, 1), "co2_saved_t": round(saved * CO2_PER_T_HFO, 1)}
            tot["fuel_saved_t"] += saved
            tot["co2_saved_t"] += saved * CO2_PER_T_HFO
        risk = None
        ok = gates.get(r["vessel_id"]) or []
        if ok and r["berth_start_hr"] in ok and r["eta_hr"] > 0:
            end = window_end(ok, r["berth_start_hr"])
            if end < cfg["horizon_hrs"] - 30:                # a window that closes inside the horizon
                slack = end - r["berth_start_hr"] + r["anchorage_wait_hrs"]
                sig = sigma_eta_h(r["eta_hr"], eta_fit)
                p = 1.0 - _phi(slack / sig)
                nxt = next((h for h in sorted(ok) if h > end), None)
                risk = {"window_closes_hr": end, "slack_h": slack, "sigma_h": round(sig, 1), "p_miss": round(p, 3),
                        "next_window_hr": nxt, "extra_wait_if_missed_h": (nxt - end) if nxt else None}
        rows.append({"vessel_id": r["vessel_id"], "cost_usd": round(cost), "wait_cost_usd": round(wait_cost), "jit": jit, "risk": risk})
        tot["cost_usd"] += cost
        tot["wait_cost_usd"] += wait_cost
    return {"ships": rows, "totals": {k: round(v, 1) for k, v in tot.items()},
            "assumptions": {"charter_usd_day": "90 x TEU^0.68", "fuel_t_day": "0.19 x TEU^(2/3) x (v/14)^3", "fuel_usd_t": FUEL_USD_T,
                            "idle_t_day": IDLE_T_DAY, "co2_per_t_hfo": CO2_PER_T_HFO,
                            "eta_sigma_h": eta_fit or {"a": 2.0, "b": 0.06, "basis": "assumption until the backtest has enough arrivals"}}}
