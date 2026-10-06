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
| 5 | ~~Push the `admin-hardening` branches and open PRs.~~ Done: the work is on `main` and live (Vercel). The Oct 2026 QA pass is on `qa/admin-flow-hardening` (local, not pushed). | Repo owner | Pushing `main` deploys. | — |
| 6 | Restrict the Firebase client API keys (Android package + SHA-1, iOS bundle id, allowed APIs). | Repo owner | Google Cloud console. | Medium |
| 7 | Add `TOTP_ENC_KEY` (32 random bytes, base64) to Vercel **before** deploying B1 — production refuses to start without it. | Repo owner | Vercel env access. | High |
| 8 | MetroMatrix-Realtime verifies access tokens with the shared `JWT_SECRET`; make it reject tokens with `typ` other than `access` (refresh tokens now carry `typ: 'refresh'`). | Realtime repo owner | Separate repository, not in scope. | Medium |
| 9 | Create a second super admin (or keep wallet adjustments under `finance.adjustmentApprovalThreshold`): above-threshold adjustments need a *different* super admin to approve. | Repo owner | Organisational decision. | Medium |
| 10 | After deploy, review existing moderators/admins in admin management: schema-default flags (users, shopping, healthcare) were true for every admin historically. | Repo owner | Needs a decision per person. | Medium |
| 11 | Finance UI (wallet list, adjustments, approvals, reconciliation) — backend done, app screens are F5 (SHOULD). | Frontend | Deferred by scope. | Low |
| 12 | `POST /api/admin/provider-submissions` (provider-app onboarding) identifies the provider by the email in the request body and needs no token — anyone who knows a verified, not-yet-submitted provider's email can submit documents for them; `check-status` reveals rejection reasons by email. Email verification already issues the provider a token: require it (`protect` + `providerOnly`, use `req.user`) together with a provider-app change in `networks/authcalls/providerProfile.ts`. | Backend + provider app | Changes provider onboarding, outside the admin console; needs an end-to-end onboarding test on a device. | High |
| 13 | Error tracking (Sentry or similar) with token scrubbing. | Repo owner | Needs an account and DSN. Logs (pino, redacted) + request ids + `/health/ready` are in place. | Low |
| 14 | Type the module endpoints in `docs/admin.openapi.yaml` (home services, healthcare, shopping use a generic envelope schema). | Backend | Incremental; the core console resources are typed. | Low |
| 15 | Restore screen for soft-deleted users and providers. The API exists and is tested (`POST /users\|providers/:id/restore`, super admin only); the app has no list of deleted accounts to restore from. | Frontend + backend (a `?deleted=true` list) | Not in the MUST scope; restore is rare and works via the API. | Low |
| 16 | Visual migration of the healthcare detail screens (doctors, appointments, appointment detail, clinics, reviews, specialties) and the whole shopping admin stack — F4 waves 4–6. Their data and envelope handling were fixed in F2; they still carry their own colours (423 hex literals) and `Alert.alert` (42). | Frontend | Deferred by scope (SHOULD). | Low |
| 17 | B4: audit-log read API and screen (QA Q26 "filters work"), broadcasts (Q27), exports (Q28), global search, finance overview. | Backend + frontend | Deferred by scope (SHOULD/COULD). `/meta` reports these features as off (`featureFlags`). | Low |
| 18 | On-device QA: Q31 (theme, 320 pt width, 1.3× font, notch), Q32 (TalkBack / VoiceOver), Q33 airplane mode mid-action, Q03 a real workday session, Q23 shopping with Cloudinary uploads. Automated evidence is in `docs/ADMIN_QA_MATRIX.md`; these rows need a person and a device build. | Repo owner | Needs a device and an EAS build. | Medium |
| 19 | Payout approval, provider approval and other non-money admin actions rely on the unique ledger idempotency index (or a 409 on a repeated state change) against a double submit. Run `scripts/sync-indexes.js` on every environment (it is in `docs/RELEASE_CHECKLIST.md`); refunds and wallet adjustments no longer depend on it. | Repo owner | Operational. | Medium |
