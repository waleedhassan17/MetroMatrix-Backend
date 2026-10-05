"""Forecast accuracy, honestly.

MAPE is undefined on a day with zero demand — and most series here have
plenty — so we report:
  WAPE   sum|a-p| / sum|a|          share of total volume the forecast missed
  sMAPE  mean 2|a-p| / (|a|+|p|)    symmetric, 0..2, zero-safe per point
  MASE   MAE / MAE(seasonal naive)  < 1 beats "same as last week"
Each returns None when it cannot be computed rather than a misleading number.
"""
import numpy as np


def wape(actual, pred):
    a = np.asarray(actual, dtype=float)
    p = np.asarray(pred, dtype=float)
    denom = np.abs(a).sum()
    return None if denom == 0 else float(np.abs(a - p).sum() / denom)


def smape(actual, pred):
    a = np.asarray(actual, dtype=float)
    p = np.asarray(pred, dtype=float)
    denom = np.abs(a) + np.abs(p)
    mask = denom > 0
    if not mask.any():
        return 0.0
    return float(np.mean(2 * np.abs(a - p)[mask] / denom[mask]))


def mase(actual, pred, train, season=7):
    a = np.asarray(actual, dtype=float)
    p = np.asarray(pred, dtype=float)
    t = np.asarray(train, dtype=float)
    if len(t) <= season:
        return None
    scale = np.mean(np.abs(t[season:] - t[:-season]))
    if scale == 0:
        return None
    return float(np.mean(np.abs(a - p)) / scale)
