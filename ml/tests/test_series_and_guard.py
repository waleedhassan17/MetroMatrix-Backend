from datetime import date

import pytest

from mm_ml.db import MlDatabase
from mm_ml.jobs.forecast_demand import pick_segments, summarise
from mm_ml.series import rows_to_series
from mm_ml.simulate import synthetic_series
from mm_ml.timeutil import day_range


def test_rows_to_series_zero_fills_and_sums_all():
    days = day_range(date(2026, 9, 28), date(2026, 9, 30))
    rows = [
        {"_id": {"day": "2026-09-28", "seg": "plumbers"}, "n": 2},
        {"_id": {"day": "2026-09-30", "seg": "electricians"}, "n": 1},
        {"_id": {"day": "2026-09-30", "seg": None}, "n": 4},
        {"_id": {"day": "2020-01-01", "seg": "plumbers"}, "n": 99},  # outside the window
    ]
    s = rows_to_series(rows, days)
    assert s["all"] == [2, 0, 5]
    assert s["plumbers"] == [2, 0, 0]
    assert s["electricians"] == [0, 0, 1]


def test_segments_need_volume():
    s = {"all": [1] * 100, "busy": [1] * 100, "quiet": [0] * 99 + [1]}
    assert pick_segments(s) == ["all", "busy"]


def test_write_guard_refuses_domain_collections():
    db = MlDatabase({"ml_demand_forecasts": "ok", "hsbookings": "nope"})
    assert db.ml("ml_demand_forecasts") == "ok"
    with pytest.raises(PermissionError):
        db.ml("hsbookings")
    assert db.src("hsbookings") == "nope"  # reading is fine


def test_synthetic_series_is_deterministic():
    assert synthetic_series("shopping", 30, 0) == synthetic_series("shopping", 30, 0)


def test_summary_reports_medians_and_quality():
    out = summarise([
        {"wape": 0.2, "mase": 0.8, "smape": 0.3, "method": "seasonal_naive", "dataQuality": "short"},
        {"wape": 0.4, "mase": 1.2, "smape": 0.5, "method": "holt_winters", "dataQuality": "ok"},
        {"wape": None, "mase": None, "smape": 0.0, "method": "mean", "dataQuality": "short"},
    ])
    assert out["wape"] == 0.3 and out["mase"] == 1.0
    assert out["shareBeatingLastWeek"] == 0.5
    assert out["dataQuality"] == "short"
