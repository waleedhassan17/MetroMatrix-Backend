# Admin console — open items

Everything the admin-hardening work could not finish or verify itself, with an
owner and the reason. "Owner: repo owner" means it needs access this work does
not have (production dashboards, app stores, devices) or a decision only the
owner can make.

| # | Item | Owner | Why it is open | Severity |
|---|---|---|---|---|
| 1 | Rotate every secret listed in `docs/SECURITY_ROTATION.md` — super-admin password first. | Repo owner | Needs Atlas / Vercel / Cloudinary / Google / Meta / Firebase console access. | Critical |
| 2 | Confirm on Vercel that `JWT_SECRET` ≠ `REFRESH_TOKEN_SECRET`, and record the production `JWT_EXPIRE`. Startup now refuses to boot if the two secrets are equal. | Repo owner | Needs Vercel env access. | High |
| 3 | Decide on a `git filter-repo` history rewrite (after rotation). | Repo owner | Rewrites every commit hash; affects all clones/forks. | Medium |
| 4 | Create a staging environment (own Vercel project, own Atlas DB, Stripe test keys) and point the app's preview profile at it. | Repo owner | Needs Vercel/Atlas accounts. Until then the app is verified against a locally run backend. | High |
| 5 | Push the `admin-hardening` branches and open PRs; CI (`.github/workflows/ci.yml`) only runs once pushed. | Repo owner | Pushing publishes; not done without explicit approval. | — |
| 6 | Restrict the Firebase client API keys (Android package + SHA-1, iOS bundle id, allowed APIs). | Repo owner | Google Cloud console. | Medium |
| 7 | Add `TOTP_ENC_KEY` (32 random bytes, base64) to Vercel **before** deploying B1 — production refuses to start without it. | Repo owner | Vercel env access. | High |
| 8 | MetroMatrix-Realtime verifies access tokens with the shared `JWT_SECRET`; make it reject tokens with `typ` other than `access` (refresh tokens now carry `typ: 'refresh'`). | Realtime repo owner | Separate repository, not in scope. | Medium |
| 9 | Create a second super admin (or keep wallet adjustments under `finance.adjustmentApprovalThreshold`): above-threshold adjustments need a *different* super admin to approve. | Repo owner | Organisational decision. | Medium |
| 10 | After deploy, review existing moderators/admins in admin management: schema-default flags (users, shopping, healthcare) were true for every admin historically. | Repo owner | Needs a decision per person. | Medium |
| 11 | Finance UI (wallet list, adjustments, approvals, reconciliation) — backend done, app screens are F5 (SHOULD). | Frontend | Deferred by scope. | Low |
