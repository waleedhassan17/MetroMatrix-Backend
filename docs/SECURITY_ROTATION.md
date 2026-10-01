# Secret rotation register

Both repositories are public. Anything ever committed is public from that commit
on, whether or not it has since been deleted: removing it from HEAD (or even
rewriting history) does not un-leak it. **Rotation is the only fix.**

Generated with `node scripts/secret-scan-history.js <repo>` (reports where a
secret-shaped value was *added* — commit, file, kind — never the value).
CI runs gitleaks on every push from now on.

Scan date: 2026-10-01. Owner for every row: repository owner (needs dashboard
access that this work does not have).

## Backend — `MetroMatrix-Backend`

| Kind | Where | First added | Still at HEAD? | Action |
|---|---|---|---|---|
| Super-admin email + password literal | `src/seeder/adminSeeder.js`, `scripts/seed-accounts.js` (also 4 QA scripts) | 5002436 (2025-11-24), 69fe25a (2026-07-19) | No (removed in admin-hardening) | **Change the super-admin password in production now.** Disable or re-password the seeded moderator. |
| `.env` committed (MongoDB URI with credentials, JWT + refresh secrets, Cloudinary secret, SMTP password, Google/Facebook OAuth client secrets, Firebase private key) | `.env` | f226db9 (2025-11-15), 9167b59 (2026-01-27) | No (untracked since) | Rotate **all** of them: Atlas DB user password, `JWT_SECRET`, `REFRESH_TOKEN_SECRET` (make them different), Cloudinary API secret, SMTP app password, Google + Facebook client secrets, Firebase service-account key (delete the old key in GCP IAM). |
| JWT secret / SMTP password / OAuth secret / Cloudinary secret in docs | `HEROKU_DEPLOYMENT_GUIDE.md`, `QUICK_REFERENCE.md`, `RELEASE_SUMMARY_v2.0.md`, `PROVIDER_ADMIN_API_COMPLETE.md` | bb5cb17 (2025-11-29), 18557b4 (2025-12-04) | No | Covered by the `.env` rotation above if they are the same values; rotate regardless. |
| Admin password literal | `HEROKU_DEPLOYMENT_GUIDE.md` | bb5cb17 (2025-11-29) | No | Covered by the super-admin rotation. |
| Demo passwords (`123456`, `Role@123`-style) | seed + QA scripts, docs | various | No | Seeded demo accounts must not exist in production — see `scripts/audit-prod-hygiene.js` (§5 release). |

False positives (no action): `test/setupEnv.js` (test-only secrets), `src/config/passport.js`
(names the variable; falls back to random bytes), `STRIPE_TESTING.md` (`whsec_XXXX…` placeholder).

## Frontend — `Waleed-MetroMatrix`

| Kind | Where | First added | Still at HEAD? | Action |
|---|---|---|---|---|
| Facebook app secret | `FB.txt`, `FACEBOOK-AUTH-COMPLETE-GUIDE.md` | d0da6f9 (2026-01-31) | No | **Reset the Facebook app secret** (Meta developer console → App settings → Basic), then update the backend env. |
| Admin password literal | `screens/user-authentication/signin-screen/signin.tsx` | 864c4c6 (2026-02-05) | No | Covered by the super-admin rotation. |
| Google API keys (Firebase client config) | `firebaseConfig.ts`, `google-services.json` (+ removed copies) | a7bed48 (2026-01-19) … | Yes (by design) | These ship inside the app and are not secret, but they must be **restricted** in Google Cloud Console (Android package + SHA-1, iOS bundle id; only the Firebase APIs the app uses). |

## History rewrite

A `git filter-repo` pass would shrink the repo and remove the values from
future clones, but it rewrites every commit hash, breaks open branches and
forks, and still does not un-leak anything already cloned. Decide after the
rotation is done; it is tracked in `docs/ADMIN_OPEN_ITEMS.md`.
