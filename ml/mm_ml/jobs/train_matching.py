"""Train the provider-matching model.

  python -m mm_ml.jobs.train_matching                 # real impressions + outcomes
  python -m mm_ml.jobs.train_matching --source synthetic
  python -m mm_ml.jobs.train_matching --dry-run

Rows: every provider shown in a logged search (ml_search_impressions, written by
the API at serve time with its features). Label 1 when that impression led to a
booking (hsbookings.rankingContext.searchId) the provider accepted or carried
out; otherwise 0. With too few real rows the job trains on simulated data
instead, registers it as synthetic and leaves it a candidate.
"""
import argparse
from datetime import datetime, timedelta, timezone

import numpy as np

from ..db import connect
from ..matching import FEATURES, evaluate, export_tfjs, gates, parity_fixtures, simulate, train
from ..registry import job_run, new_version, register_model

GOOD = {"ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"}
MIN_REAL_ROWS = 750


def load_real(db, since):
    impressions = list(db.src("ml_search_impressions").find({"createdAt": {"$gte": since}}))
    search_ids = [i["searchId"] for i in impressions]
    outcomes = {}
    for b in db.src("hsbookings").find({"rankingContext.searchId": {"$in": search_ids}}, {"rankingContext": 1, "provider": 1, "status": 1}):
        outcomes[(b["rankingContext"]["searchId"], str(b["provider"]))] = b["status"] in GOOD
    X, y, groups, times = [], [], [], []
    for g, imp in enumerate(impressions):
        t = imp["createdAt"].timestamp()
        for item in imp.get("items", []):
            f = item.get("features") or {}
            if any(name not in f for name in FEATURES):
                continue
            X.append([float(f[name]) for name in FEATURES])
            y.append(1.0 if outcomes.get((imp["searchId"], str(item["providerId"]))) else 0.0)
            groups.append(g)
            times.append(t)
    if not X:
        return None
    return np.array(X), np.array(y), np.array(groups), np.array(times)


def run(db, *, source="real", dry=False, now=None):
    now = now or datetime.now(timezone.utc)
    data = None if source == "synthetic" else load_real(db, now - timedelta(days=120))
    used = "real"
    if data is None or len(data[0]) < MIN_REAL_ROWS or data[1].sum() < 20:
        n_real = 0 if data is None else len(data[0])
        data = simulate()
        used = "synthetic"
    else:
        n_real = len(data[0])
    X, y, groups, times = data
    trained = train(X, y, times)
    metrics = evaluate(trained, X, y, groups)
    gate = gates(metrics, used)
    version = new_version("pm")
    artifact = export_tfjs(trained["mlp"])
    fixtures = parity_fixtures(trained["mlp"], trained["mean"], trained["std"], X)
    feature_spec = {"names": FEATURES, "mean": [float(v) for v in trained["mean"]], "std": [float(v) for v in trained["std"]]}

    # Logistic coefficients on the four heuristic terms → a data-informed suggestion
    # for the heuristic's own weights (admins may apply it; it is never applied automatically).
    coef = trained["logit"].coef_[0] / trained["std"]
    idx = {n: i for i, n in enumerate(FEATURES)}
    raw = {k: max(0.0, float(coef[idx[f]])) for k, f in
           (("distance", "distance_term"), ("rating", "rating_term"), ("availability", "available_now"), ("quality", "quality"))}
    total = sum(raw.values()) or 1.0
    recommended = {k: round(v / total, 3) for k, v in raw.items()}

    summary = {"version": version, "source": used, "nReal": n_real, "metrics": metrics, "gates": gate, "recommendedWeights": recommended}
    if dry:
        print(summary)
        return summary

    art_id = db.ml("ml_model_artifacts").insert_one({"task": "provider_matching", "version": version, **artifact, "createdAt": now}).inserted_id
    register_model(
        db, task="provider_matching", version=version,
        status="active" if gate["passed"] else "candidate",
        metrics=metrics, gates=gate,
        trained_on={"source": used, "nReal": n_real, "nSynthetic": 0 if used == "real" else int(len(X)),
                    "from": now - timedelta(days=120), "to": now},
        featureSpec=feature_spec, artifactId=art_id, parityFixtures=fixtures, recommendedWeights=recommended,
    )
    # An older active model is archived only when a new one passes on its own.
    if gate["passed"]:
        db.ml("ml_model_registry").update_many(
            {"task": "provider_matching", "status": "active", "version": {"$ne": version}}, {"$set": {"status": "archived"}}
        )
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--source", choices=("real", "synthetic"), default="real")
    args = ap.parse_args()
    db = connect()
    if args.dry_run:
        run(db, source=args.source, dry=True)
        return
    with job_run(db, "train_matching") as state:
        out = run(db, source=args.source)
        state["rows"] = out["metrics"]["nTrain"] + out["metrics"]["nTest"]
        print({k: out[k] for k in ("version", "source", "gates")}, out["metrics"]["auc"], out["metrics"]["baseline"])


if __name__ == "__main__":
    main()
