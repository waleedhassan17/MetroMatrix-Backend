# Facebook Auth — Manual Test Checklist

The code-level work (callback URL, stateless JWT issuance, server-side token validation via
`debug_token`, the no-email case, find-or-create/linking, fail-clean-not-crash, unit tests)
is done and unit-tested — see `src/__tests__/facebookAuth.test.js` (13/13 passing). **None
of that proves the live login dialog works.** Clicking through Facebook's actual login flow
needs a human with a browser/device and an account that has a role on this app. This is
that checklist.

---

## 1. Set env vars in Vercel, then redeploy

Project → Settings → Environment Variables. Set for **Production** (and Preview, if you
test preview deployments too):

| Variable | Value |
|---|---|
| `BACKEND_URL` | `https://metro-matrix-backend.vercel.app` |
| `FACEBOOK_CALLBACK_URL` | `https://metro-matrix-backend.vercel.app/api/auth/facebook/callback` |
| `FACEBOOK_APP_ID` | `26818541697736156` (unchanged) |
| `FACEBOOK_APP_SECRET` | your existing value (unchanged) |

Don't paste `FACEBOOK_APP_SECRET` into any file you share with teammates — set it directly
in the Vercel dashboard or your team's secrets manager.

**A redeploy is required.** Env var changes only take effect on the next deployment.

---

## 2. Confirm the Facebook Developer Console matches — Strict Mode is ON

Facebook Developers → your app → Facebook Login → Settings:

- **Valid OAuth Redirect URIs** must contain **exactly**:
  ```
  https://metro-matrix-backend.vercel.app/api/auth/facebook/callback
  ```
  Strict Mode is ON for this app, which means Facebook does a byte-for-byte match — no
  trailing slash, no `http://`, nothing extra. Get this wrong and Facebook blocks the
  redirect before your code ever runs.
- **App Domains** (Settings → Basic) should list `metro-matrix-backend.vercel.app`.

---

## 3. After redeploy: check `/api/auth/health`

```
GET https://metro-matrix-backend.vercel.app/api/auth/health
```

Expected relevant section:

```json
{
  "facebook": {
    "configured": true,
    "callbackURL": "https://metro-matrix-backend.vercel.app/api/auth/facebook/callback"
  }
}
```

- [ ] `facebook.configured` is `true` — if `false`, `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`
      didn't land in the deployed environment.
- [ ] `facebook.callbackURL` matches the Console's Valid OAuth Redirect URI **exactly**
      (step 2) — with Strict Mode on, even a trailing slash mismatch fails.
- [ ] Check Vercel function logs for `🔗 Facebook OAuth callback URL in effect: ...` —
      logged once per cold start, the ground truth for what actually registered.

This endpoint reports configuration status only, never a secret value.

---

## 4. The Development-mode gate (read this before testing — it's not a bug)

This app is in **Development mode**. Facebook silently refuses login for any account that
isn't a Tester, Developer, or Admin on the app — there's no error message, the login flow
just doesn't work, which reads exactly like a broken app even when the code is fine.

To test with your own account:
- Facebook Developers → your app → **App roles → Roles** → add your Facebook account with
  a role (Developer or Tester).
- This is **not** the same as "Test users" under Roles — that feature creates fake
  sandbox accounts, not a way to let your real account log in. Use **Roles**, not Test
  Users, for this.
- Alternative: switch the app to **Live** mode. That requires a privacy policy URL and
  (for `public_profile`/`email` beyond what Development mode already grants) may require
  App Review / advanced access, so it's a bigger step than adding a role.

If a teammate can't log in and everything above checks out, this is almost always the
answer: they aren't added under Roles yet.

---

## 5. Browser test — the web/passport OAuth redirect

Open in a browser (logged in as an account with a role — see step 4):

```
https://metro-matrix-backend.vercel.app/api/auth/facebook
```

Expected: Facebook's login/permission dialog appears → approve → redirected back to
`CLIENT_URL/auth/success?token=...` without a "URL Blocked" or redirect-mismatch error.

