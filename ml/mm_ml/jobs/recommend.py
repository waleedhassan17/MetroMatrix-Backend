"""Nightly recommendations for all three modules.

  python -m mm_ml.jobs.recommend            # writes
  python -m mm_ml.jobs.recommend --dry-run

Writes (only ml_* collections):
  ml_item_similarities  shopping: each product's similar / bought-together products
  ml_user_recs          shopping: products per customer; healthcare: doctors per
                        patient; homeservice: service categories per customer
  ml_popular            shopping: what sells now
  ml_model_registry     task 'recs_products' with leave-last-out hit rate @10
                        against the popularity baseline
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from ..db import connect
from ..recs import (WEIGHTS, build_matrix, content_similarity, decayed, hit_rate_at_k, item_cosine, neighbours,
                    popular, support, user_recs)
from ..registry import job_run, new_version, register_model

WINDOW_DAYS = 120


def _age(now, ts):
    return (now - ts.replace(tzinfo=ts.tzinfo or timezone.utc)).total_seconds() / 86400 if ts else 0


def shopping_interactions(db, now):
    since = now - timedelta(days=WINDOW_DAYS)
    out = []  # (user, item, weight, ts, kind)
    for o in db.src("shoppingorders").find({"createdAt": {"$gte": since}}, {"userId": 1, "items.productId": 1, "createdAt": 1}):
        for it in o.get("items", []):
            out.append((str(o["userId"]), str(it["productId"]), WEIGHTS["order"], o["createdAt"], "order"))
    for w in db.src("shoppingwishlists").find({}, {"userId": 1, "items": 1}):
        for it in w.get("items", []):
            ts = it.get("addedAt") or now
            if ts.replace(tzinfo=ts.tzinfo or timezone.utc) >= since:
                out.append((str(w["userId"]), str(it["product"]), WEIGHTS["wishlist"], ts, "wishlist"))
    for e in db.src("ml_events").find({"module": "shopping", "type": {"$in": ["view", "click", "add_to_cart", "wishlist"]},
                                        "userId": {"$ne": None}, "refId": {"$ne": None}, "ts": {"$gte": since}},
                                       {"userId": 1, "refId": 1, "type": 1, "ts": 1}):
        out.append((str(e["userId"]), e["refId"], WEIGHTS.get(e["type"], 1.0), e["ts"], e["type"]))
    return out


def product_texts(db, item_ids):
    from bson import ObjectId

    oids = [ObjectId(i) for i in item_ids if ObjectId.is_valid(i)]
    prods = {str(p["_id"]): p for p in db.src("shoppingproducts").find({"_id": {"$in": oids}}, {"name": 1, "tags": 1, "categoryId": 1, "brandId": 1})}
    cats = {str(c["_id"]): c.get("name", "") for c in db.src("shoppingcategories").find({}, {"name": 1})}
    brands = {str(b["_id"]): b.get("name", "") for b in db.src("brands").find({}, {"name": 1})}
    texts, names = [], {}
    for i in item_ids:
        p = prods.get(i, {})
        names[i] = p.get("name")
        texts.append(" ".join([p.get("name", ""), " ".join(p.get("tags", [])), cats.get(str(p.get("categoryId")), ""),
                               brands.get(str(p.get("brandId")), "")]).lower())
    return texts, names


def run_shopping(db, now, version, dry):
    rows = shopping_interactions(db, now)
    if not rows:
        return {"items": 0, "users": 0, "metrics": None}
    weighted = [(u, i, decayed(w, _age(now, ts))) for u, i, w, ts, _ in rows]
    users, items, M = build_matrix(weighted)
    collab, sup = item_cosine(M), support(M)
    texts, names = product_texts(db, items)
    content = content_similarity(texts)
    nbrs = neighbours(items, collab, sup, content)

    ordered_by_user = defaultdict(set)
    sequences = defaultdict(list)
    for u, i, w, ts, kind in sorted(rows, key=lambda r: r[3]):
        sequences[u].append(i)
        if kind == "order":
            ordered_by_user[u].add(i)
    recent_orders = Counter(i for u, i, w, ts, kind in rows if kind == "order" and _age(now, ts) <= 14)
    pop = popular(recent_orders or Counter(i for u, i, *_ in rows))

    history = defaultdict(lambda: defaultdict(float))
    for u, i, w in weighted:
        history[u][i] += w
    recs = {u: user_recs(list(h.items()), nbrs, exclude=ordered_by_user[u], names=names) for u, h in history.items()}

    def build_from_rest():
        return nbrs

    hr, pop_hr, n_eval = hit_rate_at_k(sequences, build_from_rest, pop)
    metrics = {"hitRate10": hr, "popularityHitRate10": pop_hr, "usersEvaluated": n_eval, "items": len(items), "users": len(users)}
    if not dry:
        sims = db.ml("ml_item_similarities")
        sims.delete_many({"domain": "shopping"})
        if nbrs:
            sims.insert_many([{"domain": "shopping", "itemId": i, "neighbors": n, "version": version, "generatedAt": now} for i, n in nbrs.items()])
        urecs = db.ml("ml_user_recs")
        urecs.delete_many({"domain": "shopping"})
        if recs:
            urecs.insert_many([{"userId": u, "domain": "shopping", "items": r, "version": version, "generatedAt": now,
                                "expiresAt": now + timedelta(days=3)} for u, r in recs.items() if r])
        db.ml("ml_popular").delete_many({"domain": "shopping"})
        db.ml("ml_popular").insert_one({"domain": "shopping", "segment": "all", "items": pop, "version": version, "generatedAt": now})
    return {"items": len(items), "users": len(users), "metrics": metrics}


def run_healthcare(db, now, version, dry):
    """Doctors in the specialties a patient has seen, best-rated first (Bayesian)."""
    since = now - timedelta(days=365)
    appts = list(db.src("appointments").find({"createdAt": {"$gte": since}}, {"patientId": 1, "doctorId": 1}))
    if not appts:
        return {"users": 0}
    doctors = {str(d["_id"]): d for d in db.src("doctors").find({"verificationStatus": "verified", "isActive": True},
                                                                {"specialtyId": 1, "rating": 1, "totalReviews": 1})}
    specs = {str(s["_id"]): s.get("name", "") for s in db.src("specialties").find({}, {"name": 1})}
    by_spec = defaultdict(list)
    for did, d in doctors.items():
        n = d.get("totalReviews") or 0
        bayes = (5 * 4.0 + (d.get("rating") or 0) * n) / (5 + n)
        by_spec[str(d.get("specialtyId"))].append((did, bayes))
    for v in by_spec.values():
        v.sort(key=lambda t: -t[1])
    affinity = defaultdict(Counter)
    seen = defaultdict(set)
    for a in appts:
        d = doctors.get(str(a["doctorId"]))
        if d:
            affinity[str(a["patientId"])][str(d.get("specialtyId"))] += 1
            seen[str(a["patientId"])].add(str(a["doctorId"]))
    docs = []
    for patient, spec_counts in affinity.items():
        items = []
        for spec, _ in spec_counts.most_common(3):
            for did, score in by_spec.get(spec, [])[:4]:
                items.append({"id": did, "score": round(score, 3),
                              "reason": ("See again" if did in seen[patient] else f"Top-rated in {specs.get(spec, 'your specialty')}")})
        if items:
            docs.append({"userId": patient, "domain": "healthcare", "items": items[:10], "version": version, "generatedAt": now,
                         "expiresAt": now + timedelta(days=3)})
    if not dry:
        db.ml("ml_user_recs").delete_many({"domain": "healthcare"})
        if docs:
            db.ml("ml_user_recs").insert_many(docs)
    return {"users": len(docs)}


def run_homeservice(db, now, version, dry):
    """Service categories per customer, from what they booked (completed counts most)."""
    weight = {"COMPLETED": 3.0, "IN_PROGRESS": 2.0, "ARRIVED": 2.0, "EN_ROUTE": 2.0, "ACCEPTED": 2.0, "PENDING": 1.0}
    aff = defaultdict(Counter)
    for b in db.src("hsbookings").find({"createdAt": {"$gte": now - timedelta(days=365)}, "description": {"$not": {"$regex": r"\[QA-E2E"}}},
                                        {"customer": 1, "serviceCategory": 1, "status": 1, "createdAt": 1}):
        aff[str(b["customer"])][b.get("serviceCategory")] += decayed(weight.get(b.get("status"), 0.5), _age(now, b["createdAt"]))
    docs = [{"userId": u, "domain": "homeservice", "items": [{"id": c, "score": round(s, 3), "reason": "You booked this before"} for c, s in cnt.most_common(3) if c],
             "version": version, "generatedAt": now, "expiresAt": now + timedelta(days=3)} for u, cnt in aff.items()]
    if not dry:
        db.ml("ml_user_recs").delete_many({"domain": "homeservice"})
        if docs:
            db.ml("ml_user_recs").insert_many(docs)
    return {"users": len(docs)}


def run(db, *, dry=False, now=None):
    now = now or datetime.now(timezone.utc)
    version = new_version("recs")
    shop = run_shopping(db, now, version, dry)
    hc = run_healthcare(db, now, version, dry)
    hs = run_homeservice(db, now, version, dry)
    summary = {"version": version, "shopping": shop, "healthcare": hc, "homeservice": hs}
    if not dry and shop.get("metrics"):
        m = shop["metrics"]
        register_model(db, task="recs_products", version=version, status="active", metrics=m,
                       trained_on={"source": "real", "nReal": m["users"], "nSynthetic": 0},
                       gates={"passed": True, "reasons": ["descriptive; hit rate reported against popularity"]})
    if dry:
        print(summary)
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--source", choices=("real", "synthetic"), default="real")
    args = ap.parse_args()
    if args.source == "synthetic":
        print("recommendations are built from real interactions only — nothing to do for synthetic")
        return
    db = connect()
    if args.dry_run:
        run(db, dry=True)
        return
    with job_run(db, "recommend") as state:
        out = run(db)
        state["rows"] = out["shopping"]["items"] + out["healthcare"]["users"] + out["homeservice"]["users"]
        print(out)


if __name__ == "__main__":
    main()
