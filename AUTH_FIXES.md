# MetroMatrix auth fixes — task.md

Backend: `MetroMatrix-Backend` · Frontend: `Waleed-MetroMatrix`
All 26 Jest suites pass (254 passed, 2 DB-gated skips). Frontend `tsc --noEmit` clean.

---

## 1. Summary table

| # | Issue | Root cause (verified in code) | Fix | Test |
|---|---|---|---|---|
| 1 | **Password login fails for everyone** (P0) | `pre('save')` in `User`/`Provider`/**`Admin`** missing `return` after `next()`, so every `save()` re-hashed the stored hash. `loginUser`/`loginProvider` `.select('+password')` then `save()` → one login corrupts the hash. Also called `bcrypt.hash(undefined)` for social accounts. | Extracted `utils/hashPassword.js`; guards on `isModified` **and** `!this.password`, returns from each branch. Applied to all three models. `matchPassword` now returns `false` instead of throwing on a missing hash. | `src/__tests__/passwordHash.test.js` (6 unit + 2 DB-gated) |
| 2 & 5 | **Google/Facebook "Account Already Exists"** (P2) | Client did Firebase `signInWithCredential` *and* a backend call. Firebase threw `auth/account-exists-with-different-credential`; the UI dead-ended on it. Backend `*-login` already auto-links by email, so the Firebase step was the only source of the modal. Signup screen also called the 409-throwing `*-signup` endpoints. | Facebook: Firebase step removed from both screens — raw FB token goes straight to `facebook-login` (backend verifies it via `debug_token`). Google: new `resolveGoogleFirebaseIdToken()` absorbs the collision (links the pending credential, else reuses the current session) instead of dead-ending. Signup slice now calls `googleLoginAPI`/`facebookLoginAPI`. | `src/__tests__/socialAccountLinking.test.js` (11) |
| 3 | **Reset says "No account found" for real users** (P1) | App called `GET /api/auth/check-email-exists` — **a route that does not exist**. It 404'd, and `forgetPassword.ts` mapped 404 → "email doesn't exist". | Preflight deleted from the client (helper removed entirely). `forgot-password` and `resend-reset-otp` now always return `200 {success:true, message:"If an account exists, a reset code has been sent."}` and only mail real accounts. OTP lockout preserved. | `src/__tests__/passwordResetEnumeration.test.js` (7) |
| 4 | **Verification email never arrives / link is dead** (P1) | (a) `createTransporter()` only built a real transporter when `NODE_ENV==='production'`; otherwise a dummy Ethereal account. (b) The verify URL came from `API_URL \|\| CLIENT_URL \|\| localhost`, duplicated in 3 places, still pointing at the retired Heroku dyno. | (a) Real SMTP whenever `EMAIL_HOST`/`EMAIL_USER` is set, in any environment; Ethereal only as a last resort, with a warning. (b) New `utils/publicUrl.js` is the single source of truth, strips a trailing `/api`, and `console.warn`s if the value contains `herokuapp.com`. | `npm run smoke:auth-email`, `npm run smoke:auth` |

### Extra defects found while verifying (not in task.md, all fixed)

| Defect | Why it mattered |
|---|---|
| `Admin.js` had the **same** double-hash bug | Admin logins were corrupting their own hash too. task.md named only User/Provider. |
| `User.phoneNumber` was **unconditionally** `required` | Social create with `phoneNumber: ''` threw a `ValidationError`, so *every brand-new Google/Facebook sign-in 500'd* — not just the modal. Verified with `validateSync()`. Now required only for non-social accounts. |
| `Provider.emailVerified` is `enum('pending'\|'active'\|'inactive')`, but 6 code paths assigned boolean `true` | Mongoose casts to `"true"`, which fails the enum → provider social signup and several verify paths always threw. Added `utils/verificationFlags.js`. |
| `onboardingStatus = 'email_verified'` in `googleLogin` | Not a valid enum value (`pending_email\|pending_documents\|pending_approval\|approved\|rejected`) → provider Google signup threw. Corrected to `pending_documents` at 4 sites. |
| Verification URLs logged with the **raw token** at 5 sites | Anyone with log access could verify any account. Now non-production only. |
| Hardcoded Heroku links in the OTP email footer + privacy page | Dead links in user-facing mail. Now derived from `API_URL`. |

### P3 hardening

| Item | Change |
|---|---|
| Debug routes | `manual-verify`, `reset-verification-limit`, `verification-status/:email` now require **non-production + `protect` + `adminOnly`**. Confirmed live today that `manual-verify` is reachable **unauthenticated** on production — this is a real auth bypass being closed. |
| Secret logging | Auth logger redacted only `password`; now redacts 13 field names (`idToken`, `accessToken`, `refreshToken`, `otp`, `resetToken`, …) recursively, and logs bodies only outside production. `googleLogin` no longer dumps `req.body`. |
| Token lifetime | `JWT_EXPIRE` defaults to **15m**; `expiresIn` is now *derived* from the configured value instead of a hardcoded 30 days. |
| Session invalidation | `resetPassword` clears `refreshToken`, so pre-reset sessions die (`/auth/refresh` checks `user.refreshToken !== token`). |
| Frontend token storage | Added `expo-secure-store` (~15.0.8, bundled in Expo Go — no rebuild needed to test). New `utils/storage_utils/secureStorage.ts` keeps `accessToken`/`refreshToken`/`providerAccessToken`/`adminToken`/`adminRefreshToken` in Keychain/Keystore, **migrates existing AsyncStorage tokens on first read** (no forced re-login), and falls back to AsyncStorage if SecureStore is unavailable. |
| Raw password persistence | `tempPassword`/`providerTempPassword` are no longer written. Auto-login after verification uses the tokens the `/verify-email` deep link already returns (`screens/verify-success`). The keys remain **delete-only** so old installs get their plaintext password purged on upgrade. |
| Silent refresh | `network.ts` retries once on 401 after a **single-flight** refresh. Concurrent 401s await one shared promise — critical because `/auth/refresh` rotates the refresh token, so parallel refreshes would log the user out. |

---

## 2. Environment variables to set in Vercel

Project → Settings → Environment Variables (Production), then **redeploy**.

```
NODE_ENV=production
API_URL=https://metro-matrix-backend.vercel.app     # no /api suffix
CLIENT_URL=https://metro-matrix-backend.vercel.app
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=waleedhassansfd@gmail.com
EMAIL_PASS=<16-char Gmail App Password>
EMAIL_FROM=MetroMatrix <waleedhassansfd@gmail.com>
JWT_EXPIRE=15m
```

`API_URL` is the important one — it is what the emailed links are built from.
Verified today: `https://metro-matrix-backend.vercel.app/verify-email` returns **200**,
and the old `metromatrix-api-2e35f5f074df.herokuapp.com/verify-email` returns **404**.
That 404 *is* Issue 4.

**Verify after redeploy:**
```bash
curl -s https://metro-matrix-backend.vercel.app/api/auth/health | python3 -m json.tool
```
`/auth/health` now also reports `publicBaseUrl`, `publicBaseUrlLooksStale` and an
`email` block (presence only, never values). You want
`publicBaseUrlLooksStale: false` and `email.smtpConfigured: true`.

### Gmail App Password

1. 2-Step Verification must be ON: <https://myaccount.google.com/security> → **2-Step Verification**.
   App passwords do not exist until it is enabled.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Name it (e.g. "MetroMatrix Backend") → **Create**.
4. Copy the 16 characters and paste them into `EMAIL_PASS` **with no spaces**.
5. Never use your normal account password — Gmail rejects it for SMTP.

`waleedhassansfd@gmail.com` can absolutely be the SMTP sender; mail arrives *from*
that address. Gmail's limit is ~500 messages/day, fine for verification and OTP
traffic. `EMAIL_FROM` must contain that same address or Gmail rewrites it.

**Prove it works:**
```bash
npm run smoke:auth-email                       # sends to EMAIL_USER
npm run smoke:auth-email konta6337@gmail.com   # sends to a specific address
```
It runs `transporter.verify()` first (so bad credentials fail with a clear
message) and then prints the real `messageId`.

### Firebase console — the config half of the Google fix

**Authentication → Settings → User account linking** → select
**"Link accounts that use the same email"**.
With "One account per email address" the client-side collision still fires;
`resolveGoogleFirebaseIdToken` now recovers from it, but linking is the correct
setting.

### Facebook console

No change is required for login now that the client no longer creates a Firebase
Facebook credential. If you ever re-enable that path, Firebase Console →
Authentication → Sign-in method → Facebook must carry App ID `26818541697736156`
(the `#100 App_id ... did not match the Viewing App` helper in
`socialAuthConfig.ts` is kept for exactly that diagnosis).

---

## 3. Runbook

```bash
# 1. Confirm the deployment is wired correctly
curl -s $API_URL/api/auth/health | python3 -m json.tool

# 2. Confirm mail actually sends from waleedhassansfd@gmail.com
npm run smoke:auth-email konta6337@gmail.com

# 3. Full user flow (pauses for you to click the link / read the OTP)
API_URL=https://metro-matrix-backend.vercel.app npm run smoke:auth

# 4. Include the provider flow
API_URL=... npm run smoke:auth -- --provider-email=you+prov@gmail.com

# 5. Non-interactive subset (CI-friendly; skips the human steps)
API_URL=... npm run smoke:auth -- --yes --skip-reset
```

`scripts/smoke-auth.js` checks, in order: health + non-Heroku `API_URL` + SMTP
configured → unknown-email reset returns the generic 200 → register → *(pause
for the emailed link)* → login → **login again** (the double-hash regression)
→ third login → `expiresIn` is not the old 30-day constant → forgot-password
returns a reply identical to the unknown-email one → *(pause for OTP)* → verify
OTP → reset → new password works, old one 401s, new one works twice → the
pre-reset refresh token is rejected → provider gates
(`EMAIL_NOT_VERIFIED` → `ACCOUNT_NOT_APPROVED` → 200 + tokens, twice) →
`manual-verify` is not publicly reachable.

### Google — manual, since a real ID token can't be minted headless

1. Brand-new email → "Continue with Google" → expect straight into the app,
   **no "Account Already Exists"**, and `googleId` set on the new document.
2. An email that already has a **password** account → "Continue with Google" →
   expect a successful login and `googleId` attached to that same document
   (no duplicate account).
3. Repeat both from the **sign-up** screen — it now hits the same auto-linking
   endpoint, so the result must be identical.

The find-or-create + linking logic itself is covered headlessly by
`socialAccountLinking.test.js`, which stubs `verifyGoogleIdToken`.

---

## 4. Deliberately not changed

- **`npm run lint` still fails** — and it failed before any of this work: the repo
  has **no ESLint config file at all** (`eslint src/` → "couldn't find a
  configuration file"). Adding one would flag hundreds of pre-existing issues
  across the codebase, which is a separate decision. Instead every touched file
  was `node --check`ed and the full Jest suite run. Say the word and I'll add a
  config plus a baseline.
- **`PendingSignup` stores the signup password in plaintext** for up to 24h
  (`registerUser` → `PendingSignup.create({ password })`, consumed by
  `/verify-email`). Not part of the five issues, and fixing it properly means
  hashing at register and bypassing the model hook at create — a change with real
  regression risk to the flow you're about to test. **Flagging it as the next
  thing worth doing.**
- **`registerUser` leaves the `PendingSignup` row behind if the mail fails**, so a
  retry hits "Signup already pending for this email." Harmless once SMTP works;
  worth a rollback later.
- **`googleSignupAPI`/`facebookSignupAPI` kept** (now unused by the screens) with
  a warning comment, since the `*-signup` backend endpoints still exist.
- **`firebaseSignInWithFacebook` kept** — task.md asked to preserve the `#100`
  App-ID-mismatch diagnostic helper.
- **No API response shape was broken.** All additions are additive
  (`/auth/health` gained fields). Two value changes, both intentional and
  requested: `expiresIn` now reflects the real token lifetime, and the
  reset messages are now the generic anti-enumeration string. The frontend never
  branched on either (`expiresIn` appears only in type declarations).

## 5. Accounts whose password was already corrupted

Any account that logged in successfully at least once under the old hook may
have a double-hashed password stored. **The fix cannot recover those** — the
original hash is gone. Those users must reset their password (which now works,
per Issue 3). New and reset passwords are unaffected from this deploy onward.
