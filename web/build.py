"""Injects the pipeline output into the HMI, validates the in-page engine against the Python
reference cases, bundles, and writes the hosted page plus a standalone test page."""
import json
import pathlib
import subprocess
root = pathlib.Path(__file__).parent
d = json.load(open(root.parent / "nct_control_tower_data.json"))
val = json.loads(subprocess.run(["node", "validate.mjs", "--json"], cwd=root, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1])
slim = lambda p: {"kpis": p["kpis"], "schedule": p["schedule"], "cuts": p["cuts"], "iterations_run": p["iterations_run"], "convergence_status": p["convergence_status"]}
payload = {"engine_version": d["engine_version"], "site": d["site"], "config": d["config"], "live": d["live"], "tide_hourly": d["tide_hourly"], "hydrostatics": d["hydrostatics"],
  "yard": {k: v for k, v in d["yard"].items() if k not in ("yard_tensor_after", "reefer_rc_thermodynamics")}, "yard_baseline": d["yard_baseline"],
  "reefer": d["reefer"], "baseline": slim(d["baseline"]), "plan_only": {"kpis": d["plan_only"]["kpis"]}, "optimised": slim(d["optimised"]),
  "pilot_tug_sensitivity": d["pilot_tug_sensitivity"], "draught_check": d["draught_check"], "night_cutoff_18h": d["night_cutoff_18h"], "validation": val}
subprocess.run(["npx", "esbuild", "src/worker.js", "--bundle", "--minify", "--format=iife", "--target=es2020", "--outfile=dist/worker.js"], cwd=root, check=True, capture_output=True)
worker_src = (root / "dist/worker.js").read_text()
jsx = (root / "src/PortFlowControlTower.template.jsx").read_text().replace("/*__MCP_DATA__*/", json.dumps(payload, separators=(",", ":"))).replace("/*__WORKER_SRC__*/''", json.dumps(worker_src))
(root / "src/PortFlowControlTower.jsx").write_text(jsx)
(root / "src/main.jsx").write_text("import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './PortFlowControlTower.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n")
shim = root / "src/shims"
shim.mkdir(exist_ok=True)
(shim / "react.cjs").write_text("module.exports = window.React;\n")
(shim / "react-dom.cjs").write_text("module.exports = window.ReactDOM;\n")
(shim / "react-dom-client.cjs").write_text("module.exports = { createRoot: window.ReactDOM.createRoot };\n")
common = ["npx", "esbuild", "src/main.jsx", "--bundle", "--minify", "--format=iife", "--target=es2020", "--define:process.env.NODE_ENV=\"production\"", "--loader:.jsx=jsx", "--jsx=transform"]
subprocess.run(common + ["--alias:react=./src/shims/react.cjs", "--alias:react-dom/client=./src/shims/react-dom-client.cjs", "--alias:react-dom=./src/shims/react-dom.cjs", "--outfile=dist/app.cdn.js"], cwd=root, check=True, capture_output=True)
subprocess.run(common + ["--outfile=dist/app.full.js"], cwd=root, check=True, capture_output=True)
head = """<title>PortFlow Control Tower</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Rajdhani:wght@500;600;700&display=swap">
<style>
/* One dark control-room surface: header and time scrubber, then traffic chart beside the copilot, KPIs, berth plan, yard. */
:root { color-scheme: dark; --page: #05090d; --page-ink: #d7e5f0; }
html, body { height: 100%; margin: 0; }
body { background: var(--page); color: var(--page-ink); font-family: 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace; }
#root { min-height: 100%; }
</style>
<div id="root"></div>
"""
cdn = ('<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>\n'
       '<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>\n')
esc = lambda js: js.replace("</script", "<\\/script")
(root / "dist/PortFlowControlTower.html").write_text(head + cdn + "<script>" + esc((root / "dist/app.cdn.js").read_text()) + "</script>\n")
(root / "dist/test_full.html").write_text("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:0'>" + head + "<script>" + esc((root / "dist/app.full.js").read_text()) + "</script></body></html>")
print("html", round((root / "dist/PortFlowControlTower.html").stat().st_size / 1024), "KB  jsx", round(len(jsx) / 1024), "KB  validation", [(v["case"], v["gap_pct"]) for v in val])
