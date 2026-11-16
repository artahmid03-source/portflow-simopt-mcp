"""Expected ships for the Port of Hamburg, from the public list on hafen-hamburg.de (times and berths from the
Hamburg Vessel Coordination Center, updated daily, the next two days). This is the port's own plan: it says which
terminal and berth each ship goes to and when, which AIS does not.

    python ingest/hamburg_expected.py --store store       # -> store/hamburg/expected/<UTC stamp>.json and latest.json

One polite request per run (the site has no robots.txt). The page says times and berths may change at any time.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

URL = "https://www.hafen-hamburg.de/en/all-vessels/expected-vessels/"
HAMBURG_TZ = ZoneInfo("Europe/Berlin")
TERMINAL_CODES = (("HHLA-CTA", "CTA"), ("HHLA-CTB", "CTB"), ("HHLA-CTT", "CTT"), ("EUROGATE CTH", "CTH"), ("EUROGATE", "CTH"))


def terminal_code(berth: str) -> Optional[str]:
    up = (berth or "").upper()
    for key, code in TERMINAL_CODES:
        if key in up:
            return code
    return None


def _num(text: Optional[str]) -> Optional[float]:
    m = re.search(r"-?\d+(?:\.\d+)?", text or "")
    return float(m.group(0)) if m else None


def parse(page: str) -> List[Dict[str, Any]]:
    """One record per ship card: name, IMO (from the photo file name, when present), local time, berth, terminal code, particulars."""
    out = []
    for card in re.findall(r'<div class="card-vessel.*?</article>', page, re.S):
        h3, h2 = re.search(r"<h3>(.*?)</h3>", card, re.S), re.search(r"<h2>(.*?)</h2>", card, re.S)
        if not h3 or not h2:
            continue
        head = html.unescape(re.sub(r"\s+", " ", h3.group(1))).strip()
        when, _, berth = head.partition("|")
        try:
            local = datetime.strptime(when.strip(), "%B %d, %Y, %I:%M %p").replace(tzinfo=HAMBURG_TZ)
        except ValueError:
            continue
        kv = {k: v.strip() for k, v in re.findall(r">(Length|Breadth|Draught|Speed|Deadweight|Capacity):\s*([^<]*)<", card)}
        imo = re.search(r"/(\d{7})(?:-\d+)?\.\d+x\d+\.(?:jpg|png)", card)
        slug = re.search(r"/en/vessels/([a-z0-9-]+)/", card)
        berth = berth.strip()
        out.append({
            "name": html.unescape(h2.group(1)).strip(), "imo": int(imo.group(1)) if imo else None, "slug": slug.group(1) if slug else None,
            "time_utc": local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "berth": berth, "terminal": terminal_code(berth),
            "length_m": _num(kv.get("Length")), "beam_m": _num(kv.get("Breadth")), "draught_m": _num(kv.get("Draught")),
            "speed_kn": _num(kv.get("Speed")), "dwt_t": _num(kv.get("Deadweight")), "teu": _num(kv.get("Capacity")),
        })
    return out


def fetch(timeout: float = 30.0) -> str:
    req = urllib.request.Request(URL, headers={"User-Agent": "PortFlow-SimOpt research (github.com/artahmid03-source/portflow-simopt-mcp)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def save(store: Path, ships: List[Dict[str, Any]], now: datetime) -> Path:
    d = store / "hamburg" / "expected"
    d.mkdir(parents=True, exist_ok=True)
    doc = {"source": URL, "fetched_utc": now.strftime("%Y-%m-%dT%H:%MZ"), "ships": ships}
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    path = d / f"{now.strftime('%Y-%m-%dT%H%MZ')}.json"
    path.write_text(text, encoding="utf-8")
    (d / "latest.json").write_text(text, encoding="utf-8")
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    a = ap.parse_args()
    try:
        ships = parse(fetch())
    except Exception as e:                          # the rest of the run must not fail on this list
        print(f"expected-vessel list unavailable: {type(e).__name__}: {e}")
        return 0
    p = save(Path(a.store), ships, datetime.now(timezone.utc))
    n = sum(1 for s in ships if s["terminal"])
    print(f"{len(ships)} expected ships, {n} at container terminals -> {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
