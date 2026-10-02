"""Model registry and job-run bookkeeping (ml_model_registry, ml_job_runs)."""
import os
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc)


@contextmanager
def job_run(db, job):
    """Record a job execution; the row says 'failed' with the error if the body raises."""
    runs = db.ml("ml_job_runs")
    row = {"job": job, "startedAt": _now(), "status": "running", "rows": 0,
           "gitSha": os.environ.get("GIT_SHA", ""), "runUrl": os.environ.get("RUN_URL", "")}
    _id = runs.insert_one(row).inserted_id
    state = {"rows": 0, "status": "ok"}
    try:
        yield state
    except Exception as e:  # noqa: BLE001 — recorded, then re-raised
        runs.update_one({"_id": _id}, {"$set": {"status": "failed", "error": f"{e}\n{traceback.format_exc()[-1500:]}", "finishedAt": _now()}})
        raise
    else:
        runs.update_one({"_id": _id}, {"$set": {"status": state["status"], "rows": state["rows"], "finishedAt": _now()}})


def register_model(db, *, task, version, metrics, trained_on, status="candidate", gates=None, **extra):
    doc = {
        "task": task, "version": version, "status": status, "metrics": metrics, "trainedOn": trained_on,
        "gates": gates or {"passed": status == "active", "reasons": []},
        "gitSha": os.environ.get("GIT_SHA", ""), "runUrl": os.environ.get("RUN_URL", ""),
        "createdAt": _now(), **extra,
    }
    return db.ml("ml_model_registry").insert_one(doc).inserted_id


def new_version(prefix):
    return f"{prefix}-{_now().strftime('%Y%m%d-%H%M%S')}"
