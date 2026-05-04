# MetroMatrix Wallet API Documentation

Complete reference for wallet, top-up, P2P transfer, and payout endpoints.

## Base URL

- **Production**: `https://metromatrix-backend-8758842b3e4c.herokuapp.com/api/wallet`
- **Development**: `http://localhost:5000/api/wallet`

## Authentication

All protected endpoints require a JWT in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

User tokens come from `POST /api/auth/login`. Provider tokens come from `POST /api/auth/provider/login`.

## Environment Variables

```env
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CURRENCY=usd
STRIPE_BACKEND_URL=https://metromatrix-backend-8758842b3e4c.herokuapp.com
APP_DEEP_LINK_SCHEME=metromatrix
WALLET_TRANSFER_FEE_PERCENT=0   # optional, default 0
```

## Endpoint Summary

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/me` | JWT | Wallet balance + paginated transactions |
| POST | `/topup/checkout` | JWT | Create Stripe checkout session for top-up |
| GET | `/topup/success` | public | HTML success page (Stripe redirect) |
| GET | `/topup/cancel` | public | HTML cancel page (Stripe redirect) |
| POST | `/transfer` | JWT | P2P wallet-to-wallet transfer |
| POST | `/connect/onboard` | Provider | Start/refresh Stripe Connect onboarding |
| GET | `/connect/status` | Provider | Get Stripe Connect account status |
| GET | `/connect/refresh` | public | Connect onboarding refresh redirect |
| GET | `/connect/return` | public | Connect onboarding return redirect |
| POST | `/payout` | Provider | Request payout from wallet to bank |
| POST | `/webhook` | public (signed) | Stripe webhook handler |

---

## 1. GET /me — Wallet + Transactions

**Auth:** JWT (user or provider)

**Query params:**
- `page` (default `1`)
- `limit` (default `20`)

**Request:**
```bash
curl -X GET "$BASE/api/wallet/me?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200):**
```json
{
  "success": true,
  "wallet": { "balance": 40, "currency": "usd" },
  "transactions": [
    {
      "_id": "…",
      "wallet": "…",
      "type": "debit",
      "amount": 5,
      "currency": "usd",
      "description": "Test transfer",
      "status": "completed",
      "source": "transfer_out",
      "counterparty": { "id": "…", "type": "Provider" },
      "transferGroupId": "tg_…",
      "metadata": { "feePercent": 0, "fee": 0 },
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "pages": 1 }
}
```

---

## 2. POST /topup/checkout — Create Stripe Checkout Session

**Auth:** JWT

**Body:**
```json
{ "amount": 25.50 }
```
- `amount` must be number between 1 and 10000.

**Response (200):**
```json
{
  "success": true,
  "sessionId": "cs_test_…",
  "url": "https://checkout.stripe.com/c/pay/cs_test_…"
}
```

Redirect the user to `url` to complete payment. A pending `stripe_topup` transaction is pre-created. Balance updates once the Stripe webhook confirms `checkout.session.completed`.

**Errors:**
- `400` — invalid amount

---

## 3. GET /topup/success & /topup/cancel — Post-Checkout Pages

**Auth:** public

Returns an HTML page that auto-redirects to the app via deep link:

- Success: `metromatrix://wallet/topup-success?session_id=<id>`
- Cancel: `metromatrix://wallet/topup-cancel`

These do not modify wallet state — the webhook is source of truth.

---

## 4. POST /transfer — Peer-to-Peer Transfer

**Auth:** JWT (sender is the authenticated caller)

**Body:**
```json
{
  "receiverId": "69f84dd0cb63ada7b40de029",
  "receiverType": "Provider",
  "amount": 25,
  "description": "Payment for booking #abc",
  "idempotencyKey": "client-generated-uuid-v4"
}
```

- `receiverType`: `"User"` or `"Provider"`
- `amount`: number, `>=0.01`, `<=100000`
- `description` (optional, ≤280 chars)
- `idempotencyKey` (optional, ≤128 chars) — strongly recommended. Supplying the same key replays the previous result without double-debiting.

**Response (200):**
```json
{
  "success": true,
  "alreadyProcessed": false,
  "transferGroupId": "tg_a57792e6a4091783",
  "senderWallet": { "balance": 40, "currency": "usd" },
  "senderTransaction": { "source": "transfer_out", "amount": 25, "status": "completed", "_id": "…" },
  "receiverTransaction": { "source": "transfer_in", "amount": 25, "status": "completed", "_id": "…" },
  "feeTransaction": null
}
```

If the same `idempotencyKey` is sent again, `alreadyProcessed: true` is returned and no new debits occur.

**Atomicity:** Uses a Mongoose transaction when the cluster supports it; falls back to sequential debit/credit with the same `transferGroupId` linking the two legs.

**Errors:**
- `400` — validation, insufficient balance, self-transfer, invalid type
- `404` — receiver not found

---

## 5. POST /connect/onboard — Start Stripe Connect Onboarding (Provider)

**Auth:** JWT (Provider only)

Creates an Express Connect account for the provider if one doesn't exist, then returns a Stripe-hosted onboarding link.

**Request:**
```bash
curl -X POST "$BASE/api/wallet/connect/onboard" -H "Authorization: Bearer $PROV_TOKEN"
```

