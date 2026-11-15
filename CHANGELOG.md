# Changelog

## 6.1.0 · 15 Nov 2026 · CI and continuous AIS collection

- **CI** (`.github/workflows/ci.yml`): ruff, 54 tests, a full pipeline re-run compared with the committed results, page build, in-page engine drift check and an asserted browser test.
- **Scheduled collector** (`ingest/collect.py`, `.github/workflows/collect.yml`): hourly AISStream listening on two connections (all ships near Chattogram; ships bound for Chattogram across the feeder region), stored as JSONL on the `data` branch; `ingest/build_db.py` loads it into SQLite.
- `web/test_page.cjs` replaces the print-only browser script with assertions; `validate.mjs --check` fails on drift from CP-SAT.
- Lint clean under ruff (E, F, W).
- Coverage probe: a third connection counts ships heard at 19 candidate ports (`ingest/probe_ports.json`) and logs them to `coverage.jsonl`, after the first run heard nothing at Chattogram.

## 6.0.0 · 13 Nov 2026 · Chattogram NCT, live queue

**Site model**
- New `sites/chattogram_nct.py`: NCT configuration, hourly tide curve from predicted highs and lows (half-cosine), bar gate per hour (tide ≥ draught + clearance − channel depth; 10.0 m only on spring highs; daylight-only for ships over 170 m or 9.0 m).
- CP-SAT plan for the live queue: tide-legal entry and departure domains, 2-D quay no-overlap including ships already alongside, hourly quay-crane pool with outages, FCFS baseline option.
- **Upgrade: pilots and tugs as a cumulative resource** over inbound and outbound river passages.
- Benders loop for the live queue with the yard DES per crane mode.
- Draught check (bar windows at planning vs AIS-reported draught) and night cut-off check (17:09 sunset vs 18:00).

**Data**
- `data/live_chattogram_2026-11-13.json`: eight ships bound for Chattogram plus one alongside, with the source and basis of every field; tide predictions 13–21 Nov.
- `ingest/aisstream_ingest.py`: AISStream websocket ingester for positions, speed, course, AIS draught and ETA; `PORTFLOW_LIVE_FILE` selects the file the pipeline plans against.

**Engine**
- Yard step stacks the lead ship's actual parcel (was always the 180-box test manifest) and exports customs-channel and dangerous-goods grids.
- DES can trace yard occupancy every 10 minutes without changing results.
- `server.py` stdio entry point; 13 MCP tools.

**HMI**
- Rebuilt: animated traffic chart, berth Gantt with tide strip, gate-open ticks and night bands, CSS-3D 40-bay yard with grooming replay, KPI tiles that count to new values, occupancy and reefer charts.
- Copilot now re-plans in the page: Claude turns the message into structured actions, `engine.js` (JavaScript DES + berth planner + Benders loop) recomputes, and the new plan plays back. A built-in parser is used when Claude is not available.
- In-page engine validated against eight CP-SAT reference cases.

**Tests:** 48 (19 engine invariants, 25 NCT rules, 4 AIS parser).
