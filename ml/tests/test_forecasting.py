import math

import numpy as np
import pytest

from mm_ml.forecasting import backtest, choose_method, data_quality, fit_predict
from mm_ml.metrics import mase, smape, wape


def weekly(weeks, pattern=(10, 9, 9, 10, 12, 18, 16), noise=0.0, seed=1):
    rng = np.random.default_rng(seed)
    y = np.tile(pattern, weeks).astype(float)
    return (y + rng.normal(0, noise, len(y))).clip(0).tolist()


def test_metrics_are_zero_safe():
    assert wape([0, 0], [1, 1]) is None  # undefined, not a fake number
    assert smape([0, 0], [0, 0]) == 0.0
    assert wape([10, 10], [8, 12]) == pytest.approx(0.2)
    assert mase([10], [10], [5] * 3) is None  # too little history for a seasonal scale


def test_thin_series_gets_a_flat_mean():
    y = [0] * 60 + [1, 0, 2]
    method, _ = choose_method(y)
    assert method == "mean"
    assert data_quality(y) == "thin"


def test_short_series_uses_last_week():
    y = weekly(5)
    method, metrics = choose_method(y)
    assert method == "seasonal_naive"
    yhat, lo, hi = fit_predict(y, "seasonal_naive", 7)
    assert list(yhat) == y[-7:]
    assert all(l <= p <= h for l, p, h in zip(lo, yhat, hi))


def test_long_series_picks_the_backtest_winner_and_beats_naive_on_trend():
    # Weekly pattern plus a steady trend: Holt-Winters should earn its place.
    base = np.array(weekly(12, noise=0.5))
    y = (base + np.linspace(0, 20, len(base))).tolist()
    method, metrics = choose_method(y)
    assert method in ("holt_winters", "seasonal_naive")
    assert metrics["mase"] is not None
    hw = backtest(y, "holt_winters")
    sn = backtest(y, "seasonal_naive")
    assert hw["mase"] < sn["mase"]
    assert method == "holt_winters"


def test_forecasts_are_never_negative():
    y = [5, 0, 0, 0, 0, 0, 0] * 10
    for m in ("mean", "seasonal_naive", "holt_winters"):
        yhat, lo, hi = fit_predict(y, m, 14)
        assert (yhat >= 0).all() and (lo >= 0).all() and (hi >= 0).all()
        assert not any(math.isnan(v) for v in yhat)
