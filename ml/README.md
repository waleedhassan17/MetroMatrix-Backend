# MetroMatrix ML batch jobs

Python jobs that learn from platform data and write their results to MongoDB
for the Node API to serve. They run nightly in GitHub Actions
(`.github/workflows/ml-nightly.yml`), never inside the API (`ml/` is in
`.vercelignore`).

| Job | Writes | Served by |
|---|---|---|
| `mm_ml.jobs.forecast_demand` | `ml_demand_forecasts`, `ml_model_registry` (task `demand_forecast`) | `/api/admin/platform/demand`, `/api/insights/demand/mine` |
| `mm_ml.jobs.train_matching` | `ml_model_artifacts`, `ml_model_registry` (task `provider_matching`) | provider search re-ranking (TensorFlow.js in Node) |
| `mm_ml.jobs.recommend` | `ml_user_recs`, `ml_item_similarities`, `ml_popular` | recommendation endpoints |

Rules every job follows:
- **Writes only `ml_*` collections** — `mm_ml.db.MlDatabase.ml()` refuses anything else.
- **Records itself** in `ml_job_runs` (status, rows, error, run URL).
- **Honest metrics.** Forecasts report WAPE / MASE / sMAPE (MAPE is undefined
  on zero-demand days). Models report their baseline alongside their own score.
  Anything trained on simulated data is registered `trainedOn.source: 'synthetic'`
  and labelled so on every screen.

```bash
cd ml
python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python -m pytest -q tests                      # unit tests
MONGO_TEST_URI=mongodb://127.0.0.1:27099/x python -m pytest -q tests   # + DB tests (throwaway DB!)
MONGODB_URI=... python -m mm_ml.jobs.forecast_demand --dry-run
```
