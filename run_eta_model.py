"""Learned arrival-time model (Hamburg): how far off are the ETAs ships declare on AIS?

The collector logs every declared ETA with the time it was heard (<store>/hamburg/eta_log.jsonl). This script matches
each logged ETA with the call AIS later saw (run_backtest.observed_calls: first report moored at a container quay), and
fits a small ridge regression of the error

    error_h = (observed alongside - passage hours) - declared ETA   ~   lead time, lead^2, ship length

It writes <store>/hamburg/eta_model.json. hamburg.build_live applies the correction only once the model is active: at
least MIN_N matched calls, and a cross-validated mean absolute error at least 10% below that of the raw declared ETAs.
Until then the planner keeps using the declared ETAs, and the page says so.

    python run_eta_model.py --store store
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "sites"))
import hamburg as hh  # noqa: E402
from run_backtest import _jsonl, _utc, observed_calls  # noqa: E402

UTC = timezone.utc
MIN_N = 20
LAMBDA = 1.0
CLIP_H = (-24.0, 48.0)
FEATURES = ["1", "lead_h/24", "(lead_h/24)^2", "len_m/100"]


def features(lead_h: float, len_m: Optional[float]) -> np.ndarray:
    x = max(0.0, min(lead_h, 240.0)) / 24.0
    return np.array([1.0, x, x * x, (len_m or 250.0) / 100.0])


predict = hh.eta_correction          # hours to add to a declared ETA; same features as features() above (0 until active)


def samples(site: Path, now: datetime) -> List[Dict[str, Any]]:
    since = now - timedelta(days=45)
    calls = observed_calls(site, since, now)
    T = hh.HAM["transit_hrs"]
    out, used = [], set()
    for r in _jsonl(site / "eta_log.jsonl"):
        heard, eta = _utc(r["heard_utc"]), _utc(r["eta_utc"])
        if heard < since or eta > now - timedelta(hours=12) or eta < heard - timedelta(hours=6):
            continue
        best = None
        for c in calls.get(str(r["mmsi"]), []):
            arr = _utc(c["alongside_utc"]) - timedelta(hours=T)
            if arr < heard - timedelta(hours=2):
                continue                                     # a call that started before the ETA was heard
            err = (arr - eta).total_seconds() / 3600.0
            if -24 <= err <= 96 and (best is None or abs(err) < abs(best)):
                best = err
        key = (r["mmsi"], r["eta_utc"], r["heard_utc"][:10])
        if best is not None and key not in used:
            used.add(key)
            out.append({"mmsi": r["mmsi"], "name": r.get("name"), "lead_h": round((eta - heard).total_seconds() / 3600.0, 1),
                        "len_m": r.get("len"), "err_h": round(best, 1)})
    return out


def _ridge(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    P = LAMBDA * np.eye(X.shape[1])
    P[0, 0] = 0.0                                            # do not shrink the bias
    return np.linalg.solve(X.T @ X + P, X.T @ y)


def fit(recs: List[Dict[str, Any]], now: datetime) -> Dict[str, Any]:
    n = len(recs)
    base = {"fitted_utc": now.isoformat(timespec="seconds"), "n": n, "min_n": MIN_N, "features": FEATURES, "clip_h": list(CLIP_H),
            "target": "observed alongside minus passage hours, minus declared ETA (hours)"}
    if n < MIN_N:
        return {**base, "active": False, "reason": f"{n} matched calls so far; the model starts at {MIN_N}"}
    X = np.array([features(r["lead_h"], r["len_m"]) for r in recs])
    y = np.array([r["err_h"] for r in recs])
    folds = np.arange(n) % 5
    pred = np.zeros(n)
    for k in range(5):                                       # 5-fold cross-validation
        tr, te = folds != k, folds == k
        pred[te] = np.clip(X[te] @ _ridge(X[tr], y[tr]), *CLIP_H)
    mae_raw, mae_cv = float(np.mean(np.abs(y))), float(np.mean(np.abs(y - pred)))
    coef = _ridge(X, y)
    active = mae_cv < 0.9 * mae_raw
    return {**base, "active": bool(active), "coef": [round(float(c), 4) for c in coef], "mae_raw_h": round(mae_raw, 1), "mae_cv_h": round(mae_cv, 1),
            "bias_raw_h": round(float(np.mean(y)), 1),
            "reason": "cross-validated error at least 10% below the declared ETAs" if active else "does not beat the declared ETAs by 10% yet"}


def run(store: Path, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or datetime.now(UTC)
    site = store / "hamburg"
    recs = samples(site, now)
    model = fit(recs, now)
    model["records"] = recs[-300:]
    (site / "eta_model.json").write_text(json.dumps(model, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return model


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", default="store")
    m = run(Path(ap.parse_args().store))
    md = (f"### Learned arrival-time model (Hamburg)\n\n{m['n']} declared ETAs matched to calls seen on AIS. "
          f"{'Active' if m['active'] else 'Not active'}: {m['reason']}." + (f" Mean abs. error: declared {m['mae_raw_h']} h, model (cross-validated) {m['mae_cv_h']} h." if "mae_raw_h" in m else "") + "\n")
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
