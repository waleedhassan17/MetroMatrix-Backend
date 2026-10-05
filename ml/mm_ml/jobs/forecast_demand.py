"""Nightly demand forecast — every vertical, overall and per top segment.

  python -m mm_ml.jobs.forecast_demand               # real data, writes
  python -m mm_ml.jobs.forecast_demand --dry-run     # prints, writes nothing
  python -m mm_ml.jobs.forecast_demand --source synthetic   # demo data, labelled synthetic

Writes ml_demand_forecasts (14 days ahead) and one ml_model_registry row
(task 'demand_forecast') carrying the backtest metrics, so every chart can say
how far to trust it. Old forecast versions are pruned after 30 days.
"""
import argparse
import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone

from ..db import connect
from ..forecasting import choose_method, data_quality, fit_predict
from ..registry import job_run, new_version, register_model
from ..series import labels_for, load_series
from ..simulate import synthetic_series
from ..timeutil import pkt_today

VERTICALS = ("homeservice", "healthcare", "shopping")
HISTORY_DAYS = 180
HORIZON = 14
MAX_SEGMENTS = 12
MIN_SEGMENT_VOLUME = 5


def forecast_series(series, horizon=HORIZON):
    method, metrics = choose_method(series)
    yhat, lo, hi = fit_predict(series, method, horizon)
    return method, metrics, yhat, lo, hi


def pick_segments(series_by_seg, recent_days=90):
    """'all' plus the busiest segments that have enough volume to model."""
    volume = {s: sum(v[-recent_days:]) for s, v in series_by_seg.items() if s != "all"}
    top = [s for s, n in sorted(volume.items(), key=lambda kv: -kv[1]) if n >= MIN_SEGMENT_VOLUME][:MAX_SEGMENTS]
    return ["all"] + top


def build_docs(vertical, segment, label, start_day, yhat, lo, hi, method, version, now):
    return [
        {"vertical": vertical, "segment": segment, "segmentLabel": label,
         "date": (start_day + timedelta(days=i)).isoformat(),
         "yhat": round(float(yhat[i]), 2), "lo": round(float(lo[i]), 2), "hi": round(float(hi[i]), 2),
         "method": method, "version": version, "generatedAt": now}
        for i in range(len(yhat))
    ]


def summarise(per_series):
    def med(key):
        vals = [m[key] for m in per_series if m.get(key) is not None]
        return round(statistics.median(vals), 3) if vals else None

    qualities = Counter(m["dataQuality"] for m in per_series)
    beats_naive = [m for m in per_series if m.get("mase") is not None]
    return {
        "series": len(per_series),
        "wape": med("wape"),
        "mase": med("mase"),
        "smape": med("smape"),
        "shareBeatingLastWeek": round(sum(1 for m in beats_naive if m["mase"] < 1) / len(beats_naive), 2) if beats_naive else None,
        "methods": dict(Counter(m["method"] for m in per_series)),
        "dataQuality": qualities.most_common(1)[0][0] if qualities else "thin",
    }


def run(db, *, source="real", dry=False, now=None):
    now = now or datetime.now(timezone.utc)
    today = pkt_today(now)
    start = today - timedelta(days=HISTORY_DAYS)
    end = today - timedelta(days=1)  # today is incomplete
    version = new_version("df-syn" if source == "synthetic" else "df")
    docs, per_series = [], []
    for vertical in VERTICALS:
        if source == "synthetic":
            series_by_seg = {"all": synthetic_series(vertical, HISTORY_DAYS, start.weekday())}
            labels = {"all": "All (synthetic)"}
        else:
            series_by_seg = load_series(db, vertical, start, end)
            labels = labels_for(db, vertical, [s for s in series_by_seg if s != "all"])
            labels["all"] = "All"
        for seg in pick_segments(series_by_seg):
            series = series_by_seg[seg]
            method, metrics, yhat, lo, hi = forecast_series(series)
            per_series.append({**metrics, "method": method, "dataQuality": data_quality(series), "vertical": vertical, "segment": seg})
            docs.extend(build_docs(vertical, seg, labels.get(seg, seg), today, yhat, lo, hi, method, version, now))

    summary = summarise(per_series)
    if dry:
        print(f"[dry-run] {version}: {len(docs)} forecast rows; {summary}")
        return {"version": version, "rows": len(docs), "summary": summary}

    if docs:
        db.ml("ml_demand_forecasts").insert_many(docs, ordered=False)
    register_model(
        db, task="demand_forecast", version=version, status="active", metrics=summary,
        trained_on={"source": source, "nReal": 0 if source == "synthetic" else HISTORY_DAYS, "nSynthetic": HISTORY_DAYS if source == "synthetic" else 0,
                    "from": datetime(start.year, start.month, start.day, tzinfo=timezone.utc), "to": now},
        gates={"passed": True, "reasons": ["descriptive forecast; accuracy reported, not gated"]},
    )
    db.ml("ml_demand_forecasts").delete_many({"generatedAt": {"$lt": now - timedelta(days=30)}})
    return {"version": version, "rows": len(docs), "summary": summary}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--source", choices=("real", "synthetic"), default="real")
    args = ap.parse_args()
    db = connect()
    if args.dry_run:
        print(run(db, source=args.source, dry=True))
        return
    with job_run(db, "forecast_demand") as state:
        out = run(db, source=args.source)
        state["rows"] = out["rows"]
        print(out)


if __name__ == "__main__":
    main()
