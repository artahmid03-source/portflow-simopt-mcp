# PortFlow: planning Chattogram's container terminal with constraint programming and simulation

**Discipline:** Industrial and Production Engineering · operations research · discrete-event simulation · software engineering
**Role:** sole engineer · **Target roles:** R&D engineer, optimisation / OR engineer, simulation engineer, Industry 4.0 software engineer
**Stack:** Python · Google OR-Tools CP-SAT · SimPy · NumPy / SciPy · FastMCP · React · JavaScript · pytest · uv · Figma

> **In one line.** A pure-software digital twin of the New Mooring Container Terminal at Chattogram. It plans the real queue of ships bound for the port on 13 November 2026 under the Karnaphuli tide, daylight-only transits and a limited number of pilots and tugs, and corrects the plan with a yard simulation through Benders cuts.

> **What kind of work this is.** Mathematical modelling, solver engineering, simulation and the code that couples them, tested like production software. No sensors, PLCs or hardware are involved: every input is a schedule, a tide table, a vessel register or an AIS message.

---

## The engineering problem

Chattogram handles most of Bangladesh's container trade through a river port. Ships wait at the outer anchorage, cross a tidal bar, travel up the Karnaphuli under pilotage, and berth at a quay whose yard runs close to full. Three coupled limits decide how fast a ship turns around:

1. **Water.** A ship may cross the bar only when the predicted tide covers its draught plus clearance, and large ships only by daylight.
2. **Quay cranes.** More cranes per ship shorten service, but only while the yard can absorb the boxes.
3. **The yard.** Past roughly 80% occupancy, yard cranes spend their time digging out buried boxes, trucks queue, and the quay stalls.

An optimiser that sees only the first two plans too many cranes into a yard that cannot take the boxes. A simulator sees the third but cannot plan. The project couples the two.

## What I built

| Layer | Method | What I implemented |
|---|---|---|
| Berth and crane plan | CP-SAT constraint programming | 2-D no-overlap on 820 m of quay; crane-count modes; tide- and daylight-legal entry and departure hours as variable domains; a cumulative resource for pilots and tugs; an hourly crane pool with outages |
| Yard response | SimPy discrete-event simulation | Night shift (off-dock evacuation, grooming) and discharge wave; closed truck loop that blocks the quay when the yard is full; priority queues; customs X-ray; 20 replications |
| Coupling | Logic-based Benders decomposition | The simulator returns one slowdown cut per crane mode the plan uses; the master's objective is a lower bound that rises to the optimum |
| Stacking | 40 × 6 × 5 NumPy tensor | Weibull dwell-aware slotting, dangerous-goods segregation, greedy night pre-marshalling |
| Cold chain | Lumped RC thermal model | Minimum compressor cap found by bisection under a 7-day, −18 °C constraint |
| Stability | Hydrostatics | KG, KM, GM and list for the lead ship's parcel |
| Live data | Ingestion pipeline | A schema that records the source and basis of every field; an AIS websocket ingester with an offline-tested parser |
| Interface | MCP server, React HMI | 13 MCP tools; a control-room page with an animated traffic chart, berth Gantt with tide and night bands, CSS-3D yard, and a copilot whose commands re-plan in the page |

## Real data, and how I handled what was missing

On 13 November 2026 I assembled the live queue from public sources: the carrier's port schedule (stamped that morning), public vessel registers for IMO and MMSI numbers, dimensions, deadweight, draught and status, and tide predictions for Chittagong. The result was eight container ships, two at anchor and six inbound from Singapore, Port Klang and Colombo.

Positions, speeds and courses were not available. The trackers tried put them behind a subscription or a bot check, and the port authority's dashboard served 2025 snapshots. I did not invent them. Each ship is drawn from its reported area, the data file states what is live and what is estimated, and I wrote an AIS ingester that fills the gap once an API key is supplied.

I also compared the specification I was given with published figures and recorded every disagreement: daytime length limit, crane and yard-crane counts, reefer plugs, yard area. Then I checked whether each one changes this plan. Most do not. No ship in the queue falls between the two night-time length limits, for example, and moving the night cut-off from sunset to 18:00 gives the same plan.

## The core contribution: a planner and a simulator that correct each other

