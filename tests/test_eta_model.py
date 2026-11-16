"""v6.5: declared-ETA log, the learned arrival-time model, and its use in the Hamburg live builder."""
import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "sites"), str(ROOT / "ingest"), str(ROOT)]
import eta_log  # noqa: E402
import hamburg as hh  # noqa: E402
import run_eta_model as em  # noqa: E402

UTC = timezone.utc
NOW = datetime(2026, 12, 20, 12, 0, tzinfo=UTC)


def _z(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_log_declared_appends_once_per_ship_eta_and_day(tmp_path):
    site = tmp_path / "hamburg"
    site.mkdir()
    (site / "tracked.json").write_text(json.dumps({
        "1": {"name": "BIG", "len": 300, "eta_utc": "2026-12-21T05:00Z", "last_seen": "2026-12-20T11:00:00Z"},
        "2": {"name": "TUG", "len": 30, "eta_utc": "2026-12-21T05:00Z", "last_seen": "2026-12-20T11:00:00Z"},
        "3": {"name": "OLD", "len": 300, "eta_utc": "2026-12-21T05:00Z", "last_seen": "2026-12-18T11:00:00Z"}}))
    assert eta_log.log_declared(site, NOW) == 1
    assert eta_log.log_declared(site, NOW) == 0
    assert json.loads((site / "eta_log.jsonl").read_text().splitlines()[0])["name"] == "BIG"


def _synthetic_store(tmp_path, n, late_h):
    """n ships that declared an ETA and arrived late_h(lead) hours after it, moored at Burchardkai."""
    site = tmp_path / "s" / "hamburg"
    (site / "positions").mkdir(parents=True)
    q = hh.QUAY_GEOM[next(iter(hh.QUAY_GEOM))]
    (a1, o1), (a2, o2) = q["line"][0], q["line"][1]
    lat, lon = (a1 + a2) / 2, (o1 + o2) / 2
    log, pos = [], {}
    rnd = random.Random(3)
    for i in range(n):
        heard = NOW - timedelta(days=20) + timedelta(hours=13 * i)
        lead = rnd.uniform(12, 120)
        eta = heard + timedelta(hours=lead)
        arr = eta + timedelta(hours=late_h(lead) + rnd.gauss(0, 1.0)) + timedelta(hours=hh.HAM["transit_hrs"])
        log.append({"mmsi": 100 + i, "name": f"S{i}", "heard_utc": _z(heard), "eta_utc": _z(eta), "len": 330})
        for t, sog, zone, la, lo in ((arr, 0.0, "PORT", lat, lon), (arr + timedelta(hours=30), 8.0, "ELBE", 53.6, 9.5)):
            pos.setdefault(t.strftime("%Y-%m-%d"), []).append({"t": _z(t), "mmsi": 100 + i, "lat": la, "lon": lo, "sog": sog, "zone": zone})
    (site / "eta_log.jsonl").write_text("\n".join(json.dumps(r) for r in log))
    for d, rows in pos.items():
        (site / "positions" / f"{d}.jsonl").write_text("\n".join(json.dumps(r) for r in sorted(rows, key=lambda r: r["t"])))
    return site.parent


def test_model_stays_off_until_enough_calls(tmp_path):
    store = _synthetic_store(tmp_path, 8, lambda lead: 0.1 * lead)
    m = em.run(store, NOW)
    assert m["n"] == 8 and not m["active"] and em.predict(m, 48, 330) == 0.0


def test_model_learns_a_lead_dependent_delay_and_is_applied(tmp_path):
    store = _synthetic_store(tmp_path, 36, lambda lead: 2.0 + 0.1 * lead)
    m = em.run(store, NOW)
    assert m["active"] and m["mae_cv_h"] < 0.5 * m["mae_raw_h"]
    assert abs(em.predict(m, 48, 330) - (2.0 + 4.8)) < 1.5
    assert hh.eta_correction(m, 48, 330) == em.predict(m, 48, 330)
    assert hh.eta_correction({"active": False}, 48, 330) == 0.0
