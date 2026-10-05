"""Daily demand forecasting — pure functions over a list of daily counts.

Method by how much history a series has:
  < 14 non-zero days   'mean'            the last 14 days' average (honestly flat)
  < 56 days            'seasonal_naive'  the same weekday last week
  otherwise            Holt-Winters (additive, damped trend, weekly season) OR
                       seasonal naive — whichever wins a rolling-origin
                       backtest on MASE. A fancier model must earn its place.
Every forecast is clipped at 0 (demand is never negative) and carries an
approximate 95% band from the method's own in-sample residuals.
"""
import warnings

import numpy as np

from .metrics import mase, smape, wape

SEASON = 7
Z95 = 1.96


def _band(yhat, resid_std):
    lo = np.clip(yhat - Z95 * resid_std, 0, None)
    hi = np.clip(yhat + Z95 * resid_std, 0, None)
    return lo, hi


def fit_predict(series, method, horizon=14):
    y = np.asarray(series, dtype=float)
    if method == "mean" or len(y) < SEASON:
        recent = y[-14:] if len(y) else np.zeros(1)
        level = float(recent.mean()) if len(recent) else 0.0
        yhat = np.full(horizon, level)
        return np.clip(yhat, 0, None), *_band(yhat, float(recent.std()) if len(recent) > 1 else level ** 0.5)

    if method == "seasonal_naive":
        last = y[-SEASON:]
        yhat = np.array([last[i % SEASON] for i in range(horizon)])
        resid = y[SEASON:] - y[:-SEASON]
        return np.clip(yhat, 0, None), *_band(yhat, float(resid.std()) if len(resid) > 1 else 1.0)

    if method == "holt_winters":
        from statsmodels.tsa.holtwinters import ExponentialSmoothing

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = ExponentialSmoothing(
                y, trend="add", damped_trend=True, seasonal="add", seasonal_periods=SEASON,
                initialization_method="estimated",
            ).fit(optimized=True)
        yhat = np.asarray(model.forecast(horizon), dtype=float)
        resid = y - np.asarray(model.fittedvalues, dtype=float)
        return np.clip(yhat, 0, None), *_band(yhat, float(np.std(resid)))

    raise ValueError(f"unknown method {method}")


def backtest(series, method, folds=4, horizon=SEASON):
    """Rolling origin: fit on everything before each of the last `folds` weeks, predict that week."""
    y = np.asarray(series, dtype=float)
    scores = {"wape": [], "mase": [], "smape": []}
    for k in range(folds, 0, -1):
        cut = len(y) - k * horizon
        if cut < 2 * SEASON:
            continue
        train, test = y[:cut], y[cut:cut + horizon]
        pred, _, _ = fit_predict(train, method, horizon=len(test))
        for name, fn in (("wape", lambda: wape(test, pred)), ("mase", lambda: mase(test, pred, train)), ("smape", lambda: smape(test, pred))):
            v = fn()
            if v is not None:
                scores[name].append(v)
    return {k: (float(np.mean(v)) if v else None) for k, v in scores.items()}


def choose_method(series):
    """The method this series has earned, and its backtest metrics."""
    y = np.asarray(series, dtype=float)
    nonzero = int((y > 0).sum())
    if nonzero < 14:
        return "mean", backtest(y, "mean") if len(y) >= 3 * SEASON else {"wape": None, "mase": None, "smape": None}
    if len(y) < 56:
        return "seasonal_naive", backtest(y, "seasonal_naive")
    candidates = {m: backtest(y, m) for m in ("seasonal_naive", "holt_winters")}
    best = min(candidates, key=lambda m: candidates[m]["mase"] if candidates[m]["mase"] is not None else float("inf"))
    return best, candidates[best]


def data_quality(series):
    y = np.asarray(series, dtype=float)
    nonzero = int((y > 0).sum())
    if nonzero < 14:
        return "thin"
    if len(y) < 56:
        return "short"
    return "ok"
