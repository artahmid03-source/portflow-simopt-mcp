"""Load the collector's plain-text store into one SQLite file for analysis.

    git clone -b data --single-branch https://github.com/<owner>/portflow-simopt-mcp.git store
    uv run python ingest/build_db.py --store store --db portflow.sqlite
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Dict, Iterator

SCHEMA = """
CREATE TABLE positions (t TEXT, mmsi INTEGER, lat REAL, lon REAL, sog REAL, cog REAL, hdg INTEGER, nav INTEGER, zone TEXT, src TEXT);
CREATE TABLE static (t TEXT, mmsi INTEGER, imo INTEGER, name TEXT, type INTEGER, len REAL, beam REAL, draught REAL, dest TEXT, eta_utc TEXT, bound INTEGER, src TEXT);
CREATE TABLE runs (t_start TEXT, t_end TEXT, near_msgs INTEGER, feeder_msgs INTEGER, near_ships INTEGER, near_static INTEGER, bound_static INTEGER,
                   tracked_heard INTEGER, tracked_total INTEGER, rows_positions INTEGER, rows_static INTEGER, errors TEXT);
CREATE INDEX positions_ship ON positions (mmsi, t);
CREATE INDEX static_ship ON static (mmsi, t);
CREATE VIEW vessels AS SELECT s.* FROM static s JOIN (SELECT mmsi, MAX(t) AS t FROM static GROUP BY mmsi) m ON s.mmsi = m.mmsi AND s.t = m.t;
"""


def rows(paths) -> Iterator[Dict]:
    for p in sorted(paths):
        with open(p, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)


def build(store: Path, db: Path) -> Dict[str, int]:
    if db.exists():
        db.unlink()
    con = sqlite3.connect(db)
    con.executescript(SCHEMA)
    counts = {}
    for table, paths in (("positions", (store / "positions").glob("*.jsonl")), ("static", (store / "static").glob("*.jsonl")),
                         ("runs", [store / "runs.jsonl"] if (store / "runs.jsonl").exists() else [])):
        cols = [c[1] for c in con.execute(f"PRAGMA table_info({table})")]
        data = [tuple(json.dumps(r[c]) if isinstance(r.get(c), list) else r.get(c) for c in cols) for r in rows(paths)]
        con.executemany(f"INSERT INTO {table} VALUES ({','.join('?' * len(cols))})", data)
        counts[table] = len(data)
    con.commit()
    con.close()
    return counts


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    ap.add_argument("--db", default="portflow.sqlite")
    a = ap.parse_args()
    print(build(Path(a.store), Path(a.db)))