CP-SAT proposes a plan assuming the yard never slows the quay. The simulator measures the actual slowdown β for each crane mode the plan uses. Those measurements return as cuts that lengthen the affected service times, and CP-SAT re-solves. Unmeasured modes are treated as having no slowdown, so each solve is a relaxation and its objective a lower bound. When the plan uses only measured modes, the bound is attained and the plan is optimal for the simulated yard. Here the loop converged in two to three iterations, and the bound never fell, which is checked by a test.

**The upgrade in this version: pilots and tugs as a constrained resource.** Each ship needs a pilot and a tug for the two-hour river passage in each direction. I modelled the inbound and outbound passages as intervals on a cumulative resource of capacity K, inside the same CP-SAT model as the tide gates. With one set, the live plan degrades from 2.01 to 2.62 days and anchorage waiting more than doubles, from 35 h to 77 h. A second set recovers everything and a third adds nothing. The model can therefore say how many pilot/tug sets the queue actually needs.

## Results on the live queue

The baseline is the rule a busy terminal falls back on: ships in arrival order, every crane they can take, no off-dock relief.

| Metric | Baseline | Optimised | Change |
|---|---:|---:|---:|
| Average vessel turnaround | 3.04 days | **2.01 days** | −33.9% |
| Anchorage waiting, all ships | 53 h | **35 h** | −34.0% |
| Quay slowdown caused by the yard (β) | 2.02 | **1.00** | removed |
| Peak yard occupancy | 95.5% | **62.1%** | below the 80% cliff |
| Truck wait at the gate | 1,882 min | **69 min** | −96.3% |
| Unproductive yard-crane digging | 171 h | **0 h** | eliminated |
| Blocking boxes in a 40-bay block | 485 | **260** | −46% |
| Reefer peak power, 400 plugs | 1,351 kW | **1,080 kW** | −20.1%, no cold-chain breach |

**The finding I would lead with in an interview.** Optimising the berth plan on its own improved turnaround by only 3%. The constraint was in the yard, not at the quay. Once a third of the import boxes are moved to off-dock depots during the night shift, the yard stays at 62%, the slowdown disappears, and the same optimiser delivers the other 31%. The simulation is what revealed that the bottleneck had moved.

**A second finding from the real data.** Several ships report draughts above the 9.5 m standard limit. The spring tides end on 15 November, so at their reported draughts HR FARHA and SINAR SABA would get only one daylight bar window each, on 21 November, against 13 and 9 windows at 9.5 m. A planner that trusts AIS draughts would strand them, and one that ignores them may plan crossings the ships cannot make. The model reports both cases.

## Software engineering practice

- **48 automated tests** run under uv: tide gates and the night rule hold in every plan, no two ships share quay and time, pilot/tug and crane capacities are never exceeded, the Benders bound never falls, grooming never moves dangerous goods, stability and cold-chain limits hold, and the AIS parser handles the documented message format.
- **Byte-reproducible output.** Fixed seeds and a single-threaded solver give identical results on every run, which I verified by diffing two complete pipeline runs.
- **Honest validation of the in-browser engine.** The JavaScript port matches CP-SAT exactly on five of eight reference cases and is within 6.2% on the rest. I documented a case it fails, where CP-SAT finds a plan it misses, and made the page say so.
- **Protocol-level checks.** The MCP server is tested by a client that lists its 13 tools and calls the disruption tool, and by a raw JSON-RPC handshake over stdio.
- **Performance work.** Profiling showed the CSS-3D yard was halving the frame rate during playback. Isolating it on its own compositing layer took playback from 27 to 56 frames per second.
- **Design as an artifact.** The HMI layout is an editable Figma file with colour tokens, local components and an isometric yard generated from the engine's own output.

## Limitations

Positions were not live in this run. Box counts per call, the starting yard level, channel depth, clearance and pilot/tug capacity are stated assumptions. The off-dock share and crane rate come from the brief rather than a public source. Every result above is a result inside this model, which is useful for comparing decisions, not as a forecast.

## Skills demonstrated

Constraint programming (CP-SAT) · logic-based Benders decomposition · discrete-event simulation (SimPy) · combinatorial yard optimisation · thermal modelling and numerical methods · data ingestion and provenance · API and protocol design (MCP) · JavaScript port of a solver and simulator · React and CSS-3D visualisation · test design and reproducibility · Python packaging with uv · UI design in Figma

**Links:** GitHub repository · live control-tower page · Figma design file
