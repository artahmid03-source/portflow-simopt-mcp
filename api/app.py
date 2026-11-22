"""PortFlow planning API: the CP-SAT + yard-simulation engine behind the public Control Tower pages.

The pages re-plan in the browser with a fast heuristic. When this API is reachable they send the operator's scenario here
first, and the real engine (CP-SAT berth plan, SimPy yard cuts, Benders loop) answers instead.

    python api/app.py                     # http://localhost:8000
    GET  /health                          -> {"ok": true, ...}
    POST /plan  {"site": "hamburg", "scenario": {"etaShift": {"NAME": 6}, "qgcOutages": [[0, 24, 2, "CTA"]],
                 "rtgOutages": [[0, 1440]], "icd": 0.1, "occ": 80, "tugSets": 2}}

The queue, tide and rules are today's tower.json from the repo's data branch (refreshed every 10 minutes), so the API
holds no state of its own. Standard library only on top of the engine's own dependencies.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "sites")]
os.environ.setdefault("PORTFLOW_CPSAT_TIME_S", "20")
os.environ.setdefault("PORTFLOW_CPSAT_WORKERS", "1")
import chattogram_nct as nct  # noqa: E402

RAW = os.environ.get("PORTFLOW_DATA_URL", "https://raw.githubusercontent.com/artahmid03-source/portflow-simopt-mcp/data/{site}/tower.json")
ORIGINS = [o.strip() for o in os.environ.get("PORTFLOW_ORIGINS", "https://artahmid03-source.github.io,http://localhost:8000,null").split(",")]
SITES = ("hamburg", "chattogram")
TTL_S = 600
_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_sims: Dict[str, Dict[str, Any]] = {}          # per site and data version: yard simulations already run (see run_nct_benders)
REPS = int(os.environ.get("PORTFLOW_API_REPS", "4"))
_busy = threading.Semaphore(int(os.environ.get("PORTFLOW_API_JOBS", "1")))
VERSION = "6.5"


def rules_for(site: str):
    if site == "hamburg":
        import hamburg as hh
        return hh
    return nct


class PlanMismatch(Exception):
    """The page shows a plan this server does not hold (an embedded fallback plan, or a page loaded before the latest run)."""


def tower(site: str, loader=None, last_ok: bool = False) -> Dict[str, Any]:
    key = site + (":last_ok" if last_ok else "")
    now = time.time()
    if key in _cache and now - _cache[key][0] < TTL_S:
        return _cache[key][1]
    if loader is not None:
        doc = loader(key)
    else:
        url = RAW.format(site=site).replace("tower.json", "tower_last_ok.json") if last_ok else RAW.format(site=site)
        with urllib.request.urlopen(url, timeout=20) as r:   # noqa: S310 (fixed https URL)
            doc = json.loads(r.read().decode("utf-8"))
    _cache[key] = (now, doc)
    return doc


def pick(site: str, want: Optional[str], loader=None) -> Dict[str, Any]:
    """The plan the page is showing: the latest run, or the last run that had ships; never a different one."""
    docs = [tower(site, loader)]
    try:
        docs.append(tower(site, loader, last_ok=True))
    except Exception:  # noqa: BLE001  (no last good plan yet)
        pass
    for d in docs:
        if d.get("status") == "ok" and d.get("optimised", {}).get("schedule") and (not want or d.get("generated_utc") == want):
            return d
    raise PlanMismatch("this server holds no live plan matching the one on the page" + (f" ({want})" if want else ""))


def _int(x: Any, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(round(float(x)))))


def clean(sc: Dict[str, Any], doc: Dict[str, Any]) -> Dict[str, Any]:
    """Turn the page's scenario into engine arguments, clamped so a request cannot ask for an unbounded job."""
    cfg, names = doc["config"], {v["name"] for v in doc["live"]["vessels"]}
    pools = set((cfg.get("crane_pools") or {}).keys())
    H = int(cfg["horizon_hrs"])
    shift = {k: _int(v, -48, 96) for k, v in (sc.get("etaShift") or {}).items() if k in names}
    qgc = []
    for o in (sc.get("qgcOutages") or [])[:6]:
        a, b, c = _int(o[0], 0, H), _int(o[1], 0, H), _int(o[2], 1, 12)
        if b > a:
            qgc.append([a, b, c] + ([o[3]] if len(o) > 3 and o[3] in pools else []))
    rtg = [[0.0, float(_int(o[1], 1, 1500))] for o in (sc.get("rtgOutages") or [])[:6]]
    out: Dict[str, Any] = {"eta_shift_hrs": shift or None, "qgc_outages": qgc or None, "rtg_outages": rtg or None}
    if sc.get("icd") is not None:
        out["icd_ratio"] = max(0.0, min(0.6, float(sc["icd"])))
    if sc.get("occ") is not None:
        out["initial_yard_occupancy_pct"] = max(30.0, min(95.0, float(sc["occ"])))
    if sc.get("tugSets") is not None:
        out["pilot_tug_sets"] = _int(sc["tugSets"], 1, 6)
    return out


