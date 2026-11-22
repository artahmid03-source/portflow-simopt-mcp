"""Builds the public Control Tower pages for GitHub Pages:
    docs/tower/app.js            the page bundle (React included), shared by both pages
    docs/tower/chattogram.html   loads data/chattogram/tower.json from the data branch; then the last plan with ships
                                 (tower_last_ok.json); then docs/tower/chattogram_default.js (the 13 Nov queue)
    docs/tower/hamburg.html      loads data/hamburg/tower.json; falls back to docs/tower/hamburg_default.js
Run after `python build.py` (which writes dist/app.full.js).   python build_pages.py [--hamburg-default <tower.json>] [--chattogram-default <tower.json>]
"""
import argparse
import json
import pathlib
import hashlib
import shutil

root = pathlib.Path(__file__).parent
docs = root.parent / "docs" / "tower"
API_FILE = pathlib.Path(__file__).resolve().parent / "api_url.txt"   # the deployed planning API (api/app.py), if any
API = API_FILE.read_text(encoding="utf-8").strip() if API_FILE.exists() else ""
API_JS = f' window.PORTFLOW_API = "{API}";' if API.startswith("https://") else ""
RAW = "https://raw.githubusercontent.com/artahmid03-source/portflow-simopt-mcp/data/{site}/tower.json"

ap = argparse.ArgumentParser()
ap.add_argument("--hamburg-default", default=None, help="a validated hamburg tower.json to embed as the fallback")
ap.add_argument("--chattogram-default", default=None, help="a validated chattogram tower.json to embed as the fallback")
a = ap.parse_args()
docs.mkdir(parents=True, exist_ok=True)
shutil.copyfile(root / "dist" / "app.full.js", docs / "app.js")
ver = hashlib.sha1((docs / "app.js").read_bytes()).hexdigest()[:10]       # cache-busting: browsers keep app.js otherwise
for site, src in (("hamburg", a.hamburg_default), ("chattogram", a.chattogram_default)):
    if src:
        d = json.loads(pathlib.Path(src).read_text())
        (docs / f"{site}_default.js").write_text("window.PORTFLOW_DEFAULT = " + json.dumps(d, separators=(",", ":"), ensure_ascii=False) + ";\n", encoding="utf-8")

def page(site, title, extra_head=""):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="PortFlow: a berth and yard plan for {title.split(' · ')[0]}, re-planned every 4 hours from live AIS and tide data with CP-SAT and a yard simulation.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Rajdhani:wght@500;600;700&display=swap">
{extra_head}<style>:root{{color-scheme:dark}} html,body{{margin:0;background:#05090d;color:#d7e5f0;font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace}}</style>
</head><body><div id="root"></div>
<script>window.PORTFLOW_NAV = true; window.PORTFLOW_DATA_URL = "{RAW.format(site=site)}";{API_JS}</script>
"""

leaflet = '<link rel="stylesheet" href="../vendor/leaflet/leaflet.css">\n<script src="../vendor/leaflet/leaflet.js"></script>\n'


def head(site):
    f = docs / f"{site}_default.js"
    if not f.exists():
        return leaflet
    return leaflet + f'<script src="{f.name}?v={hashlib.sha1(f.read_bytes()).hexdigest()[:10]}"></script>\n'


(docs / "chattogram.html").write_text(page("chattogram", "Chattogram NCT · PortFlow Control Tower", head("chattogram")) + f'<script src="app.js?v={ver}"></script>\n</body></html>\n', encoding="utf-8")
(docs / "hamburg.html").write_text(page("hamburg", "Port of Hamburg · PortFlow Control Tower", head("hamburg")) + f'<script src="app.js?v={ver}"></script>\n</body></html>\n', encoding="utf-8")
print("pages:", sorted(p.name for p in docs.iterdir()), round((docs / "app.js").stat().st_size / 1024), "KB app")
