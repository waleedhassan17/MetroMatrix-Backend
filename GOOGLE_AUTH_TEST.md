# Google Auth — Manual Test Checklist

The code-level work (callback URL, stateless JWT issuance, token verification hardening,
fail-clean-not-crash, find-or-create/linking, unit tests) is done and unit-tested — see
`src/__tests__/googleAuth.test.js` (11/11 passing). **None of that proves the live OAuth
flow works.** Clicking through Google's account picker and confirming the deployed Vercel
instance behaves correctly needs a human with a browser and a real Google account. This
is that checklist.

---

## 1. Set env vars in Vercel, then redeploy

Project → Settings → Environment Variables. Set these for the **Production** environment
(and Preview, if you test on preview deployments):

| Variable | Value |
|---|---|
| `BACKEND_URL` | `https://metro-matrix-backend.vercel.app` |
| `GOOGLE_CALLBACK_URL` | `https://metro-matrix-backend.vercel.app/api/auth/google/callback` |
| `GOOGLE_CLIENT_ID` | your existing value (starts `942315940095-t465...`) |
| `GOOGLE_CLIENT_SECRET` | your existing value |
| `FIREBASE_PROJECT_ID` | `metromatrix-c44c6` |
| `FIREBASE_CLIENT_EMAIL` | your existing service account email |
| `FIREBASE_PRIVATE_KEY` | your existing key, **with literal `\n` sequences** (not real newlines) — this is the classic Vercel failure point, see the troubleshooting table |

Do not paste `GOOGLE_CLIENT_SECRET` or `FIREBASE_PRIVATE_KEY` into any file you intend to
share with teammates (Slack, this doc, a committed file) — set them directly in the Vercel
dashboard, one engineer at a time, or through your team's secrets manager.

**A redeploy is required.** Vercel env var changes only take effect on the next deployment
— saving the value alone does nothing to a currently-running instance.

---

## 2. Confirm the Google Cloud Console redirect URI matches exactly

Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client ID →
Authorized redirect URIs. It must contain **exactly**:

```
https://metro-matrix-backend.vercel.app/api/auth/google/callback
```

No trailing slash, no `http://`, no different subdomain. If this doesn't match character-
for-character what the backend sends, Google returns `redirect_uri_mismatch` and nothing
else in this checklist matters until it's fixed.

---

## 3. After redeploy: check `/api/auth/health`

```
GET https://metro-matrix-backend.vercel.app/api/auth/health
```

Expected response:

```json
{
  "success": true,
  "nodeEnv": "production",
  "google": {
    "configured": true,
    "callbackURL": "https://metro-matrix-backend.vercel.app/api/auth/google/callback"
  },
  "facebook": { "configured": true },
  "firebaseAdminInitialized": true
}
```

Checklist:
- [ ] `google.configured` is `true` — if `false`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
      didn't land in the deployed environment.
- [ ] `google.callbackURL` matches the Console redirect URI from step 2 **exactly**.
- [ ] `firebaseAdminInitialized` is `true` — if `false`, the mobile Google sign-in flow
      (`/api/auth/google-login`) will return 503 regardless of what the browser flow does.
- [ ] Check your Vercel function logs for the line `🔗 Google OAuth callback URL in
      effect: ...` — it's logged once per cold start and is the ground truth for what the
      running code actually registered.

This endpoint reports configuration status only — it never returns a secret value.

---

## 4. Browser test — the web/passport OAuth redirect

Open in a browser:

```
https://metro-matrix-backend.vercel.app/api/auth/google
```

Expected: Google's account picker appears → choose/sign in with a real Google account →
you're redirected back to `CLIENT_URL/auth/success?token=...` (or `.../auth/error` on
failure) **without** a `redirect_uri_mismatch` error page from Google itself.

- [ ] No `redirect_uri_mismatch` from Google.
- [ ] Redirected back to your app, not stuck on an error page.
- [ ] If it 503s instead with `"Google login is not configured on this server"`, step 1's
      env vars didn't land — re-check `/api/auth/health`.

## 5. In-app (mobile) test — the flow that matters for real users

