import base64
import struct

import numpy as np

from mm_ml.matching import FEATURES, auc, evaluate, export_tfjs, gates, heuristic_score, parity_fixtures, simulate, train


def test_auc_matches_definition():
    assert auc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]) == 0.75
    assert auc([1, 1], [0.2, 0.3]) is None


def test_simulation_shape_and_labels():
    X, y, g, t = simulate(n_searches=50)
    assert X.shape[1] == len(FEATURES)
    assert set(np.unique(y)) <= {0.0, 1.0}
    assert ((X >= 0) & (X <= 1)).all()


def test_model_beats_the_heuristic_on_data_where_price_matters():
    X, y, g, t = simulate(n_searches=1500)
    tr = train(X, y, t)
    m = evaluate(tr, X, y, g)
    assert m["auc"] > m["baseline"]["heuristicAuc"] + 0.02
    # ...and a synthetic model is still never auto-activated.
    gate = gates(m, "synthetic")
    assert not gate["passed"]
    assert any("synthetic" in r for r in gate["reasons"])


def test_gates_need_enough_real_evidence():
    m = {"nTest": 40, "positivesTest": 3, "auc": 0.9, "aucCI": [0.7, 0.95], "baseline": {"heuristicAuc": 0.6}}
    gate = gates(m, "real")
    assert not gate["passed"] and len(gate["reasons"]) == 2
    m.update(nTest=500, positivesTest=60)
    assert gates(m, "real")["passed"]


def test_export_is_a_keras_sequential_with_matching_weights():
    X, y, g, t = simulate(n_searches=300)
    tr = train(X, y, t)
    art = export_tfjs(tr["mlp"])
    layers = art["modelTopology"]["config"]["layers"]
    assert layers[0]["config"]["batch_input_shape"] == [None, len(FEATURES)]
    assert layers[-1]["config"]["activation"] == "sigmoid"
    data = base64.b64decode(art["weightDataB64"])
    expected = sum(int(np.prod(s["shape"])) for s in art["weightSpecs"]) * 4
    assert len(data) == expected == art["sizeBytes"]
    first = struct.unpack("<f", data[:4])[0]
    assert abs(first - float(tr["mlp"].coefs_[0][0, 0])) < 1e-6


def test_numpy_forward_pass_reproduces_sklearn():
    """The same arithmetic TF.js will do, so parity failures point at the export, not the maths."""
    X, y, g, t = simulate(n_searches=300)
    tr = train(X, y, t)
    fixtures = parity_fixtures(tr["mlp"], tr["mean"], tr["std"], X)
    for f in fixtures:
        h = (np.array(f["raw"]) - tr["mean"]) / tr["std"]
        for i, (W, b) in enumerate(zip(tr["mlp"].coefs_, tr["mlp"].intercepts_)):
            h = h @ W + b
            h = np.maximum(h, 0) if i < len(tr["mlp"].coefs_) - 1 else 1 / (1 + np.exp(-h))
        assert abs(float(h[0]) - f["p"]) < 1e-4


def test_heuristic_score_uses_the_production_terms():
    X = np.zeros((1, len(FEATURES)))
    X[0, FEATURES.index("rating_term")] = 1.0
    assert abs(heuristic_score(X)[0] - 0.4 / 1.15) < 1e-9
