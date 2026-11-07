"""Backtest correctness: Holt parity with the browser code + walk-forward logic."""
import json
import math
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import backtest as bt  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")


def _series(n=200):
    return [100 + 10 * math.sin(i / 5) + 0.3 * i for i in range(n)]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_holt_matches_frontend_core_js():
    prices = _series(31)
    js = (
        "const c=require('./frontend/js/core.js');"
        f"process.stdout.write(JSON.stringify(c.holtForecast({json.dumps(prices)},7)))"
    )
    out = json.loads(subprocess.check_output(["node", "-e", js], cwd=ROOT))
    med, lo, hi = bt.holt_forecast(prices, 7)
    for a, b in zip(out["median"], med):
        assert abs(a - b) < 1e-9
    for a, b in zip(out["low"], lo):
        assert abs(a - b) < 1e-9
    for a, b in zip(out["high"], hi):
        assert abs(a - b) < 1e-9


def test_walk_forward_uses_no_future_data():
    prices = _series(150)
    res, holt, naive, _ = bt.score_series(prices)
    assert res["holt"]["n"] == len(prices) - bt.WARMUP - bt.HORIZON
    # Changing a future price must not change earlier forecasts' predictions.
    prices2 = list(prices)
    prices2[-1] *= 3
    _, holt2, _, _ = bt.score_series(prices2)
    assert [r["ape"] for r in holt[:-bt.HORIZON]] == [r["ape"] for r in holt2[:-bt.HORIZON]]


def test_perfect_trend_scores_perfectly():
    prices = [100 + 2 * i for i in range(150)]
    res, *_ = bt.score_series(prices)
    assert res["holt"]["direction_accuracy"] == 1.0
    assert res["holt"]["mape"] < 1e-6
    assert res["naive"]["mape"] > 0


def test_daily_closes_takes_last_point_per_day():
    day = 86400 * 1000
    raw = [[0, 1.0], [3600_000, 2.0], [day, 3.0], [day + 7200_000, 4.0]]
    assert bt.daily_closes(raw) == [2.0, 4.0]
