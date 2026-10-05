"""Daily demand series from the platform's collections (read-only).

  homeservice  booking requests per day  (hsbookings,      segment = serviceCategory)
  healthcare   appointments per day      (appointments,    segment = doctor's specialty)
  shopping     orders per day            (shoppingorders,  segment = brand)

Days are Pakistan days. QA harness bookings ("[QA-E2E ...]") are excluded.
"""
from datetime import datetime, timedelta, timezone

from .timeutil import day_range

QA_REGEX = r"\[QA-E2E"
CATEGORY_LABELS = {"electricians": "Electricians", "plumbers": "Plumbers", "ac-repairers": "AC repairers"}


def _day_expr():
    return {"$dateToString": {"format": "%Y-%m-%d", "date": "$createdAt", "timezone": "+05:00"}}


def _pipeline(vertical, since):
    if vertical == "homeservice":
        return [
            {"$match": {"createdAt": {"$gte": since}, "description": {"$not": {"$regex": QA_REGEX}}}},
            {"$group": {"_id": {"day": _day_expr(), "seg": "$serviceCategory"}, "n": {"$sum": 1}}},
        ]
    if vertical == "shopping":
        return [
            {"$match": {"createdAt": {"$gte": since}}},
            {"$group": {"_id": {"day": _day_expr(), "seg": "$brandId"}, "n": {"$sum": 1}}},
        ]
    if vertical == "healthcare":
        return [
            {"$match": {"createdAt": {"$gte": since}}},
            {"$lookup": {"from": "doctors", "localField": "doctorId", "foreignField": "_id", "as": "d",
                         "pipeline": [{"$project": {"specialtyId": 1}}]}},
            {"$group": {"_id": {"day": _day_expr(), "seg": {"$first": "$d.specialtyId"}}, "n": {"$sum": 1}}},
        ]
    raise ValueError(vertical)


COLLECTIONS = {"homeservice": "hsbookings", "healthcare": "appointments", "shopping": "shoppingorders"}


def rows_to_series(rows, days):
    """{segment: [count per day]} plus 'all', zero-filled over `days` (list of date)."""
    keys = [d.isoformat() for d in days]
    index = {k: i for i, k in enumerate(keys)}
    out = {"all": [0] * len(keys)}
    for r in rows:
        day = r["_id"]["day"]
        if day not in index:
            continue
        seg = r["_id"].get("seg")
        seg = str(seg) if seg is not None else None
        out["all"][index[day]] += r["n"]
        if seg:
            out.setdefault(seg, [0] * len(keys))[index[day]] += r["n"]
    return out


def load_series(db, vertical, start_day, end_day):
    since = datetime(start_day.year, start_day.month, start_day.day, tzinfo=timezone.utc) - timedelta(hours=5)
    rows = list(db.src(COLLECTIONS[vertical]).aggregate(_pipeline(vertical, since)))
    return rows_to_series(rows, day_range(start_day, end_day))


def labels_for(db, vertical, segments):
    if vertical == "homeservice":
        return {s: CATEGORY_LABELS.get(s, s) for s in segments}
    from bson import ObjectId

    ids = [ObjectId(s) for s in segments if ObjectId.is_valid(s)]
    coll = "brands" if vertical == "shopping" else "specialties"
    names = {str(d["_id"]): d.get("name", "") for d in db.src(coll).find({"_id": {"$in": ids}}, {"name": 1})}
    return {s: names.get(s, s) for s in segments}