- [ ] No "This redirect failed because the redirect URI is not white-listed" error.
- [ ] Redirected back to your app, not stuck on a Facebook error page.
- [ ] If it 503s instead with `"Facebook login is not configured on this server"`, step 1's
      env vars didn't land — re-check `/api/auth/health`.

## 6. In-app (mobile) test — the flow that matters for real users

Sign in with Facebook inside the actual MetroMatrix app (the access-token flow via
`/api/auth/facebook-login`), using an account with a role (step 4).

- [ ] Sign-in completes and the app lands you authenticated.
- [ ] Open the `users`/`providers` collection in MongoDB Atlas and confirm **exactly one**
      document was created for that account — not two, not zero.
- [ ] Sign in with Facebook again with the same account: confirm no second document is
      created.
- [ ] **Test the no-email case**: if you have (or can configure) a Facebook test account
      that declines the email permission, confirm the app shows a clear "email permission
      required" message rather than crashing or hanging. (The unit test proves the backend
      returns a clean 400 for this — this step confirms the app surfaces that message
      sensibly instead of a generic error.)
- [ ] If you have an existing password/Google test account, try Facebook sign-in with that
      same email: confirm it logs into the *same* account (gets `facebookId` attached)
      rather than creating a duplicate — the linking behavior documented above
      `facebookLogin` in `authController.js`.

---

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| Login does nothing / silently fails | App is in Development mode and the account isn't a Tester/Developer/Admin | App roles → Roles (step 4) |
| "URL Blocked" / redirect URI mismatch | Console redirect URI, `FACEBOOK_CALLBACK_URL`, and the deployed callback don't match character-for-character (Strict Mode is unforgiving) | Compare Console (step 2) vs `/api/auth/health`'s `facebook.callbackURL` (step 3) vs the `🔗 Facebook OAuth callback URL in effect` log line |
| No email returned from Facebook | Expected — user declined the permission or the account has none. Handled per Part D: clean 400, not a crash | `src/controllers/authController.js`, comment above `facebookLogin`; covered by the "WITHOUT email" unit test |
| `/api/auth/facebook` or `/facebook-login` returns 503 `FACEBOOK_AUTH_NOT_CONFIGURED` | `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` missing or not redeployed | `/api/auth/health` → `facebook.configured` |
| `/api/auth/facebook-login` returns 401 "token was not issued for this app" | The access token came from a different Facebook app than `FACEBOOK_APP_ID` — check what the client SDK is actually configured with | `src/config/facebook.js`'s `validateFacebookAccessToken` (debug_token `app_id` check) |
| A real user ends up with two accounts for one email | The email-uniqueness DB safeguard should prevent this — if it still happened, some other code path is creating `User`/`Provider` docs without the `$or: [{facebookId}, {email}]` lookup first | `authController.js`'s `facebookLogin`/`facebookSignup` |

---

## What's actually proven vs. what needs your hands

| Check | Verified by |
|---|---|
| Callback URL resolves from `FACEBOOK_CALLBACK_URL`, warns on dev-looking URL in prod | Automated (`src/config/passport.js`) |
| No session/serialize dependency — stateless JWT issuance, Vercel-safe | Confirmed by code inspection: no `express-session`, no `passport.session()`, every `authenticate()` call passes `session: false` |
| Access token validated server-side via Graph API `debug_token`, app id checked | Automated (`src/config/facebook.js`, exercised in `facebookAuth.test.js`) |
| No-email case handled cleanly, never a crash | Automated — this is the test to watch |
| Missing `FACEBOOK_APP_ID`/`SECRET` → 503, not a crash | Automated |
| Find-or-create, linking, no duplicate on race | Automated, including a simulated `E11000` race |
| Facebook console redirect URI is correct (Strict Mode) | **You** — step 2 |
| Your test account has a Tester/Developer/Admin role | **You** — step 4 |
| Real browser OAuth redirect completes without a blocked-URL error | **You** — step 5 |
| Real in-app Facebook sign-in works, creates exactly one user, no-email case behaves | **You** — step 6 |

If the bottom four rows hold, Facebook auth is genuinely production-ready. The automated
rows being green does not imply the manual ones are — that's the whole reason this file
exists.
