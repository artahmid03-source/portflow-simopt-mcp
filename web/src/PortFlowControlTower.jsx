// PortFlow Control Tower v6 — Chattogram NCT and the Port of Hamburg. The page re-plans and re-simulates in the
// browser (src/engine.js, a JavaScript port of the Python CP-SAT + SimPy model) every time the copilot receives a
// command. DEFAULT_MCP_DATA below is the output of run_nct_pipeline.py (the 13 Nov 2026 Chattogram snapshot); a page
// may instead embed window.PORTFLOW_DEFAULT and point window.PORTFLOW_DATA_URL (or ?data=) at the daily live plan
// written by run_tower.py, which is loaded at runtime.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea } from 'recharts';
import { solve, simulateReplicated, makeSite, planFigures, yardLedger, explainRow } from './engine.js';

const DEFAULT_MCP_DATA = (typeof window !== 'undefined' && window.PORTFLOW_DEFAULT) || {"engine_version":"6.0","site":"Chattogram NCT","config":{"quay_ocean_m":820,"quay_barge_m":180,"berth_gap_m":20,"qgc_total":14,"qgc_gmph":18.5,"rtg_total":28,"rtg_per_berth_cluster":7,"yard_blocks":14,"yard_bays":40,"yard_rows":6,"yard_tiers":5,"yard_cluster_teu":4200.0,"reefer_plugs":400,"icd_ratio":0.33,"initial_yard_occupancy_pct":78.0,"max_loa_m":200.0,"max_draught_m":9.5,"spring_max_draught_m":10.0,"spring_tide_min_m":3.0,"night_max_loa_m":170.0,"night_max_draught_m":9.0,"daylight_hours":[6,17],"channel_depth_m":7.5,"ukc_m":0.6,"transit_hrs":2,"pilot_tug_sets":2,"horizon_hrs":192,"ref_boxes_per_hr":48.0,"yard_teu_total":16800.0,"import_dwell_days":7.0,"teu_per_box":1.0},"live":{"port":"Chattogram (BDCGP)","retrieved":"2026-11-13","plan_epoch_local":"2026-11-13T12:00:00+06:00","what_is_live":"Vessel names, IMO/MMSI, dimensions, deadweight, reported draught, navigation status and area, last port and departure time, carrier ETA/ETD. Tide and sun times.","what_is_not_live":"Latitude/longitude, speed and course are paywalled on every source reached and are NOT in this file. Container counts per vessel, berth assignments, yard inventory and crane status are not published and are estimated or assumed (see 'estimates').","sources":{"carrier_schedule":"CNC / CMA CGM port schedule export for BDCGP, stamped Friday 13 November 2026 10:59","ais_status":"Maritime Optima public vessel pages and VesselFinder vessel pages, read 13 November 2026","tides":"tide-forecast.com, Chittagong, datum Mean Lower Low Water, read 13 November 2026","cpa_tos":"cpatos.gov.bd/tosdashboard snapshots dated June and October 2025 (stale; used only to calibrate boxes per call)"},"estimates":{"teu_capacity":"deadweight / 14 (not published on the pages read)","moves_per_call":"0.85 x estimated TEU capacity, calibrated on import+export boxes per call in the 2025 CPA TOS snapshots","draught_used":"reported draught capped at the 9.5 m standard limit; AIS draught is crew-entered and several values read were stale"},"fixed_occupants":[{"name":"SOL MALAYSIA","imo":9081019,"mmsi":352687000,"loa_m":166.76,"beam_m":27.4,"dwt_t":20072,"draught_reported_m":9.9,"status":"moored at Chittagong since 12 Nov 08:00 UTC","carrier_etd_local":"2026-11-14T15:00","release_hr":27,"berth_start_m":0,"note":"Its terminal is not published; placed on the first NCT ocean berth as an assumption."}],"also_in_port_not_modelled":[{"name":"HR AARAI","imo":9123594,"mmsi":405000338,"loa_m":184.51,"beam_m":27.6,"dwt_t":24662,"draught_reported_m":9.8,"status":"moored at Chittagong, arrived 12 Nov 06:15 UTC"},{"name":"SITC QIUMING","imo":9932830,"mmsi":477846900,"loa_m":185.99,"beam_m":35.2,"dwt_t":37542,"draught_reported_m":10.0,"status":"moored at Chittagong, arrived 12 Nov 07:06 UTC"}],"vessels":[{"name":"HAIAN ZETA","imo":9354648,"mmsi":352005215,"flag":"Panama","built":2010,"loa_m":182.52,"beam_m":25.2,"gt":18199,"dwt_t":23978,"draught_reported_m":8.8,"draught_used_m":8.8,"status":"at anchor near Chittagong","area":"ANCHORAGE","last_port":"Colombo, departed 7 Nov 01:44 UTC","arrived_anchorage_local":"2026-11-12T07:28","carrier_eta_local":"2026-11-14T08:00","carrier_etd_local":"2026-11-17T08:00","eta_hr":0,"waited_before_epoch_hr":28.5,"eta_basis":"already at anchor at the plan epoch"},{"name":"HR HERA","imo":9175614,"mmsi":405000309,"flag":"Bangladesh","built":1999,"loa_m":182.83,"beam_m":28.0,"gt":17652,"dwt_t":23849,"draught_reported_m":9.7,"draught_used_m":9.5,"status":"at anchor near Chittagong","area":"ANCHORAGE","last_port":"Singapore, departed 6 Nov 11:15 UTC","arrived_anchorage_local":"2026-11-12T08:50","carrier_eta_local":"2026-11-14T08:00","carrier_etd_local":"2026-11-16T10:00","eta_hr":0,"waited_before_epoch_hr":27.2,"eta_basis":"already at anchor at the plan epoch"},{"name":"HR FARHA","imo":9123582,"mmsi":405000337,"flag":"Bangladesh","built":1996,"loa_m":184.51,"beam_m":27.6,"gt":16772,"dwt_t":24657,"draught_reported_m":9.6,"draught_used_m":9.5,"status":"under way, Bangladeshi EEZ","area":"BAY_NEAR","last_port":"Port Klang, departed 8 Nov 23:43 UTC","carrier_eta_local":"2026-11-15T08:00","carrier_etd_local":"2026-11-17T10:00","eta_hr":17,"waited_before_epoch_hr":0,"eta_basis":"ETA broadcast by the ship: 13 Nov 23:00 UTC"},{"name":"KOTA DUNIA","imo":9483475,"mmsi":565417000,"flag":"Singapore","built":2010,"loa_m":115.47,"beam_m":20.81,"gt":6245,"dwt_t":8214,"draught_reported_m":6.8,"draught_used_m":6.8,"status":"under way, Myanmar EEZ","area":"BAY_MID","last_port":"Singapore, departed 8 Nov 08:40 UTC","carrier_eta_local":"2026-11-15T11:00","carrier_etd_local":"2026-11-17T05:00","eta_hr":24,"waited_before_epoch_hr":0,"eta_basis":"ETA broadcast by the ship: 14 Nov 06:00 UTC"},{"name":"CNC NEPTUNE","imo":9836658,"mmsi":563088700,"flag":"Singapore","built":2019,"loa_m":172.0,"beam_m":28.4,"gt":18652,"dwt_t":22081,"draught_reported_m":null,"draught_used_m":9.0,"status":"under way, Andaman and Nicobar EEZ","area":"BAY_FAR","last_port":"Port Klang, departed 11 Nov 05:34 UTC","carrier_eta_local":"2026-11-15T09:00","carrier_etd_local":"2026-11-17T09:00","eta_hr":45,"waited_before_epoch_hr":0,"eta_basis":"carrier schedule; arrival draught not reliably reported, planned at 9.0 m"},{"name":"MTT PELEPAS","imo":9974228,"mmsi":533132942,"flag":"Malaysia","built":2024,"loa_m":171.99,"beam_m":28.4,"gt":18680,"dwt_t":24533,"draught_reported_m":8.7,"draught_used_m":8.7,"status":"under way, Sri Lankan EEZ","area":"BAY_FAR","last_port":"Colombo, departed 13 Nov 03:08 UTC","carrier_eta_local":"2026-11-17T08:00","carrier_etd_local":"2026-11-19T08:00","eta_hr":92,"waited_before_epoch_hr":0,"eta_basis":"carrier schedule"},{"name":"SINAR SABA","imo":9970454,"mmsi":636023015,"flag":"Liberia","built":2023,"loa_m":171.99,"beam_m":28.4,"gt":19944,"dwt_t":28665,"draught_reported_m":9.8,"draught_used_m":9.5,"status":"under way, Malacca Strait","area":"BAY_FAR","last_port":"Singapore, departed 12 Nov 19:12 UTC","carrier_eta_local":"2026-11-14T12:00","carrier_etd_local":"2026-11-15T19:00","eta_hr":94,"waited_before_epoch_hr":0,"eta_basis":"ESTIMATE: the carrier ETA of 14 Nov 12:00 is not reachable from a 12 Nov 19:12 UTC Singapore departure; replaced by about 1,570 nm at 15 kn"},{"name":"KOTA RAJIN","imo":9296286,"mmsi":563625000,"flag":"Singapore","built":2005,"loa_m":145.93,"beam_m":22.6,"gt":9678,"dwt_t":13212,"draught_reported_m":8.3,"draught_used_m":8.3,"status":"under way, Andaman Sea","area":"BAY_MID","last_port":"Singapore, departed 11 Nov 12:06 UTC","carrier_eta_local":"2026-11-17T18:00","carrier_etd_local":"2026-11-20T21:00","eta_hr":102,"waited_before_epoch_hr":0,"eta_basis":"carrier schedule"}],"tides":[["2026-11-13T02:38","H",3.89],["2026-11-13T09:54","L",0.62],["2026-11-13T14:56","H",3.2],["2026-11-13T21:46","L",0.81],["2026-11-14T03:15","H",3.68],["2026-11-14T10:31","L",0.77],["2026-11-14T15:35","H",3.01],["2026-11-14T22:21","L",0.97],["2026-11-15T03:56","H",3.44],["2026-11-15T11:11","L",0.92],["2026-11-15T16:21","H",2.81],["2026-11-15T23:03","L",1.13],["2026-11-16T04:43","H",3.18],["2026-11-16T11:55","L",1.03],["2026-11-16T17:20","H",2.64],["2026-11-16T23:54","L",1.26],["2026-11-17T05:45","H",2.95],["2026-11-17T12:45","L",1.09],["2026-11-17T18:46","H",2.58],["2026-11-18T00:55","L",1.33],["2026-11-18T07:10","H",2.82],["2026-11-18T13:42","L",1.07],["2026-11-18T20:15","H",2.72],["2026-11-19T02:07","L",1.3],["2026-11-19T08:29","H",2.86],["2026-11-19T14:44","L",0.98],["2026-11-19T21:16","H",2.99],["2026-11-20T03:23","L",1.16],["2026-11-20T09:29","H",2.99],["2026-11-20T15:44","L",0.81],["2026-11-20T22:04","H",3.31],["2026-11-21T04:31","L",0.91],["2026-11-21T10:18","H",3.17],["2026-11-21T16:39","L",0.6],["2026-11-21T22:47","H",3.63]],"sun_local":{"sunrise":"06:05","sunset":"17:09"},"tide_note":"A second source (TidesAtlas) gives highs about 0.6 m greater for the same dates and states no datum. The tide-forecast series is used because it states its datum."},"tide_hourly":[1.977,2.717,3.153,3.16,2.903,2.46,1.923,1.402,1.007,0.819,0.935,1.461,2.238,3.017,3.55,3.672,3.473,3.044,2.465,1.842,1.289,0.908,0.77,0.972,1.515,2.198,2.767,3.009,2.919,2.632,2.209,1.74,1.324,1.048,0.974,1.22,1.769,2.452,3.06,3.403,3.402,3.161,2.738,2.212,1.68,1.241,0.975,0.937,1.207,1.712,2.273,2.687,2.808,2.691,2.418,2.049,1.662,1.342,1.158,1.162,1.444,1.939,2.499,2.956,3.173,3.118,2.871,2.48,2.019,1.574,1.229,1.048,1.076,1.346,1.777,2.226,2.548,2.638,2.535,2.301,1.988,1.667,1.409,1.273,1.303,1.553,1.958,2.405,2.767,2.942,2.898,2.678,2.327,1.916,1.525,1.233,1.096,1.146,1.38,1.735,2.116,2.423,2.573,2.537,2.351,2.064,1.749,1.487,1.344,1.362,1.554,1.875,2.245,2.574,2.779,2.809,2.646,2.325,1.917,1.516,1.212,1.074,1.13,1.359,1.709,2.101,2.446,2.667,2.714,2.567,2.264,1.89,1.55,1.338,1.314,1.475,1.78,2.157,2.515,2.77,2.86,2.74,2.417,1.971,1.513,1.155,0.986,1.048,1.321,1.746,2.224,2.649,2.922,2.983,2.812,2.451,1.993,1.556,1.253,1.162,1.307,1.652,2.106,2.553,2.875,2.99,2.851,2.476,1.959,1.428,1.013,0.817,0.899,1.26,1.814,2.427,2.951,3.261,3.283,3.029,2.561,1.988,1.444,1.054,0.91,1.067,1.505,2.096,2.672,3.065,3.164,2.95,2.481,1.869,1.261],"hydrostatics":{"vessel_id":"HAIAN ZETA","containers_parsed":360,"total_mass_tonnes":6675.9,"displacement_tonnes":26802.9,"KG_vertical_cog_m":9.355,"parcel_VCG_m":12.234,"TCG_transverse_cog_m":0.0455,"KM_m":10.79,"GM_metacentric_height_m":1.435,"heeling_list_angle_deg":1.81,"imo_stability_compliant":true},"yard":{"containers_stacked":360,"containers_unplaced":0,"inherited_stock_boxes":600,"boxes_in_block":960,"block_fill_pct":80.0,"stacking_policy":"weibull_dwell_aware","inherited_blocking_inversions":237,"new_parcel_blocking_inversions":56,"initial_blocking_inversions":293,"night_premarshal_relocations_executed":33,"post_premarshal_blocking_inversions":260,"blocking_ratio":0.2708,"rtg_gantry_travel_m":8083.2,"premarshal_moves":[[1,1,3,13,4,5,56],[1,3,3,26,4,5,59],[2,6,4,1,3,3,49],[2,6,3,1,1,3,30],[3,4,3,19,3,5,50],[3,5,5,37,6,5,54],[3,5,4,4,6,4,18],[10,5,3,9,5,5,25],[10,5,2,10,1,4,23],[12,6,4,13,2,4,34],[13,1,3,12,5,5,38],[15,6,3,16,5,4,16],[15,6,2,15,1,4,12],[17,3,5,16,6,4,26],[21,6,3,21,4,5,27],[21,6,2,23,3,5,17],[23,4,3,25,4,5,49],[23,5,4,24,2,5,29],[24,3,4,24,6,5,31],[25,5,3,23,1,5,25],[25,5,2,25,6,5,17],[27,6,4,4,5,4,48],[27,6,3,1,3,4,48],[29,5,3,27,2,5,17],[29,5,2,26,6,5,42],[30,6,3,29,2,5,34],[33,1,4,32,2,5,30],[33,3,5,36,2,5,28],[34,1,3,38,3,5,38],[34,4,3,4,5,5,47],[35,6,5,1,3,5,48],[35,6,4,38,6,5,29],[40,5,3,39,4,4,24]],"yard_tensor_before":[[[99.0,30.0,56.4,0.0,0.0],[33.5,41.7,274.7,0.0,0.0],[123.9,51.2,58.6,0.0,0.0],[39.8,57.2,36.2,66.1,396.8],[223.1,144.7,137.6,125.9,69.3],[41.1,106.7,33.8,0.0,0.0]],[[41.8,46.8,33.6,0.0,0.0],[30.9,11.7,281.5,0.0,0.0],[44.9,58.8,42.9,35.3,0.0],[44.9,243.2,153.4,88.6,0.0],[51.3,97.9,209.6,9.1,0.0],[21.2,112.3,29.7,48.8,0.0]],[[105.7,103.0,102.8,87.8,73.9],[114.8,110.7,50.8,11.7,0.0],[99.1,264.1,73.8,288.9,35.9],[153.2,1.1,50.0,0.0,0.0],[10.5,33.8,97.4,18.1,54.0],[62.6,38.7,72.9,0.0,0.0]],[[159.2,7.3,98.8,0.0,0.0],[35.8,26.3,22.9,0.0,0.0],[66.5,33.7,73.9,396.8,54.3],[43.9,177.9,36.8,30.6,0.0],[107.5,51.2,49.9,0.0,0.0],[43.3,18.7,18.2,0.0,0.0]],[[53.2,51.9,30.0,28.8,0.0],[24.7,24.2,87.0,0.0,0.0],[84.8,77.8,76.0,64.4,63.3],[126.6,27.8,22.2,99.9,0.0],[25.0,17.2,150.9,0.0,0.0],[17.2,120.9,9.0,0.0,0.0]],[[82.6,147.2,42.0,30.1,0.0],[47.8,25.6,25.0,0.0,0.0],[225.3,50.1,190.0,30.5,0.0],[20.2,13.0,105.1,0.0,0.0],[35.2,25.7,142.5,41.7,69.6],[21.8,118.6,147.4,0.0,0.0]],[[111.2,62.5,43.6,134.2,39.8],[34.7,24.4,24.1,192.4,0.0],[12.7,6.2,93.7,0.0,0.0],[42.2,87.5,75.1,95.4,9.4],[35.6,29.7,27.8,23.7,0.0],[37.5,143.7,147.0,31.4,30.1]],[[121.4,98.1,85.0,65.5,63.6],[34.9,24.0,87.8,78.2,0.0],[40.7,31.6,26.2,0.0,0.0],[127.0,30.2,52.4,0.0,0.0],[115.6,41.6,35.1,33.5,0.0],[148.4,91.9,59.9,58.5,53.9]],[[33.4,21.7,18.1,203.7,0.0],[48.6,103.2,64.3,34.3,0.0],[45.9,43.0,425.4,34.0,0.0],[93.6,287.6,120.0,74.5,147.4],[38.4,37.9,27.2,100.2,0.0],[20.0,166.2,107.6,214.3,0.0]],[[28.9,23.0,86.5,0.0,0.0],[46.0,84.8,59.7,74.0,38.3],[60.7,56.3,51.8,42.6,0.0],[33.3,21.4,132.3,0.0,0.0],[11.5,22.6,25.1,0.0,0.0],[231.9,72.9,59.0,228.0,25.1]],[[28.2,126.5,30.9,42.6,26.4],[71.6,59.9,63.8,54.8,43.1],[191.3,32.5,58.2,127.8,30.7],[42.2,53.3,7.7,151.3,0.0],[100.2,179.3,95.1,83.6,63.5],[280.3,78.9,49.5,73.5,44.7]],[[22.3,102.9,19.3,66.9,0.0],[194.4,120.8,92.9,88.5,78.8],[20.9,256.5,19.2,0.0,0.0],[149.0,80.4,41.9,37.8,33.3],[110.1,62.4,47.0,40.0,0.0],[167.3,13.9,170.4,33.8,0.0]],[[108.1,18.0,38.4,0.0,0.0],[35.2,372.5,34.8,0.0,0.0],[45.3,325.3,44.6,43.7,0.0],[63.7,77.1,61.2,60.7,0.0],[99.5,42.5,124.9,42.1,0.0],[17.7,318.1,238.5,0.0,0.0]],[[41.5,8.6,164.5,0.0,0.0],[207.7,21.1,318.7,0.0,0.0],[104.1,103.2,61.1,57.2,48.5],[361.9,320.9,310.9,261.6,187.6],[46.2,176.4,24.1,182.1,0.0],[43.2,128.7,183.6,319.5,0.0]],[[24.5,27.8,12.5,0.0,0.0],[76.1,25.5,23.3,0.0,0.0],[19.3,11.2,5.4,0.0,0.0],[32.2,130.1,30.2,0.0,0.0],[60.7,38.4,43.5,36.1,0.0],[7.4,12.0,16.5,0.0,0.0]],[[45.0,188.2,53.0,44.9,43.6],[41.7,42.7,50.1,76.4,41.1],[25.5,69.1,221.6,0.0,0.0],[152.3,49.5,30.8,0.0,0.0],[59.3,20.8,16.8,0.0,0.0],[55.1,36.7,27.5,0.0,0.0]],[[293.1,247.9,235.6,229.3,186.9],[181.6,30.7,4.3,99.5,99.0],[60.1,123.6,81.6,8.7,25.7],[42.7,51.5,76.3,25.1,0.0],[36.7,37.4,177.2,23.3,137.4],[142.2,29.2,161.7,25.5,0.0]],[[118.4,199.3,67.8,66.3,63.4],[78.1,50.6,50.6,44.2,37.1],[97.0,86.5,123.9,66.6,60.5],[26.0,24.8,7.4,142.3,0.0],[78.6,167.7,62.3,25.3,56.0],[208.1,31.0,106.0,134.7,0.0]],[[60.7,134.6,47.9,46.4,0.0],[57.5,361.3,39.8,0.0,0.0],[60.0,135.2,57.4,54.8,0.0],[36.7,65.3,159.3,0.0,0.0],[69.6,124.5,35.2,29.5,0.0],[20.1,45.2,63.7,25.8,4.6]],[[6.1,38.5,2.7,63.8,0.0],[172.5,122.9,23.8,76.6,110.3],[20.2,17.1,12.0,11.4,0.0],[100.8,70.5,69.2,48.6,48.1],[13.8,43.2,179.7,185.9,0.0],[1.2,135.0,390.0,360.1,0.0]],[[55.9,50.9,44.6,42.2,0.0],[164.6,322.4,162.8,136.4,127.1],[318.0,70.3,40.8,34.1,0.0],[110.4,29.4,164.9,27.6,0.0],[276.3,125.1,103.7,71.6,63.8],[13.1,16.6,26.5,0.0,0.0]],[[235.0,25.2,34.7,76.2,0.0],[107.7,59.6,149.9,52.4,46.9],[154.4,128.6,105.4,84.1,75.5],[95.2,26.3,219.8,251.0,0.0],[67.7,97.3,44.7,43.2,31.1],[46.8,46.2,43.8,41.8,38.5]],[[28.9,53.8,26.0,116.1,0.0],[24.5,46.1,40.1,196.4,0.0],[18.8,263.9,97.7,127.2,0.0],[49.6,12.9,48.5,0.0,0.0],[81.8,26.0,303.7,29.3,0.0],[166.4,57.1,75.5,45.2,0.0]],[[333.6,139.3,109.5,122.2,130.2],[30.9,29.7,293.7,163.4,0.0],[67.0,55.4,21.3,31.1,0.0],[90.2,54.7,80.3,38.4,81.9],[162.0,49.4,19.7,268.9,0.0],[33.5,31.8,216.5,72.0,0.0]],[[94.4,391.3,47.3,102.0,0.0],[21.8,195.8,21.3,0.0,0.0],[218.8,94.3,63.5,46.9,0.0],[98.3,94.2,70.4,51.4,0.0],[16.8,16.9,25.4,0.0,0.0],[19.6,66.7,48.2,49.8,0.0]],[[61.4,30.5,22.4,79.4,109.8],[85.1,71.4,27.5,66.9,22.7],[86.5,163.9,44.7,42.7,78.6],[99.9,240.3,75.1,59.8,0.0],[63.4,58.1,42.0,41.4,41.3],[61.9,56.1,49.4,44.2,0.0]],[[23.5,158.6,104.7,37.4,108.4],[65.6,19.9,88.0,136.5,0.0],[12.7,23.4,122.4,0.0,0.0],[199.1,195.8,173.5,143.1,134.8],[23.2,33.7,22.0,21.6,0.0],[27.3,74.1,48.1,47.9,0.0]],[[140.5,35.8,32.9,24.3,0.0],[68.3,59.2,74.6,49.3,47.9],[16.8,15.9,137.4,0.0,0.0],[124.4,74.8,65.9,63.4,60.5],[125.0,55.9,197.2,22.9,223.5],[35.7,34.5,30.6,29.8,0.0]],[[15.2,14.9,14.9,0.0,0.0],[42.7,38.3,36.4,35.8,0.0],[146.8,46.0,56.6,37.1,87.7],[106.4,45.6,104.5,362.7,16.3],[8.6,42.3,17.0,0.0,0.0],[33.6,20.3,15.6,0.0,0.0]],[[215.2,173.0,136.3,53.8,45.3],[75.7,37.5,30.6,0.0,0.0],[307.5,259.9,230.2,213.6,150.4],[16.5,12.6,144.5,0.0,0.0],[214.9,130.5,129.4,108.2,76.3],[141.2,3.2,34.0,0.0,0.0]],[[40.3,71.4,35.1,35.0,34.4],[37.3,84.3,116.8,259.3,0.0],[130.8,43.2,45.1,67.9,42.8],[102.8,7.8,15.2,140.3,0.0],[34.8,15.1,87.1,0.0,0.0],[145.7,27.2,289.1,25.7,0.0]],[[63.2,4.4,151.4,92.5,0.0],[183.5,55.4,107.6,33.4,0.0],[42.6,42.8,154.0,67.2,39.2],[32.2,74.8,30.9,27.3,0.0],[213.0,203.2,138.4,108.1,57.2],[41.0,28.4,26.4,0.0,0.0]],[[149.9,19.1,80.0,30.1,0.0],[47.5,77.9,174.5,181.7,56.1],[40.7,133.7,1.1,175.7,28.1],[7.3,70.1,91.7,0.0,0.0],[74.2,165.8,63.0,53.2,49.2],[66.3,47.1,173.1,116.0,76.3]],[[142.0,19.2,37.8,0.0,0.0],[151.5,13.8,9.7,0.0,0.0],[237.1,143.5,132.8,127.2,100.8],[42.3,11.5,47.5,0.0,0.0],[31.9,274.4,27.0,0.0,0.0],[45.2,21.7,231.0,0.0,0.0]],[[27.7,30.7,13.3,0.0,0.0],[41.6,32.4,28.0,0.0,0.0],[74.8,27.1,24.0,0.0,0.0],[38.7,11.8,359.2,0.0,0.0],[12.6,4.5,1.2,0.0,0.0],[128.9,10.6,184.4,28.8,47.5]],[[152.1,105.4,126.3,104.9,60.5],[202.4,30.0,68.2,56.5,0.0],[21.7,118.8,82.2,16.4,0.0],[125.1,116.6,113.8,110.1,93.1],[48.4,31.1,20.6,15.1,0.0],[44.4,24.1,22.5,145.4,0.0]],[[91.8,93.2,4.4,158.1,0.0],[20.9,28.8,41.6,161.0,0.0],[155.9,206.4,35.2,0.0,0.0],[54.3,53.1,48.5,19.5,0.0],[13.7,331.9,5.0,0.0,0.0],[98.4,82.8,73.1,63.3,0.0]],[[52.0,50.3,41.9,41.2,39.3],[86.9,282.5,69.1,37.2,0.0],[45.2,160.1,62.1,42.6,0.0],[182.6,131.6,96.9,42.8,0.0],[35.9,138.5,33.1,93.1,0.0],[97.0,29.2,46.4,71.1,0.0]],[[91.0,134.5,48.3,46.2,0.0],[303.2,70.9,30.1,0.0,0.0],[47.9,23.3,20.0,0.0,0.0],[90.3,52.3,28.3,0.0,0.0],[33.4,70.1,29.0,0.0,0.0],[87.9,125.1,129.1,79.9,78.8]],[[73.7,51.2,43.9,326.1,0.0],[240.4,73.6,121.9,323.1,65.9],[41.8,212.0,41.1,0.0,0.0],[40.2,38.3,36.6,0.0,0.0],[9.2,105.6,24.1,0.0,0.0],[97.9,82.6,46.6,44.2,0.0]]],"yard_channel_before":[[[4,4,4,0,0],[4,4,4,0,0],[4,4,4,0,0],[4,4,4,4,4],[4,3,3,3,2],[4,4,1,0,0]],[[4,4,4,0,0],[4,4,3,0,0],[4,4,1,1,0],[4,4,4,4,0],[4,4,4,4,0],[4,4,4,4,0]],[[2,2,2,2,3],[4,4,4,4,0],[4,4,4,4,4],[4,4,4,0,0],[4,4,4,4,4],[4,4,4,0,0]],[[4,4,4,0,0],[4,1,1,0,0],[4,4,4,4,4],[4,4,1,1,0],[4,4,1,0,0],[4,4,2,0,0]],[[1,1,1,1,0],[1,1,2,0,0],[4,2,1,1,1],[4,4,4,4,0],[4,4,4,0,0],[4,4,1,0,0]],[[4,4,4,1,0],[1,1,1,0,0],[4,4,4,4,0],[1,1,2,0,0],[4,4,4,4,4],[4,4,2,0,0]],[[4,2,1,2,1],[4,1,1,3,0],[1,1,2,0,0],[4,4,4,4,4],[2,1,1,1,0],[4,4,4,1,1]],[[2,2,2,1,1],[1,1,2,3,0],[4,2,1,0,0],[4,4,4,0,0],[4,4,1,2,0],[4,4,1,2,1]],[[1,1,1,3,0],[4,4,4,1,0],[4,1,3,1,0],[4,4,4,4,4],[4,1,2,2,0],[4,4,4,2,0]],[[4,1,2,0,0],[4,4,4,4,4],[4,1,2,2,0],[4,1,2,0,0],[4,4,4,0,0],[4,4,4,4,4]],[[4,4,4,4,4],[4,4,4,2,1],[4,4,4,4,4],[4,4,4,4,0],[4,4,2,2,1],[4,4,4,4,1]],[[4,4,1,1,0],[4,3,2,3,2],[4,3,1,0,0],[4,4,4,2,1],[4,4,1,2,0],[4,4,4,4,0]],[[4,4,4,0,0],[4,4,1,0,0],[4,4,1,1,0],[4,4,1,1,0],[4,4,4,2,0],[1,3,3,0,0]],[[4,4,2,0,0],[4,4,3,0,0],[4,3,2,1,1],[3,3,3,3,3],[4,4,4,4,0],[4,4,4,4,0]],[[4,4,4,0,0],[4,4,1,0,0],[1,1,1,0,0],[4,4,1,0,0],[4,4,4,2,0],[4,4,4,0,0]],[[4,4,4,2,1],[4,4,4,2,2],[4,4,4,0,0],[4,4,4,0,0],[4,4,1,0,0],[4,1,1,0,0]],[[3,3,3,3,3],[4,4,4,4,4],[4,4,4,4,4],[4,4,4,4,0],[4,4,4,4,4],[4,4,4,1,0]],[[4,4,2,1,1],[4,4,1,1,1],[4,4,4,1,2],[4,1,1,2,0],[4,4,4,4,4],[4,4,4,3,0]],[[4,4,1,1,0],[4,4,2,0,0],[4,4,4,2,0],[4,4,4,0,0],[4,4,4,1,0],[4,4,4,4,4]],[[4,4,1,1,0],[4,4,4,4,4],[1,1,1,1,0],[4,1,1,3,2],[4,4,4,4,0],[4,4,3,3,0]],[[4,4,2,1,0],[4,3,3,2,3],[4,4,4,1,0],[4,4,3,1,0],[4,4,3,1,2],[4,4,4,0,0]],[[4,4,4,4,0],[4,4,2,1,1],[3,2,3,2,2],[4,4,2,3,0],[4,4,4,2,1],[4,4,1,1,1]],[[4,4,1,2,0],[4,4,4,4,0],[4,3,2,3,0],[4,4,4,0,0],[4,4,4,4,0],[4,4,4,1,0]],[[4,4,4,4,4],[4,1,3,3,0],[4,4,4,4,0],[4,4,4,4,4],[4,4,4,3,0],[4,1,3,2,0]],[[4,4,4,4,0],[4,4,1,0,0],[4,4,2,1,0],[4,2,2,1,0],[4,4,4,0,0],[4,4,4,4,0]],[[4,4,4,4,3],[4,1,1,2,2],[4,4,4,1,2],[4,4,3,2,0],[4,1,1,1,1],[4,1,1,1,0]],[[4,4,4,4,4],[4,4,4,4,0],[4,4,3,0,0],[4,3,3,2,2],[4,4,1,1,0],[4,4,4,4,0]],[[4,4,1,2,0],[4,4,4,4,4],[3,1,3,0,0],[4,4,1,1,1],[4,4,4,4,4],[1,1,1,2,0]],[[4,1,1,0,0],[4,1,2,1,0],[4,4,4,4,4],[4,4,4,4,4],[4,4,4,0,0],[4,1,1,0,0]],[[4,3,3,1,1],[4,4,1,0,0],[3,3,3,3,3],[1,1,2,0,0],[4,4,2,2,1],[4,4,4,0,0]],[[4,4,1,1,2],[4,4,4,4,0],[4,4,4,4,1],[4,4,4,4,0],[4,4,2,0,0],[4,4,4,4,0]],[[4,4,4,4,0],[4,4,4,4,0],[4,4,4,4,2],[4,4,1,1,0],[4,3,3,2,1],[4,1,1,0,0]],[[4,4,4,4,0],[4,4,4,4,4],[4,4,4,4,4],[4,4,2,0,0],[4,4,4,1,1],[4,4,4,4,4]],[[4,4,4,0,0],[4,4,1,0,0],[4,3,2,2,2],[4,4,4,0,0],[4,4,1,0,0],[4,4,3,0,0]],[[4,4,1,0,0],[1,1,3,0,0],[4,4,1,0,0],[4,4,4,0,0],[4,1,1,0,0],[4,4,4,4,4]],[[3,2,2,2,1],[4,4,4,4,0],[4,4,4,1,0],[2,1,3,2,2],[4,1,1,1,0],[4,4,1,2,0]],[[4,4,4,4,0],[4,4,4,4,0],[4,4,4,0,0],[4,4,4,4,0],[4,4,4,0,0],[4,1,2,2,0]],[[2,2,1,1,3],[4,3,2,1,0],[4,4,4,1,0],[4,4,4,4,0],[4,4,1,2,0],[4,4,4,4,0]],[[4,4,1,1,0],[4,4,4,0,0],[4,1,1,0,0],[4,4,4,0,0],[4,4,1,0,0],[4,4,4,1,3]],[[1,1,1,3,0],[4,4,4,4,1],[4,3,1,0,0],[4,1,1,0,0],[4,4,4,0,0],[4,2,1,1,0]]],"yard_imdg_before":[[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,3,3,3,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,3,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,3,0,3,3],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,3,0,0,0],[0,0,0,0,0],[0,0,3,0,0],[0,0,3,0,0],[0,0,3,0,0]],[[0,0,0,3,0],[3,0,3,0,0],[0,3,0,3,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,3,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,1,1,1,1],[0,1,0,1,0],[1,0,1,0,0],[0,0,0,0,0],[0,1,0,1,0],[0,0,0,1,1]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[2,0,2,2,0],[0,0,0,0,0],[0,0,2,0,0],[0,0,0,0,0],[0,2,2,0,0],[0,0,0,2,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,1],[0,0,0,0,1]],[[0,0,0,1,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,0,1,1],[0,0,1,1,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,3,0,0],[0,3,3,3,0],[0,3,3,3,3],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[3,0,0,0,0],[0,0,3,0,0],[0,0,0,3,0],[0,0,0,0,0]],[[0,0,0,3,3],[0,0,0,3,3],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,3,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,2,2,0],[0,0,2,2,2],[0,0,0,2,0],[0,0,2,2,0],[0,0,0,0,0],[0,0,0,2,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,1,1,0],[0,0,0,0,0],[0,0,1,1,0],[0,0,1,1,0],[0,0,0,0,0],[0,0,0,1,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,2,2,2],[2,0,2,2,2],[0,0,2,2,0],[0,0,0,2,2],[0,0,0,0,2]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,3,3,3,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,3,0],[0,3,3,3,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,2],[0,0,2,2,2],[0,0,0,2,2],[0,0,2,2,0],[0,2,2,2,0],[0,0,2,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,1,0,0],[0,0,0,0,0],[0,1,0,0,0],[0,0,0,0,1],[0,0,0,0,0],[0,0,1,0,0]],[[0,0,0,0,0],[0,0,0,1,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,1,0,1,1],[0,0,0,0,0],[1,1,0,1,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,1,0,1],[0,0,0,0,0],[0,0,0,0,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,1],[0,0,1,1,0],[0,0,1,0,1],[0,1,1,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,1,0,1,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,3,0,3],[0,0,0,0,0],[0,0,0,3,0],[3,3,0,0,0],[0,0,0,3,0],[0,0,0,3,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[1,0,0,1,1],[0,0,1,1,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],[[0,3,0,3,0],[0,0,0,0,3],[0,3,0,0,0],[0,3,3,0,0],[0,0,0,0,0],[0,3,0,3,0]]]},"yard_baseline":{"containers_stacked":360,"containers_unplaced":0,"inherited_stock_boxes":600,"boxes_in_block":960,"block_fill_pct":80.0,"stacking_policy":"random_nearest","inherited_blocking_inversions":237,"new_parcel_blocking_inversions":248,"initial_blocking_inversions":485,"night_premarshal_relocations_executed":0,"post_premarshal_blocking_inversions":485,"blocking_ratio":0.5052,"rtg_gantry_travel_m":4614.4},"reefer":{"n_reefers":400,"unmanaged_peak_demand_kw":1351.2,"smart_shaved_peak_demand_kw":1080.0,"peak_shaved_pct":20.1,"unmanaged_weekly_max_kw":1395.0,"smart_weekly_max_kw":1080.0,"unmanaged_tariff_window_peak_kw":1395.0,"smart_tariff_window_peak_kw":1065.0,"unmanaged_energy_kwh_per_day":26472.0,"smart_energy_kwh_per_day":25845.0,"compressor_cap_offpeak":144,"compressor_cap_tariff_window":142,"max_box_temp_degC":-18.27,"unmanaged_max_box_temp_degC":-18.43,"cold_chain_limit_degC":-18.0,"smart_mean_temp_drift_last_day_K":0.061,"cold_chain_breaches":0,"unmanaged_cold_chain_breaches":0,"series_30min":[{"hour":0.0,"ambient_c":26.5,"unmanaged_kw":952.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.36,"smart_mean_temp_c":-18.44},{"hour":0.5,"ambient_c":26.0,"unmanaged_kw":937.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.36,"smart_mean_temp_c":-18.44},{"hour":1.0,"ambient_c":25.7,"unmanaged_kw":877.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.37,"smart_mean_temp_c":-18.45},{"hour":1.5,"ambient_c":25.4,"unmanaged_kw":847.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.38,"smart_mean_temp_c":-18.46},{"hour":2.0,"ambient_c":25.2,"unmanaged_kw":885.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.39,"smart_mean_temp_c":-18.47},{"hour":2.5,"ambient_c":25.0,"unmanaged_kw":847.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.4,"smart_mean_temp_c":-18.48},{"hour":3.0,"ambient_c":25.0,"unmanaged_kw":960.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.41,"smart_mean_temp_c":-18.49},{"hour":3.5,"ambient_c":25.0,"unmanaged_kw":1072.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.42,"smart_mean_temp_c":-18.5},{"hour":4.0,"ambient_c":25.2,"unmanaged_kw":1110.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.43,"smart_mean_temp_c":-18.51},{"hour":4.5,"ambient_c":25.4,"unmanaged_kw":1125.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.43,"smart_mean_temp_c":-18.52},{"hour":5.0,"ambient_c":25.7,"unmanaged_kw":1087.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.44,"smart_mean_temp_c":-18.52},{"hour":5.5,"ambient_c":26.0,"unmanaged_kw":1072.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.45,"smart_mean_temp_c":-18.53},{"hour":6.0,"ambient_c":26.5,"unmanaged_kw":1035.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.46,"smart_mean_temp_c":-18.54},{"hour":6.5,"ambient_c":27.0,"unmanaged_kw":1042.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.54},{"hour":7.0,"ambient_c":27.5,"unmanaged_kw":1117.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.55},{"hour":7.5,"ambient_c":28.1,"unmanaged_kw":1042.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.55},{"hour":8.0,"ambient_c":28.7,"unmanaged_kw":1065.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.55},{"hour":8.5,"ambient_c":29.3,"unmanaged_kw":1027.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.55},{"hour":9.0,"ambient_c":30.0,"unmanaged_kw":982.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.55},{"hour":9.5,"ambient_c":30.7,"unmanaged_kw":1005.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.55},{"hour":10.0,"ambient_c":31.3,"unmanaged_kw":1020.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.46,"smart_mean_temp_c":-18.55},{"hour":10.5,"ambient_c":31.9,"unmanaged_kw":1087.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.47,"smart_mean_temp_c":-18.54},{"hour":11.0,"ambient_c":32.5,"unmanaged_kw":1147.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.45,"smart_mean_temp_c":-18.54},{"hour":11.5,"ambient_c":33.0,"unmanaged_kw":1170.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.45,"smart_mean_temp_c":-18.53},{"hour":12.0,"ambient_c":33.5,"unmanaged_kw":1260.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.44,"smart_mean_temp_c":-18.52},{"hour":12.5,"ambient_c":34.0,"unmanaged_kw":1275.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.43,"smart_mean_temp_c":-18.51},{"hour":13.0,"ambient_c":34.3,"unmanaged_kw":1200.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.41,"smart_mean_temp_c":-18.5},{"hour":13.5,"ambient_c":34.6,"unmanaged_kw":1260.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.4,"smart_mean_temp_c":-18.49},{"hour":14.0,"ambient_c":34.8,"unmanaged_kw":1207.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.39,"smart_mean_temp_c":-18.48},{"hour":14.5,"ambient_c":35.0,"unmanaged_kw":1215.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.43,"smart_max_temp_c":-18.39,"smart_mean_temp_c":-18.47},{"hour":15.0,"ambient_c":35.0,"unmanaged_kw":1260.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.43,"smart_max_temp_c":-18.38,"smart_mean_temp_c":-18.46},{"hour":15.5,"ambient_c":35.0,"unmanaged_kw":1215.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.36,"smart_mean_temp_c":-18.44},{"hour":16.0,"ambient_c":34.8,"unmanaged_kw":1207.5,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.43,"smart_max_temp_c":-18.35,"smart_mean_temp_c":-18.43},{"hour":16.5,"ambient_c":34.6,"unmanaged_kw":1200.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.34,"smart_mean_temp_c":-18.42},{"hour":17.0,"ambient_c":34.3,"unmanaged_kw":1192.5,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.33,"smart_mean_temp_c":-18.41},{"hour":17.5,"ambient_c":34.0,"unmanaged_kw":1275.0,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.32,"smart_mean_temp_c":-18.4},{"hour":18.0,"ambient_c":33.5,"unmanaged_kw":1200.0,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.31,"smart_mean_temp_c":-18.39},{"hour":18.5,"ambient_c":33.0,"unmanaged_kw":1177.5,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.3,"smart_mean_temp_c":-18.38},{"hour":19.0,"ambient_c":32.5,"unmanaged_kw":1125.0,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.29,"smart_mean_temp_c":-18.37},{"hour":19.5,"ambient_c":31.9,"unmanaged_kw":1162.5,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.29,"smart_mean_temp_c":-18.37},{"hour":20.0,"ambient_c":31.3,"unmanaged_kw":1185.0,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":20.5,"ambient_c":30.7,"unmanaged_kw":1035.0,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":21.0,"ambient_c":30.0,"unmanaged_kw":1042.5,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":21.5,"ambient_c":29.3,"unmanaged_kw":1050.0,"smart_kw":1065.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":22.0,"ambient_c":28.7,"unmanaged_kw":1065.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.45,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":22.5,"ambient_c":28.1,"unmanaged_kw":1050.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":23.0,"ambient_c":27.5,"unmanaged_kw":1065.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.44,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.36},{"hour":23.5,"ambient_c":27.0,"unmanaged_kw":1110.0,"smart_kw":1080.0,"unmanaged_max_temp_c":-18.46,"smart_max_temp_c":-18.28,"smart_mean_temp_c":-18.37}]},"baseline":{"kpis":{"objective":3948.0,"avg_turnaround_days":3.04,"total_anchorage_wait_hrs":53,"total_tide_hold_hrs":66,"cpsat_status":"OPTIMAL","backpressure_beta_max":2.021,"wave_start_yard_occupancy_pct":78.0,"peak_yard_occupancy_pct":95.535,"avg_gate_truck_wait_mins":1882.14,"avg_rtg_wait_mins":10.017,"unproductive_rehandle_hrs":171.404,"icd_evacuated_containers":0.0,"hfo_proxy_tonnes":98.1},"schedule":[{"vessel_id":"HAIAN ZETA","imo":9354648,"loa_m":182.52,"draft_m":8.8,"moves":1456,"berth_start_m":395,"berth_end_m":578,"eta_hr":0,"transit_in_hr":0,"berth_start_hr":2,"cargo_done_hr":63,"tidal_depart_hr":66,"tide_departure_hold_hrs":3,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":0,"turnaround_hrs":68,"night_restricted":true,"tide_needed_m":1.9,"virtual_arrival_hfo_saved_tonnes":0.0},{"vessel_id":"HR HERA","imo":9175614,"loa_m":182.83,"draft_m":9.5,"moves":1448,"berth_start_m":192,"berth_end_m":375,"eta_hr":0,"transit_in_hr":1,"berth_start_hr":3,"cargo_done_hr":64,"tidal_depart_hr":90,"tide_departure_hold_hrs":26,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":1,"turnaround_hrs":92,"night_restricted":true,"tide_needed_m":2.6,"virtual_arrival_hfo_saved_tonnes":1.9},{"vessel_id":"HR FARHA","imo":9123582,"loa_m":184.51,"draft_m":9.5,"moves":1497,"berth_start_m":598,"berth_end_m":783,"eta_hr":17,"transit_in_hr":26,"berth_start_hr":28,"cargo_done_hr":91,"tidal_depart_hr":114,"tide_departure_hold_hrs":23,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":9,"turnaround_hrs":99,"night_restricted":true,"tide_needed_m":2.6,"virtual_arrival_hfo_saved_tonnes":16.7},{"vessel_id":"KOTA DUNIA","imo":9483475,"loa_m":115.47,"draft_m":6.8,"moves":499,"berth_start_m":31,"berth_end_m":147,"eta_hr":24,"transit_in_hr":28,"berth_start_hr":30,"cargo_done_hr":52,"tidal_depart_hr":52,"tide_departure_hold_hrs":0,"assigned_qcs":2,"crane_intensity":"1.840","anchorage_wait_hrs":4,"turnaround_hrs":30,"night_restricted":false,"tide_needed_m":0.0,"virtual_arrival_hfo_saved_tonnes":7.4},{"vessel_id":"CNC NEPTUNE","imo":9836658,"loa_m":172.0,"draft_m":9.0,"moves":1341,"berth_start_m":0,"berth_end_m":172,"eta_hr":45,"transit_in_hr":50,"berth_start_hr":52,"cargo_done_hr":108,"tidal_depart_hr":116,"tide_departure_hold_hrs":8,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":5,"turnaround_hrs":73,"night_restricted":true,"tide_needed_m":2.1,"virtual_arrival_hfo_saved_tonnes":9.2},{"vessel_id":"MTT PELEPAS","imo":9974228,"loa_m":171.99,"draft_m":8.7,"moves":1490,"berth_start_m":395,"berth_end_m":567,"eta_hr":92,"transit_in_hr":92,"berth_start_hr":94,"cargo_done_hr":156,"tidal_depart_hr":162,"tide_departure_hold_hrs":6,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":0,"turnaround_hrs":72,"night_restricted":true,"tide_needed_m":1.8,"virtual_arrival_hfo_saved_tonnes":0.0},{"vessel_id":"SINAR SABA","imo":9970454,"loa_m":171.99,"draft_m":9.5,"moves":1740,"berth_start_m":166,"berth_end_m":338,"eta_hr":94,"transit_in_hr":114,"berth_start_hr":116,"cargo_done_hr":189,"tidal_depart_hr":189,"tide_departure_hold_hrs":0,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":20,"turnaround_hrs":97,"night_restricted":true,"tide_needed_m":2.6,"virtual_arrival_hfo_saved_tonnes":37.0},{"vessel_id":"KOTA RAJIN","imo":9296286,"loa_m":145.93,"draft_m":8.3,"moves":802,"berth_start_m":0,"berth_end_m":146,"eta_hr":102,"transit_in_hr":116,"berth_start_hr":118,"cargo_done_hr":153,"tidal_depart_hr":153,"tide_departure_hold_hrs":0,"assigned_qcs":2,"crane_intensity":"1.840","anchorage_wait_hrs":14,"turnaround_hrs":53,"night_restricted":false,"tide_needed_m":1.4,"virtual_arrival_hfo_saved_tonnes":25.9}],"cuts":{"1.840":1.472,"2.629":2.021},"iterations_run":2,"convergence_status":"CONVERGED"},"plan_only":{"kpis":{"objective":3624.0,"avg_turnaround_days":2.95,"total_anchorage_wait_hrs":35,"total_tide_hold_hrs":66,"cpsat_status":"OPTIMAL","backpressure_beta_max":2.021,"wave_start_yard_occupancy_pct":78.0,"peak_yard_occupancy_pct":95.535,"avg_gate_truck_wait_mins":1882.14,"avg_rtg_wait_mins":10.017,"unproductive_rehandle_hrs":171.404,"icd_evacuated_containers":0.0,"hfo_proxy_tonnes":64.8}},"optimised":{"kpis":{"objective":2544.0,"avg_turnaround_days":2.01,"total_anchorage_wait_hrs":35,"total_tide_hold_hrs":94,"cpsat_status":"OPTIMAL","backpressure_beta_max":1.0,"wave_start_yard_occupancy_pct":62.1,"peak_yard_occupancy_pct":62.1,"avg_gate_truck_wait_mins":69.185,"avg_rtg_wait_mins":0.558,"unproductive_rehandle_hrs":0.0,"icd_evacuated_containers":1325.45,"hfo_proxy_tonnes":64.8},"schedule":[{"vessel_id":"HAIAN ZETA","imo":9354648,"loa_m":182.52,"draft_m":8.8,"moves":1456,"berth_start_m":601,"berth_end_m":784,"eta_hr":0,"transit_in_hr":0,"berth_start_hr":2,"cargo_done_hr":32,"tidal_depart_hr":42,"tide_departure_hold_hrs":10,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":0,"turnaround_hrs":44,"night_restricted":true,"tide_needed_m":1.9,"virtual_arrival_hfo_saved_tonnes":0.0},{"vessel_id":"HR HERA","imo":9175614,"loa_m":182.83,"draft_m":9.5,"moves":1448,"berth_start_m":398,"berth_end_m":581,"eta_hr":0,"transit_in_hr":1,"berth_start_hr":3,"cargo_done_hr":33,"tidal_depart_hr":51,"tide_departure_hold_hrs":18,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":1,"turnaround_hrs":53,"night_restricted":true,"tide_needed_m":2.6,"virtual_arrival_hfo_saved_tonnes":1.9},{"vessel_id":"KOTA DUNIA","imo":9483475,"loa_m":115.47,"draft_m":6.8,"moves":499,"berth_start_m":205,"berth_end_m":321,"eta_hr":24,"transit_in_hr":24,"berth_start_hr":26,"cargo_done_hr":41,"tidal_depart_hr":41,"tide_departure_hold_hrs":0,"assigned_qcs":2,"crane_intensity":"1.840","anchorage_wait_hrs":0,"turnaround_hrs":19,"night_restricted":false,"tide_needed_m":0.0,"virtual_arrival_hfo_saved_tonnes":0.0},{"vessel_id":"HR FARHA","imo":9123582,"loa_m":184.51,"draft_m":9.5,"moves":1497,"berth_start_m":0,"berth_end_m":185,"eta_hr":17,"transit_in_hr":26,"berth_start_hr":28,"cargo_done_hr":59,"tidal_depart_hr":90,"tide_departure_hold_hrs":31,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":9,"turnaround_hrs":75,"night_restricted":true,"tide_needed_m":2.6,"virtual_arrival_hfo_saved_tonnes":16.7},{"vessel_id":"CNC NEPTUNE","imo":9836658,"loa_m":172.0,"draft_m":9.0,"moves":1341,"berth_start_m":601,"berth_end_m":773,"eta_hr":45,"transit_in_hr":50,"berth_start_hr":52,"cargo_done_hr":80,"tidal_depart_hr":90,"tide_departure_hold_hrs":10,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":5,"turnaround_hrs":47,"night_restricted":true,"tide_needed_m":2.1,"virtual_arrival_hfo_saved_tonnes":9.2},{"vessel_id":"MTT PELEPAS","imo":9974228,"loa_m":171.99,"draft_m":8.7,"moves":1490,"berth_start_m":3,"berth_end_m":175,"eta_hr":92,"transit_in_hr":92,"berth_start_hr":94,"cargo_done_hr":125,"tidal_depart_hr":138,"tide_departure_hold_hrs":13,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":0,"turnaround_hrs":48,"night_restricted":true,"tide_needed_m":1.8,"virtual_arrival_hfo_saved_tonnes":0.0},{"vessel_id":"KOTA RAJIN","imo":9296286,"loa_m":145.93,"draft_m":8.3,"moves":802,"berth_start_m":601,"berth_end_m":747,"eta_hr":102,"transit_in_hr":102,"berth_start_hr":104,"cargo_done_hr":128,"tidal_depart_hr":128,"tide_departure_hold_hrs":0,"assigned_qcs":2,"crane_intensity":"1.840","anchorage_wait_hrs":0,"turnaround_hrs":28,"night_restricted":false,"tide_needed_m":1.4,"virtual_arrival_hfo_saved_tonnes":0.0},{"vessel_id":"SINAR SABA","imo":9970454,"loa_m":171.99,"draft_m":9.5,"moves":1740,"berth_start_m":195,"berth_end_m":367,"eta_hr":94,"transit_in_hr":114,"berth_start_hr":116,"cargo_done_hr":152,"tidal_depart_hr":164,"tide_departure_hold_hrs":12,"assigned_qcs":3,"crane_intensity":"2.629","anchorage_wait_hrs":20,"turnaround_hrs":72,"night_restricted":true,"tide_needed_m":2.6,"virtual_arrival_hfo_saved_tonnes":37.0}],"cuts":{"1.840":1.0,"2.629":1.0},"iterations_run":2,"convergence_status":"CONVERGED"},"pilot_tug_sensitivity":{"1":{"objective":3756.0,"avg_turnaround_days":2.62,"total_anchorage_wait_hrs":77,"total_tide_hold_hrs":170,"cpsat_status":"OPTIMAL","backpressure_beta_max":1.0,"wave_start_yard_occupancy_pct":62.1,"peak_yard_occupancy_pct":62.1,"avg_gate_truck_wait_mins":67.89,"avg_rtg_wait_mins":0.535,"unproductive_rehandle_hrs":0.0,"icd_evacuated_containers":1324.3,"hfo_proxy_tonnes":142.5},"2":{"objective":2544.0,"avg_turnaround_days":2.01,"total_anchorage_wait_hrs":35,"total_tide_hold_hrs":94,"cpsat_status":"OPTIMAL","backpressure_beta_max":1.0,"wave_start_yard_occupancy_pct":62.1,"peak_yard_occupancy_pct":62.1,"avg_gate_truck_wait_mins":67.89,"avg_rtg_wait_mins":0.535,"unproductive_rehandle_hrs":0.0,"icd_evacuated_containers":1324.3,"hfo_proxy_tonnes":64.8},"3":{"objective":2544.0,"avg_turnaround_days":2.01,"total_anchorage_wait_hrs":35,"total_tide_hold_hrs":94,"cpsat_status":"OPTIMAL","backpressure_beta_max":1.0,"wave_start_yard_occupancy_pct":62.1,"peak_yard_occupancy_pct":62.1,"avg_gate_truck_wait_mins":67.89,"avg_rtg_wait_mins":0.535,"unproductive_rehandle_hrs":0.0,"icd_evacuated_containers":1324.3,"hfo_proxy_tonnes":64.8}},"draught_check":[{"vessel":"HAIAN ZETA","reported_m":8.8,"planned_m":8.8,"inbound_starts_planned":36,"first_start_planned":0,"inbound_starts_reported":36,"first_start_reported":0},{"vessel":"HR HERA","reported_m":9.7,"planned_m":9.5,"inbound_starts_planned":16,"first_start_planned":1,"inbound_starts_reported":2,"first_start_reported":2},{"vessel":"HR FARHA","reported_m":9.6,"planned_m":9.5,"inbound_starts_planned":13,"first_start_planned":26,"inbound_starts_reported":1,"first_start_reported":189},{"vessel":"KOTA DUNIA","reported_m":6.8,"planned_m":6.8,"inbound_starts_planned":168,"first_start_planned":24,"inbound_starts_reported":168,"first_start_reported":24},{"vessel":"CNC NEPTUNE","reported_m":null,"planned_m":9.0,"inbound_starts_planned":22,"first_start_planned":50,"inbound_starts_reported":null,"first_start_reported":null},{"vessel":"MTT PELEPAS","reported_m":8.7,"planned_m":8.7,"inbound_starts_planned":21,"first_start_planned":92,"inbound_starts_reported":21,"first_start_reported":92},{"vessel":"SINAR SABA","reported_m":9.8,"planned_m":9.5,"inbound_starts_planned":9,"first_start_planned":114,"inbound_starts_reported":1,"first_start_reported":189},{"vessel":"KOTA RAJIN","reported_m":8.3,"planned_m":8.3,"inbound_starts_planned":61,"first_start_planned":102,"inbound_starts_reported":61,"first_start_reported":102}],"night_cutoff_18h":{"objective":2544.0,"avg_turnaround_days":2.01,"total_anchorage_wait_hrs":35,"total_tide_hold_hrs":94,"cpsat_status":"OPTIMAL","backpressure_beta_max":1.0,"wave_start_yard_occupancy_pct":62.1,"peak_yard_occupancy_pct":62.1,"avg_gate_truck_wait_mins":67.89,"avg_rtg_wait_mins":0.535,"unproductive_rehandle_hrs":0.0,"icd_evacuated_containers":1324.3,"hfo_proxy_tonnes":64.8},"validation":[{"case":"nominal","cpsat_objective":2544,"js_objective":2544,"gap_pct":0,"cpsat_turnaround":2.01,"js_turnaround":2.01},{"case":"HR FARHA 6 h late","cpsat_objective":2436,"js_objective":2436,"gap_pct":0,"cpsat_turnaround":1.98,"js_turnaround":1.98},{"case":"6 QGC out 48 h","cpsat_objective":2616,"js_objective":2616,"gap_pct":0,"cpsat_turnaround":2.07,"js_turnaround":2.07},{"case":"3 RTG out 24 h","cpsat_objective":2544,"js_objective":2544,"gap_pct":0,"cpsat_turnaround":2.01,"js_turnaround":2.01},{"case":"ICD 10%","cpsat_objective":2544,"js_objective":2544,"gap_pct":0,"cpsat_turnaround":2.01,"js_turnaround":2.01},{"case":"ICD 0%","cpsat_objective":3624,"js_objective":3462,"gap_pct":-4.5,"cpsat_turnaround":2.95,"js_turnaround":2.81},{"case":"yard starts 86%","cpsat_objective":3060,"js_objective":3078,"gap_pct":0.6,"cpsat_turnaround":2.46,"js_turnaround":2.46},{"case":"one pilot/tug set","cpsat_objective":3756,"js_objective":3990,"gap_pct":6.2,"cpsat_turnaround":2.62,"js_turnaround":2.42}]};
const WORKER_SRC = "(()=>{function Q(o){let t=o>>>0,s=()=>{t|=0,t=t+1831565813|0;let e=Math.imul(t^t>>>15,1|t);return e=e+Math.imul(e^e>>>7,61|e)^e,((e^e>>>14)>>>0)/4294967296};return{u:s,exp:e=>-e*Math.log(1-s()),uni:(e,n)=>e+(n-e)*s()}}var N=class{constructor(){this.now=0,this.h=[],this.n=0}at(t,s){let e={t,n:this.n++,fn:s},n=this.h,c=n.push(e)-1;for(;c>0;){let l=c-1>>1;if(n[l].t<e.t||n[l].t===e.t&&n[l].n<e.n)break;n[c]=n[l],c=l}n[c]=e}pop(){let t=this.h,s=t[0],e=t.pop();if(t.length){let n=0;for(;;){let c=2*n+1;if(c>=t.length||(c+1<t.length&&(t[c+1].t<t[c].t||t[c+1].t===t[c].t&&t[c+1].n<t[c].n)&&c++,e.t<t[c].t||e.t===t[c].t&&e.n<t[c].n))break;t[n]=t[c],n=c}t[n]=e}return s}timeout(t){return s=>this.at(this.now+t,s)}process(t){let s=()=>{let e=t.next();e.done||e.value(s)};s()}run(){for(;this.h.length;){let t=this.pop();this.now=t.t,t.fn()}}},$=class{constructor(t,s){this.env=t,this.cap=s,this.users=0,this.q=[],this.n=0}request(t=0){return s=>{this.users<this.cap?(this.users++,s()):this.q.push({prio:t,n:this.n++,cb:s})}}release(){if(this.users--,!this.q.length)return;let t=0;for(let e=1;e<this.q.length;e++)(this.q[e].prio<this.q[t].prio||this.q[e].prio===this.q[t].prio&&this.q[e].n<this.q[t].n)&&(t=e);let s=this.q.splice(t,1)[0];this.users++,this.env.at(this.env.now,s.cb)}};function W(o,t){let s=Math.min(Math.max(o,.15),.95),e=2.6+t*3.5;return s<=.78?e*(1+.25*s):Math.min(e*(1+.42*Math.pow(s/(1-s),1.32)),20)}function P(o){let t=new N,s=Q(o.seed),e=new $(t,o.rtgFleet),n=new $(t,2),c=new $(t,3),l=new $(t,12),m=o.yardCap,y=360,p=o.nDis||750,d=Math.round(.56*p),_=1.25/Math.max(o.intensity,.05),u={teu:o.occ/100*m,peak:0,waveStart:null,waits:[],gate:[],icdN:0,icdD:0,rehandle:0,nominal:0,doneAt:null,blocked:0,trace:[]},x=()=>W(u.teu/m,o.blocking),f=()=>{t.now>=y&&(u.peak=Math.max(u.peak,u.teu/m*100))};function*i(g,k){yield t.timeout(g),yield e.request(-1),yield t.timeout(k),e.release()}function*a(){yield e.request(1),yield t.timeout(x()),e.release()}function*r(){yield e.request(1),yield t.timeout(x()*.85),u.teu-=1,e.release(),yield c.request(),yield t.timeout(1.4),u.icdN++,c.release()}function*h(){yield c.request(),yield t.timeout(1.4),u.icdD++,c.release()}function*q(){let g=t.now;yield e.request(0),u.waits.push(t.now-g);let k=u.teu/m,v=W(k,o.blocking);k>.8&&(u.rehandle+=v-2.6),yield t.timeout(v),u.teu+=1,f(),e.release(),yield t.timeout(1.5),l.release(),s.u()<.14&&(yield n.request(),yield t.timeout(s.uni(3.5,6.5)),n.release())}function*b(){yield t.timeout(y),u.waveStart=u.teu/m*100,f();for(let g=0;g<p;g++){let k=s.exp(_);if(u.nominal+=k,yield t.timeout(k),s.u()<o.icd){t.process(h());continue}let v=t.now;for(;u.teu+l.users>=m&&t.now-v<2880;)yield t.timeout(1);if(u.teu+l.users>=m){u.blocked+=t.now-v;continue}yield l.request(),u.blocked+=t.now-v,t.process(q())}u.doneAt=t.now}function*F(g){yield e.request(1),u.gate.push(t.now-g),yield t.timeout(x()*.85),u.teu-=1,e.release()}function*O(){yield t.timeout(y);for(let g=0;g<d;g++)yield t.timeout(s.exp(2.1)),u.teu>1e3&&t.process(F(t.now))}function*C(){for(let g=0;g<=1500;g+=10)u.trace.push([g,+(u.teu/m*100).toFixed(2),e.users,e.q.length]),yield t.timeout(10)}for(let[g,k]of o.rtgOutages||[])t.process(i(g,k));if(o.icd>0){for(let k=0;k<o.premarshalJobs;k++)t.process(a());let g=Math.round(o.icd*u.teu);for(let k=0;k<g;k++)t.process(r())}t.process(b()),t.process(O()),o.trace&&t.process(C()),t.run();let M=g=>g.length?g.reduce((k,v)=>k+v,0)/g.length:0;return{beta:Math.max(1,(u.doneAt-y)/u.nominal),waveStart:u.waveStart,peak:u.peak,gateWait:M(u.gate),rtgWait:M(u.waits),rehandleHrs:u.rehandle/60,icdBoxes:u.icdN+u.icdD,blockedHrs:u.blocked/60,makespanHrs:(u.doneAt-y)/60,trace:u.trace}}function G(o,t){let s=[];for(let n=0;n<t;n++)s.push(P({...o,seed:2026+n,trace:o.trace&&n===0}));let e=n=>s.reduce((c,l)=>c+l[n],0)/s.length;return{beta:+e(\"beta\").toFixed(3),waveStart:+e(\"waveStart\").toFixed(1),peak:+e(\"peak\").toFixed(1),gateWait:+e(\"gateWait\").toFixed(1),rtgWait:+e(\"rtgWait\").toFixed(2),rehandleHrs:+e(\"rehandleHrs\").toFixed(1),icdBoxes:Math.round(e(\"icdBoxes\")),blockedHrs:+e(\"blockedHrs\").toFixed(2),trace:s[0].trace,reps:t}}var R=o=>Math.pow(o,.88),I=o=>R(o).toFixed(3),J=[800,1600,3200],K=[500,1e3,2e3,3e3],U=o=>J.filter(t=>o>=t).length,B=(o,t,s)=>o.yard_model===\"per_ship\"?`${I(t)}|c${U(s.moves)}`:I(t);function Y(o){let t=o.config,s=o.live,e=o.tide_hourly,n=Number(s.plan_epoch_local.slice(11,13)),c=i=>((n+i)%24+24)%24,l=(i,a,r)=>{if(i<0||i>=e.length||s.hw_windows&&!s.hw_windows.some(([q,b])=>i>=q&&i<b)||a>t.max_loa_m||r>t.spring_max_draught_m||e[i]<r+t.ukc_m-t.channel_depth_m+(s.tide_margin_m||0)||r>t.max_draught_m&&e[i]<t.spring_tide_min_m)return!1;let h=c(i);return h>=t.daylight_hours[0]&&h<t.daylight_hours[1]?!0:a<=t.night_max_loa_m&&r<=t.night_max_draught_m},m=t.crane_pools||{all:t.qgc_total},y=Object.keys(m)[0],p=(i={})=>s.vessels.map(a=>({id:a.name,imo:a.imo,mmsi:a.mmsi,len:Math.ceil(a.loa_m),loa:a.loa_m,draft:a.draught_used_m,eta:a.eta_hr+(i[a.name]||0),moves:a.moves_est??Math.round(.85*(a.teu_est??a.dwt_t/14)),minQc:1,maxQc:a.max_qc??(a.loa_m>=160?3:2),ranges:a.quay_ranges||[[0,t.quay_ocean_m]],pool:a.terminal||y,quay:a.terminal,wWait:t.objective===\"cost\"?a.w_wait??18:18,wOcc:t.objective===\"cost\"?a.w_occ??6:6})),d={};for(let[i,a,r]of o.meeting||[])(d[i]=d[i]||[]).push([a,new Set(r)]);let _=o.gates,u=(i,a)=>_&&_[i.id]?_[i.id].in[a]===\"1\":(()=>{for(let r=1;r<=t.transit_hrs;r++)if(!l(a-r,i.loa,i.draft))return!1;return!0})();return{C:t,live:s,tide:e,clock:c,transitOk:l,vessels:p,pools:m,firstPool:y,inOk:u,outOk:(i,a)=>_&&_[i.id]?_[i.id].out[a]===\"1\":(()=>{for(let r=0;r<t.transit_hrs;r++)if(!l(a+r,i.loa,i.draft))return!1;return!0})(),gateNow:(i,a)=>{let r=p().find(h=>h.id===i);return r?u(r,a):!1},meet:d}}function L(o,t,s,e){let{C:n}=o,c=n.horizon_hrs,l=n.transit_hrs,m=n.berth_gap_m,y=e.tugSets,p=Object.fromEntries(Object.keys(o.pools).map(a=>[a,new Int16Array(c+4)])),d=new Int16Array(c+8),_=[],u=(a,r)=>{let h=0;for(let[q,b,F,O]of e.qgcOutages)q<=a&&a<b&&(O??o.firstPool)===r&&(h+=F);return Math.max(0,o.pools[r]-h)};for(let a of o.live.fixed_occupants||[]){_.push({id:a.name,b0:a.berth_start_m,b1:a.berth_start_m+Math.ceil(a.loa_m)+m,ts:0,td:a.release_hr,sIn:null});for(let r=0;r<l;r++)d[a.release_hr+r]++}let x=(a,r,h)=>{for(let q of _){for(let[b,F]of o.meet[a.id]||[])if(b===q.id){let O=q.td-r;if(Math.abs(O)<l&&!F.has(O))return!1}if(q.sIn!=null){for(let[b,F]of o.meet[q.id]||[])if(b===a.id){let O=h-q.sIn;if(Math.abs(O)<l&&!F.has(O))return!1}}}return!0},f=[],i=0;for(let a of s){let r=t[a],h=null,q=e.forceMax?[r.maxQc]:Array.from({length:r.maxQc-r.minQc+1},(b,F)=>r.minQc+F);for(let b of q){let F=e.cuts[B(n,b,r)]??1,O=Math.ceil(r.moves/(n.qgc_gmph/Math.max(F,.5)*R(b))),C=0;for(let M=Math.max(r.eta+l,e.minStart);M<c-(n.berth_tail_hrs??30)&&C<14;M++){if(!o.inOk(r,M))continue;let g=!0;for(let w=1;w<=l;w++)if(d[M-w]>=y){g=!1;break}if(!g)continue;let k=p[r.pool];for(let w=M;w<M+O;w++)if(k[w]+b>u(w,r.pool)){g=!1;break}if(!g)continue;let v=-1;for(let w=M+O;w<c-l;w++){if(!o.outOk(r,w))continue;let j=!0;for(let H=0;H<l;H++)if(d[w+H]>=y){j=!1;break}if(j&&x(r,M-l,w)){v=w;break}}if(v<0)continue;let E=_.filter(w=>w.ts<v&&M<w.td).sort((w,j)=>w.b0-j.b0),D=-1;for(let[w,j]of r.ranges){let H=[w,...E.map(S=>S.b1).filter(S=>S>w&&S<j)];for(let S of H)if(!(S+r.len>j)&&E.every(A=>S+r.len+m<=A.b0||A.b1<=S)){D=S;break}if(D>=0)break}if(D<0)continue;C++;let T=r.wWait*(M-l-r.eta)+r.wOcc*(v-M);(!h||T<h.c)&&(h={c:T,q:b,ts:M,td:v,dur:O,b:D})}}if(!h)return{fail:r.id};for(let b=h.ts;b<h.ts+h.dur;b++)p[r.pool][b]+=h.q;for(let b=1;b<=l;b++)d[h.ts-b]++;for(let b=0;b<l;b++)d[h.td+b]++;_.push({id:r.id,b0:h.b,b1:h.b+r.len+m,ts:h.ts,td:h.td,sIn:h.ts-l}),i+=h.c,e.minStart=e.fcfs?h.ts:0,f.push({vessel_id:r.id,imo:r.imo,mmsi:r.mmsi,loa_m:r.loa,draft_m:r.draft,moves:r.moves,berth_start_m:h.b,berth_end_m:h.b+r.len,eta_hr:r.eta,transit_in_hr:h.ts-l,berth_start_hr:h.ts,cargo_done_hr:h.ts+h.dur,tidal_depart_hr:h.td,tide_departure_hold_hrs:h.td-h.ts-h.dur,assigned_qcs:h.q,crane_intensity:B(n,h.q,r),anchorage_wait_hrs:h.ts-l-r.eta,turnaround_hrs:h.td+l-r.eta,night_restricted:r.loa>n.night_max_loa_m||r.draft>n.night_max_draught_m,tide_needed_m:V(o,r),...r.quay?{quay:r.quay,pool:r.pool}:{}})}return{cost:i,rows:f}}function V(o,t){let s=o.C;if(!o.live.vessels.some(l=>l.terminal))return+Math.max(0,t.draft+s.ukc_m-s.channel_depth_m).toFixed(2);let e=t.loa>s.mega_loa_m||(o.live.vessels.find(l=>l.name===t.id)?.beam_m||0)>s.mega_beam_m,n=e?s.draught_indep_mega_m:s.draught_indep_m,c=(e?s.draught_max_in_mega_m:s.draught_max_in_m)-s.deepening_shortfall_m;return+Math.max(0,Math.min(t.draft,c)-n).toFixed(2)}function X(o,t){let s=[],e=new Array(o).fill(!1),n=[];return function c(l){if(l===o){s.push(n.slice());return}for(let m=0;m<o;m++)e[m]||Math.abs(m-l)>t||(m>l,e[m]=!0,n.push(m),c(l+1),n.pop(),e[m]=!1)}(0),s}function Z(o,t){let s=o.vessels(t.etaShift).sort((p,d)=>p.eta-d.eta||(p.id<d.id?-1:1)),e={cuts:t.cuts||{},tugSets:t.tugSets??o.C.pilot_tug_sets,qgcOutages:t.qgcOutages||[],forceMax:!!t.forceMax,fcfs:!!t.fcfs},n=t.fcfs?[s.map((p,d)=>d)]:X(s.length,s.length>9?1:2);if(!t.fcfs){let p=o.C.horizon_hrs,d=s.map(x=>{let f=0;for(let i=0;i<p;i++)o.inOk(x,i)&&f++;return f}),_=x=>Object.keys(o.meet).includes(x.id)?1:0;n.push(s.map((x,f)=>f).sort((x,f)=>d[x]-d[f]||s[x].eta-s[f].eta)),n.push(s.map((x,f)=>f).sort((x,f)=>_(s[f])-_(s[x])||s[x].eta-s[f].eta));let u=Q(7);for(let x=0;x<(s.length>9?120:0);x++){let f=s.map((i,a)=>a);for(let i=f.length-1;i>0;i--){let a=Math.floor(u.u()*(i+1));[f[i],f[a]]=[f[a],f[i]]}n.push(f)}}let c=null,l={};for(let p of n){let d=L(o,s,p,{...e,minStart:0});if(d.fail){l[d.fail]=(l[d.fail]||0)+1;continue}(!c||d.cost<c.cost)&&(c=d)}if(!c){let p=Object.entries(l).sort((d,_)=>_[1]-d[1])[0];return{feasible:!1,ordersTried:n.length,schedule:[],blocker:p&&p[0]}}let m=c.rows.sort((p,d)=>p.berth_start_hr-d.berth_start_hr),y=m.length;return{feasible:!0,ordersTried:n.length,objective:c.cost,avgTurnaroundDays:+(m.reduce((p,d)=>p+d.turnaround_hrs,0)/y/24).toFixed(2),totalWaitHrs:m.reduce((p,d)=>p+d.anchorage_wait_hrs,0),totalHoldHrs:m.reduce((p,d)=>p+d.tide_departure_hold_hrs,0),schedule:m}}function z(o,t={},s=()=>{}){let e=Y(o),n=e.C,c=t.icd??n.icd_ratio,l=t.occ??n.initial_yard_occupancy_pct,m=t.reps??8,y={},p={},d=[],_=null,u=!1;s(`scenario: off-dock evacuation ${Math.round(c*100)}%, yard ${l}%, ${t.tugSets??n.pilot_tug_sets} pilot/tug sets, ${(t.qgcOutages||[]).length} quay-crane outage(s), ${(t.rtgOutages||[]).length} yard-crane outage(s)`);for(let i=1;i<=8;i++){if(_=Z(e,{...t,cuts:y}),!_.feasible){s(`iteration ${i}: no feasible berth plan inside the ${n.horizon_hrs} h horizon${_.blocker?`; ${_.blocker} cannot finish and sail on a legal tide before it ends`:\"\"}`);break}let a=[...new Set(_.schedule.map(r=>r.crane_intensity))].filter(r=>!(r in y)).sort();s(`iteration ${i}: planner searched ${_.ordersTried} berthing orders, cost ${_.objective}, turnaround ${_.avgTurnaroundDays} d`);for(let r of a)p[r]=G({occ:l,icd:c,intensity:n.qgc_gmph*Number(r.split(\"|\")[0])/n.ref_boxes_per_hr,nDis:r.includes(\"|c\")?K[Number(r.split(\"|c\")[1])]:750,rtgFleet:n.rtg_per_berth_cluster,yardCap:n.yard_cluster_teu,blocking:o.yard.blocking_ratio,premarshalJobs:o.yard.night_premarshal_relocations_executed,rtgOutages:t.rtgOutages,trace:!0},m),y[r]=p[r].beta,s(`  yard DES, crane effect ${r}: ${m} replications, backpressure ${p[r].beta.toFixed(3)}, peak occupancy ${p[r].peak}%  -> cut added`);if(d.push({iteration:i,objective:_.objective,cuts:{...y}}),!a.length){u=!0,s(`iteration ${i}: plan uses only simulated crane modes, bound attained`);break}}if(!_||!_.feasible)return{feasible:!1,trace:d,blocker:_&&_.blocker};let x=_.schedule.map(i=>i.crane_intensity).sort((i,a)=>Number(a.split(\"|\")[0])-Number(i.split(\"|\")[0])||y[a]-y[i])[0],f=p[x];return{feasible:!0,converged:u,iterations:d.length,cuts:y,trace:d,schedule:_.schedule,kpis:{objective:_.objective,turnaround:_.avgTurnaroundDays,wait:_.totalWaitHrs,hold:_.totalHoldHrs,beta:Math.max(..._.schedule.map(i=>y[i.crane_intensity])),waveStart:f.waveStart,peak:f.peak,gateWait:f.gateWait,rtgWait:f.rtgWait,rehandle:f.rehandleHrs,icdBoxes:f.icdBoxes,hfo:+(_.totalWaitHrs*1.85).toFixed(1)},yardTrace:f.trace}}self.onmessage=o=>{let t=z(o.data.data,o.data.opt,s=>self.postMessage({log:s}));self.postMessage({done:t})};})();\n";

// Re-plan in a Web Worker when the page allows it; otherwise on the main thread.
function solveAsync(data, opt, onLog) {
  if (WORKER_SRC && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      return new Promise((ok) => {
        const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })), w = new Worker(url);
        const fallback = () => { w.terminate(); URL.revokeObjectURL(url); ok(solve(data, opt, onLog)); };
        w.onmessage = (e) => { if (e.data.log) onLog(e.data.log); if (e.data.done) { w.terminate(); URL.revokeObjectURL(url); ok(e.data.done); } };
        w.onerror = fallback;
        w.postMessage({ data, opt });
      });
    } catch (e) { /* blocked by the page's security policy: fall through */ }
  }
  return new Promise((ok) => setTimeout(() => ok(solve(data, opt, onLog)), 30));
}

