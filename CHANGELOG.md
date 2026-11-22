# Changelog

## 6.5.1 · 22 Nov 2026 · Empty live queues

- When a live run finds no ship (Chattogram since 17 Nov: AIS hears no ship declaring it, the 13 Nov schedule has run out and the due list is not updated), the tower pages show the last plan that had ships (`<site>/tower_last_ok.json`, kept by `run_tower.py`) or the embedded 13 Nov plan, with an information banner that says why, instead of an error-style banner and the old v6.0 snapshot. The lamp reads SAVED PLAN for embedded plans.
- Collector: more spellings of Chattogram matched (BDCTG, BD CTG, CHATTAGRAM), and a running count of destinations declared in the feeder region (`chattogram/destinations_seen.json`) to check the match.
- The planning API re-plans only the plan the page shows (latest run or last good run, matched by its timestamp) and answers 409 otherwise, so the page re-plans in the browser instead of mixing plans.
- 110 tests; tower page test 33 checks.

## 6.5.0 · 16 Nov 2026 · Server engine for the copilot, yard ledger, learned arrival times

- Planning API (`api/app.py`, standard library over the engine): `POST /plan` runs the CP-SAT + yard-simulation Benders loop for a page scenario on that day's data; Dockerfile and Render blueprint. The tower pages use it first when configured and fall back to the in-browser planner.
- Yard ledger across the whole plan with background flows; per-ship slowdown fed back into the planner with a damped fixed-point loop (`run_tower.ledger_refine`), reporting when it does not settle. Panel and "Why it waits" column on the page; Python/JS parity checked in CI.
- Cut validity written up (Forbes et al. 2024): cuts keyed by (crane mode, size class) are exact for the simulated response; the ledger is a heuristic.
- Declared-ETA log in the collector and a cross-validated arrival-time model (`run_eta_model.py`), applied to Hamburg ETAs only once it beats the declared ones.
- 103 tests (15 new); API browser test.
- Plans, tide forecast, backtest and arrival-time model now refresh every 4 hours instead of once a day (no free always-on host without a card was found; see the README); plans archived per run, first of each day scored.
- Deployed at https://portflow-api.onrender.com; yard simulations cached per data version and warmed at start-up for the free host's fraction of a CPU.

## 6.4.0 · 16 Nov 2026 · Review: realism, speed, usefulness

- Port of Hamburg expected-vessel list (HVCC) ingested every half hour; terminal and time from the port replace guesses; feeders added.
- Elbe passing-box meeting rule, wind limit for big ships, Köhlbrand width limit for Altenwerder; hourly wind forecast in the daily update.
- Chattogram: 10 m / 200 m limits, high-water movement windows, stale schedule ships dropped, hand-entered port due list (`data/chattogram_due.csv`).
- Yard simulation sized per ship class, gate pickups scaled, overflow instead of deadlock; cuts keyed by mode and class.
- CP-SAT crane pool as a cumulative over optional intervals (snapshot pipeline 80 s → 24 s, same optima), warm start from yesterday's plan, multi-thread and multi-process options.
- Cost objective, just-in-time speed and fuel advice, tide-window risk (`sites/advice.py`, mirrored in the page).
- Plan against reality: daily plan archive and `run_backtest.py`; panel on the Hamburg page.
- Collector: 12 minutes every half hour, always-on mode and deployment files.
- Page: re-planning in a Web Worker; new KPI tiles, table columns and footer notes. In-page planner searches constrained-first orders and shuffles.
- 88 tests (9 new); browser test of the public pages now checks the worker, the cost tile and the backtest panel.

## 6.3.0 · 16 Nov 2026 · Control towers for Hamburg and Chattogram on live data

- **Hamburg control tower** (`sites/hamburg.py`): five quay segments on four terminals from the OpenStreetMap outlines, one crane pool per terminal, ships alongside placed from their AIS positions, inbound ships assigned by past moorings or a carrier-to-terminal map, and the Elbe tide rule (tide-independent and tide-dependent draughts for the two ship classes) checked against the six-gauge forecast plus its lead-time error.
- **Chattogram on live data** (`sites/chattogram_live.py`): ships declaring Chattogram heard by AIS in Singapore, the Malacca Strait and Colombo (third collector connection), dead-reckoned along the sea route when the ETA is missing; ships from the carrier schedule still to come; Open-Meteo sea level calibrated to the Chittagong table (0.11 m RMSE) with a harmonic fallback and a daily cross-check; sunrise and sunset per day.
- Planner generalised: rules module per site (gate windows, vessels), quay segments as unions of intervals, crane pools, hourly tide series, tide margin. The NCT results are unchanged (the reproducibility check passes).
- `run_tower.py`: the daily plan for one site → `<site>/tower.json` on the data branch; FCFS baseline falls back when it does not fit the horizon.
- In-page engine: gate masks, quay segments and crane pools; matches CP-SAT on the Hamburg cases.
- HMI: one page for both ports. Hamburg gets a real Leaflet map with the plan animated along the Elbe and terminal bands in the berth chart; the page loads the daily plan at runtime and falls back to the embedded plan with a banner. Public pages `docs/tower/hamburg.html` and `docs/tower/chattogram.html`.
- Chattogram gets the same real map: Bay of Bengal sea routes from Singapore/Malacca and Colombo, the outer anchorage, the Karnaphuli river line and the NCT and CCT quays from OpenStreetMap; the schematic chart remains only where Leaflet is not loaded.
- Coverage probe removed (its finding stands: no AIS at Chattogram); the third connection now follows Chattogram-bound ships.
- 79 tests; a second browser test for the public pages.

## 6.2.0 · 15 Nov 2026 · Hamburg as the live-data site

- Collector is site-aware; default site Hamburg (German Bight, Elbe, port; discovery across the Channel and North Sea). Positions are kept for cargo ships of 100 m or more; data is stored under `<site>/` on the `data` branch.
- `sites/tides.py`: PEGELONLINE client, robust 16-constituent harmonic fit, surge carry-over, hold-out and lead-time skill.
- `run_daily.py` + `daily.yml`: daily tide forecast for six Elbe gauges and the vessel picture (bound for Hamburg, on the Elbe, in port), written to `hamburg/latest.json`.
- Public Hamburg live page (`docs/index.html`, GitHub Pages): real maps (Leaflet, OpenStreetMap, OpenSeaMap sea marks) with ship positions, port close-up, 8-day tide forecast, ship tables; covered by the browser test.
- Destinations written FROM>TO count only the TO port; inland vessels (no IMO number) are excluded.
- 64 tests.

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
