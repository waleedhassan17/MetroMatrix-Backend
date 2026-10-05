import numpy as np

from mm_ml.recs import build_matrix, content_similarity, decayed, hit_rate_at_k, item_cosine, neighbours, popular, support, user_recs


def test_decay_halves_every_30_days():
    assert decayed(2.0, 0) == 2.0
    assert abs(decayed(2.0, 30) - 1.0) < 1e-9


def test_item_cosine_links_items_bought_together():
    rows = [("u1", "shoe", 1), ("u1", "sock", 1), ("u2", "shoe", 1), ("u2", "sock", 1), ("u3", "kurta", 1)]
    users, items, M = build_matrix(rows)
    S = item_cosine(M)
    i = {name: k for k, name in enumerate(items)}
    assert S[i["shoe"], i["sock"]] > 0.99
    assert S[i["shoe"], i["kurta"]] == 0
    assert support(M)[i["shoe"], i["sock"]] == 2


def test_hybrid_uses_content_for_items_without_shared_buyers():
    items = ["a", "b", "c"]
    collab = np.zeros((3, 3))
    sup = np.zeros((3, 3))
    content = content_similarity(["red running shoe", "red running shoe pro", "silk scarf"])
    nb = neighbours(items, collab, sup, content)
    assert nb["a"][0]["id"] == "b" and nb["a"][0]["reason"] == "similar"


def test_user_recs_exclude_what_was_bought_and_explain():
    nbrs = {"shoe": [{"id": "sock", "score": 0.9}, {"id": "lace", "score": 0.5}]}
    recs = user_recs([("shoe", 2.0)], nbrs, exclude={"lace"}, names={"shoe": "Air Zoom"})
    assert [r["id"] for r in recs] == ["sock"]
    assert recs[0]["reason"] == "Because you liked Air Zoom"


def test_hit_rate_beats_popularity_when_tastes_cluster():
    # Two taste groups; popularity is dominated by group A's items.
    seqs = {}
    for u in range(30):
        seqs[f"a{u}"] = ["a1", "a2", "a3"]
    for u in range(10):
        seqs[f"b{u}"] = ["b1", "b2", "b3"]
    rows = [(u, i, 1.0) for u, s in seqs.items() for i in s[:-1]] + [(u, s[-1], 1.0) for u, s in list(seqs.items())[::2]]
    users, items, M = build_matrix(rows)
    nb = neighbours(items, item_cosine(M), support(M), np.zeros((len(items), len(items))), min_support=1)
    pop = popular({"a1": 30, "a2": 30, "a3": 15, "b1": 10})
    hr, pop_hr, n = hit_rate_at_k(seqs, lambda: nb, pop, k=1)
    assert n == 40 and hr > pop_hr
