"""Log the ETAs ships declare on AIS, so that a model can later learn how far off they are.

tracked.json keeps only each ship's latest declared ETA. Every collector run appends the (ship, declared ETA) pairs it
has not logged yet today to <store>/<site>/eta_log.jsonl, with the time it was heard. Pure standard library.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def log_declared(site_dir: Path, now: Optional[datetime] = None, min_len: int = 120) -> int:
    now = now or datetime.now(timezone.utc)
    tracked_f, log_f = site_dir / "tracked.json", site_dir / "eta_log.jsonl"
    if not tracked_f.exists():
        return 0
    tracked = json.loads(tracked_f.read_text(encoding="utf-8"))
    day = now.strftime("%Y-%m-%d")
    seen = set()
    if log_f.exists():
        for line in log_f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                seen.add((str(r["mmsi"]), r["eta_utc"], r["heard_utc"][:10]))
    out = []
    for m, t in tracked.items():
        eta, heard = t.get("eta_utc"), t.get("last_seen") or now.isoformat(timespec="seconds").replace("+00:00", "Z")
        if not eta or (t.get("len") or 0) < min_len or (m, eta, day) in seen or heard[:10] != day:
            continue
        out.append({"mmsi": int(m), "name": t.get("name"), "heard_utc": heard, "eta_utc": eta, "len": t.get("len"), "dest": t.get("dest")})
    if out:
        with log_f.open("a", encoding="utf-8") as f:
            for r in out:
                f.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")
    return len(out)
