"""Provider matching: features, training, honest evaluation, TF.js export.

The model scores one candidate provider for one search: how likely is it that
showing this provider leads to a booking the provider accepts and carries
out? It re-ranks the top of the heuristic's list (services/discoveryPipeline.js);
the heuristic stays the fallback and the baseline it must beat.

FEATURES is the contract with the Node side (src/modules/ml/services/
featureSpec.js): same names, same order, same definitions. Node computes them
at serve time and logs them in ml_search_impressions, so training reads
exactly what serving computed — no train/serve skew by construction.
"""
import base64
import hashlib
import json
import struct

import numpy as np

FEATURES = [
    "distance_term",   # heuristic closeness term, 0..1 (0.5 when distance unknown)
    "distance_known",  # 1 when the provider's base is pinned
    "distance_km",     # min(km, 30) / 30, or 0.5 when unknown
    "rating_term",     # Bayesian rating / 5
    "reviews_log",     # log1p(review count) / log1p(500), capped at 1
    "available_now",   # online, recently seen, inside working hours
    "quality",         # smoothed completion rate
    "price_ratio",     # visit charge / median of the result set, clipped 0..3, / 3
    "is_new",          # fewer than 3 completed jobs
    "online",          # the provider's online toggle
]

DEFAULT_WEIGHTS = {"distance": 0.4, "rating": 0.4, "availability": 0.2, "quality": 0.15}


def heuristic_score(X, weights=None):
    """The production heuristic over the same features — the baseline to beat."""
    w = weights or DEFAULT_WEIGHTS
    i = {n: k for k, n in enumerate(FEATURES)}
    total = sum(w.values()) or 1.0
    return (w["distance"] * X[:, i["distance_term"]] + w["rating"] * X[:, i["rating_term"]]
            + w["availability"] * X[:, i["available_now"]] + w["quality"] * X[:, i["quality"]]) / total


# ── synthetic data (pipeline checks and cold start only) ─────────────────────

def simulate(n_searches=1500, seed=11):
    """Searches of 6–14 candidates; the customer books one by a known logistic
    utility that — unlike the heuristic — dislikes high prices and trusts
    review volume; the booking succeeds with the provider's quality.
    Returns X (n, F), y (n,), groups (n,), times (n,)."""
    rng = np.random.default_rng(seed)
    X, y, groups, times = [], [], [], []
    for s in range(n_searches):
        k = int(rng.integers(6, 15))
        known = rng.random(k) < 0.7
        km = np.where(known, rng.gamma(2.0, 3.0, k).clip(0, 40), np.nan)
        dist_term = np.where(known, 1 - np.minimum(km / 15.0, 1), 0.5)
        reviews = rng.poisson(rng.choice([1, 5, 30, 120], k))
        avg = np.clip(rng.normal(4.3, 0.4, k), 1, 5)
        bayes = (5 * 4.0 + avg * reviews) / (5 + reviews)
        avail = (rng.random(k) < 0.45).astype(float)
        online = np.maximum(avail, (rng.random(k) < 0.2).astype(float))
        completed = rng.poisson(rng.choice([0, 2, 15, 60], k))
        quality = (completed * rng.uniform(0.7, 1.0, k) + 1) / (completed + 2)
        price = rng.lognormal(7.0, 0.35, k)
        ratio = np.clip(price / np.median(price), 0, 3) / 3
        feats = np.column_stack([
            dist_term, known.astype(float), np.where(known, np.minimum(np.nan_to_num(km), 30) / 30, 0.5),
            bayes / 5, np.minimum(np.log1p(reviews) / np.log1p(500), 1), avail, quality, ratio,
            (completed < 3).astype(float), online,
        ])
        # ratio is price/median/3 (~0.33 ± 0.1), so its coefficient is large:
        # paying double the going rate costs about as much as being 6 km further.
        utility = (2.2 * dist_term + 3.0 * (bayes / 5) + 1.4 * avail + 1.5 * quality
                   - 9.0 * ratio + 1.2 * feats[:, 4] + rng.gumbel(0, 0.6, k))
        chosen = int(np.argmax(utility))
        booked = rng.random() < 0.75  # some searches end without a booking
        label = np.zeros(k)
        if booked and rng.random() < quality[chosen]:
            label[chosen] = 1
        X.append(feats)
        y.append(label)
        groups.append(np.full(k, s))
        times.append(np.full(k, s))
    return np.vstack(X), np.concatenate(y), np.concatenate(groups), np.concatenate(times)


# ── evaluation ───────────────────────────────────────────────────────────────

def auc(y, score):
    """Mann–Whitney AUC; None when only one class is present."""
    y = np.asarray(y)
    score = np.asarray(score, dtype=float)
    pos, neg = score[y == 1], score[y == 0]
    if not len(pos) or not len(neg):
        return None
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order))
    ranks[order] = np.arange(1, len(order) + 1)
    # average ties
    allv = np.concatenate([pos, neg])
    for v in np.unique(allv):
        m = allv == v
        if m.sum() > 1:
            ranks[m] = ranks[m].mean()
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def auc_ci(y, score, n_boot=300, seed=3):
    rng = np.random.default_rng(seed)
    y = np.asarray(y)
    score = np.asarray(score)
    vals = []
    for _ in range(n_boot):
        idx = rng.integers(0, len(y), len(y))
        a = auc(y[idx], score[idx])
        if a is not None:
            vals.append(a)
    if not vals:
        return None
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def precision_at_k(y, score, groups, k=5):
    hits, n = 0, 0
    for g in np.unique(groups):
        m = groups == g
        if y[m].sum() == 0:
            continue
        top = np.argsort(-score[m])[:k]
        hits += int(y[m][top].sum() > 0)
        n += 1
    return float(hits / n) if n else None


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