**Response (200):**
```json
{
  "success": true,
  "url": "https://connect.stripe.com/setup/…",
  "accountId": "acct_1…",
  "status": "pending"
}
```

Open `url` in a webview/browser. On return, Stripe redirects to `/connect/return` which deep-links to the app (`metromatrix://wallet/connect-return`).

**Prerequisite:** Your platform Stripe account must have Connect enabled at <https://dashboard.stripe.com/connect>. This is free and takes ~1 minute in test mode.

**Errors:**
- `403` — caller is not a provider

---

## 6. GET /connect/status — Stripe Connect Status (Provider)

**Auth:** JWT (Provider only)

Retrieves the live Stripe account state and syncs local flags.

**Response (200):**
```json
{
  "success": true,
  "status": "active",
  "accountId": "acct_1…",
  "chargesEnabled": true,
  "payoutsEnabled": true,
  "detailsSubmitted": true,
  "live": {
    "chargesEnabled": true,
    "payoutsEnabled": true,
    "detailsSubmitted": true,
    "requirementsDue": []
  }
}
```

`status` is one of: `not_started`, `pending`, `restricted`, `active`.

---

## 7. POST /payout — Payout Wallet to Bank (Provider)

**Auth:** JWT (Provider only; `stripePayoutsEnabled` must be `true`)

**Body:**
```json
{
  "amount": 50,
  "description": "Weekly payout",
  "idempotencyKey": "client-uuid"
}
```

Flow:
1. Debit provider wallet (creates `pending` `payout` transaction).
2. `stripe.transfers.create` moves funds from platform balance to the provider's connected account.
3. `stripe.payouts.create` on the connected account initiates the bank payout.
4. On any Stripe failure, the wallet debit is refunded automatically.
5. Webhook events `payout.paid` / `payout.failed` update the transaction's final status.

**Response (200):**
```json
{
  "success": true,
  "wallet": { "balance": 0, "currency": "usd" },
  "transaction": { "source": "payout", "status": "pending", "_id": "…", "stripeTransferId": "tr_…", "stripePayoutId": "po_…" },
  "stripe": {
    "transferId": "tr_…",
    "payoutId": "po_…",
    "status": "pending",
    "arrivalDate": 1730000000
  }
}
```

**Errors:**
- `400` — not onboarded, payouts disabled, insufficient balance, invalid amount, Stripe error
- `403` — caller is not a provider

---

## 8. POST /webhook — Stripe Webhook

**Auth:** public; verified by `stripe-signature` header.

Uses raw JSON body (`express.raw`) so Stripe's signature check works.

Events handled:

| Event | Action |
|---|---|
| `checkout.session.completed` | Credit wallet for top-up (idempotent via sessionId) |
| `checkout.session.expired` | Mark pending top-up transaction `failed` |
| `checkout.session.async_payment_failed` | Mark pending top-up transaction `failed` |
| `account.updated` | Sync provider Connect status/flags |
| `payout.paid` | Mark payout transaction `completed` |
| `payout.failed` | Mark transaction `failed` and refund wallet |
| `payout.canceled` | Mark transaction `failed` and refund wallet |

**Response (200):** `{ "received": true }`
**On signature failure (400):** `{ "success": false, "error": "Webhook Error: …" }`

### Configure in Stripe Dashboard

Go to <https://dashboard.stripe.com/test/webhooks>, add endpoint:

- URL: `https://metromatrix-backend-8758842b3e4c.herokuapp.com/api/wallet/webhook`
- Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_failed`, `account.updated`, `payout.paid`, `payout.failed`, `payout.canceled`

For Connect events, also check "Listen to events on Connected accounts" so the Connect events are forwarded to the platform endpoint.

---

## Transaction Model Reference

Fields on each transaction:

| Field | Values / Notes |
|---|---|
| `type` | `credit` / `debit` |
| `status` | `pending` / `completed` / `failed` / `refunded` |
| `source` | `stripe_topup`, `service_payment`, `refund`, `admin_adjustment`, `payout`, `transfer_in`, `transfer_out`, `transfer_fee` |
| `counterparty` | `{ id, type }` for transfers |
| `transferGroupId` | Links sender/receiver legs of a transfer |
| `idempotencyKey` | Unique sparse — replays short-circuit |
| `stripeSessionId`, `stripePaymentIntentId` | For top-ups |
| `stripeTransferId`, `stripePayoutId`, `stripeConnectAccountId` | For payouts |

## Stripe Test Cards

- **Success:** `4242 4242 4242 4242`
- **Decline:** `4000 0000 0000 0002`
- **3D Secure:** `4000 0025 0000 3155`
- Any future expiry date; any CVC.

## Local Smoke Test

```bash
npm run smoke:wallet
```

Verifies wallet creation, top-up, and idempotency end-to-end.

## Error Format

All errors share the same shape:

```json
{ "success": false, "error": "Human-readable message" }
```

Validation errors also include an `errors` array.

## Status Codes

- `200` OK
- `400` Bad request / validation / insufficient balance / Stripe error
- `401` Unauthorized (missing or invalid JWT)
- `403` Forbidden (wrong role or signature)
- `404` Resource not found
- `500` Unexpected server error