Sign in with Google inside the actual MetroMatrix app (the Firebase-ID-token flow via
`/api/auth/google-login`).

- [ ] Sign-in completes and the app lands you authenticated (not stuck on a spinner or
      error toast).
- [ ] Open the `users` (or `providers`) collection in MongoDB Atlas and confirm **exactly
      one** document was created for that email — not two, not zero.
- [ ] Sign out and sign in with Google again with the *same* account: confirm no second
      document was created (this proves the find-or-create match-by-`googleId`-or-email
      logic is working, not just the happy path).
- [ ] If you have an existing password-based test account, try Google sign-in with that
      same email: confirm it logs into the *same* account (gets `googleId` attached) rather
      than creating a duplicate or rejecting — this is the linking behavior documented in
      `authController.js` above the `googleLogin` function.

---

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| `redirect_uri_mismatch` from Google | Console redirect URI, `GOOGLE_CALLBACK_URL` env var, and the actual deployed callback URL don't all match character-for-character | Compare Console (step 2) against `/api/auth/health`'s `google.callbackURL` (step 3) against the `🔗 Google OAuth callback URL in effect` log line |
| `/api/auth/google` returns 503 `GOOGLE_AUTH_NOT_CONFIGURED` | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` missing or not redeployed | `/api/auth/health` → `google.configured` |
| `/api/auth/google-login` (mobile) returns 503 `GOOGLE_AUTH_NOT_CONFIGURED` | Firebase Admin SDK didn't initialize — usually `FIREBASE_PRIVATE_KEY`'s `\n` escaping got mangled in Vercel's env storage | `/api/auth/health` → `firebaseAdminInitialized`; check Vercel function logs for `❌ Failed to initialize Firebase Admin SDK: <specific error>` |
| `/api/auth/google-login` returns 401 "Invalid Google token" for a token you're sure is fresh | The Google OAuth client (`GOOGLE_CLIENT_ID`) doesn't belong to the same Firebase project (`metromatrix-c44c6`) the backend verifies against — see the coupling comment above `googleLogin` in `authController.js` | Firebase Console → confirm the web client under this project matches `GOOGLE_CLIENT_ID` |
| A real user ends up with two accounts for one email | The email-uniqueness DB safeguard should prevent this (`email: { unique: true }` on both `User` and `Provider`) — if it still happened, something bypassed `googleLogin`'s find-or-create path | Check `src/controllers/authController.js`'s `googleLogin`/`googleSignup`, and confirm no other code path creates `User`/`Provider` docs without the `$or: [{googleId}, {email}]` lookup first |
| Works on `localhost` but not on Vercel | `NODE_ENV` is unset on Vercel by default (not `'production'`) — code paths that only checked `=== 'production'` may behave differently in dev vs. deployed | `/api/auth/health` → `nodeEnv` shows exactly what the running instance sees |

---

## What's actually proven vs. what needs your hands

| Check | Verified by |
|---|---|
| Callback URL resolves from `GOOGLE_CALLBACK_URL`, warns on dev-looking URL in prod | Automated (`src/config/passport.js`, exercised in `googleAuth.test.js`) |
| No session/serialize dependency — stateless JWT issuance, Vercel-safe | Confirmed by code inspection: no `express-session`, no `passport.session()`, every `authenticate()` call passes `session: false` |
| Token verified server-side (Firebase Admin), not trusted from client fields | Automated |
| Missing `GOOGLE_CLIENT_ID`/`SECRET` → 503, not a crash | Automated (`googleAuth.test.js`) |
| Firebase Admin init failure → 503, not a crash | Automated (`googleAuth.test.js`) |
| Find-or-create, linking, no duplicate on race | Automated (`googleAuth.test.js`, including a simulated `E11000` race) |
| Google console redirect URI is correct | **You** — step 2 |
| Real browser OAuth redirect completes without `redirect_uri_mismatch` | **You** — step 4 |
| Real in-app Google sign-in works and creates exactly one user | **You** — step 5 |

If the bottom three rows hold, Google auth is genuinely production-ready. The top rows
being green does not imply the bottom ones are — that's the whole reason this file exists.