# ── training ─────────────────────────────────────────────────────────────────

def standardize_fit(X):
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std < 1e-6] = 1.0
    return mean, std


def train(X, y, times, seed=7):
    """Time split (oldest 80% / newest 20%), MLP + logistic baseline + heuristic baseline."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.neural_network import MLPClassifier

    cut = np.quantile(times, 0.8)
    tr, te = times <= cut, times > cut
    mean, std = standardize_fit(X[tr])
    Z = (X - mean) / std
    # No early stopping: scikit-learn's version watches validation ACCURACY,
    # which sits near 0.95 whatever the model does when ~5% of rows are
    # positive, so it stopped training after ~20 iterations. A fixed budget
    # with L2 regularisation trains properly.
    mlp = MLPClassifier(hidden_layer_sizes=(16, 8), activation="relu", alpha=1e-2, max_iter=300,
                        early_stopping=False, random_state=seed)
    mlp.fit(Z[tr], y[tr])
    logit = LogisticRegression(max_iter=1000).fit(Z[tr], y[tr])
    return {"mlp": mlp, "logit": logit, "mean": mean, "std": std, "train_mask": tr, "test_mask": te, "Z": Z}


def evaluate(trained, X, y, groups):
    te = trained["test_mask"]
    Z = trained["Z"]
    p_mlp = trained["mlp"].predict_proba(Z[te])[:, 1]
    p_log = trained["logit"].predict_proba(Z[te])[:, 1]
    h = heuristic_score(X[te])
    g = groups[te]
    out = {
        "nTrain": int(trained["train_mask"].sum()), "nTest": int(te.sum()),
        "positivesTest": int(y[te].sum()),
        "auc": auc(y[te], p_mlp), "aucCI": auc_ci(y[te], p_mlp), "brier": brier(y[te], p_mlp),
        "precisionAt5": precision_at_k(y[te], p_mlp, g),
        "baseline": {
            "heuristicAuc": auc(y[te], h), "heuristicPrecisionAt5": precision_at_k(y[te], h, g),
            "logisticAuc": auc(y[te], p_log),
        },
    }
    return out


def gates(metrics, source, min_rows=150, min_pos=15):
    reasons = []
    if source != "real":
        reasons.append("trained on synthetic data — never auto-activated")
    if metrics["nTest"] < min_rows:
        reasons.append(f"test set {metrics['nTest']} < {min_rows} rows")
    if metrics["positivesTest"] < min_pos:
        reasons.append(f"only {metrics['positivesTest']} positive outcomes in test")
    a, h = metrics["auc"], metrics["baseline"]["heuristicAuc"]
    if a is None:
        reasons.append("AUC undefined")
    else:
        if a < max(0.6, (h or 0) + 0.02):
            reasons.append(f"AUC {a:.3f} does not beat the heuristic ({h if h is None else round(h, 3)}) by 0.02")
        if metrics["aucCI"] and metrics["aucCI"][0] <= 0.5:
            reasons.append("AUC confidence interval reaches 0.5")
    return {"passed": not reasons, "reasons": reasons}


# ── export: scikit-learn MLP → TensorFlow.js LayersModel ─────────────────────

def _dense(name, units, activation, input_dim=None):
    cfg = {"name": name, "trainable": True, "dtype": "float32", "units": int(units), "activation": activation,
           "use_bias": True, "kernel_initializer": {"class_name": "Zeros", "config": {}},
           "bias_initializer": {"class_name": "Zeros", "config": {}}, "kernel_regularizer": None,
           "bias_regularizer": None, "activity_regularizer": None, "kernel_constraint": None, "bias_constraint": None}
    if input_dim is not None:
        cfg["batch_input_shape"] = [None, int(input_dim)]
    return {"class_name": "Dense", "config": cfg}


def export_tfjs(mlp):
    """A Keras-2 style Sequential topology + float32 weights, loadable with
    tf.loadLayersModel(tf.io.fromMemory(...)). sklearn's coefs_[i] is
    (in, out) — exactly a Dense kernel — and intercepts_[i] is the bias."""
    layers, specs, blobs = [], [], []
    n = len(mlp.coefs_)
    for i, (W, b) in enumerate(zip(mlp.coefs_, mlp.intercepts_)):
        last = i == n - 1
        name = f"dense_{i + 1}"
        act = "sigmoid" if last else mlp.activation
        layers.append(_dense(name, W.shape[1], act, W.shape[0] if i == 0 else None))
        specs.append({"name": f"{name}/kernel", "shape": list(W.shape), "dtype": "float32"})
        specs.append({"name": f"{name}/bias", "shape": [int(b.shape[0])], "dtype": "float32"})
        blobs.append(np.asarray(W, dtype="<f4").tobytes())
        blobs.append(np.asarray(b, dtype="<f4").tobytes())
    data = b"".join(blobs)
    topology = {"class_name": "Sequential", "config": {"name": "provider_matching", "layers": layers},
                "keras_version": "2.15.0", "backend": "tensorflow"}
    return {
        "format": "tfjs-layers", "modelTopology": topology, "weightSpecs": specs,
        "weightDataB64": base64.b64encode(data).decode("ascii"), "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def parity_fixtures(mlp, mean, std, X, n=20, seed=5):
    """Raw feature rows and the sklearn probability for each — the Node side
    must reproduce these to 1e-4 before it serves the model."""
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(X), size=min(n, len(X)), replace=False)
    raw = X[idx]
    p = mlp.predict_proba((raw - mean) / std)[:, 1]
    return [{"raw": [round(float(v), 6) for v in r], "p": round(float(q), 6)} for r, q in zip(raw, p)]
