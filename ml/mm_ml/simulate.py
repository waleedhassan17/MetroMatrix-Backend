"""Synthetic demand — for demos and pipeline checks ONLY.

Everything produced from here is registered with trainedOn.source='synthetic'
and the admin charts label it so. It is never mixed into real series.
"""
import numpy as np

WEEKLY = {"homeservice": [1.0, 0.9, 0.95, 1.0, 1.1, 1.5, 1.4], "healthcare": [1.3, 1.2, 1.1, 1.1, 1.0, 0.6, 0.4],
          "shopping": [0.9, 0.85, 0.9, 1.0, 1.2, 1.5, 1.3]}
BASE = {"homeservice": 12, "healthcare": 20, "shopping": 35}
# Fixed per vertical — str hash() is randomised per process and would make runs differ.
SEED_OFFSET = {"homeservice": 11, "healthcare": 23, "shopping": 37}


def synthetic_series(vertical, days, start_weekday, seed=7):
    rng = np.random.default_rng(seed + SEED_OFFSET[vertical])
    w = WEEKLY[vertical]
    trend = np.linspace(1.0, 1.15, days)
    lam = [BASE[vertical] * w[(start_weekday + i) % 7] * trend[i] for i in range(days)]
    return rng.poisson(lam).astype(int).tolist()
