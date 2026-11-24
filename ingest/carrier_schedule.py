"""Upcoming container-ship calls at a port, from a carrier's public schedule API.

Chattogram has no AIS coverage and its port authority does not allow automated fetching, so this is the automatic
source of its live queue. It reads the DCSA Commercial Schedules 1.0 `port-schedules` endpoint that Maersk publishes
(https://developer.maersk.com, self-service key). It is off until the repository secret MAERSK_CONSUMER_KEY exists;
without the key, or when the service fails, it records why and the planner falls back to its other sources.

    MAERSK_CONSUMER_KEY=... python ingest/carrier_schedule.py --store store       # -> store/chattogram/schedule/latest.json

Never raises on network or format problems: a failed day is listed under "errors" and the rest is kept.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

UTC = timezone.utc
BASE = os.environ.get("MAERSK_SCHEDULE_BASE", "https://api.maersk.com/dcsa/cs/v1")
RANK = {"ACT": 3, "EST": 2, "PLN": 1}


def _get(url: str, key: str, timeout: float = 30.0, tries: int = 3) -> Any:
    """GET with the Consumer-Key header; retries 429 and 5xx with backoff."""
    last: Optional[Exception] = None
    for i in range(tries):
        req = urllib.request.Request(url, headers={"Consumer-Key": key, "Accept": "application/json", "User-Agent": "portflow-simopt-mcp"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310 (fixed https base)
                return json.loads(r.read().decode("utf-8") or "[]")
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 500, 502, 503, 504):
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
        time.sleep(2 ** i)
    raise last if last else RuntimeError("no response")


def _best(stamps: List[Dict[str, Any]], kind: str) -> Optional[Dict[str, Any]]:
    c = [t for t in stamps or [] if t.get("eventTypeCode") == kind and t.get("eventDateTime")]
    return max(c, key=lambda t: (RANK.get(t.get("eventClassifierCode"), 0), t["eventDateTime"])) if c else None


def parse(doc: Any) -> List[Dict[str, Any]]:
    """DCSA PortSchedule list -> one record per vessel call (arrival and departure, best of actual/estimated/planned)."""
    out = []
    for ps in doc if isinstance(doc, list) else [doc] if isinstance(doc, dict) else []:
        for vs in (ps or {}).get("vesselSchedules") or []:
            v = vs.get("vessel") or {}
            name = (v.get("vesselName") or "").strip().upper()
            if not name or v.get("isDummyVessel"):
                continue
            arr, dep = _best(vs.get("timestamps"), "ARRI"), _best(vs.get("timestamps"), "DEPA")
            if not arr:
                continue
            sp = (vs.get("servicePartners") or [{}])[0]
            imo = str(v.get("vesselIMONumber") or "").strip()
            out.append({"name": name, "imo": int(imo) if imo.isdigit() else None, "eta_utc": arr["eventDateTime"],
                        "eta_kind": arr.get("eventClassifierCode"), "etd_utc": dep["eventDateTime"] if dep else None,
                        "carrier": sp.get("carrierCode"), "service": sp.get("carrierServiceCode") or sp.get("carrierServiceName"),
                        "voyage": sp.get("carrierImportVoyageNumber") or sp.get("carrierExportVoyageNumber")})
    return out


def run(store: Path, now: Optional[datetime] = None, locode: str = "BDCGP", site: str = "chattogram", days: int = 7,
        key: Optional[str] = None, get: Callable[..., Any] = _get) -> Dict[str, Any]:
    now = now or datetime.now(UTC)
    key = key if key is not None else os.environ.get("MAERSK_CONSUMER_KEY", "")
    doc: Dict[str, Any] = {"fetched_utc": now.isoformat(timespec="seconds"), "locode": locode,
                           "source": "Maersk port schedule (DCSA Commercial Schedules 1.0)", "ships": [], "errors": [], "status": "ok"}
    if not key:
        doc.update(status="off", errors=["no MAERSK_CONSUMER_KEY secret: carrier schedule not read"])
    else:
        seen = {}
        for d in range(days):
            day = (now + timedelta(days=d)).strftime("%Y-%m-%d")
            url = f"{BASE}/port-schedules?" + urllib.parse.urlencode({"UNLocationCode": locode, "date": day})
            try:
                for s in parse(get(url, key)):
                    seen[(s["imo"] or s["name"], s["eta_utc"][:10])] = s
            except Exception as e:  # noqa: BLE001  (record and keep the other days)
                doc["errors"].append(f"{day}: {type(e).__name__}: {str(e)[:140]}")
        doc["ships"] = sorted(seen.values(), key=lambda s: s["eta_utc"])
        if doc["errors"] and not doc["ships"]:
            doc["status"] = "failed"
        elif doc["errors"]:
            doc["status"] = "partial"
    d = store / site / "schedule"
    d.mkdir(parents=True, exist_ok=True)
    if doc["status"] in ("ok", "partial") or not (d / "latest.json").exists():
        (d / "latest.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    (d / "last_attempt.json").write_text(json.dumps({k: doc[k] for k in ("fetched_utc", "status", "errors")}, indent=1), encoding="utf-8")
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    ap.add_argument("--locode", default="BDCGP")
    ap.add_argument("--days", type=int, default=7)
    a = ap.parse_args()
    doc = run(Path(a.store), locode=a.locode, days=a.days)
    print(f"carrier schedule {a.locode}: {doc['status']}, {len(doc['ships'])} calls; {'; '.join(doc['errors'][:3])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
