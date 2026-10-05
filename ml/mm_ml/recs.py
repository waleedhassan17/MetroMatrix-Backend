"""Recommendations — pure functions over interaction lists.

Products: item-to-item collaborative filtering (people who bought / saved /
viewed X also engaged with Y), blended with content similarity (TF-IDF over
name, tags, category and brand) so new products with no history still have
neighbours. Personal lists add up a user's recent items' neighbours.
Evaluation: leave-last-out hit rate @10 against simply showing what is popular.
"""
import math
from collections import defaultdict

import numpy as np

# How much each signal says about taste.
WEIGHTS = {"order": 3.0, "add_to_cart": 2.0, "wishlist": 2.0, "click": 1.0, "view": 1.0}
HALF_LIFE_DAYS = 30.0


def decayed(weight, age_days):
    return weight * math.pow(0.5, max(age_days, 0.0) / HALF_LIFE_DAYS)


def build_matrix(interactions):
    """interactions: iterable of (user, item, weight). → (users, items, dense matrix u×i)."""
    users, items = {}, {}
    cells = defaultdict(float)
    for u, i, w in interactions:
        ui = users.setdefault(u, len(users))
        ii = items.setdefault(i, len(items))
        cells[(ui, ii)] += w
    M = np.zeros((len(users), len(items)))
    for (ui, ii), w in cells.items():
        M[ui, ii] = w
    return list(users), list(items), M


def item_cosine(M):
    """Item-item cosine similarity of a user×item matrix (zero diagonal)."""
    norms = np.linalg.norm(M, axis=0)
    norms[norms == 0] = 1.0
    X = M / norms
    S = X.T @ X
    np.fill_diagonal(S, 0.0)
    return S


def support(M):
    """How many users engaged with both items."""
    B = (M > 0).astype(float)
    C = B.T @ B
    np.fill_diagonal(C, 0.0)
    return C


def content_similarity(texts):
    """TF-IDF cosine over product descriptions (n×n)."""
    from sklearn.feature_extraction.text import TfidfVectorizer

    if len(texts) < 2:
        return np.zeros((len(texts), len(texts)))
    tfidf = TfidfVectorizer(min_df=1, ngram_range=(1, 2), sublinear_tf=True).fit_transform(texts)
    S = (tfidf @ tfidf.T).toarray()
    np.fill_diagonal(S, 0.0)
    return S


def neighbours(item_ids, collab, collab_support, content, k=20, min_support=2):
    """Hybrid neighbours per item: 0.6·collaborative + 0.4·content where at
    least `min_support` people link the pair, content alone otherwise."""
    out = {}
    for a, item in enumerate(item_ids):
        hyb = np.where(collab_support[a] >= min_support, 0.6 * collab[a] + 0.4 * content[a], content[a])
        order = np.argsort(-hyb)[:k]
        out[item] = [
            {"id": item_ids[b], "score": round(float(hyb[b]), 4),
             "reason": "bought_together" if collab_support[a][b] >= min_support else "similar"}
            for b in order if hyb[b] > 0
        ]
    return out


def user_recs(history, nbrs, exclude=None, k=20, names=None):
    """history: [(item, weight)] for one user. Neighbours' scores summed,
    already-ordered items excluded, each pick explained by its top source."""
    exclude = exclude or set()
    scores, because = defaultdict(float), {}
    for item, w in history:
        for n in nbrs.get(item, []):
            if n["id"] in exclude or n["id"] == item:
                continue
            contrib = w * n["score"]
            scores[n["id"]] += contrib
            if contrib > because.get(n["id"], (None, 0))[1]:
                because[n["id"]] = (item, contrib)
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])[:k]
    out = []
    for item, s in ranked:
        src = because[item][0]
        label = (names or {}).get(src)
        out.append({"id": item, "score": round(s, 4), "reason": f"Because you liked {label}" if label else "Picked for you"})
    return out


def popular(counts, k=30):
    return [{"id": i, "score": float(c), "reason": "Popular right now"} for i, c in sorted(counts.items(), key=lambda kv: -kv[1])[:k]]


def hit_rate_at_k(sequences, build_nbrs, popular_items, k=10):
    """Leave-last-out: for each user with ≥2 distinct items, hide the last one,
    recommend from the rest, count a hit if it is in the top k. Returns
    (model rate, popularity rate, users evaluated)."""
    hits = pop_hits = n = 0
    nbrs = build_nbrs()
    pop = [p["id"] for p in popular_items[:k]]
    for user, seq in sequences.items():
        distinct = []
        for item in seq:
            if item not in distinct:
                distinct.append(item)
        if len(distinct) < 2:
            continue
        held, rest = distinct[-1], distinct[:-1]
        recs = [r["id"] for r in user_recs([(i, 1.0) for i in rest], nbrs, exclude=set(rest), k=k)]
        hits += held in recs
        pop_hits += held in [p for p in pop if p not in rest][:k]
        n += 1
    return (hits / n if n else None), (pop_hits / n if n else None), n
