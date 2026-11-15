"""Tide module: the harmonic fit recovers a known signal, and the daily builder works from a store without network."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sites"))
sys.path.insert(0, str(ROOT))
import run_daily  # noqa: E402
import tides  # noqa: E402

T0 = datetime(2026, 10, 15, tzinfo=timezone.utc)


def synthetic(days=31.0, surge=0.0, noise=0.0, step_min=5):
    """A made-up gauge: mean 500 cm, M2 150 cm, S2 40 cm, M4 12 cm, plus optional constant surge in the last two days."""
    rng = np.random.default_rng(1)
    out = []
    for i in range(int(days * 1440 / step_min)):
        t = T0 + timedelta(minutes=i * step_min)
        h = tides.hours(t)
        y = 500 + 150 * np.cos(np.deg2rad(tides.SPEEDS["M2"]) * h - 1.0) + 40 * np.cos(np.deg2rad(tides.SPEEDS["S2"]) * h - 0.3) + 12 * np.cos(np.deg2rad(tides.SPEEDS["M4"]) * h)
        y += surge if i * step_min > (days - 2) * 1440 else 0.0
        out.append((t, float(y + noise * rng.standard_normal())))
    return out


def test_fit_recovers_known_constituents():
    m = tides.fit(synthetic(noise=5.0))
    assert abs(m["mean_cm"] - 500) < 1 and abs(m["amplitude_cm"]["M2"] - 150) < 1 and abs(m["amplitude_cm"]["S2"] - 40) < 1 and abs(m["amplitude_cm"]["M4"] - 12) < 1
    assert m["amplitude_cm"]["K1"] < 1 and m["rms_residual_cm"] < 6


def test_prediction_extends_the_record_and_high_waters_are_12_4_hours_apart():
    lv = synthetic()
    h = tides.holdout(lv)
    assert h["rmse_cm"] < 0.5 and h["hw_time_mae_min"] < 2
    grid = [lv[-1][0] + timedelta(minutes=10 * i) for i in range(6 * 144)]
    highs = [p[0] for p in tides.turning_points(grid, tides.predict(tides.fit(lv), grid)) if p[1] == "H"]
    gaps = [(b - a).total_seconds() / 3600 for a, b in zip(highs, highs[1:])]
    assert all(11.9 < g < 12.9 for g in gaps)


def test_recent_surge_is_carried_forward_and_decays():
    lv = synthetic(surge=40.0)
    model = tides.fit(lv)
    soon, late = lv[-1][0] + timedelta(hours=1), lv[-1][0] + timedelta(days=8)
    lift_soon = float(tides.forecast(lv, [soon], model)[0] - tides.predict(model, [soon])[0])
    lift_late = float(tides.forecast(lv, [late], model)[0] - tides.predict(model, [late])[0])
    assert 15 < lift_soon < 45 and abs(lift_late) < 1.5


def test_mean_low_water_of_the_synthetic_gauge():
    assert 300 < tides.mean_low_water(synthetic()) < 370           # 500 - (150 + 40 on springs, 150 - 40 on neaps), averaged


def test_daily_update_builds_from_a_store_without_network(tmp_path):
    now = T0 + timedelta(days=31)
    site = tmp_path / "hamburg"
    (site / "positions").mkdir(parents=True)
    stamp = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = [{"t": stamp, "mmsi": 1, "lat": 53.54, "lon": 9.93, "sog": 0.0, "cog": 0.0, "hdg": None, "nav": 5, "zone": "PORT", "src": "near"},
            {"t": stamp, "mmsi": 2, "lat": 53.80, "lon": 9.40, "sog": 11.5, "cog": 120.0, "hdg": 120, "nav": 0, "zone": "ELBE", "src": "near"}]
    (site / "positions" / f"{now.strftime('%Y-%m-%d')}.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    (site / "ships.json").write_text(json.dumps({"1": {"name": "FIXTURE A", "imo": 1, "type": 71, "len": 300, "beam": 48}, "2": {"name": "FIXTURE B", "imo": 2, "type": 71, "len": 200, "beam": 32}}))
    (site / "tracked.json").write_text(json.dumps({"2": {"name": "FIXTURE B", "dest": "DEHAM", "draught": 11.2, "eta_utc": "2026-11-15T18:00Z", "first_seen": stamp, "last_seen": stamp}}))
    (site / "runs.jsonl").write_text(json.dumps({"t_end": stamp, "near_ships": 40, "errors": []}))
    doc = run_daily.build(tmp_path, now=now, fetch=lambda name: synthetic())
    assert set(doc["tide"]["gauges"]) == {g for g, _ in run_daily.GAUGES} and not doc["tide"]["errors"]
    g = doc["tide"]["gauges"]["HAMBURG ST. PAULI"]
    assert len(g["hourly_cm"]) == 8 * 24 + 1 and g["forecast_rmse_cm_by_lead"]["6h"] < 1
    v = doc["vessels"]
    assert [x["name"] for x in v["bound_for_hamburg"]] == ["FIXTURE B"] and v["bound_for_hamburg"][0]["zone"] == "ELBE"
    assert v["moored_in_port"] == 1 and len(v["on_the_elbe"]) == 1 and v["runs_last_24h"] == 1
    assert json.loads((site / "latest.json").read_text())["site"] == "hamburg"
    assert "Hamburg daily update" in run_daily.summary(doc)


def test_one_failing_gauge_does_not_lose_the_others(tmp_path):
    def fetch(name):
        if name.startswith("SCHULAU"):
            raise OSError("gauge offline")
        return synthetic()
    doc = run_daily.build(tmp_path, now=T0 + timedelta(days=31), fetch=fetch)
    assert len(doc["tide"]["gauges"]) == 5 and "SCHULAU" in doc["tide"]["errors"][0]
