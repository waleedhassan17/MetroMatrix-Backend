"""The whole job against a throwaway MongoDB (skipped unless MONGO_TEST_URI is set)."""
import os
from datetime import datetime, timedelta, timezone

import pytest

URI = os.environ.get("MONGO_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="MONGO_TEST_URI not set")


def test_job_writes_forecasts_and_registry_and_ignores_qa():
    from pymongo import MongoClient

    from mm_ml.db import MlDatabase
    from mm_ml.jobs.forecast_demand import run

    client = MongoClient(URI.rsplit("/", 1)[0] + "/mm_ml_job_test")
    raw = client.get_default_database()
    client.drop_database(raw.name)
    now = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
    rows = []
    for d in range(1, 70):
        created = now - timedelta(days=d)
        for _ in range(3 + (created.weekday() == 5) * 4):
            rows.append({"serviceCategory": "plumbers", "createdAt": created, "description": ""})
        rows.append({"serviceCategory": "plumbers", "createdAt": created, "description": "[QA-E2E x] test"})
    raw.hsbookings.insert_many(rows)

    out = run(MlDatabase(raw), now=now)
    assert out["rows"] > 0
    f = list(raw.ml_demand_forecasts.find({"vertical": "homeservice", "segment": "plumbers"}).sort("date", 1))
    assert len(f) == 14
    assert f[0]["date"] == "2026-10-01"
    # ~3/day weekdays, ~7 on Saturdays — the QA booking per day is excluded.
    assert 2.0 < sum(x["yhat"] for x in f[:7]) / 7 < 5.5
    reg = raw.ml_model_registry.find_one({"task": "demand_forecast"})
    assert reg["status"] == "active" and reg["trainedOn"]["source"] == "real"
    assert reg["metrics"]["series"] >= 2
    assert raw.hsbookings.count_documents({}) == len(rows)  # never wrote to a domain collection
    client.drop_database(raw.name)
