# PortFlow collected data

This branch is written by the `Collect AIS` workflow on `main`. It holds what the hourly AISStream collector heard around Chattogram, as plain text.

| File | Contents |
|---|---|
| `positions/YYYY-MM-DD.jsonl` | `t` (UTC), `mmsi`, `lat`, `lon`, `sog` (knots), `cog`, `hdg`, `nav` (AIS navigational status), `zone`, `src` (`near` = heard in the northern Bay of Bengal box, `track` = followed because it declared Chattogram). One row per ship per run; a ship that has not moved 0.05 nm is re-logged only every 6 hours. |
| `static/YYYY-MM-DD.jsonl` | `t`, `mmsi`, `imo`, `name`, `type`, `len`, `beam`, `draught`, `dest`, `eta_utc`, `bound` (destination text matches Chattogram), `src`. Written when a ship changes destination, ETA or draught. |
| `tracked.json` | Ships that declared Chattogram as destination in the last 14 days. |
| `runs.jsonl` | One row per run: messages heard, ships seen, rows written, errors. |
| `last.json`, `static_seen.json` | Collector state used to skip unchanged rows. |

Load it into SQLite from the `main` branch: `uv run python ingest/build_db.py --store <this folder> --db portflow.sqlite`.

Source: AIS messages relayed by aisstream.io. Times are the collector's receive times in UTC.