def to_page(res: Dict[str, Any]) -> Dict[str, Any]:
    """The engine's result in the shape the page's in-browser planner returns, so the page can use either."""
    if not res.get("schedule"):
        return {"feasible": False, "engine": "server CP-SAT", "status": res.get("convergence_status"), "trace": res.get("trace", [])}
    k = res["kpis"]
    return {"feasible": True, "engine": "server CP-SAT", "converged": res["convergence_status"] == "CONVERGED", "iterations": res["iterations_run"],
            "cuts": res["cuts"], "trace": res["trace"], "schedule": res["schedule"],
            "kpis": {"objective": k["objective"], "turnaround": k["avg_turnaround_days"], "wait": k["total_anchorage_wait_hrs"],
                     "hold": k["total_tide_hold_hrs"], "beta": k["backpressure_beta_max"], "waveStart": k["wave_start_yard_occupancy_pct"],
                     "peak": k["peak_yard_occupancy_pct"], "gateWait": k["avg_gate_truck_wait_mins"], "rtgWait": k["avg_rtg_wait_mins"],
                     "rehandle": k["unproductive_rehandle_hrs"], "icdBoxes": k["icd_evacuated_containers"], "hfo": k["hfo_proxy_tonnes"],
                     "cpsat_status": k["cpsat_status"]},
            "yardTrace": None}


def plan(site: str, scenario: Dict[str, Any], loader=None, want: Optional[str] = None) -> Dict[str, Any]:
    if site not in SITES:
        raise ValueError(f"site must be one of {SITES}")
    doc = pick(site, want, loader)
    args = clean(scenario or {}, doc)
    hint = {r["vessel_id"]: r for r in doc["optimised"]["schedule"]}
    t0 = time.time()
    ver = f"{site}|{doc.get('generated_utc')}"
    cache = _sims.setdefault(ver, {})
    for k in [k for k in _sims if k.startswith(site + "|") and k != ver]:
        del _sims[k]                                # the daily data changed: drop the old simulations
    n0 = len(cache)
    res = nct.run_nct_benders(doc["live"], cfg=doc["config"], rules=rules_for(site), sim_replications=REPS, hint=hint, sim_cache=cache, **args)
    out = to_page(res)
    out.update({"site": site, "data_generated_utc": doc.get("generated_utc"), "runtime_s": round(time.time() - t0, 1),
                "yard_sims_reused": n0 > 0 and len(cache) == n0, "yard_sims_new": len(cache) - n0,
                "scenario_applied": {k: v for k, v in args.items() if v is not None}})
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "PortFlowAPI/" + VERSION

    def _cors(self) -> None:
        o = self.headers.get("Origin")
        if o and (o in ORIGINS or "*" in ORIGINS):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, body: Dict[str, Any]) -> None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            return self._json(200, {"ok": True, "engine_version": VERSION, "sites": list(SITES), "cpsat_time_s": float(os.environ["PORTFLOW_CPSAT_TIME_S"])})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/plan":
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 20000:
            return self._json(413, {"error": "body must be 1-20000 bytes of JSON"})
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return self._json(400, {"error": "invalid JSON"})
        site = str(req.get("site", ""))
        if site not in SITES:
            return self._json(400, {"error": f"site must be one of {SITES}"})
        if not _busy.acquire(timeout=60.0):          # wait for a job in progress (or the start-up warm-up) to finish
            return self._json(429, {"error": "the planner is busy with another request; the page will re-plan in the browser"})
        try:
            self._json(200, plan(site, req.get("scenario") or {}, want=req.get("generated_utc")))
        except PlanMismatch as e:
            self._json(409, {"error": str(e)})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001  (report, do not crash the server)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
        finally:
            _busy.release()

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def warm() -> None:
    """Run the nominal plan for each site once at start-up, so the yard simulations it needs are cached before the first
    operator command (a free host has a fraction of a CPU; most scenarios reuse these simulations)."""
    for site in SITES:
        with _busy:
            try:
                r = plan(site, {})
                print(f"warm {site}: feasible={r['feasible']} in {r['runtime_s']} s", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"warm {site} failed: {e}", flush=True)


def main(port: Optional[int] = None) -> None:
    port = port or int(os.environ.get("PORT", "8000"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"PortFlow API {VERSION} on :{port}", flush=True)
    if os.environ.get("PORTFLOW_API_WARM", "1") == "1":
        threading.Thread(target=warm, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
