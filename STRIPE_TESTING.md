# STRIPE_TESTING — how to prove the wallet top-up flow actually works

This is written for the person running the demo, not just the code. Follow it in order. The whole
point is verifying the balance **in the database**, not trusting a green checkmark on Stripe's screen.

---

## 1. Get test keys

1. Log into the [Stripe Dashboard](https://dashboard.stripe.com) → toggle **Test mode** (top-right).
2. Developers → API keys:
   - **Secret key** (`sk_test_...`) → `STRIPE_SECRET_KEY`
   - **Publishable key** (`pk_test_...`) → `STRIPE_PUBLISHABLE_KEY`
3. Put both in `.env` (copy `.env.example` if you haven't already — every var there has a comment
   explaining what it's for).

Test mode never touches real money and never charges a real card, even with a valid card number.

## 2. Get a webhook signing secret and forward events to your local server

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli) once, then:

```bash
stripe login
stripe listen --forward-to localhost:5000/api/wallet/webhook
```

This prints a line like:

```
> Ready! Your webhook signing secret is whsec_XXXXXXXXXXXXXXXXXXXXXXXXXXXX (^C to quit)
```

Copy that `whsec_...` value into `.env` as `STRIPE_WEBHOOK_SECRET`, then **restart the backend**
(`npm run dev`) so it picks up the new value. Leave the `stripe listen` terminal running — it's the
tunnel that gets Stripe's real webhook events to your machine.

**If you skip this step**, every webhook call 400s on signature verification and the wallet is never
credited — that was the exact bug PART A of `WALLET_DESIGN.md` documents. `stripe listen` is not
optional for testing top-ups locally.

## 3. Test card numbers

Use these at Stripe's hosted checkout page (the `url` returned by
`POST /api/wallet/topup/checkout`) — expiry can be any future date, CVC any 3 digits, ZIP any 5 digits.

| Card number | Result |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 9995` | Declines — insufficient funds |
| `4000 0025 0000 3155` | Requires 3D Secure authentication (test the "Complete authentication" popup) |

## 4. The full top-up flow, and how to verify the balance ACTUALLY changed

1. Log into the app (or call `POST /api/auth/login`) and grab the access token.
2. `POST /api/wallet/topup/checkout` with `{ "amount": 2000 }` (whole PKR — the endpoint converts to
   USD test-mode cents internally, see `config/currency.js`). Response includes a Stripe-hosted `url`.
3. Open that `url`, pay with `4242 4242 4242 4242`.
4. Stripe redirects to `success_url`, AND — separately, over the `stripe listen` tunnel — POSTs a
   `checkout.session.completed` event to `/api/wallet/webhook`. Watch the `stripe listen` terminal:
   you should see the event logged with a `200` response from your server.
5. **Verify in the database, not the UI:**
   ```bash
   node -e "
   require('dotenv').config();
   const mongoose = require('mongoose');
   const WalletService = require('./src/services/walletService');
   (async () => {
     await mongoose.connect(process.env.MONGODB_URI);
     const wallet = await WalletService.getOrCreateWallet('<your user id>', 'User');
     console.log('balance:', wallet.balance, wallet.currency);
     await mongoose.disconnect();
   })();
   "
   ```
   The balance must have increased by exactly the PKR amount you requested. If `stripe listen` showed
   a non-200 for the webhook, the balance will NOT have moved — that is the signature-verification bug
   coming back; check `STRIPE_WEBHOOK_SECRET` matches what `stripe listen` printed.
6. Also check `GET /api/wallet/transactions?source=stripe_topup` — you should see one `credit`,
   `status: 'completed'`, with `metadata.fxRate` recorded.

## 5. Stripe Connect test onboarding for a provider, and triggering a test payout

1. Log in as a provider, `POST /api/wallet/connect/onboard`. Response has a Stripe-hosted onboarding
   `url`.
2. Open it. Stripe's test-mode onboarding accepts fake everything — use `000000000` for SSN-like
   fields, any test business details, and Stripe's test bank account (routing `110000000`,
   account `000123456789`).
3. On completion you're redirected to `/api/wallet/connect/return`, which deep-links back to the app.
4. `GET /api/wallet/connect/status` should now show `chargesEnabled: true, payoutsEnabled: true`.
5. With a positive wallet balance, `POST /api/wallet/payout` with `{ "amount": 500 }` (PKR — converted
   to USD cents the same way top-ups are). Watch `stripe listen` for `payout.paid`; the wallet debit
   should already be visible immediately (payouts reserve funds before the Stripe call, see
   `WalletService.initiatePayout`), and the transaction's `status` flips to `completed` once
   `payout.paid` lands.

## 6. Proving signature verification is genuinely working (not silently failing)

This is the property the whole webhook fix exists for — don't skip it.

1. **Positive proof:** with `stripe listen` running and the correct `STRIPE_WEBHOOK_SECRET`, trigger a
   synthetic event directly:
   ```bash
   stripe trigger checkout.session.completed
   ```
   `stripe listen`'s terminal must show `200` for the forwarded event, and your server logs should show
   no signature error.
2. **Negative proof (deliberately break it):** stop the server, change one character in
   `STRIPE_WEBHOOK_SECRET`, restart, and trigger the event again. This time you should see a `400` in
   `stripe listen` and `"Webhook Error: No signatures found matching the expected signature for
   payload"` in your server logs. Put the correct secret back and restart before continuing.
3. **Automated proof:** `npm test -- src/__tests__/stripeWebhook.test.js` — asserts a correctly signed
   payload verifies and credits the wallet, a bad signature 400s, a replayed event id is a no-op, and a
   non-Buffer body (the original bug's exact failure mode) fails loudly rather than silently.
4. **End-to-end proof against a live server:** `npm run smoke:wallet-stripe` — creates a real Stripe
   test-mode checkout session, signs a webhook payload with the SDK's own test-signing helper, posts it
   to your running server, and asserts the balance in the database actually increased; then settles a
   payment to a provider and asserts the commission landed in the Platform ledger; then replays the same
   event id and asserts no double-credit. Needs the server running and `STRIPE_SECRET_KEY` +
   `STRIPE_WEBHOOK_SECRET` set (does not need `stripe listen` — it signs its own synthetic event).