// The real engine (CP-SAT + yard simulation) on a server, when one is configured: window.PORTFLOW_API or ?api=<url>.
// The page asks it first and falls back to the in-browser planner if it is unreachable, busy or slow.
function apiUrl() {
  if (typeof window === 'undefined') return null;
  try { const q = new URLSearchParams(window.location.search).get('api'); if (q === 'off') return null; if (q && /^https:\/\/|^http:\/\/localhost/.test(q)) return q.replace(/\/$/, ''); } catch (e) { /* no URL API */ }
  return window.PORTFLOW_API ? String(window.PORTFLOW_API).replace(/\/$/, '') : null;
}
async function solveServer(data, opt, onLog) {
  const api = apiUrl();
  if (!api || !data.site_kind || typeof fetch === 'undefined') return null;
  onLog(`asking the server CP-SAT engine (${api.replace(/^https?:\/\//, '')}); a sleeping server can take a minute to wake`);
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tm = ctl && setTimeout(() => ctl.abort(), 100000), t0 = Date.now();
  try {
    const r = await fetch(`${api}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify({ site: data.site_kind, generated_utc: data.generated_utc, scenario: { etaShift: opt.etaShift, qgcOutages: opt.qgcOutages, rtgOutages: opt.rtgOutages, icd: opt.icd, occ: opt.occ, tugSets: opt.tugSets } }) });
    if (!r.ok) { onLog(r.status === 409 ? 'server CP-SAT holds a different plan from the one on this page; re-planning in the browser instead' : `server CP-SAT: HTTP ${r.status}; re-planning in the browser instead`); return null; }
    const res = await r.json();
    (res.trace || []).forEach((it) => onLog(`server CP-SAT iteration ${it.iteration}: objective ${it.master_objective ?? it.objective ?? '-'}, turnaround ${it.avg_turnaround_days ?? '-'} d${it.cuts_added && Object.keys(it.cuts_added).length ? `, yard cuts ${Object.entries(it.cuts_added).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join(' ')}` : ''}`));
    onLog(`server CP-SAT answered in ${((Date.now() - t0) / 1000).toFixed(1)} s (solve ${res.runtime_s} s, data of ${res.data_generated_utc || 'today'})`);
    return res;
  } catch (e) { onLog(`server CP-SAT unreachable (${(e && e.name) || 'error'}); re-planning in the browser instead`); return null; } finally { if (tm) clearTimeout(tm); }
}

const CSS = `
.pf{--bg:#05090d;--panel:#0a1219;--well:#060b10;--line:#16293a;--line-hi:#2b4a63;--ink:#d7e5f0;--muted:#8097a9;--tele:#5ef2c8;--amber:#ffb224;--red:#ff5a52;--blue:#4aa3ff;--ok:#3ddc84;
 --mono:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;--disp:'Rajdhani','Segoe UI',system-ui,sans-serif;
 background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:12px;line-height:1.45;min-height:100vh;padding:14px 16px 28px;box-sizing:border-box}
.pf *{box-sizing:border-box}.pf .num{font-variant-numeric:tabular-nums}
.pf button{font:inherit;color:inherit;cursor:pointer}
.pf button:focus-visible,.pf input:focus-visible{outline:2px solid var(--tele);outline-offset:2px}
.pf-top{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 22px;border-bottom:1px solid var(--line-hi);padding-bottom:10px}
.pf-brand{font-family:var(--disp);font-weight:700;font-size:25px;letter-spacing:.09em;line-height:1;text-transform:uppercase}
.pf-brand small{display:block;font-family:var(--mono);font-weight:400;font-size:10.5px;letter-spacing:.04em;color:var(--muted);text-transform:none;margin-top:5px}
.pf-clock{font-family:var(--disp);font-weight:600;font-size:25px;letter-spacing:.06em;color:var(--tele);line-height:1}
.pf-clock small{display:block;font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.02em;margin-top:5px}
.pf-lamps{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.pf-lamp{border:1px solid var(--line-hi);background:var(--well);padding:4px 9px;font-size:10.5px;display:flex;align-items:center;gap:7px;white-space:nowrap}
.pf-lamp i{width:8px;height:8px;border-radius:50%;background:var(--c);box-shadow:0 0 8px var(--c)}
.pf-scrub{display:flex;align-items:center;gap:10px;margin:10px 0;background:var(--panel);border:1px solid var(--line);padding:7px 10px}
.pf-scrub input{flex:1;accent-color:var(--tele);min-width:80px}
.pf-btn{background:var(--well);border:1px solid var(--line-hi);padding:5px 10px;min-height:30px;white-space:nowrap}
.pf-btn:hover{border-color:var(--tele)}.pf-btn.on{background:#0e2a2a;border-color:var(--tele);color:var(--tele)}
.pf-btn:disabled{opacity:.45;cursor:default}
.pf-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px}
.pf-panel{background:var(--panel);border:1px solid var(--line);padding:11px 12px;min-width:0;grid-column:span 12}
.s7{grid-column:span 7}.s5{grid-column:span 5}
@media(max-width:980px){.s7,.s5{grid-column:span 12}}
.pf-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.pf-tag{font-family:var(--disp);font-size:10.5px;letter-spacing:.16em;color:var(--tele);text-transform:uppercase}
.pf-head h2{font-family:var(--disp);font-weight:600;font-size:17px;letter-spacing:.05em;margin:0;text-transform:uppercase}
.pf-note{color:var(--muted);font-size:10.5px;margin:6px 0 0;max-width:96ch}
.pf-seg{display:flex;gap:4px;flex-wrap:wrap}
.pf-radar{position:relative;background:radial-gradient(ellipse at 33% 60%,#0b2030 0,#060b10 70%);border:1px solid var(--line);overflow:hidden}
.pf-radar svg{display:block;width:100%;height:auto}
.pf-sweep{transform-origin:250px 258px;animation:pfsweep 7s linear infinite}
@keyframes pfsweep{to{transform:rotate(360deg)}}
.pf-ship{cursor:pointer;transition:opacity .4s}
.pf-ship .ping{animation:pfping 1.8s ease-out infinite;transform-origin:center;transform-box:fill-box}
@keyframes pfping{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(2.6)}}
.pf-card{background:var(--well);border:1px solid var(--line-hi);border-top:0;padding:8px 10px;font-size:10.5px}
.pf-card h3{font-family:var(--disp);font-size:15px;letter-spacing:.06em;margin:0 0 4px;color:#fff}
.pf-card h3 span{font-family:var(--mono);font-size:10.5px;font-weight:400;letter-spacing:0;margin-left:10px}
.pf-card dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:5px 14px;margin:0}.pf-card dt{color:var(--muted);font-size:10px}.pf-card dd{margin:0}
.pf-chat{display:flex;flex-direction:column;gap:8px;height:100%}
.pf-msgs{background:var(--well);border:1px solid var(--line);padding:8px;height:214px;overflow-y:auto;display:flex;flex-direction:column;gap:7px}
.pf-msg{max-width:92%;padding:6px 9px;border:1px solid var(--line);white-space:pre-wrap;animation:pfin .3s ease-out}
.pf-msg.u{align-self:flex-end;background:#0e2233;border-color:#24507a}.pf-msg.a{align-self:flex-start;background:#0a1a18;border-color:#1d4a42}
@keyframes pfin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pf-in{display:flex;gap:6px}.pf-in input{flex:1;min-width:0;background:var(--well);border:1px solid var(--line-hi);color:var(--ink);font:inherit;padding:7px 9px;min-height:34px}
.pf-chips{display:flex;flex-wrap:wrap;gap:5px}
.pf-chip{background:transparent;border:1px solid var(--line-hi);padding:3px 8px;font-size:10.5px;color:var(--muted);text-align:left}
.pf-chip:hover{color:var(--ink);border-color:var(--tele)}
.pf-chip.act{color:var(--amber);border-color:#6b4c12;background:#1a1408}
.pf-term{background:#020507;border:1px solid var(--line);height:128px;overflow-y:auto;padding:6px 8px;font-size:10.5px;color:#9fe8d2}
.pf-term div{white-space:pre-wrap;animation:pfin .2s ease-out}.pf-term .cur::after{content:'▍';animation:pfblink 1s steps(2) infinite}
@keyframes pfblink{50%{opacity:0}}
.pf-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.pf-kpi{background:var(--well);border:1px solid var(--line);padding:8px 10px;position:relative;overflow:hidden}
.pf-kpi .l{font-family:var(--disp);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.pf-kpi .v{font-family:var(--disp);font-weight:600;font-size:27px;line-height:1.1;color:#fff}
.pf-kpi .v small{font-size:13px;color:var(--muted);font-weight:500;margin-left:3px}
.pf-kpi .d{font-size:10.5px;color:var(--muted)}.pf-kpi .d b{font-weight:500}
.pf-kpi.flash::after{content:'';position:absolute;inset:0;border:1px solid var(--tele);animation:pfflash 1.2s ease-out forwards;pointer-events:none}
@keyframes pfflash{from{opacity:1;box-shadow:inset 0 0 22px rgba(94,242,200,.5)}to{opacity:0}}
.pf-scroll{overflow-x:auto}
.pf-gbar{transition:transform .9s cubic-bezier(.2,.8,.2,1);cursor:pointer}
.pf-gbar rect{transition:width .9s cubic-bezier(.2,.8,.2,1)}
.pf-table{width:100%;border-collapse:collapse;font-size:10.5px;min-width:980px}
.pf-table th{font-family:var(--disp);font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:right;padding:5px 7px;border-bottom:1px solid var(--line-hi);white-space:nowrap}
.pf-table td{text-align:right;padding:5px 7px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
.pf-table th:first-child,.pf-table td:first-child,.pf-table .tl{text-align:left}
.pf-table tr{cursor:pointer}.pf-table tr.sel td{background:#0e2a2a}
.pf-key{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;margin-right:12px}
.pf-key i{width:10px;height:10px;background:var(--c);display:inline-block}
.pf-read{background:var(--well);border:1px solid var(--line);padding:6px 9px;min-height:30px;margin-top:8px;font-size:10.5px}
.pf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-top:8px}
.pf-stat{background:var(--well);border:1px solid var(--line);padding:5px 8px}
.pf-stat .l{font-family:var(--disp);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.pf-stat .v{font-size:12.5px}
.y3-stage{position:relative;overflow:hidden;contain:strict;isolation:isolate;background:radial-gradient(ellipse at 50% 60%,#0d1c29 0,#060a0f 72%);border:1px solid var(--line)}
.y3-fit{position:absolute;left:0;top:0;width:900px;height:380px;transform-origin:0 0;will-change:transform}
.pf.playing .y3-box.hz .t::after{animation-play-state:paused}
.y3-scene{position:absolute;left:50%;top:50%;transform-style:preserve-3d;transform:translate(-50%,-30%) rotateX(58deg) rotateZ(24deg);
 background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);outline:1px solid var(--line-hi)}
.y3-box{position:absolute;transform-style:preserve-3d;transform:translateZ(var(--z));transition:left .45s ease,top .45s ease,transform .45s ease;animation:y3drop .7s cubic-bezier(.25,1.2,.5,1) backwards;animation-delay:var(--dl)}
.y3-box i{position:absolute;display:block;outline:1px solid rgba(5,8,12,.85);outline-offset:-1px}
.y3-box .t{left:0;top:0;width:100%;height:100%;transform:translateZ(var(--h));background:var(--c0)}
.y3-box .s{left:0;top:100%;width:100%;height:var(--h);transform-origin:0 0;transform:rotateX(90deg);background:var(--c2)}
.y3-box .e{left:100%;top:0;width:var(--h);height:100%;transform-origin:0 0;transform:rotateY(-90deg);background:var(--c1)}
.y3-box.im .t{background:repeating-linear-gradient(45deg,#ff8a1f 0 3px,#14100a 3px 6px)}
.y3-box.hz i{outline:1.5px solid #fff}
.y3-box.hz .t::after{content:'';position:absolute;inset:0;border:2.5px solid #fff;box-shadow:0 0 9px 3px rgba(255,90,82,.95);animation:y3haz 1s ease-in-out infinite alternate}
.y3-box.mv i{outline:2px solid var(--tele)}
.y3-box.dim i{opacity:.07;animation:none}
@keyframes y3drop{from{transform:translateZ(calc(var(--z) + 420px));opacity:0}to{transform:translateZ(var(--z));opacity:1}}
@keyframes y3haz{from{opacity:.35}to{opacity:1}}
.pf-foot{margin-top:14px;color:var(--muted);font-size:10.5px}.pf-foot summary{cursor:pointer;color:var(--ink)}.pf-foot li{margin:3px 0;max-width:110ch}
.pf-foot a{color:var(--tele)}
.pf-map{height:430px;border:1px solid var(--line);background:#06121b}
.pf-map .leaflet-tile-pane{filter:invert(1) hue-rotate(185deg) brightness(.85) contrast(.92) saturate(.55)}
.pf-map .leaflet-container,.pf .leaflet-container{background:#06121b;font:inherit}
.pf .pf-mk{background:none;border:0}
.pf .pf-tip{background:rgba(5,9,13,.82);border:1px solid #2b4a63;color:#d7e5f0;font:10.5px var(--mono);padding:1px 5px;box-shadow:none}
.pf .pf-tip::before{display:none}
.pf .leaflet-control-attribution{background:rgba(5,9,13,.75);color:#8097a9}.pf .leaflet-control-attribution a{color:#5ef2c8}
.pf-banner{margin:8px 0 0;padding:6px 10px;border:1px solid #6b4c12;background:#1a1408;color:var(--amber);font-size:10.5px}
.pf-banner.ok{border-color:#1d4a42;background:#0a1a18;color:var(--tele)}
.pf-nav{display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px}.pf-nav a{color:var(--muted);text-decoration:none;border:1px solid var(--line-hi);padding:3px 8px}.pf-nav a:hover,.pf-nav a.on{color:var(--tele);border-color:var(--tele)}
@media(prefers-reduced-motion:reduce){.pf-sweep,.pf-ship .ping,.y3-box,.y3-box.hz .t::after,.pf-msg,.pf-term div{animation:none}.y3-box,.pf-gbar,.pf-gbar rect{transition:none}}
`;

const C = { tele: '#5ef2c8', amber: '#ffb224', red: '#ff5a52', blue: '#4aa3ff', ok: '#3ddc84', muted: '#8097a9', ink: '#d7e5f0', line: '#16293a', hi: '#2b4a63' };
const fmt = (x, d = 1) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
const tip = { contentStyle: { background: '#05080c', border: '1px solid #2b4a63', borderRadius: 0, fontSize: 11, fontFamily: 'inherit', color: C.ink }, labelStyle: { color: C.muted }, itemStyle: { color: C.ink, padding: 0 } };
const ax = { stroke: C.muted, tick: { fill: C.muted, fontSize: 10 }, tickLine: false };

const pyKpis = (k) => ({ objective: k.objective, turnaround: k.avg_turnaround_days, wait: k.total_anchorage_wait_hrs, hold: k.total_tide_hold_hrs, beta: k.backpressure_beta_max,
  peak: k.peak_yard_occupancy_pct, gateWait: k.avg_gate_truck_wait_mins, rehandle: k.unproductive_rehandle_hrs, icdBoxes: k.icd_evacuated_containers, hfo: k.hfo_proxy_tonnes });

function useTween(target, ms = 800) {
  const [x, setX] = useState(target); const cur = useRef(target);
  useEffect(() => {
    const a = cur.current, t0 = performance.now(); let raf;
    const step = (now) => { const k = Math.min(1, (now - t0) / ms), v = a + (target - a) * (1 - Math.pow(1 - k, 3)); cur.current = v; setX(v); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return x;
}

// ------------------------------------------------------------------ plan clock
function planClock(epochIso, t) {
  const d = new Date(new Date(epochIso.slice(0, 19) + 'Z').getTime() + t * 3600e3);
  return { day: DAYS[d.getUTCDay()], date: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), label: `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

// ------------------------------------------------------------------ radar geometry (schematic chart, not to scale)
const CH = [[338, 258], [420, 262], [472, 254], [512, 232], [540, 200], [572, 172], [618, 154], [690, 140], [738, 132]];
const CH_LEN = CH.slice(1).reduce((a, p, i) => { a.push(a[i] + Math.hypot(p[0] - CH[i][0], p[1] - CH[i][1])); return a; }, [0]);
const CH_TOTAL = CH_LEN[CH_LEN.length - 1];
function chan(s) {
  const d = clamp(s, 0, CH_TOTAL); let i = 1; while (i < CH.length - 1 && CH_LEN[i] < d) i++;
  const k = (d - CH_LEN[i - 1]) / (CH_LEN[i] - CH_LEN[i - 1]), p = lerp(CH[i - 1], CH[i], k);
  return { p, ang: Math.atan2(CH[i][1] - CH[i - 1][1], CH[i][0] - CH[i - 1][0]) };
}
const QUAY_S0 = CH_LEN[5] + 8, QUAY_S1 = CH_TOTAL - 6;                    // the quay runs beside the last reach of the channel
const quayS = (m) => QUAY_S0 + (m / 1000) * (QUAY_S1 - QUAY_S0);
const off = (c, d) => [c.p[0] + Math.sin(c.ang) * d, c.p[1] - Math.cos(c.ang) * d];   // d > 0 = towards the north bank
const ORIGIN = (v) => (/Colombo/.test(v.last_port) ? [-14, 318] : [128, 446]);
const START_K = { ANCHORAGE: 1, BAY_NEAR: 0.72, BAY_MID: 0.4, BAY_FAR: 0.06 };
const anchorSlot = (i) => [186 + (i % 3) * 72, 232 + (Math.floor(i / 3) % 3) * 34];

function shipAt(row, v, t, idx, T) {
  const slot = anchorSlot(idx), o = ORIGIN(v), mid = (row.berth_start_m + row.berth_end_m) / 2, sB = quayS(mid), berth = off(chan(sB), 7);
  const face = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (t < row.eta_hr) { const k0 = START_K[v.area] ?? 0.2, k = k0 + (1 - k0) * (row.eta_hr > 0 ? t / row.eta_hr : 1); return { phase: 'INBOUND', p: lerp(o, slot, k), ang: face(o, slot), text: `Inbound, ${fmt(row.eta_hr - t, 0)} h to the anchorage` }; }
  if (t < row.transit_in_hr) return { phase: 'ANCHOR', p: slot, ang: -0.5, text: `At anchor, pilot booked in ${fmt(row.transit_in_hr - t, 0)} h` };
  if (t < row.berth_start_hr) {
    const u = (t - row.transit_in_hr) / T;
    if (u < 0.18) return { phase: 'CHANNEL', p: lerp(slot, CH[0], u / 0.18), ang: face(slot, CH[0]), text: 'Under pilotage, inbound' };
    const w = (u - 0.18) / 0.82, c = chan(w * sB), side = clamp((w - 0.8) / 0.2, 0, 1);
    return { phase: 'CHANNEL', p: off(c, 7 * side), ang: c.ang, text: 'Under pilotage, inbound on the Karnaphuli' };
  }
  if (t < row.tidal_depart_hr) return { phase: 'BERTH', p: berth, ang: chan(sB).ang, text: t < row.cargo_done_hr ? `Working cargo with ${row.assigned_qcs} quay cranes` : 'Cargo complete, holding for tide or daylight' };
  if (t < row.tidal_depart_hr + T) { const u = (t - row.tidal_depart_hr) / T, c = chan((1 - u) * sB); return { phase: 'CHANNEL', p: off(c, 7 * clamp(1 - u / 0.2, 0, 1)), ang: c.ang + Math.PI, text: 'Under pilotage, outbound' }; }
  const u = (t - row.tidal_depart_hr - T) / 10;
  return u < 1 ? { phase: 'SAILED', p: lerp(CH[0], o, u), ang: face(CH[0], o), text: 'Sailed', fade: 1 - u } : null;
}
const PHASE_C = { INBOUND: C.blue, ANCHOR: C.amber, CHANNEL: C.tele, BERTH: C.ok, SAILED: C.muted };

function NctCard({ cur, gate, tide, dc }) {
  return (
        <div className="pf-card">
          <h3>{cur.r.vessel_id}<span style={{ color: PHASE_C[cur.s.phase] }}>{cur.s.text}</span></h3>
          <dl>
            <div><dt>IMO / MMSI</dt><dd className="num">{cur.v.imo} / {cur.v.mmsi}</dd></div>
            <div><dt>Length × beam</dt><dd className="num">{fmt(cur.v.loa_m, 2)} × {fmt(cur.v.beam_m, 1)} m</dd></div>
            <div><dt>Draught</dt><dd className="num">{cur.v.draught_reported_m == null ? 'not reported' : `${fmt(cur.v.draught_reported_m)} m reported`}, {fmt(cur.r.draft_m)} m planned</dd></div>
            <div><dt>Reported status</dt><dd>{cur.v.status}</dd></div>
            <div><dt>Speed and course</dt><dd>{cur.v.sog_kn != null ? `${fmt(cur.v.sog_kn)} kn, ${fmt(cur.v.cog_deg, 0)}° (AIS ${cur.v.ais_time_utc || ''})` : 'not published by any source read'}</dd></div>
            <div><dt>Tide gate now</dt><dd style={{ color: gate ? C.ok : C.red }}>{gate ? 'open' : tide < cur.r.tide_needed_m ? `shut: needs ${fmt(cur.r.tide_needed_m)} m of tide` : 'shut: night rule'}</dd></div>
            <div><dt>Assigned berth</dt><dd className="num">{cur.r.berth_start_m}–{cur.r.berth_end_m} m, {cur.r.assigned_qcs} quay cranes</dd></div>
            <div><dt>Last port</dt><dd>{cur.v.last_port}</dd></div>
            {dc && <div><dt>Daylight bar windows</dt><dd>{dc.inbound_starts_planned} at {fmt(dc.planned_m)} m{dc.inbound_starts_reported != null && dc.reported_m !== dc.planned_m ? `; ${dc.inbound_starts_reported} at the reported ${fmt(dc.reported_m)} m` : ''}</dd></div>}
          </dl>
        </div>
  );
}

const Radar = React.memo(function Radar({ data, site, schedule, t, sel, onSel, tide }) {
  const T = data.config.transit_hrs, vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const ships = schedule.map((r) => ({ r, v: vmap[r.vessel_id], s: shipAt(r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })).filter((x) => x.s);
  const fixed = (data.live.fixed_occupants || []).filter((fx) => t < fx.release_hr + T).map((fx) => ({ fx, pos: t < fx.release_hr ? off(chan(quayS(fx.berth_start_m + fx.loa_m / 2)), 7) : chan((1 - (t - fx.release_hr) / T) * quayS(fx.loa_m / 2)).p }));
  const q0 = off(chan(quayS(0)), 13), q820 = off(chan(quayS(820)), 13), q1000 = off(chan(quayS(1000)), 13);
  const berthRank = Object.fromEntries(ships.filter((x) => x.s.phase === 'BERTH').sort((a, b) => a.r.berth_start_m - b.r.berth_start_m).map((x, i) => [x.r.vessel_id, i]));
  const cur = ships.find((x) => x.r.vessel_id === sel), dc = cur && (data.draught_check || []).find((d) => d.vessel === sel);
  const hr = Math.floor(t), gate = cur && site.transitOk(hr, cur.r.loa_m, cur.r.draft_m), night = !(site.clock(hr) >= data.config.daylight_hours[0] && site.clock(hr) < data.config.daylight_hours[1]);
  const hull = 'M13,0 L5,-4.6 L-11,-4.6 L-11,4.6 L5,4.6 Z';
  return (
    <div><div className="pf-radar">
      <svg viewBox="0 0 760 430" role="img" aria-label="Schematic chart of the Bay of Bengal approach, the outer anchorage, the Karnaphuli channel and the NCT quay with the planned position of each vessel">
        <defs><linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#5ef2c8" stopOpacity="0" /><stop offset="1" stopColor="#5ef2c8" stopOpacity=".28" /></linearGradient></defs>
        {[60, 120, 180, 240].map((r) => <circle key={r} cx="250" cy="258" r={r} fill="none" stroke="#12303f" strokeDasharray="2 5" />)}
        <g className="pf-sweep"><path d="M250,258 L250,18 A240,240 0 0 1 420,88 Z" fill="url(#sw)" /></g>
        <path d="M430,0 C420,60 452,120 440,180 C434,214 470,236 452,244 L560,158 C600,130 680,112 760,96 L760,0 Z" fill="#0c1a22" stroke="#24404f" />
        <path d="M452,272 C480,268 520,262 556,214 C590,180 650,168 760,150 L760,430 L470,430 C440,380 470,330 452,272 Z" fill="#0c1a22" stroke="#24404f" />
        <polyline points={CH.map((p) => p.join(',')).join(' ')} fill="none" stroke="#1d5068" strokeWidth="1.2" strokeDasharray="6 5" />
        <line x1={q0[0]} y1={q0[1]} x2={q820[0]} y2={q820[1]} stroke={C.tele} strokeWidth="3.5" />
        <line x1={q820[0]} y1={q820[1]} x2={q1000[0]} y2={q1000[1]} stroke={C.muted} strokeWidth="3.5" strokeDasharray="4 3" />
        <g fontFamily="Rajdhani, sans-serif" fontSize="11" letterSpacing="1.4" fill={C.muted}>
          <text x="20" y="26">BAY OF BENGAL</text><text x="170" y="196">OUTER ANCHORAGE</text><text x="378" y="286">SEA BUOY</text>
          <text x="470" y="318">KARNAPHULI RIVER</text><text x={q0[0] - 70} y={q0[1] - 44} fill={C.tele}>NCT OCEAN QUAY 0–820 m</text><text x="754" y={q1000[1] + 54} textAnchor="end">BARGE BERTH ↑</text>
          <text x="20" y="418">from Singapore · Port Klang ↗</text><text x="20" y="340">← from Colombo</text><text x="640" y="60">CHATTOGRAM</text>
        </g>
        <ellipse cx="258" cy="252" rx="104" ry="62" fill="rgba(255,178,36,.04)" stroke="#5a4313" strokeDasharray="3 4" />
        {cur && cur.s.phase !== 'SAILED' && <polyline points={[ORIGIN(cur.v), anchorSlot(order.indexOf(sel)), ...CH.filter((_, i) => CH_LEN[i] < quayS((cur.r.berth_start_m + cur.r.berth_end_m) / 2)), off(chan(quayS((cur.r.berth_start_m + cur.r.berth_end_m) / 2)), 7)].map((p) => p.join(',')).join(' ')} fill="none" stroke={C.tele} strokeOpacity=".45" strokeWidth="1" />}
        {(data.live.also_in_port_not_modelled || []).map((o, i) => { const c = off(chan(CH_LEN[3] + i * 26), -8); return <g key={o.name} transform={`translate(${c[0]},${c[1]}) rotate(${(chan(CH_LEN[3]).ang * 180) / Math.PI})`}><path d={hull} fill="none" stroke="#51677a" /><title>{`${o.name}: ${o.status}. Terminal not published, not in the plan.`}</title></g>; })}
        {fixed.map(({ fx, pos }) => <g key={fx.name}><g transform={`translate(${pos[0]},${pos[1]}) rotate(${(chan(quayS(fx.loa_m / 2)).ang * 180) / Math.PI})`}><path d={hull} fill="#51677a" /><title>{`${fx.name}: ${fx.status}`}</title></g>
          <text x={pos[0] - 30} y={pos[1] + 17} fontSize="9" fill="#6f8598">{fx.name}</text></g>)}
        {ships.map(({ r, s }) => (
          <g key={r.vessel_id} className="pf-ship" opacity={s.fade ?? 1} onClick={() => onSel(r.vessel_id)} tabIndex="0" role="button" aria-label={`${r.vessel_id}, ${s.text}`} onKeyDown={(e) => e.key === 'Enter' && onSel(r.vessel_id)}>
            <g transform={`translate(${s.p[0].toFixed(1)},${s.p[1].toFixed(1)})`}>
              {(s.phase === 'CHANNEL' || r.vessel_id === sel) && <circle className="ping" r="12" fill="none" stroke={PHASE_C[s.phase]} />}
              <circle r="16" fill="transparent" />
              <path d={hull} transform={`rotate(${((s.ang * 180) / Math.PI).toFixed(1)})`} fill={PHASE_C[s.phase]} stroke={r.vessel_id === sel ? '#fff' : 'none'} strokeWidth="1.4" />
              <text textAnchor="middle" y={s.phase === 'BERTH' ? (berthRank[r.vessel_id] % 2 ? 21 : -11) : -10} fontSize="10.5" fill={r.vessel_id === sel ? '#fff' : C.ink} stroke="#060b10" strokeWidth="2.5" paintOrder="stroke">{r.vessel_id}</text>
            </g>
          </g>
        ))}
        <g fontSize="10" fill={C.muted}><text x="592" y="420">tide {fmt(tide, 2)} m · {night ? 'night rule on' : 'daylight'}</text></g>
      </svg></div>
      {cur && <NctCard cur={cur} gate={gate} tide={tide} dc={dc} />}
    </div>
  );
});

// ------------------------------------------------------------------ Hamburg: real map of the Elbe and the terminals (Leaflet, OpenStreetMap)
const TERM_C = { CTB: '#4aa3ff', CTH: '#c58cff', CTT: '#ffb224', CTA: '#5ef2c8' };
const SEA_EXIT = [54.06, 7.85];
const mxy = (p) => [p[1] * 111320 * Math.cos((p[0] * Math.PI) / 180), p[0] * 110540];
const TILE_OSM = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }];
const TILE_SEA = ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { pane: 'sea', maxZoom: 18, attribution: 'sea marks &copy; <a href="https://www.openseamap.org">OpenSeaMap</a>' }];
function useBaseMap(box, Lf, bounds, draw, deps) {           // one Leaflet map: OSM base (darkened in CSS), OpenSeaMap marks, then the site's own layers
  const map = useRef(null), mk = useRef({});
  useEffect(() => {
    if (!Lf || !box.current || map.current) return undefined;
    const m = Lf.map(box.current, { scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true }).fitBounds(bounds);
    Lf.tileLayer(...TILE_OSM).addTo(m);
    m.createPane('sea'); m.getPane('sea').style.zIndex = 250; m.getPane('sea').style.pointerEvents = 'none';
    Lf.tileLayer(...TILE_SEA).addTo(m);
    draw(m);
    m.on('click', () => m.scrollWheelZoom.enable());           // the wheel zooms only after a click, so the page still scrolls
    map.current = m;
    return () => { m.remove(); map.current = null; mk.current = {}; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { map, mk };
}
function syncShips(Lf, map, mk, ships, sel, onSel) {           // create or move one marker per ship; markers of ships gone from view are removed
  const m = map.current; if (!m || !Lf) return;
  const keep = new Set();
  for (const x of ships) {
    keep.add(x.id); const c = x.fixed ? '#8aa0b3' : PHASE_C[x.s.phase], on = x.id === sel, html = shipSvg(c, x.s.ang, on);
    let e = mk.current[x.id];
    if (!e) {
      e = { m: Lf.marker(x.s.p, { icon: Lf.divIcon({ className: 'pf-mk', iconSize: [26, 26], iconAnchor: [13, 13], html }), title: x.id, keyboard: true }).addTo(m), html };
      e.m.on('click', () => !x.fixed && onSel(x.id)); e.m.bindTooltip(x.tip || x.id, { permanent: !x.fixed, direction: 'right', offset: [10, 0], className: 'pf-tip' });
      mk.current[x.id] = e;
    } else e.m.setLatLng(x.s.p);
    if (e.html !== html) { const el = e.m.getElement(); if (el) el.innerHTML = html; e.html = html; }
    const el = e.m.getElement(); if (el) el.style.opacity = String(x.s.fade ?? 1);
  }
  for (const [id, e] of Object.entries(mk.current)) if (!keep.has(id)) { e.m.remove(); delete mk.current[id]; }
}
const segM = (a, b) => Math.hypot(mxy(b)[0] - mxy(a)[0], mxy(b)[1] - mxy(a)[1]);
function along(path, f) {                                     // point and heading at fraction f of a lat/lon polyline
  const L = []; let tot = 0; for (let i = 1; i < path.length; i++) { tot += segM(path[i - 1], path[i]); L.push(tot); }
  const d = clamp(f, 0, 1) * tot; let i = 0; while (i < L.length - 1 && L[i] < d) i++;
  const a = path[i], b = path[i + 1] || path[i], d0 = i ? L[i - 1] : 0, k = L[i] > d0 ? (d - d0) / (L[i] - d0) : 0;
  const A = mxy(a), B = mxy(b);
  return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], ang: Math.atan2(B[0] - A[0], B[1] - A[1]) };
}
function quayOf(quays, axisM) { return Object.values(quays).find((q) => axisM >= q.axis_lo && axisM < q.axis_hi + 1) || Object.values(quays)[0]; }
function berthPoint(quays, axisStart, len) {
  const q = quayOf(quays, axisStart), line = q.line; let tot = 0; for (let i = 1; i < line.length; i++) tot += segM(line[i - 1], line[i]);
  const s = along(line, (axisStart - q.axis_lo + len / 2) / tot);
  return { q, p: s.p, ang: s.ang };
}
function hamPath(data, v, q) {                                  // inbound route: from the ship's river position (if any) up the Elbe to its terminal
  const route = data.live.elbe_route, inRiver = v && v.lat != null && v.lon > route[0][1] && v.lon < route[route.length - 1][1] && /ELBE|ESTUARY/.test(v.area || '');
  const pts = inRiver ? [[v.lat, v.lon], ...route.filter((p) => p[1] > v.lon)] : route;
  return [...pts, ...q.approach];
}
function hamShipAt(data, row, v, t, idx, T) {
  const bp = berthPoint(data.live.quays, row.berth_start_m, row.berth_end_m - row.berth_start_m), path = [...hamPath(data, v, bp.q), bp.p];
  const hold = [54.03 + 0.035 * (idx % 3), 7.98 - 0.11 * Math.floor(idx / 3)];
  if (t < row.eta_hr) {
    const o = v && v.lat != null && !/ELBE|ESTUARY|PORT/.test(v.area || '') ? [v.lat, v.lon] : hold, k = row.eta_hr > 0 ? t / row.eta_hr : 1;
    return { phase: 'INBOUND', p: [o[0] + (hold[0] - o[0]) * k, o[1] + (hold[1] - o[1]) * k], ang: Math.atan2(hold[1] - o[1], hold[0] - o[0]), text: `Inbound, ${fmt(row.eta_hr - t, 0)} h to the Elbe` };
  }
  if (t < row.transit_in_hr) return { phase: 'ANCHOR', p: hold, ang: 1.6, text: `Waiting off Elbe-1, passage starts in ${fmt(row.transit_in_hr - t, 0)} h` };
  if (t < row.berth_start_hr) { const s = along(path, (t - row.transit_in_hr) / T); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'On the Elbe, inbound' }; }
  if (t < row.tidal_depart_hr) return { phase: 'BERTH', p: bp.p, ang: bp.ang, text: t < row.cargo_done_hr ? `Working cargo with ${row.assigned_qcs} quay cranes` : 'Cargo complete, waiting for the tide' };
  const out = [bp.p, ...[...bp.q.approach].reverse(), ...[...data.live.elbe_route].reverse(), SEA_EXIT];
  if (t < row.tidal_depart_hr + T) { const s = along(out, (t - row.tidal_depart_hr) / T * 0.93); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'On the Elbe, outbound' }; }
  const u = (t - row.tidal_depart_hr - T) / 6;
  return u < 1 ? { ...along(out, 0.93 + 0.07 * u), phase: 'SAILED', text: 'Sailed', fade: 1 - u } : null;
}
const shipSvg = (c, ang, selOn) => `<svg viewBox="-13 -13 26 26" width="26" height="26" style="overflow:visible"><g transform="rotate(${((ang * 180) / Math.PI).toFixed(0)})"><path d="M0,-10 L5,7 L0,3.6 L-5,7 Z" fill="${c}" stroke="${selOn ? '#fff' : '#05090d'}" stroke-width="${selOn ? 1.6 : 1}"/></g></svg>`;

const ElbeMap = React.memo(function ElbeMap({ data, site, schedule, t, sel, onSel }) {
  const box = useRef(null), [zoomed, setZoomed] = useState('river');
  const T = data.config.transit_hrs, Lf = typeof window !== 'undefined' ? window.L : null;
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const { map, mk } = useBaseMap(box, Lf, [[53.47, 7.85], [54.1, 10.0]], (m) => {
    Lf.polyline(data.live.elbe_route, { color: '#5ef2c8', weight: 1.4, opacity: 0.55, dashArray: '6 6' }).addTo(m);
    Object.values(data.live.quays).forEach((q) => Lf.polyline(q.line, { color: TERM_C[q.terminal], weight: 6, opacity: 0.9 }).addTo(m).bindTooltip(`${q.id} · ${q.name} · ${fmt(q.length_m, 0)} m`, { sticky: true }));
    (data.live.gauges || []).forEach((g) => { const pos = GAUGE_LL[g.name]; if (pos) Lf.circleMarker(pos, { radius: 3.5, color: '#4aa3ff', weight: 1, fillOpacity: 1 }).addTo(m).bindTooltip(`${g.name} gauge, Elbe km ${g.km}`); });
  }, [data, Lf]);
  const ships = [
    ...schedule.map((r) => ({ id: r.vessel_id, r, v: vmap[r.vessel_id], s: hamShipAt(data, r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })),
    ...(data.live.fixed_occupants || []).map((f) => { const r = { vessel_id: f.name, berth_start_m: f.berth_start_m, berth_end_m: f.berth_start_m + Math.ceil(f.loa_m), eta_hr: -99, transit_in_hr: -98, berth_start_hr: -97, cargo_done_hr: f.release_hr, tidal_depart_hr: f.release_hr, assigned_qcs: 0 };
      return { id: f.name, r, v: f, fixed: true, s: hamShipAt(data, r, f, t, 0, T) }; }),
  ].filter((x) => x.s);
  useEffect(() => syncShips(Lf, map, mk, ships, sel, onSel));
  const go = (w) => { const m = map.current; if (!m) return; setZoomed(w); m.flyToBounds(w === 'port' ? [[53.493, 9.895], [53.545, 9.965]] : [[53.47, 7.85], [54.1, 10.0]], { duration: 0.8 }); };
  const cur = ships.find((x) => x.id === sel && !x.fixed), hr = Math.floor(t), gate = cur && site.gateNow(sel, hr);
  return (
    <div>
      <div className="pf-seg" style={{ marginBottom: 6 }}><button className={`pf-btn${zoomed === 'river' ? ' on' : ''}`} onClick={() => go('river')}>Elbe, sea to port</button><button className={`pf-btn${zoomed === 'port' ? ' on' : ''}`} onClick={() => go('port')}>Terminals</button>
        {Object.entries(TERM_C).map(([k, c]) => <span key={k} className="pf-key" style={{ '--c': c, marginLeft: 6 }}><i />{k}</span>)}</div>
      {Lf ? <div ref={box} className="pf-map" role="application" aria-label="Map of the Elbe from the North Sea to the Hamburg container terminals with each ship at its planned position" /> : <div className="pf-map pf-read">The map library did not load; the plan is still in the berth chart and the table below.</div>}
      {cur && (
        <div className="pf-card">
          <h3>{cur.id}<span style={{ color: PHASE_C[cur.s.phase] }}>{cur.s.text}</span></h3>
          <dl>
            <div><dt>IMO / MMSI</dt><dd className="num">{cur.v.imo} / {cur.v.mmsi}</dd></div>
            <div><dt>Length × beam</dt><dd className="num">{fmt(cur.v.loa_m, 0)} × {fmt(cur.v.beam_m, 0)} m</dd></div>
            <div><dt>Draught</dt><dd className="num">{cur.v.draught_reported_m == null ? 'not reported' : `${fmt(cur.v.draught_reported_m)} m on AIS`}{cur.v.tide_dependent ? ', tide-dependent on the Elbe' : ', tide-independent'}</dd></div>
            <div><dt>Terminal</dt><dd>{data.live.terminals[cur.v.terminal]} ({cur.v.terminal_basis})</dd></div>
            <div><dt>Last AIS</dt><dd>{cur.v.ais_time_utc ? `${cur.v.ais_time_utc.slice(5, 16).replace('T', ' ')}Z, ${cur.v.sog_kn ?? '—'} kn` : 'no position kept'}</dd></div>
            <div><dt>Elbe gate now</dt><dd style={{ color: gate ? C.ok : C.red }}>{gate ? 'open' : `shut: needs ${fmt(cur.r.tide_needed_m)} m above mean low water plus the forecast error`}</dd></div>
            <div><dt>Berth</dt><dd className="num">{berthLabel(data, cur.r)}, {cur.r.assigned_qcs} quay cranes</dd></div>
            <div><dt>Arrival basis</dt><dd>{cur.v.eta_basis}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
});
// ------------------------------------------------------------------ Chattogram: real map of the Bay of Bengal, the outer anchorage and the Karnaphuli (Leaflet, OpenStreetMap)
// Quay lines are the water side of the OpenStreetMap quay outlines (way 1074952516 for NCT, 1074952517 for CCT and the general
// cargo berths); the river line is OSM's Karnaphuli centre line. Which end of the NCT quay holds the barge berth is not published:
// the planner's 0-1000 m axis is laid on the northern 1,000 m of the outline, barge berth upstream.
const NCT_LINE = [[22.28917, 91.79354], [22.29073, 91.79363], [22.29242, 91.79369], [22.29334, 91.79386], [22.29525, 91.79427], [22.29738, 91.79478], [22.29785, 91.7949], [22.29829, 91.7951], [22.29927, 91.79561], [22.30175, 91.79674]];
const CCT_LINE = [[22.30332, 91.79751], [22.30486, 91.7986], [22.30609, 91.79953], [22.30754, 91.80096], [22.30918, 91.80284], [22.31084, 91.80517], [22.31271, 91.80779], [22.31412, 91.80983], [22.31529, 91.81145], [22.31639, 91.81299]];
const KARNAPHULI = [[22.2249, 91.80495], [22.24215, 91.82622], [22.24493, 91.82969], [22.25606, 91.83605], [22.26039, 91.83707], [22.26485, 91.83635], [22.268, 91.83321], [22.2705, 91.82876], [22.27148, 91.8196], [22.27287, 91.81295], [22.27483, 91.80756], [22.27699, 91.80365], [22.28003, 91.79987], [22.28354, 91.79733], [22.28708, 91.79612]];
const SEA_BUOY = [22.19, 91.77], BAY_ENTRY = [21.0, 91.55];
const ROUTE_SG = [[1.25, 103.85], [2.6, 101.4], [4.2, 99.8], [5.9, 97.6], [6.0, 94.6], BAY_ENTRY];
const ROUTE_CMB = [[6.95, 79.85], [5.85, 80.6], BAY_ENTRY];
const CTG_VIEWS = { bay: [[0.5, 78.5], [23.2, 104.5]], approach: [[21.55, 91.25], [22.45, 92.05]], port: [[22.22, 91.765], [22.32, 91.845]] };
const lineLen = (line) => { let s = 0; for (let i = 1; i < line.length; i++) s += segM(line[i - 1], line[i]); return s; };
const NCT_LEN = lineLen(NCT_LINE);
const nctPoint = (axisM) => along(NCT_LINE, (NCT_LEN - 1000 + clamp(axisM, 0, 1000)) / NCT_LEN);
function seaPath(v) {                                           // from where the ship is (AIS) or its last port (schedule) to the Bay entry
  if (v && v.lat != null) {
    const { lat, lon } = v;
    const ahead = lon >= 97 && lat < 6.5 ? ROUTE_SG.filter((p) => p[1] < lon) : lon >= 94 && lat < 6.5 ? [[6.0, 94.6], BAY_ENTRY] : lon < 82 && lat < 10 ? (lon < 80.6 ? [[5.85, 80.6], BAY_ENTRY] : [BAY_ENTRY]) : [];
    return { path: [[lat, lon], ...ahead], live: true };
  }
  return { path: /Colombo/.test((v && v.last_port) || '') ? ROUTE_CMB : ROUTE_SG, live: false };
}
function ctgShipAt(row, v, t, idx, T) {
  const slot = [22.035 + 0.032 * (idx % 3), 91.665 + 0.038 * (Math.floor(idx / 3) % 3)];
  const bp = nctPoint((row.berth_start_m + row.berth_end_m) / 2), sea = seaPath(v), inbound = [...sea.path, slot];
  if (t < row.eta_hr) {
    const k0 = sea.live ? 0 : START_K[(v && v.area) || ''] ?? 0.2, k = k0 + (1 - k0) * (row.eta_hr > 0 ? t / row.eta_hr : 1), s = along(inbound, k);
    return { phase: 'INBOUND', p: s.p, ang: s.ang, text: `Inbound, ${fmt(row.eta_hr - t, 0)} h to the anchorage` };
  }
  if (t < row.transit_in_hr) return { phase: 'ANCHOR', p: slot, ang: 0.6, text: `At anchor, pilot booked in ${fmt(row.transit_in_hr - t, 0)} h` };
  const river = [slot, SEA_BUOY, ...KARNAPHULI, bp.p];
  if (t < row.berth_start_hr) { const s = along(river, (t - row.transit_in_hr) / T); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'Under pilotage, inbound on the Karnaphuli' }; }
  if (t < row.tidal_depart_hr) return { phase: 'BERTH', p: bp.p, ang: bp.ang, text: t < row.cargo_done_hr ? `Working cargo with ${row.assigned_qcs} quay cranes` : 'Cargo complete, holding for tide or daylight' };
  const out = [...river].reverse();
  if (t < row.tidal_depart_hr + T) { const s = along(out, (t - row.tidal_depart_hr) / T); return { phase: 'CHANNEL', p: s.p, ang: s.ang, text: 'Under pilotage, outbound' }; }
  const u = (t - row.tidal_depart_hr - T) / 10;
  return u < 1 ? { ...along([slot, BAY_ENTRY], u), phase: 'SAILED', text: 'Sailed', fade: 1 - u } : null;
}

const KarnaphuliMap = React.memo(function KarnaphuliMap({ data, site, schedule, t, sel, onSel, tide }) {
  const box = useRef(null), [zoomed, setZoomed] = useState('bay');
  const T = data.config.transit_hrs, Lf = typeof window !== 'undefined' ? window.L : null;
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);
  const order = useMemo(() => [...schedule].sort((a, b) => a.eta_hr - b.eta_hr).map((r) => r.vessel_id), [schedule]);
  const { map, mk } = useBaseMap(box, Lf, CTG_VIEWS.bay, (m) => {
    [ROUTE_SG, ROUTE_CMB].forEach((r) => Lf.polyline([...r, [22.08, 91.7]], { color: '#4aa3ff', weight: 1.2, opacity: 0.45, dashArray: '4 7' }).addTo(m));
    Lf.rectangle([[22.02, 91.645], [22.13, 91.775]], { color: '#ffb224', weight: 1, opacity: 0.6, fill: false, dashArray: '3 4' }).addTo(m).bindTooltip('Outer anchorage (approximate)');
    Lf.polyline([SEA_BUOY, ...KARNAPHULI, NCT_LINE[NCT_LINE.length - 1]], { color: '#5ef2c8', weight: 1.4, opacity: 0.6, dashArray: '6 6' }).addTo(m).bindTooltip('Karnaphuli channel (OpenStreetMap river line)');
    const n0 = (NCT_LEN - 1000) / NCT_LEN, n820 = (NCT_LEN - 180) / NCT_LEN, part = (a, b) => Array.from({ length: 25 }, (_, i) => along(NCT_LINE, a + ((b - a) * i) / 24).p);
    Lf.polyline(part(n0, n820), { color: '#5ef2c8', weight: 6, opacity: 0.95 }).addTo(m).bindTooltip('NCT ocean quay, 0-820 m on the plan axis', { sticky: true });
    Lf.polyline(part(n820, 1), { color: '#8097a9', weight: 6, opacity: 0.9 }).addTo(m).bindTooltip('NCT barge berth, 820-1000 m (not planned)', { sticky: true });
    Lf.polyline(CCT_LINE, { color: '#3a4b5b', weight: 6, opacity: 0.9 }).addTo(m).bindTooltip('CCT and general cargo berths (not modelled)', { sticky: true });
    if (data.live.tide_detail) Lf.circleMarker([22.208, 91.792], { radius: 4, color: '#4aa3ff', weight: 1, fillOpacity: 1 }).addTo(m).bindTooltip('Open-Meteo sea-level grid cell used for the tide forecast');
  }, [data, Lf]);
  const ships = [
    ...schedule.map((r) => ({ id: r.vessel_id, r, v: vmap[r.vessel_id], s: ctgShipAt(r, vmap[r.vessel_id], t, order.indexOf(r.vessel_id), T) })),
    ...(data.live.fixed_occupants || []).map((f) => { const r = { vessel_id: f.name, berth_start_m: f.berth_start_m, berth_end_m: f.berth_start_m + Math.ceil(f.loa_m), eta_hr: -99, transit_in_hr: -98, berth_start_hr: -97, cargo_done_hr: f.release_hr, tidal_depart_hr: f.release_hr, assigned_qcs: 0 };
      return { id: f.name, r, v: f, fixed: true, tip: `${f.name} (alongside)`, s: ctgShipAt(r, f, t, 0, T) }; }),
    ...(data.live.also_in_port_not_modelled || []).map((o, i) => { const s = along(CCT_LINE, 0.25 + 0.3 * i); return { id: o.name, v: o, fixed: true, tip: `${o.name}: in port, terminal not published, not in the plan`, s: { ...s, phase: 'BERTH' } }; }),
  ].filter((x) => x.s);
  useEffect(() => syncShips(Lf, map, mk, ships, sel, onSel));
  const go = (w) => { const m = map.current; if (!m) return; setZoomed(w); m.flyToBounds(CTG_VIEWS[w], { duration: 0.8 }); };
  const cur = ships.find((x) => x.id === sel && !x.fixed), dc = cur && (data.draught_check || []).find((d) => d.vessel === sel);
  const hr = Math.floor(t), gate = cur && site.transitOk(hr, cur.r.loa_m, cur.r.draft_m);
  return (
    <div>
      <div className="pf-seg" style={{ marginBottom: 6 }}>
        {[['bay', 'Bay of Bengal'], ['approach', 'Approach and anchorage'], ['port', 'Karnaphuli and NCT']].map(([k, l]) => <button key={k} className={`pf-btn${zoomed === k ? ' on' : ''}`} onClick={() => go(k)}>{l}</button>)}
      </div>
      {Lf ? <div ref={box} className="pf-map" role="application" aria-label="Map of the Bay of Bengal, the Chattogram outer anchorage and the Karnaphuli river to the NCT quay, with each ship at its planned position" /> : <div className="pf-map pf-read">The map library did not load; the plan is still in the berth chart and the table below.</div>}
      {cur && <NctCard cur={cur} gate={gate} tide={tide} dc={dc} />}
    </div>
  );
});

const GAUGE_LL = { 'CUXHAVEN STEUBENHÖFT': [53.8677, 8.7174], 'BRUNSBÜTTEL MPM': [53.8878, 9.1487], 'GLÜCKSTADT': [53.7844, 9.4094], 'STADERSAND': [53.6297, 9.5266], 'SCHULAU': [53.5679, 9.7029], 'HAMBURG ST. PAULI': [53.5454, 9.97] };
function berthLabel(data, r) {
  if (!data.live.quays) return `${r.berth_start_m}–${r.berth_end_m} m`;
  const q = quayOf(data.live.quays, r.berth_start_m);
  return `${q.id} ${fmt(r.berth_start_m - q.axis_lo, 0)}–${fmt(r.berth_end_m - q.axis_lo, 0)} m`;
}

// ------------------------------------------------------------------ berth Gantt with tide strip
const G0 = { L: 64, R: 12, W: 1180, tideTop: 14, tideH: 62, top: 96, H: 250 };
const Gantt = React.memo(function Gantt({ data, site, schedule, ghost, t, sel, onSel, tMax }) {
  const quays = data.live.quays ? Object.values(data.live.quays) : null, AX = quays ? data.config.quay_ocean_m : 1000, G = quays ? { ...G0, L: 92, H: 380 } : G0;
  const tMaxTide = Math.max(4.2, ...data.tide_hourly.slice(0, data.config.horizon_hrs + 1)) * 1.04;
  const cfg = data.config, H = cfg.horizon_hrs, px = (G.W - G.L - G.R) / H, x = (h) => G.L + h * px, y = (m) => G.top + (m / AX) * G.H, ty = (v) => G.tideTop + G.tideH - (v / tMaxTide) * G.tideH;
  const ep = Number(data.live.plan_epoch_local.slice(11, 13));
  const nights = []; for (let h = 0; h < H; h++) { const c = site.clock(h), n = !(c >= cfg.daylight_hours[0] && c < cfg.daylight_hours[1]); if (n && (h === 0 || nights.length === 0 || nights[nights.length - 1][1] !== h)) nights.push([h, h + 1]); else if (n) nights[nights.length - 1][1] = h + 1; }
  const days = []; for (let h = (24 - ep) % 24; h <= H; h += 24) days.push(h);
  const s = schedule.find((r) => r.vessel_id === sel), need = s ? s.tide_needed_m : quays ? 0 : cfg.max_draught_m + cfg.ukc_m - cfg.channel_depth_m;
  const open = []; for (let h = 0; h < H; h++) if (quays ? s && site.gateNow(s.vessel_id, h) : site.transitOk(h, s ? s.loa_m : 185, s ? s.draft_m : cfg.max_draught_m)) open.push(h);
  const tidePath = data.tide_hourly.slice(0, H + 1).map((v, h) => `${h ? 'L' : 'M'}${x(h).toFixed(1)},${ty(v).toFixed(1)}`).join(' ');
  const hgt = (m) => (m / AX) * G.H;
  return (
    <div className="pf-scroll">
      <svg viewBox={`0 0 ${G.W} ${G.top + G.H + 30}`} style={{ display: 'block', width: '100%', minWidth: 860 }} role="img" aria-label="Berth plan: quay position against time, with the tide curve and night bands">
        <defs><pattern id="hold" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#132a3c" /><rect width="2.5" height="6" fill="#3b6a8f" /></pattern></defs>
        {nights.map(([a, b]) => <rect key={a} x={x(a)} y={G.tideTop} width={(b - a) * px} height={G.top + G.H - G.tideTop} fill="#000" opacity=".42" />)}
        {days.map((h) => { const c = planClock(data.live.plan_epoch_local, h); return <g key={h}><line x1={x(h)} x2={x(h)} y1={G.tideTop} y2={G.top + G.H} stroke={C.line} /><text x={x(h) + 4} y={G.top + G.H + 14} fontSize="10" fill={C.muted}>{c.day} {c.date}</text></g>; })}
        <text x={G.L - 6} y={G.tideTop + 8} fontSize="9.5" fill={C.muted} textAnchor="end">{quays ? 'm > MLW' : 'tide m'}</text>
        {[1, 2, 3, ...(tMaxTide > 4.6 ? [4] : [])].map((v) => <text key={v} x={G.L - 6} y={ty(v) + 3} fontSize="9" fill={C.muted} textAnchor="end">{v}</text>)}
        <path d={`${tidePath} L${x(H)},${ty(0)} L${x(0)},${ty(0)} Z`} fill="rgba(74,163,255,.14)" /><path d={tidePath} fill="none" stroke={C.blue} strokeWidth="1.3" />
        {need > 0 && <line x1={x(0)} x2={x(H)} y1={ty(need)} y2={ty(need)} stroke={C.amber} strokeDasharray="4 3" />}
        <text x={x(H) - 4} y={ty(Math.max(need, 0.15)) - 3} fontSize="9.5" fill={C.amber} textAnchor="end">{quays ? (s ? (need > 0 ? `${s.vessel_id} needs ${fmt(need)} m above mean low water on the river, plus the forecast error` : `${s.vessel_id} is tide-independent`) : 'select a ship') : `${s ? `${s.vessel_id} needs` : `${fmt(cfg.max_draught_m)} m draught needs`} ${fmt(need)} m of tide`}</text>
        {open.map((h) => <rect key={h} x={x(h)} y={G.tideTop + G.tideH + 5} width={px} height="5" fill={C.ok} />)}
        <text x={G.L - 6} y={G.tideTop + G.tideH + 11} fontSize="9" fill={C.ok} textAnchor="end">gate open</text>
        <rect x={x(0)} y={y(0)} width={H * px} height={G.H} fill="none" stroke={C.hi} />
        {quays ? <>
          {quays.map((q, i) => <g key={q.id}>{i > 0 && <rect x={x(0)} y={y(q.axis_lo - 200)} width={H * px} height={hgt(200)} fill="#05090d" />}
            <line x1={x(0)} x2={x(H)} y1={y(q.axis_lo)} y2={y(q.axis_lo)} stroke={C.hi} /><rect x={G.L - 5} y={y(q.axis_lo)} width="3" height={hgt(q.length_m)} fill={TERM_C[q.terminal]} />
            <text x={G.L - 9} y={y((q.axis_lo + q.axis_hi) / 2) + 3} fontSize="10" fill={C.ink} textAnchor="end">{q.id}</text><text x={G.L - 9} y={y((q.axis_lo + q.axis_hi) / 2) + 14} fontSize="8.5" fill={C.muted} textAnchor="end">{fmt(q.length_m, 0)} m</text></g>)}
        </> : <>
          <rect x={x(0)} y={y(cfg.quay_ocean_m)} width={H * px} height={y(1000) - y(cfg.quay_ocean_m)} fill="#0b141c" /><text x={x(0) + 6} y={y(910) + 4} fontSize="10" fill={C.muted}>barge berth 820–1000 m: river barges, not planned here</text>
          {[0, 205, 410, 615, 820, 1000].map((m) => <g key={m}><line x1={x(0)} x2={x(H)} y1={y(m)} y2={y(m)} stroke={C.line} /><text x={G.L - 6} y={y(m) + 3} fontSize="9.5" fill={C.muted} textAnchor="end">{m} m</text></g>)}
        </>}
        {(data.live.fixed_occupants || []).map((fx) => <g key={fx.name}><rect x={x(0)} y={y(fx.berth_start_m)} width={Math.max(0, Math.min(fx.release_hr, H)) * px} height={hgt(fx.loa_m)} fill="#27333e" stroke="#3a4b5b" />
          <text x={x(0) + 4} y={y(fx.berth_start_m) + Math.min(13, hgt(fx.loa_m) - 2)} fontSize="9.5" fill={C.muted}>{fx.name} (alongside)</text><title>{`${fx.name}: ${fx.status}${fx.release_basis ? `; leaves about hour ${fx.release_hr} (${fx.release_basis})` : ''}`}</title></g>)}
        {ghost && ghost.map((r) => <rect key={`g${r.vessel_id}`} x={x(r.berth_start_hr)} y={y(r.berth_start_m)} width={(r.tidal_depart_hr - r.berth_start_hr) * px} height={hgt(r.berth_end_m - r.berth_start_m)} fill="none" stroke={C.red} strokeDasharray="4 3" opacity=".8" />)}
        {schedule.map((r) => { const w = (r.tidal_depart_hr - r.berth_start_hr) * px, cw = (r.cargo_done_hr - r.berth_start_hr) * px, h = hgt(r.berth_end_m - r.berth_start_m), on = r.vessel_id === sel;
          return (
            <g key={r.vessel_id} className="pf-gbar" style={{ transform: `translate(${x(r.berth_start_hr)}px,${y(r.berth_start_m)}px)` }} onClick={() => onSel(r.vessel_id)}>
              <rect width={w} height={h} fill="url(#hold)" /><rect width={cw} height={h} fill={on ? '#2b8f86' : '#2f6f9f'} />
              <rect width={w} height={h} fill="none" stroke={on ? '#fff' : '#7fb6e0'} strokeWidth={on ? 1.6 : 0.8} />
              <line x1={-data.config.transit_hrs * px} x2="0" y1={h / 2} y2={h / 2} stroke={C.tele} strokeWidth="2" /><line x1={w} x2={w + data.config.transit_hrs * px} y1={h / 2} y2={h / 2} stroke={C.tele} strokeWidth="2" />
              <text x="5" y={Math.min(14, h - 2)} fontSize="10.5" fill="#fff">{r.vessel_id}</text>{h > 30 && <text x="5" y="27" fontSize="9.5" fill="#cfe3f2">{r.assigned_qcs} {quays ? 'STS' : 'QGC'} · {r.moves} moves{r.anchorage_wait_hrs > 0 ? ` · waited ${r.anchorage_wait_hrs} h` : ''}</text>}
              <title>{`${r.vessel_id}: berth ${berthLabel(data, r)}, alongside hour ${r.berth_start_hr}, cargo done hour ${r.cargo_done_hr}, sails hour ${r.tidal_depart_hr} (held ${r.tide_departure_hold_hrs} h for tide${quays ? '' : ' or daylight'}), ${r.assigned_qcs} cranes, ${r.moves} moves`}</title>
            </g>
          ); })}
        <g style={{ transform: `translateX(${x(Math.min(t, tMax))}px)` }}><line y1={G.tideTop} y2={G.top + G.H} stroke={C.tele} strokeWidth="1.4" /><path d={`M-5,${G.tideTop - 8} L5,${G.tideTop - 8} L0,${G.tideTop} Z`} fill={C.tele} /></g>
      </svg>
    </div>
  );
});

// ------------------------------------------------------------------ CSS-3D yard
const Y3 = { U: 21, V: 22, H: 15, G: 1 };
const FACE = { 1: ['#2fbf8f', '#1e8a67', '#15634a'], 2: ['#e0a52a', '#a6781a', '#7a5812'], 3: ['#e2584f', '#a63d37', '#7a2c28'], 4: ['#5d7388', '#44566a', '#33414f'] };
const CH_NAME = { 1: 'green channel', 2: 'yellow channel', 3: 'red channel', 4: 'inherited stock, channel not in the manifest' };
const IMDG_NAME = { 1: 'IMDG class 3', 2: 'IMDG class 2.1', 3: 'IMDG class 5.1' };
export function yardState(Y, nMoves) {
  const map = new Map();
  Y.yard_tensor_before.forEach((rows, b) => rows.forEach((col, r) => col.forEach((d, t) => { if (d > 0) map.set(`${b}-${r}-${t}`, { id: `${b}-${r}-${t}`, b, r, t, d, ch: Y.yard_channel_before[b][r][t], im: Y.yard_imdg_before[b][r][t], moved: false }); })));
  Y.premarshal_moves.slice(0, nMoves).forEach(([b1, r1, t1, b2, r2, t2]) => { const k = `${b1 - 1}-${r1 - 1}-${t1 - 1}`, x = map.get(k); if (!x) return; map.delete(k); map.set(`${b2 - 1}-${r2 - 1}-${t2 - 1}`, { ...x, b: b2 - 1, r: r2 - 1, t: t2 - 1, moved: true }); });
  const boxes = [...map.values()], stacks = {};
  boxes.forEach((x) => { (stacks[`${x.b}-${x.r}`] = stacks[`${x.b}-${x.r}`] || [])[x.t] = x; });
  let blocking = 0;
  Object.values(stacks).forEach((st) => { let min = Infinity; st.forEach((x) => { x.blocking = x.d > min; x.under = x.blocking ? min : null; if (x.blocking) blocking++; min = Math.min(min, x.d); }); });
  boxes.forEach((x) => { x.top = !map.has(`${x.b}-${x.r}-${x.t + 1}`); x.south = !map.has(`${x.b}-${x.r + 1}-${x.t}`); x.east = !map.has(`${x.b + 1}-${x.r}-${x.t}`); });
  return { boxes: boxes.sort((a, b) => (a.id < b.id ? -1 : 1)), blocking };
}
const Yard3D = React.memo(function Yard3D({ boxes, onlyBlocking, onHover, dropKey }) {
  const ref = useRef(null), [w, setW] = useState(900), fit = Math.min(1.2, w / 900);
  useEffect(() => { const el = ref.current; if (!el) return undefined; const m = () => setW(el.clientWidth || 900); m(); if (typeof ResizeObserver === 'undefined') return undefined; const ro = new ResizeObserver(m); ro.observe(el); return () => ro.disconnect(); }, []);
  const W = 40 * Y3.U, D = 6 * Y3.V;
  return (
    <div ref={ref} className="y3-stage" style={{ height: 380 * fit }} role="img" aria-label="Three-dimensional view of one yard block, 40 bays by 6 rows by 5 tiers">
      <div className="y3-fit" style={{ transform: `translateX(${(w - 900 * fit) / 2}px) scale(${fit})` }}>
        <div key={dropKey} className="y3-scene" style={{ width: W, height: D, backgroundSize: `${Y3.U}px ${Y3.V}px` }}>
          {boxes.map((x) => { const f = FACE[x.ch] || FACE[4];
            return (
              <div key={x.id} className={`y3-box${x.blocking ? ' hz' : ''}${x.im ? ' im' : ''}${x.moved ? ' mv' : ''}${onlyBlocking && !x.blocking ? ' dim' : ''}`} onMouseEnter={() => onHover(x)} onMouseLeave={() => onHover(null)}
                style={{ left: x.b * Y3.U + Y3.G, top: x.r * Y3.V + Y3.G, width: Y3.U - 2 * Y3.G, height: Y3.V - 2 * Y3.G, '--z': `${x.t * Y3.H}px`, '--h': `${Y3.H - 1}px`, '--dl': `${(x.t * 0.16 + x.b * 0.012).toFixed(2)}s`, '--c0': f[0], '--c1': f[1], '--c2': f[2] }}>
                {x.south && <i className="s" />}{x.east && <i className="e" />}{(x.top || x.blocking) && <i className="t" />}
              </div>
            ); })}
          {[1, 10, 20, 30, 40].map((n) => <span key={n} style={{ position: 'absolute', left: (n - 1) * Y3.U + 2, top: D + 14, color: C.muted, fontSize: 11 }}>B{pad(n)}</span>)}
        </div>
      </div>
    </div>
  );
});

// ------------------------------------------------------------------ copilot: text -> structured actions
const RULES = (vessels, sc, k, t, HH) => `You are the command parser for a container-terminal planning engine at ${HH ? 'the Port of Hamburg (terminals CTB Burchardkai, CTH Eurogate, CTT Tollerort, CTA Altenwerder; ships come up the Elbe)' : 'Chattogram NCT'}. Turn the operator's message into JSON only, no prose around it:
{"actions":[...],"reply":"one or two plain sentences"}
Action types (use only these):
{"type":"delay","vessel":"<exact name>","hours":<int>}  a ship arrives later (negative = earlier)
{"type":"qgc_out","count":<int>,"start_hr":<int>,"hours":<int>${HH ? ',"terminal":"CTB|CTH|CTT|CTA"' : ''}}  quay cranes out of service; a named crane such as QGC-03 is count 1; the engine models the pool, not individual cranes${HH ? '; terminal defaults to CTB' : ''}
{"type":"rtg_out","count":<int 1-6>,"hours":<int>}  yard cranes out in the berth's yard cluster
{"type":"icd","pct":<0-60>}  share of boxes evacuated ${HH ? 'by night rail and barge' : 'to off-dock depots'}
{"type":"yard","pct":<40-95>}  yard occupancy at the start
${HH ? '' : '{"type":"tugs","sets":<1-4>}  pilot and tug sets available at once\n'}{"type":"reset"}  back to the nominal plan
Vessels (name, hours until arrival): ${vessels.map((v) => `${v.name} ${v.eta_hr}`).join('; ')}. "The next feeder" or an unnamed incoming ship means the first with hours > 0. Default durations: 24 h for outages, 6 h for delays. start_hr is hours from the plan start; the plan clock now reads hour ${Math.floor(t)}.
Current scenario: ${JSON.stringify(sc)}. Current result: turnaround ${k.turnaround} d, ${HH ? 'wait before the Elbe passage' : 'anchorage wait'} ${k.wait} h, tide hold ${k.hold} h, peak yard ${k.peak}%, backpressure ${k.beta}.
If the message is a question rather than a command, return "actions":[] and answer it in "reply" from the figures above. If it is a command, "reply" restates what you understood in one sentence.`;

const TERM_WORDS = { CTB: /\bctb\b|burchardkai/, CTH: /\bcth\b|eurogate|predöhl|predohl/, CTT: /\bctt\b|tollerort/, CTA: /\bcta\b|altenwerder/ };
function offlineParse(text, vessels, HH) {
  const s = text.toLowerCase(), num = (re, d) => { const m = s.match(re); return m ? Number(m[1]) : d; }, acts = [];
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }, wnum = (re, d) => { const m = s.match(re); return m ? (words[m[1]] ?? Number(m[1])) : d; };
  if (/\breset\b|nominal|start over|clear all/.test(s)) return [{ type: 'reset' }];
  const hrs = num(/(\d+)\s*-?\s*(?:h\b|hr|hour)/, null);
  if (/delay|late|fog|storm|held up|slow/.test(s)) {
    const inbound = vessels.filter((v) => v.eta_hr > 0).sort((a, b) => a.eta_hr - b.eta_hr);
    let names = vessels.filter((v) => v.name.toLowerCase().split(' ').some((w) => w.length > 3 && s.includes(w)) || s.includes(v.name.toLowerCase())).map((v) => v.name);
    if (!names.length) names = inbound.slice(0, wnum(/(\d+|one|two|three|four|five|six)\s+(?:ships|vessels|feeders)/, 1)).map((v) => v.name);
    names.forEach((n) => acts.push({ type: 'delay', vessel: n, hours: hrs ?? 6 }));
  }
  if (/rtg|yard crane/.test(s)) acts.push({ type: 'rtg_out', count: wnum(/(\d+|one|two|three|four|five|six)\s*(?:x\s*)?(?:rtg|yard crane)/, 2), hours: hrs ?? 24 });
  else if (/qgc|quay crane|sts|gantry|crane/.test(s) && /off|out|broke|down|fail|trip/.test(s)) acts.push({ type: 'qgc_out', count: wnum(/(\d+|one|two|three|four|five|six)\s+(?:qgc|quay|crane|sts)/, 1), start_hr: 0, hours: hrs ?? 24, ...(HH ? { terminal: Object.keys(TERM_WORDS).find((k) => TERM_WORDS[k].test(s)) || 'CTB' } : {}) });
  if (/icd|off-?dock|evacuat|depot|rail|barge/.test(s)) acts.push({ type: 'icd', pct: num(/(\d+)\s*%/, /stop|halt|suspend|no off|without|zero|strike|closed/.test(s) ? 0 : 40) });
  else if (/yard|occupan/.test(s) && /%/.test(s)) acts.push({ type: 'yard', pct: num(/(\d+)\s*%/, 86) });
  if (!HH && /tug|pilot/.test(s)) acts.push({ type: 'tugs', sets: wnum(/(\d+|one|two|three|four)\s*(?:pilot|tug|set)/, 1) });
  return acts;
}
const NOMINAL = { etaShift: {}, qgcOutages: [], rtgOutages: [], icd: null, occ: null, tugSets: null };
function applyActions(sc, acts, names, HH, cfg) {
  let n = { ...sc, etaShift: { ...sc.etaShift }, qgcOutages: [...sc.qgcOutages], rtgOutages: [...sc.rtgOutages] }; const said = [];
  for (const a of acts || []) {
    if (a.type === 'reset') { n = { ...NOMINAL, etaShift: {}, qgcOutages: [], rtgOutages: [] }; said.push('nominal scenario restored'); }
    else if (a.type === 'delay' && names.includes(a.vessel)) { const h = clamp(Math.round(a.hours || 6), -24, 96); n.etaShift[a.vessel] = (n.etaShift[a.vessel] || 0) + h; said.push(`${a.vessel} ${h >= 0 ? 'delayed' : 'advanced'} ${Math.abs(h)} h`); }
    else if (a.type === 'qgc_out') {
      const term = HH ? (cfg.crane_pools[a.terminal] ? a.terminal : 'CTB') : null, cap = HH ? cfg.crane_pools[term] - 1 : 13;
      const c = clamp(Math.round(a.count || 1), 1, cap), s0 = clamp(Math.round(a.start_hr || 0), 0, cfg.horizon_hrs - 12), h = clamp(Math.round(a.hours || 24), 1, cfg.horizon_hrs);
      n.qgcOutages.push(HH ? [s0, s0 + h, c, term] : [s0, s0 + h, c]); said.push(`${c} quay crane${c > 1 ? 's' : ''}${HH ? ` at ${term}` : ''} out for ${h} h from hour ${s0}`); }
    else if (a.type === 'rtg_out') { const c = clamp(Math.round(a.count || 2), 1, 6), h = clamp(Math.round(a.hours || 24), 1, 25); for (let i = 0; i < c; i++) n.rtgOutages.push([0, h * 60]); said.push(`${c} yard crane${c > 1 ? 's' : ''} out for ${h} h`); }
    else if (a.type === 'icd') { n.icd = clamp(Number(a.pct), 0, 60) / 100; said.push(`${HH ? 'night rail and barge evacuation' : 'off-dock evacuation'} ${Math.round(n.icd * 100)}%`); }
    else if (a.type === 'yard') { n.occ = clamp(Number(a.pct), 40, 95); said.push(`yard starts ${n.occ}% full`); }
    else if (a.type === 'tugs' && !HH) { n.tugSets = clamp(Math.round(a.sets || 1), 1, 4); said.push(`${n.tugSets} pilot and tug set${n.tugSets > 1 ? 's' : ''}`); }
  }
  return { next: n, said };
}
const scChips = (sc, cfg) => [
  ...Object.entries(sc.etaShift).filter(([, h]) => h).map(([v, h]) => `${v} ${h > 0 ? '+' : ''}${h} h`), ...sc.qgcOutages.map(([a, b, c, q]) => `${c} ${q ? `${q} STS` : 'QGC'} out h${a}–${b}`),
  ...(sc.rtgOutages.length ? [`${sc.rtgOutages.length} RTG out ${sc.rtgOutages[0][1] / 60} h`] : []), ...(sc.icd != null ? [`ICD ${Math.round(sc.icd * 100)}%`] : []), ...(sc.occ != null ? [`yard ${sc.occ}%`] : []), ...(sc.tugSets != null && sc.tugSets !== cfg.pilot_tug_sets ? [`${sc.tugSets} tug sets`] : []),
];
const QUICK = ['Delay the next feeder by 6 hours due to Kutubdia fog', 'Take QGC-03 offline for 24 hours', 'Increase off-dock ICD evacuation to 40%', 'A storm delayed three ships by 12 hours and two yard cranes broke', 'Stop off-dock evacuation', 'Only one pilot and tug set today', 'Reset'];
const QUICK_HH = ['Delay the next ship by 6 hours, fog in the German Bight', 'Take 6 quay cranes at Burchardkai offline for 48 hours', 'Stop night rail and barge evacuation', 'A storm delayed three ships by 12 hours and two yard cranes broke', 'Yard starts 86% full', 'Take 4 cranes at Altenwerder out for 24 hours', 'Reset'];

const SidePanels = React.memo(function SidePanels({ trace, R, cfg, HH }) {
  return (
        <section className="pf-panel s5">
          <div className="pf-head"><div><div className="pf-tag">Yard simulation</div><h2>Occupancy through one shift cycle</h2></div></div>
          <div style={{ height: 190 }}><ResponsiveContainer><LineChart data={trace} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="h" type="number" domain={[0, 24]} ticks={[0, 6, 12, 18, 24]} unit=" h" {...ax} /><YAxis domain={[40, 100]} unit="%" {...ax} />
            <ReferenceArea x1={0} x2={6} fill="#000" fillOpacity={0.35} /><ReferenceLine y={80} stroke={C.red} strokeDasharray="4 3" label={{ value: '80% cliff', fill: C.red, fontSize: 10, position: 'insideTopRight' }} />
            <Tooltip {...tip} formatter={(v, n) => [`${fmt(v)}%`, n === 'now' ? 'this scenario' : HH ? 'no night evacuation' : 'no off-dock evacuation']} labelFormatter={(h) => `${fmt(h)} h into the cycle`} />
            <Line dataKey="none" stroke={C.muted} strokeWidth={1.5} dot={false} isAnimationActive={false} /><Line dataKey="now" stroke={C.tele} strokeWidth={2} dot={false} animationDuration={900} />
          </LineChart></ResponsiveContainer></div>
          <div><span className="pf-key" style={{ '--c': C.tele }}><i />this scenario</span><span className="pf-key" style={{ '--c': C.muted }}><i />{HH ? 'no night rail/barge evacuation' : 'no off-dock evacuation'}</span></div>
          <p className="pf-note">First 6 hours: night shift ({HH ? 'boxes leave by rail and barge' : 'evacuation to depots'}, and grooming). Then the discharge wave. One berth's yard cluster, {cfg.rtg_per_berth_cluster} yard {HH ? 'machines (straddle carriers or stacking cranes)' : 'cranes'}{HH ? '; Hamburg yard figures are assumptions' : ''}.</p>
          <div className="pf-head" style={{ marginTop: 12 }}><div><div className="pf-tag">Reefer power in kW, {R.n_reefers} plugs</div><h2>Evening peak shaved</h2></div></div>
          <div style={{ height: 150 }}><ResponsiveContainer><LineChart data={R.series_30min} margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="hour" type="number" domain={[0, 24]} ticks={[0, 6, 12, 17, 22]} {...ax} /><YAxis domain={['auto', 'auto']} {...ax} width={44} />
            <ReferenceArea x1={17} x2={22} fill={C.amber} fillOpacity={0.1} /><Tooltip {...tip} formatter={(v, n) => [`${fmt(v, 0)} kW`, n === 'smart_kw' ? 'capped' : 'uncontrolled']} labelFormatter={(h) => `${pad(Math.floor(h))}:${pad((h % 1) * 60)}`} />
            <Line dataKey="unmanaged_kw" stroke={C.muted} strokeWidth={1.5} dot={false} isAnimationActive={false} /><Line dataKey="smart_kw" stroke={C.tele} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart></ResponsiveContainer></div>
          <div className="pf-stats">
            <div className="pf-stat"><div className="l">Mean daily peak</div><div className="v num">{fmt(R.unmanaged_peak_demand_kw, 0)} → {fmt(R.smart_shaved_peak_demand_kw, 0)} kW</div></div>
            <div className="pf-stat"><div className="l">Shaved</div><div className="v num" style={{ color: C.ok }}>−{fmt(R.peak_shaved_pct)}%</div></div>
            <div className="pf-stat"><div className="l">Warmest box, 7 days</div><div className="v num">{fmt(R.max_box_temp_degC, 2)} °C</div></div>
            <div className="pf-stat"><div className="l">Cold-chain breaches</div><div className="v num">{R.cold_chain_breaches}</div></div>
          </div>
          <p className="pf-note">Shaded: 17:00–22:00 peak tariff window. Limit −18 °C.</p>
        </section>
  );
});

function valNote(val) {
  const ok = (val || []).filter((v) => v.gap_pct != null);
  if (!ok.length) return 'Re-plans made here use the in-page planner, a fast heuristic checked against CP-SAT in every scheduled run.';
  return `Re-plans made here use the in-page planner; it matched CP-SAT exactly on ${ok.filter((v) => Math.abs(v.gap_pct) < 0.05).length} of ${val.length} test cases and was within ${fmt(Math.max(...ok.map((v) => Math.abs(v.gap_pct))))}% on the rest.`;
}

function Kpi({ label, v, unit, d, base, nom, flash, better = 'low' }) {
  const x = useTween(v), delta = base ? ((v - base) / base) * 100 : 0, good = better === 'low' ? delta <= 0 : delta >= 0;
  return (
    <div className={`pf-kpi${flash ? ' flash' : ''}`} key={flash}>
      <div className="l">{label}</div><div className="v num">{fmt(x, d)}<small>{unit}</small></div>
      <div className="d">FCFS baseline <b className="num">{fmt(base, d)}</b> · <b style={{ color: Math.abs(delta) < 0.05 ? C.muted : good ? C.ok : C.red }}>{delta <= 0 ? '−' : '+'}{fmt(Math.abs(delta))}%</b></div>
      <div className="d">nominal plan <b className="num">{fmt(nom, d)}</b></div>
    </div>
  );
}

// Loads the daily live plan when the page names one, and falls back to the embedded plan.
export default function PortFlowControlTower() {
  const url = typeof window === 'undefined' ? null : (new URLSearchParams(window.location.search).get('data') || window.PORTFLOW_DATA_URL || null);
  const [st, setSt] = useState({ data: DEFAULT_MCP_DATA, src: url ? 'loading' : 'embedded', note: '' });
  useEffect(() => {
    if (!url) return undefined;
    let on = true; const ac = typeof AbortController !== 'undefined' ? new AbortController() : null, to = setTimeout(() => ac && ac.abort(), 10000);
    const get = (u) => fetch(u, { cache: 'no-store', signal: ac ? ac.signal : undefined }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
    const usable = (d) => d && d.status === 'ok' && d.optimised && d.optimised.schedule && d.optimised.schedule.length;
    const when = (s) => (s ? `${String(s).slice(0, 16).replace('T', ' ')} UTC` : 'the latest run');
    const emb = DEFAULT_MCP_DATA.live && DEFAULT_MCP_DATA.live.retrieved ? `the plan for the queue read ${DEFAULT_MCP_DATA.live.retrieved}` : 'the plan embedded in the page';
    get(url)
      .then((d) => {
        if (!on) return null;
        if (usable(d)) { setSt({ data: d, src: 'live', note: '' }); return null; }
        const why = d.status === 'no_queue' ? `found no ship in the queue${d.reason ? ` (${d.reason})` : ''}` : 'found no feasible plan';
        // the last live run that had a plan, kept by run_tower.py next to tower.json
        return get(url.replace(/tower\.json(\?.*)?$/, 'tower_last_ok.json')).catch(() => null).then((p) => {
          if (!on) return;
          if (usable(p)) setSt({ data: p, src: 'live', info: true, note: `The live run of ${when(d.generated_utc)} ${why}. Showing the last live plan, from ${when(p.generated_utc)}.` });
          else setSt((x) => ({ ...x, src: 'embedded', info: true, note: `The live run of ${when(d.generated_utc)} ${why}. Showing ${emb} instead.` }));
        });
      })
      .catch((e) => on && setSt((x) => ({ ...x, src: 'embedded', note: `The live plan could not be loaded (${e.name === 'AbortError' ? 'timed out' : e.message}); showing ${emb} instead.` })))
      .finally(() => clearTimeout(to));
    return () => { on = false; clearTimeout(to); };
  }, [url]);
  if (st.src === 'loading') return <div className="pf"><style>{CSS}</style><div className="pf-brand">PortFlow Control Tower<small>loading today's live plan…</small></div></div>;
  return <Tower key={`${st.src}-${st.data.generated_utc || ''}`} data={st.data} feed={st} />;
}

function Tower({ data, feed }) {
  const cfg = data.config, site = useMemo(() => makeSite(data), [data]), HH = data.site_kind === 'hamburg';
  const isLive = data.status === 'ok';
  const hasLeaflet = typeof window !== 'undefined' && !!window.L;   // the public pages load Leaflet; elsewhere the schematic chart is used
  const nominal = useMemo(() => ({ schedule: data.optimised.schedule, kpis: pyKpis(data.optimised.kpis) }), [data]);
  const baseK = useMemo(() => pyKpis(data.baseline.kpis), [data]);
  const [plan, setPlan] = useState({ ...nominal, source: 'CP-SAT reference', yardTrace: null });
  const [sc, setSc] = useState(NOMINAL);
  const [t, setT] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(8);
  const [sel, setSel] = useState(() => (data.live.vessels.some((v) => v.name === 'HR FARHA') ? 'HR FARHA' : (data.optimised.schedule[0] || {}).vessel_id));
  const [ghost, setGhost] = useState(false);
  const [msgs, setMsgs] = useState([{ role: 'a', text: HH
    ? `Live queue loaded: ${data.live.vessels.length} container ships declaring Hamburg on AIS and ${(data.live.fixed_occupants || []).length} alongside, read ${data.live.retrieved}. The nominal plan is on screen. Tell me what changed and I will re-plan the berths and re-run the yard simulation${apiUrl() ? ' with the CP-SAT engine on the server (or here in the page if it does not answer)' : ' here in the page'}.`
    : `Live queue loaded: ${data.live.vessels.length} container ships bound for Chattogram, read ${data.live.retrieved}. The nominal plan is on screen. Tell me what changed and I will re-plan the berths and re-run the yard simulation${apiUrl() ? ' with the CP-SAT engine on the server (or here in the page if it does not answer)' : ' here in the page'}.` }]);
  const [log, setLog] = useState(['engine ready: berth planner + yard discrete-event simulation loaded in the page']);
  const [input, setInput] = useState(''), [busy, setBusy] = useState(false), [flash, setFlash] = useState(0), [mode, setMode] = useState('checking');
  const [yMode, setYMode] = useState('after'), [step, setStep] = useState(null), [onlyB, setOnlyB] = useState(false), [hover, setHover] = useState(null), [dropKey, setDropKey] = useState(0);
  const sample = useRef(null), msgEnd = useRef(null), termEnd = useRef(null);
  const tMax = useMemo(() => Math.min(cfg.horizon_hrs, Math.max(...plan.schedule.map((r) => r.tidal_depart_hr)) + cfg.transit_hrs + 8), [plan, cfg]);
  const names = useMemo(() => data.live.vessels.map((v) => v.name), [data]);

  useEffect(() => { let live = true; const c = typeof window !== 'undefined' ? window.claude : null;
    if (c && typeof c.use === 'function') c.use('sample').then((fn) => { if (live) { sample.current = fn; setMode(fn ? 'claude' : 'offline'); } }).catch(() => live && setMode('offline')); else setMode('offline');
    return () => { live = false; }; }, []);
  // nominal yard trace and the no-relief comparison are simulated once in the page
  const traces = useMemo(() => { const modes = data.optimised.schedule.map((r) => r.crane_intensity), mk = modes.sort((a, b) => modes.filter((x) => x === b).length - modes.filter((x) => x === a).length)[0] || '2.629';
    const p = { occ: cfg.initial_yard_occupancy_pct, intensity: (cfg.qgc_gmph * Number(mk)) / cfg.ref_boxes_per_hr, rtgFleet: cfg.rtg_per_berth_cluster, yardCap: cfg.yard_cluster_teu, blocking: data.yard.blocking_ratio, premarshalJobs: data.yard.night_premarshal_relocations_executed, trace: true };
    return { nominal: simulateReplicated({ ...p, icd: cfg.icd_ratio }, 1).trace, none: simulateReplicated({ ...p, icd: 0 }, 1).trace }; }, [data, cfg]);
  useEffect(() => { if (!playing) return undefined; let raf, last = performance.now();
    const tick = (now) => { const dt = (now - last) / 1000; last = now; setT((x) => { const n = x + dt * speed; if (n >= tMax) { setPlaying(false); return tMax; } return n; }); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [playing, speed, tMax]);
  useEffect(() => { if (msgEnd.current) msgEnd.current.scrollTop = msgEnd.current.scrollHeight; }, [msgs]);
  useEffect(() => { if (termEnd.current) termEnd.current.scrollTop = termEnd.current.scrollHeight; }, [log]);
  useEffect(() => { if (step == null) return undefined; if (step >= data.yard.premarshal_moves.length) { const id = setTimeout(() => { setStep(null); setYMode('after'); }, 900); return () => clearTimeout(id); } const id = setTimeout(() => setStep(step + 1), 200); return () => clearTimeout(id); }, [step, data]);

  const yard = useMemo(() => yardState(data.yard, step != null ? step : yMode === 'after' ? data.yard.premarshal_moves.length : 0), [data, step, yMode]);
  const say = (role, text) => setMsgs((m) => [...m, { role, text }]);
  const reveal = (lines) => new Promise((res) => { let i = 0; const push = () => { if (i >= lines.length) { res(); return; } const ln = lines[i++]; setLog((l) => [...l.slice(-80), ln]); setTimeout(push, 95); }; push(); });

  const run = useCallback(async (text) => {
    if (busy || !text.trim()) return; setBusy(true); setInput(''); say('u', text); setPlaying(false);
    const stamp = `[${planClock(data.live.plan_epoch_local, t).label}]`;
    let acts = null, reply = '';
    if (mode === 'claude' && sample.current) {
      try { await reveal([`${stamp} copilot: asking Claude to read the command`]);
        const r = await sample.current.json([{ role: 'user', content: `${RULES(data.live.vessels, sc, plan.kpis, t, HH)}\n\nOPERATOR MESSAGE: ${text}` }], { modelTier: 'quick', cache: false });
        acts = Array.isArray(r && r.actions) ? r.actions : []; reply = (r && r.reply) || '';
      } catch (e) { await reveal([`copilot: Claude unavailable (${(e && e.code) || 'error'}); using the built-in command parser`]); }
    }
    if (acts == null) { acts = offlineParse(text, data.live.vessels, HH); if (mode !== 'claude') await reveal([`${stamp} copilot: built-in command parser (Claude is not available in this view)`]); }
    const { next, said } = applyActions(sc, acts, names, HH, cfg);
    if (!said.length) { say('a', reply || `I could not turn that into a change to the plan. Try: delay a ship by some hours, take quay or yard cranes out${HH ? ' at a terminal' : ''}, set the ${HH ? 'night rail and barge' : 'off-dock'} evacuation share, set the starting yard level${HH ? '' : ', or set the number of pilot and tug sets'}.`); setBusy(false); return; }
    await reveal([`parsed: ${said.join('; ')}`]);
    const lines = [], t0 = performance.now();
    const opt = { etaShift: next.etaShift, qgcOutages: next.qgcOutages, rtgOutages: next.rtgOutages, icd: next.icd ?? undefined, occ: next.occ ?? undefined, tugSets: next.tugSets ?? undefined, reps: 8 };
    const srvLines = [], srv = scChips(next, cfg).length ? await solveServer(data, opt, (l) => srvLines.push(l)) : null;
    if (srvLines.length) await reveal(srvLines);
    const res = srv || await solveAsync(data, opt, (l) => lines.push(l));
    await reveal(lines);
    if (!res.feasible && srv) { await reveal(['no feasible plan: scenario not applied']); say('a', `The CP-SAT engine on the server found no plan that finishes inside the ${cfg.horizon_hrs}-hour horizon with ${said.join(', ')} within its time limit. I kept the previous plan.`); setBusy(false); return; }
    if (!res.feasible) { await reveal(['no feasible plan: scenario not applied']); say('a', `The in-page planner found no plan that finishes inside the ${cfg.horizon_hrs}-hour tide table with ${said.join(', ')}${res.blocker ? `; ${res.blocker} is the ship it could not fit` : ''}. This planner is a fast heuristic: the CP-SAT engine searches exhaustively and can find plans it misses (in testing it fitted a storm-plus-no-evacuation case this planner rejected), so check the case with the Python engine${HH ? ' (run_tower.py)' : ' on the MCP server with nct_simulate_disruption'}. I kept the previous plan.`); setBusy(false); return; }
    await reveal([`${res.converged ? 'converged' : 'stopped'} after ${res.iterations} iteration(s) in ${Math.round(performance.now() - t0)} ms: turnaround ${res.kpis.turnaround} d, wait ${res.kpis.wait} h, backpressure ${res.kpis.beta.toFixed(2)}`]);
    const old = Object.fromEntries(plan.schedule.map((r) => [r.vessel_id, r])), k0 = plan.kpis, k1 = res.kpis;
    const moved = res.schedule.filter((r) => { const o = old[r.vessel_id]; return o && (o.berth_start_hr !== r.berth_start_hr || Math.abs(o.berth_start_m - r.berth_start_m) > 5 || o.assigned_qcs !== r.assigned_qcs); });
    const isNominal = !scChips(next, cfg).length;
    setSc(next); setPlan(isNominal ? { ...nominal, source: 'CP-SAT reference', yardTrace: null } : { schedule: res.schedule, kpis: k1, source: srv ? 'server CP-SAT re-plan' : 'in-page re-plan', yardTrace: res.yardTrace }); setFlash((f) => f + 1); setT(0);
    const kk = isNominal ? nominal.kpis : k1;
    say('a', `${reply ? `${reply}\n` : ''}Re-planned: average turnaround ${fmt(k0.turnaround, 2)} → ${fmt(kk.turnaround, 2)} days, ${HH ? 'wait before the Elbe' : 'anchorage wait'} ${fmt(k0.wait, 0)} → ${fmt(kk.wait, 0)} h, peak yard ${fmt(k0.peak)} → ${fmt(kk.peak)}%, backpressure ${fmt(k0.beta, 2)} → ${fmt(kk.beta, 2)}.${moved.length && !isNominal ? `\nMoved: ${moved.slice(0, 4).map((r) => `${r.vessel_id} to ${berthLabel(data, r)} at hour ${r.berth_start_hr} with ${r.assigned_qcs} quay cranes`).join('; ')}${moved.length > 4 ? `; and ${moved.length - 4} more` : ''}.` : ''}\nPlaying the new plan on the chart.`);
    if (!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { setSpeed(16); setPlaying(true); }
    setBusy(false);
  }, [busy, mode, sc, plan, t, data, names, cfg, nominal, HH]);

  const clk = planClock(data.live.plan_epoch_local, t), hr = Math.min(Math.floor(t), cfg.horizon_hrs), tideNow = data.tide_hourly[hr] + (data.tide_hourly[Math.min(hr + 1, cfg.horizon_hrs)] - data.tide_hourly[hr]) * (t - hr);
  const night = !(site.clock(hr) >= cfg.daylight_hours[0] && site.clock(hr) < cfg.daylight_hours[1]);
  const k = plan.kpis, chips = scChips(sc, cfg), Y = data.yard, R = data.reefer, hy = data.hydrostatics;
  // money, just-in-time fuel and tide-window risk of the plan on screen (Python figures for the reference plan, in-page otherwise)
  const fig = useMemo(() => (plan.source === 'CP-SAT reference' && data.advice ? data.advice : planFigures(data, plan.schedule)), [plan, data]);
  const figBase = useMemo(() => (data.advice_baseline ? data.advice_baseline.totals : planFigures(data, data.baseline.schedule).totals), [data]);
  const figNom = useMemo(() => (data.advice ? data.advice.totals : planFigures(data, data.optimised.schedule).totals), [data]);
  const risky = (f) => f.ships.filter((x) => x.risk && x.risk.p_miss >= 0.2).length;
  const figMap = Object.fromEntries(fig.ships.map((x) => [x.vessel_id, x]));
  const ledger = useMemo(() => yardLedger(data, plan.schedule, sc.icd ?? undefined, sc.occ ?? undefined), [data, plan, sc]);
  const ledgerRows = useMemo(() => { const ks = Object.keys(ledger.pools), n = ledger.pools[ks[0]].length, out = []; for (let h = 0; h < n; h += 2) { const row = { h }; ks.forEach((k) => { row[k] = ledger.pools[k][h]; }); out.push(row); } return out; }, [ledger]);
  const windNow = HH && data.live.wind_ms_hourly ? data.live.wind_ms_hourly[Math.min(Math.floor(t), data.live.wind_ms_hourly.length - 1)] : null;
  const trace = useMemo(() => (plan.yardTrace || traces.nominal).map((p, i) => ({ h: +(p[0] / 60).toFixed(2), now: p[1], none: traces.none[i] ? traces.none[i][1] : null })), [plan, traces]);
  const vmap = useMemo(() => Object.fromEntries(data.live.vessels.map((v) => [v.name, v])), [data]);

  return (
    <div className={`pf${playing ? ' playing' : ''}`}>
      <style>{CSS}</style>
      <header className="pf-top">
        <div className="pf-brand">PortFlow Control Tower<small>{HH ? 'Port of Hamburg · Burchardkai · Eurogate · Tollerort · Altenwerder' : 'Chattogram · New Mooring Container Terminal'} · engine v{data.engine_version}</small></div>
        <div className="pf-clock num">{clk.label}<small>plan hour {fmt(t, 1)} of {tMax} · {HH ? 'UTC' : 'Bangladesh time'}</small></div>
        <div className="pf-lamps">
          <span className="pf-lamp" style={{ '--c': plan.source === 'CP-SAT reference' ? C.ok : C.tele }}><i />PLAN: {plan.source.toUpperCase()}</span>
          <span className="pf-lamp" style={{ '--c': isLive && !(feed && feed.src === 'embedded') ? C.ok : C.amber }}><i />{feed && feed.src === 'embedded' ? `SAVED PLAN ${data.live.retrieved}` : isLive ? `LIVE DATA ${data.live.retrieved}` : `SNAPSHOT ${data.live.retrieved}`}</span>
          <span className="pf-lamp" style={{ '--c': C.blue }}><i />{HH ? `ST. PAULI +${fmt(tideNow, 2)} m MLW` : `TIDE ${fmt(tideNow, 2)} m`}</span>
          {!HH && <span className="pf-lamp" style={{ '--c': night ? C.amber : C.ok }}><i />{night ? 'NIGHT RULE ON' : 'DAYLIGHT'}</span>}
          {windNow != null && <span className="pf-lamp" style={{ '--c': windNow >= cfg.wind_limit_ms ? C.red : C.ok }}><i />WIND {fmt(windNow)} m/s{windNow >= cfg.wind_limit_ms ? ': BIG SHIPS HOLD' : ''}</span>}
          <span className="pf-lamp" style={{ '--c': k.peak >= 80 ? C.red : C.ok }}><i />YARD PEAK {fmt(k.peak)}%</span>
          <span className="pf-lamp" style={{ '--c': mode === 'claude' ? C.ok : C.amber }}><i />COPILOT: {mode === 'claude' ? 'CLAUDE' : mode === 'offline' ? 'BUILT-IN PARSER' : '…'}</span>
        </div>
      </header>
      {typeof window !== 'undefined' && window.PORTFLOW_NAV && <nav className="pf-nav" aria-label="Ports" style={{ marginTop: 8 }}>
        <a href="chattogram.html" className={HH ? '' : 'on'}>Chattogram control tower</a><a href="hamburg.html" className={HH ? 'on' : ''}>Hamburg control tower</a><a href="../index.html">Hamburg live AIS and tide</a>
        <a href="https://github.com/artahmid03-source/portflow-simopt-mcp">Source on GitHub</a>
      </nav>}
      {feed && feed.note && <div className={`pf-banner${feed.info ? ' ok' : ''}`} role="status">{feed.note}</div>}

      <div className="pf-scrub">
        <button className="pf-btn" onClick={() => { if (t >= tMax) setT(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
        <input type="range" min="0" max={tMax} step="0.25" value={Math.min(t, tMax)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Plan time" />
        <div className="pf-seg">{[4, 8, 16, 32].map((s) => <button key={s} className={`pf-btn${speed === s ? ' on' : ''}`} onClick={() => setSpeed(s)} aria-label={`${s} plan hours per second`}>{s} h/s</button>)}</div>
      </div>

      <div className="pf-grid">
        <section className="pf-panel s7">
          <div className="pf-head"><div><div className="pf-tag">{HH ? 'German Bight, Elbe and port' : 'Approach and channel'}</div><h2>Vessel traffic</h2></div>
            <div><span className="pf-key" style={{ '--c': C.blue }}><i />inbound</span><span className="pf-key" style={{ '--c': C.amber }}><i />{HH ? 'waiting' : 'at anchor'}</span><span className="pf-key" style={{ '--c': C.tele }}><i />{HH ? 'on the Elbe' : 'under pilotage'}</span><span className="pf-key" style={{ '--c': C.ok }}><i />alongside</span></div></div>
          {HH ? <ElbeMap data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} />
            : hasLeaflet ? <KarnaphuliMap data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} tide={tideNow} />
              : <Radar data={data} site={site} schedule={plan.schedule} t={t} sel={sel} onSel={setSel} tide={tideNow} />}
          <p className="pf-note">{HH
            ? `OpenStreetMap with OpenSeaMap sea marks. At hour 0 each ship is where AIS last heard it (moored ships at their quay); from there it moves as the plan says: waiting off Elbe-1, a ${cfg.transit_hrs}-hour passage, alongside, and out. Grey: ships already alongside at the plan start. Click a ship for its details.`
            : hasLeaflet ? `OpenStreetMap with OpenSeaMap sea marks; quay and river lines from OpenStreetMap. ${isLive ? 'At hour 0 each ship is where AIS last heard it (Singapore, the Malacca Strait or Colombo; AIS does not reach Chattogram)' : `Ship details were read from public sources on ${data.live.retrieved} without positions, so each ship starts on the sea route from its last port at a point matching its reported area`}; from there it moves as the plan says: outer anchorage, pilotage up the Karnaphuli, the NCT quay, and out. Grey: ships alongside at the start, or in port at a terminal not modelled. Click a ship for its details.`
            : isLive ? 'Schematic, not to scale. Ships are drawn from the region where AIS last heard them (Singapore and the Malacca Strait, or Colombo) and then move according to the plan. Click a ship for its details.'
              : `Schematic, not to scale. Ship names, numbers, sizes and status were read from public sources on ${data.live.retrieved}; no source gave latitude, longitude, speed or course, so each ship is drawn from its reported area and then moves according to the plan. Click a ship for its details.`}</p>
        </section>

        <section className="pf-panel s5">
          <div className="pf-chat">
            <div className="pf-head" style={{ marginBottom: 0 }}><div><div className="pf-tag">Copilot</div><h2>Tell the tower what changed</h2></div>
              <button className="pf-btn" disabled={busy || !chips.length} onClick={() => run('Reset')}>Reset scenario</button></div>
            <div className="pf-msgs" ref={msgEnd} aria-live="polite">{msgs.map((m, i) => <div key={i} className={`pf-msg ${m.role}`}>{m.text}</div>)}{busy && <div className="pf-msg a">working…</div>}</div>
            {chips.length > 0 && <div className="pf-chips" aria-label="Active changes">{chips.map((c) => <span key={c} className="pf-chip act">{c}</span>)}</div>}
            <form className="pf-in" onSubmit={(e) => { e.preventDefault(); run(input); }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={`e.g. ${names[1] || names[0]} is 8 hours late and one quay crane is down`} aria-label="Command for the copilot" disabled={busy} />
              <button className="pf-btn on" type="submit" disabled={busy || !input.trim()}>Send</button>
            </form>
            <div className="pf-chips">{(HH ? QUICK_HH : QUICK).slice(0, 6).map((q) => <button key={q} className="pf-chip" disabled={busy} onClick={() => run(q)}>{q}</button>)}</div>
            <div className="pf-tag" style={{ marginTop: 2 }}>Solver log</div>
            <div className="pf-term" ref={termEnd}>{log.map((l, i) => <div key={i} className={i === log.length - 1 ? 'cur' : ''}>{l}</div>)}</div>
          </div>
        </section>

        <section className="pf-panel">
          <div className="pf-kpis">
            <Kpi label="Average turnaround" v={k.turnaround} unit="days" d={2} base={baseK.turnaround} nom={nominal.kpis.turnaround} flash={flash} />
            <Kpi label={HH ? 'Wait before the Elbe' : 'Anchorage wait'} v={k.wait} unit="h" d={0} base={baseK.wait} nom={nominal.kpis.wait} flash={flash} />
            <Kpi label="Peak yard occupancy" v={k.peak} unit="%" d={1} base={baseK.peak} nom={nominal.kpis.peak} flash={flash} />
            <Kpi label="Quay slowdown from yard" v={k.beta} unit="×" d={2} base={baseK.beta} nom={nominal.kpis.beta} flash={flash} />
            <Kpi label="Gate truck wait" v={k.gateWait} unit="min" d={0} base={baseK.gateWait} nom={nominal.kpis.gateWait} flash={flash} />
            <Kpi label="Cost of the queue" v={fig.totals.cost_usd / 1000} unit="k USD" d={0} base={figBase.cost_usd / 1000} nom={figNom.cost_usd / 1000} flash={flash} />
            <Kpi label="Ships at risk of missing their tide" v={risky(fig)} unit={`of ${plan.schedule.length}`} d={0} base={risky({ ships: planFigures(data, data.baseline.schedule).ships })} nom={risky(data.advice || planFigures(data, data.optimised.schedule))} flash={flash} />
            <Kpi label={HH ? 'Held for tide' : 'Held for tide or daylight'} v={k.hold} unit="h" d={0} base={baseK.hold} nom={nominal.kpis.hold} flash={flash} />
          </div>
          <p className="pf-note">FCFS baseline: {data.baseline_rule ? data.baseline_rule.replace('off-dock', HH ? 'night rail and barge' : 'off-dock') : `ships berth in arrival order with every crane they can take and no ${HH ? 'night rail and barge' : 'off-dock'} evacuation`}. Nominal plan: the Python engine (CP-SAT with simulation cuts) at {Math.round(cfg.icd_ratio * 100)}% evacuation{isLive ? `, run ${(data.generated_utc || '').slice(0, 16).replace('T', ' ')} UTC on today's data` : ''}. {valNote(data.validation)}{HH && Math.abs(baseK.turnaround - k.turnaround) < 0.005 ? ' With today\'s queue the quays have room, so the baseline and the optimised plan coincide; use the copilot to stress the plan.' : ''}</p>
        </section>

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Quay against time</div><h2>{HH ? 'Berth plan by terminal, with the Elbe tide' : 'Berth plan, tide and night bands'}</h2></div>
            <div className="pf-seg"><button className={`pf-btn${ghost ? ' on' : ''}`} onClick={() => setGhost(!ghost)}>{ghost ? 'Hide' : 'Show'} FCFS baseline</button></div></div>
          <Gantt data={data} site={site} schedule={plan.schedule} ghost={ghost ? data.baseline.schedule : null} t={t} sel={sel} onSel={setSel} tMax={tMax} />
          <p className="pf-note">{HH
            ? `One axis for five quay segments (left labels; the colour strip is the terminal). Solid bar: working cargo. Hatched: cargo finished, ship held until the tide lets it sail. Teal stubs: the ${cfg.transit_hrs}-hour Elbe passage in and out. Grey: ships already alongside, leaving at an estimated hour. Tide strip: forecast level at St. Pauli above mean low water. Green ticks: hours the selected ship may come alongside under the tide rule.`
            : `Solid bar: working cargo. Hatched: cargo finished, ship held until the tide and daylight allow it to sail. Teal stubs: the ${cfg.transit_hrs}-hour pilotage in and out. Dark bands: night, when ships over ${cfg.night_max_loa_m} m or deeper than ${fmt(cfg.night_max_draught_m)} m may not move. Green ticks: hours when the selected ship may transit.`}</p>
        </section>

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Yard ledger</div><h2>Yard occupancy over the whole plan</h2></div>
            <div className="pf-stats" style={{ marginTop: 0 }}><div className="pf-stat"><div className="l">Peak</div><div className="v num" style={{ color: ledger.peak_pct >= 80 ? C.red : C.ok }}>{fmt(ledger.peak_pct)}%</div></div>
              {data.ledger && data.ledger.refined_kpis && <div className="pf-stat"><div className="l">Turnaround with the yard carried over</div><div className="v num">{fmt(data.ledger.refined_kpis.avg_turnaround_days, 2)} days (plan {fmt(data.optimised.kpis.avg_turnaround_days, 2)})</div></div>}</div></div>
          <div style={{ height: 200 }}><ResponsiveContainer><LineChart data={ledgerRows} margin={{ top: 6, right: 10, bottom: 0, left: -14 }}>
            <CartesianGrid stroke={C.line} vertical={false} /><XAxis dataKey="h" type="number" domain={[0, cfg.horizon_hrs]} unit=" h" {...ax} /><YAxis domain={[40, 100]} unit="%" {...ax} />
            <ReferenceLine y={80} stroke={C.red} strokeDasharray="4 3" label={{ value: '80% cliff', fill: C.red, fontSize: 10, position: 'insideTopRight' }} />
            <ReferenceLine x={Math.min(t, cfg.horizon_hrs)} stroke={C.tele} />
            <Tooltip {...tip} formatter={(v, n) => [`${fmt(v)}%`, n === 'all' ? 'yard' : n]} labelFormatter={(h) => `plan hour ${h}`} />
            {Object.keys(ledger.pools).map((k, i) => <Line key={k} dataKey={k} stroke={HH ? TERM_C[k] : [C.tele, C.blue, C.amber][i % 3]} strokeWidth={2} dot={false} isAnimationActive={false} />)}
          </LineChart></ResponsiveContainer></div>
          <p className="pf-note">The yard simulation above follows one shift; this ledger follows {HH ? 'each terminal\'s' : 'the whole'} yard hour by hour through the plan: imports land while a ship works (less the share evacuated at night) and leave after a {cfg.import_dwell_days}-day dwell, exports arrive in the 72 h before their ship and leave as it loads; half of each call is imports. Above about 80% yard cranes slow down sharply.{data.ledger && data.ledger.refined_kpis ? ((data.ledger.status || 'converged') === 'converged' ? ` Feeding each ship's ledger slowdown back into the planner settles in ${data.ledger.trace.length} rounds at ${fmt(data.ledger.refined_kpis.avg_turnaround_days, 2)} days, the more realistic figure when the yard runs this full.` : ` Feeding each ship's ledger slowdown back into the planner does not settle: ${String(data.ledger.status).replace(/^(not settled|infeasible): /, '')}. The last feasible round gives ${fmt(data.ledger.refined_kpis.avg_turnaround_days, 2)} days, so the yard, not the quay, is the binding limit.`) : ''} Background flows (earlier calls' imports leaving, later calls' exports arriving) run at this plan's average rates. Capacities and dwell are assumptions.</p>
        </section>

        <section className="pf-panel s7">
          <div className="pf-head"><div><div className="pf-tag">Yard block, 40 × 6 × 5</div><h2>Stack plan for {hy.vessel_id}'s parcel</h2></div>
            <div className="pf-seg">
              <button className={`pf-btn${yMode === 'before' && step == null ? ' on' : ''}`} onClick={() => { setStep(null); setYMode('before'); }}>As landed</button>
              <button className={`pf-btn${yMode === 'after' && step == null ? ' on' : ''}`} onClick={() => { setStep(null); setYMode('after'); }}>After night grooming</button>
              <button className={`pf-btn${step != null ? ' on' : ''}`} onClick={() => { setYMode('before'); setStep(0); }}>▶ Replay {Y.premarshal_moves.length} moves</button>
              <button className="pf-btn" onClick={() => setDropKey((x) => x + 1)}>Restack</button>
              <button className={`pf-btn${onlyB ? ' on' : ''}`} onClick={() => setOnlyB(!onlyB)}>Blocking only</button>
            </div></div>
          <Yard3D boxes={yard.boxes} onlyBlocking={onlyB} onHover={setHover} dropKey={dropKey} />
          <div style={{ marginTop: 8 }}><span className="pf-key" style={{ '--c': FACE[1][0] }}><i />green channel</span><span className="pf-key" style={{ '--c': FACE[2][0] }}><i />yellow</span><span className="pf-key" style={{ '--c': FACE[3][0] }}><i />red</span><span className="pf-key" style={{ '--c': FACE[4][0] }}><i />inherited stock</span><span className="pf-key" style={{ '--c': '#ff8a1f' }}><i />dangerous goods</span><span className="pf-key" style={{ '--c': '#fff' }}><i />glowing: blocks an earlier-leaving box</span></div>
          <div className="pf-read num">{hover ? `Bay ${hover.b + 1}, row ${hover.r + 1}, tier ${hover.t + 1}: leaves in ${fmt(hover.d, 0)} h, ${CH_NAME[hover.ch]}${hover.im ? `, ${IMDG_NAME[hover.im]} (never relocated)` : ''}${hover.blocking ? `. Blocking: sits above a box leaving in ${fmt(hover.under, 0)} h` : ''}${hover.moved ? '. Moved by night grooming' : ''}` : step != null ? `Night grooming: move ${Math.min(step, Y.premarshal_moves.length)} of ${Y.premarshal_moves.length}` : 'Point at a box for its slot, departure time and customs channel.'}</div>
          <div className="pf-stats">
            <div className="pf-stat"><div className="l">Blocking boxes now</div><div className="v num" style={{ color: C.red }}>{yard.blocking}</div></div>
            <div className="pf-stat"><div className="l">Random stacking</div><div className="v num">{data.yard_baseline.initial_blocking_inversions}</div></div>
            <div className="pf-stat"><div className="l">Dwell-aware stacking</div><div className="v num">{Y.initial_blocking_inversions}</div></div>
            <div className="pf-stat"><div className="l">After grooming</div><div className="v num">{Y.post_premarshal_blocking_inversions}</div></div>
            <div className="pf-stat"><div className="l">Block fill</div><div className="v num">{fmt(Y.block_fill_pct)}%</div></div>
          </div>
        </section>

        <SidePanels trace={trace} R={R} cfg={cfg} HH={HH} />

        <section className="pf-panel">
          <div className="pf-head"><div><div className="pf-tag">Queue</div><h2>Ships in the plan</h2></div>
            <div className="pf-stats" style={{ marginTop: 0 }}><div className="pf-stat"><div className="l">Stability check, {hy.vessel_id}{HH ? ', 360-box test parcel' : ''}</div><div className="v num">GM {fmt(hy.GM_metacentric_height_m, 2)} m · list {fmt(hy.heeling_list_angle_deg, 2)}° · {hy.imo_stability_compliant ? 'pass' : 'FAIL'}</div></div></div></div>
          <div className="pf-scroll"><table className="pf-table"><thead><tr><th>Vessel</th><th>IMO</th><th>MMSI</th><th>LOA m</th><th>Draught m</th><th className="tl">Reported status</th><th className="tl">Arrival basis</th><th>Berth</th><th>Alongside</th><th>Sails</th><th>Cranes</th><th>Wait h</th><th>Hold h</th><th>Cost k USD</th><th className="tl">Just-in-time advice</th><th>Tide risk</th><th className="tl">Why it waits</th></tr></thead>
            <tbody>{plan.schedule.map((r) => { const v = vmap[r.vessel_id]; return (
              <tr key={r.vessel_id} className={sel === r.vessel_id ? 'sel' : ''} onClick={() => setSel(r.vessel_id)}>
                <td>{r.vessel_id}</td><td>{v.imo}</td><td>{v.mmsi}</td><td>{fmt(v.loa_m, 2)}</td><td>{v.draught_reported_m == null ? '—' : fmt(v.draught_reported_m)} / {fmt(r.draft_m)}</td><td className="tl">{v.status}</td><td className="tl" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.eta_basis}>{v.eta_basis}</td>
                <td>{berthLabel(data, r)}</td><td>{planClock(data.live.plan_epoch_local, r.berth_start_hr).label}</td><td>{planClock(data.live.plan_epoch_local, r.tidal_depart_hr).label}</td><td>{r.assigned_qcs}</td><td>{r.anchorage_wait_hrs}</td><td>{r.tide_departure_hold_hrs}</td>
                <td>{figMap[r.vessel_id] ? fmt(figMap[r.vessel_id].cost_usd / 1000, 0) : '—'}</td>
                <td className="tl">{figMap[r.vessel_id] && figMap[r.vessel_id].jit ? `${fmt(figMap[r.vessel_id].jit.speed_now_kn)} → ${fmt(figMap[r.vessel_id].jit.speed_advised_kn)} kn, saves ${fmt(figMap[r.vessel_id].jit.fuel_saved_t)} t fuel` : r.anchorage_wait_hrs > 0 ? 'no position to advise from' : 'no wait planned'}</td>
                <td style={{ color: figMap[r.vessel_id] && figMap[r.vessel_id].risk && figMap[r.vessel_id].risk.p_miss >= 0.2 ? C.amber : undefined }} title={figMap[r.vessel_id] && figMap[r.vessel_id].risk ? `planned window closes at hour ${figMap[r.vessel_id].risk.window_closes_hr}; slack ${figMap[r.vessel_id].risk.slack_h} h against an arrival error of ±${figMap[r.vessel_id].risk.sigma_h} h; next window ${figMap[r.vessel_id].risk.extra_wait_if_missed_h ?? '—'} h later` : 'no tide window to miss'}>{figMap[r.vessel_id] && figMap[r.vessel_id].risk ? `${fmt(figMap[r.vessel_id].risk.p_miss * 100, 0)}%` : '—'}</td>
                <td className="tl" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={explainRow(data, r)}>{explainRow(data, r) || '—'}</td>
              </tr>); })}</tbody></table></div>
          <p className="pf-note">{HH
            ? `Draught: reported on AIS / used in the plan (capped at the inbound tide-dependent limit). Box counts per call are estimates (${data.live.estimates.moves_per_call}); the terminal comes from where AIS has seen the ship moored, or else from a carrier-to-terminal assumption. ${(data.live.excluded || []).length} ships declaring Hamburg were left out (see below).`
            : `Draught: reported by the ship / used in the plan (capped at the ${fmt(cfg.max_draught_m)} m limit). Box counts per call are estimates from ${isLive ? 'length and beam' : 'deadweight'}; terminals are not published, so every ship is treated as an NCT call.`}</p>
        </section>
      </div>

      {(HH || data.backtest) && <section className="pf-panel" style={{ marginTop: 10 }}>
        <div className="pf-head"><div><div className="pf-tag">Plan against reality</div><h2>How close yesterday's plans came</h2></div></div>
        {data.backtest && (data.backtest.plan.n || data.backtest.port_list.n) ? <div className="pf-scroll"><table className="pf-table" style={{ minWidth: 640 }}><thead><tr><th>Source</th><th>Calls matched</th><th>Mean error, alongside</th><th>Bias</th><th>90th percentile</th><th>Right terminal</th></tr></thead><tbody>
          {[['PortFlow plan', data.backtest.plan], ["Port's expected-vessel list (HVCC)", data.backtest.port_list]].map(([l, x]) => <tr key={l}><td>{l}</td><td>{x.n}</td><td>{x.n ? `${fmt(x.mae_h)} h` : '—'}</td><td>{x.n ? `${x.bias_h > 0 ? '+' : ''}${fmt(x.bias_h)} h` : '—'}</td><td>{x.n ? `${fmt(x.p90_abs_h)} h` : '—'}</td><td>{x.terminal_accuracy != null && !Number.isNaN(x.terminal_accuracy) ? `${fmt(x.terminal_accuracy * 100, 0)}%` : '—'}</td></tr>)}
        </tbody></table></div> : <div className="pf-read">Collecting: every plan is archived (the first of each day is scored), and once the planned ships have berthed, AIS mooring times are compared with the plan here. {data.backtest ? `${data.backtest.plans_archived} plans archived, ${data.backtest.observed_calls} container-quay calls seen so far.` : ''}</div>}
        <p className="pf-note">Positive bias: ships berth later than planned. {data.backtest ? data.backtest.resolution_note : ''} The tide-window risk uses an arrival error of {data.backtest && data.backtest.eta_sigma_fit ? `${data.backtest.eta_sigma_fit.a} h + ${data.backtest.eta_sigma_fit.b} × lead time (fitted)` : '2 h + 0.06 × lead time (assumed until enough calls are matched)'}.</p>
      </section>}

      <details className="pf-foot"><summary>What is measured, what is assumed</summary><ul>
        <li>Read from public sources on {data.live.retrieved}: {data.live.what_is_live}</li>
        <li>Not available: {data.live.what_is_not_live}</li>
        <li>Sources: {Object.values(data.live.sources).join(' · ')}</li>
        {HH
          ? <li>Assumed: {fmt(cfg.qgc_gmph, 0)} moves per crane-hour; quay cranes per terminal {Object.entries(cfg.crane_pools).map(([k2, v2]) => `${k2} ${v2}`).join(', ')} (Eurogate's count is not confirmed); yard starting {fmt(cfg.initial_yard_occupancy_pct, 0)}% full with {Math.round(cfg.icd_ratio * 100)}% of boxes leaving by night rail and barge; Elbe passage {cfg.transit_hrs} h; the tide check applies between Waltershof and Brunsbüttel; ships moored at the start leave at an estimated hour.</li>
          : <li>Assumed: channel depth {fmt(cfg.channel_depth_m)} m below datum, under-keel clearance {fmt(cfg.ukc_m)} m, {cfg.pilot_tug_sets} pilot and tug sets, yard starting {fmt(cfg.initial_yard_occupancy_pct, 0)}% full, {fmt(cfg.qgc_gmph)} moves per crane-hour, {cfg.qgc_total} quay cranes. The quay-crane, yard-crane and reefer-plug counts are the ones supplied for this model; published figures for NCT differ.</li>}
        <li>{data.live.tide_note}</li>
        {data.advice && <li>Money and fuel: charter {data.advice.assumptions.charter_usd_day} USD/day, main-engine fuel {data.advice.assumptions.fuel_t_day} t/day, fuel {data.advice.assumptions.fuel_usd_t} USD/t, {data.advice.assumptions.idle_t_day} t/day at anchor, {data.advice.assumptions.co2_per_t_hfo} t CO₂ per t fuel. {cfg.objective === 'cost' ? 'The plan minimises this cost (waiting and time alongside at each ship\'s charter rate).' : ''}</li>}
        {HH && <li>Elbe rules in the plan: tide-independent and tide-dependent draughts; ships wider than 90 m together meet only in the Wedel–Blankenese passing box and above 104 m not at all; ships over 330 m or 45 m wide do not move at {fmt(cfg.wind_limit_ms)} m/s or more (wind forecast: {data.live.wind_source || 'not available today'}); ships wider than 51 m are not sent under the Köhlbrand bridge to Altenwerder unless the port's list says so. The wind, meeting and bridge thresholds are assumptions.</li>}
        {!HH && data.live.rules && <li>River rules in the plan: up to {fmt(data.live.rules.max_draught_m)} m draught and {fmt(data.live.rules.max_loa_m, 0)} m length; transits only from 5 h before to 1 h after each predicted high water ({data.live.rules.source}).</li>}
        {(data.live.excluded || []).length > 0 && <li>Left out of the plan: {data.live.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}.</li>}
      </ul></details>
    </div>
  );
}
