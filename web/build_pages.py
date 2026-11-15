"""Builds the public Control Tower pages for GitHub Pages:
    docs/tower/app.js            the page bundle (React included), shared by both pages
    docs/tower/chattogram.html   loads data/chattogram/tower.json from the data branch; falls back to the 13 Nov snapshot in the bundle
    docs/tower/hamburg.html      loads data/hamburg/tower.json; falls back to docs/tower/hamburg_default.js
Run after `python build.py` (which writes dist/app.full.js).   python build_pages.py [--hamburg-default <tower.json>]
"""
import argparse
import json
import pathlib
import shutil

root = pathlib.Path(__file__).parent
docs = root.parent / "docs" / "tower"
RAW = "https://raw.githubusercontent.com/artahmid03-source/portflow-simopt-mcp/data/{site}/tower.json"

ap = argparse.ArgumentParser()
ap.add_argument("--hamburg-default", default=None, help="a validated hamburg tower.json to embed as the fallback")
a = ap.parse_args()
docs.mkdir(parents=True, exist_ok=True)
shutil.copyfile(root / "dist" / "app.full.js", docs / "app.js")
if a.hamburg_default:
    d = json.loads(pathlib.Path(a.hamburg_default).read_text())
    (docs / "hamburg_default.js").write_text("window.PORTFLOW_DEFAULT = " + json.dumps(d, separators=(",", ":"), ensure_ascii=False) + ";\n", encoding="utf-8")

def page(site, title, extra_head=""):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="PortFlow: a berth and yard plan for {title.split(' · ')[0]}, re-planned every day from live AIS and tide data with CP-SAT and a yard simulation.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Rajdhani:wght@500;600;700&display=swap">
{extra_head}<style>:root{{color-scheme:dark}} html,body{{margin:0;background:#05090d;color:#d7e5f0;font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace}}</style>
</head><body><div id="root"></div>
<script>window.PORTFLOW_NAV = true; window.PORTFLOW_DATA_URL = "{RAW.format(site=site)}";</script>
"""

ham_head = '<link rel="stylesheet" href="../vendor/leaflet/leaflet.css">\n<script src="../vendor/leaflet/leaflet.js"></script>\n<script src="hamburg_default.js"></script>\n'
(docs / "chattogram.html").write_text(page("chattogram", "Chattogram NCT · PortFlow Control Tower") + '<script src="app.js"></script>\n</body></html>\n', encoding="utf-8")
(docs / "hamburg.html").write_text(page("hamburg", "Port of Hamburg · PortFlow Control Tower", ham_head) + '<script src="app.js"></script>\n</body></html>\n', encoding="utf-8")
print("pages:", sorted(p.name for p in docs.iterdir()), round((docs / "app.js").stat().st_size / 1024), "KB app")
