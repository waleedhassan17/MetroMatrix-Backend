# MetroMatrix Wallet API Documentation

## Overview
The Wallet API allows users and providers to manage their wallet balance, top up funds via Stripe, and view transaction history.

## Base URL
- **Production**: `https://finmatrix-api-830293a85dd8.herokuapp.com/api/wallet`
- **Development**: `http://localhost:5000/api/wallet`

## Environment Variables Required
```env
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CURRENCY=usd
STRIPE_BACKEND_URL=https://your-backend-url.com
APP_DEEP_LINK_SCHEME=metromatrix
```

## Authentication
All protected endpoints require a valid JWT token in the `Authorization` header:
```
Authorization: Bearer <access_token>
```

---

## Endpoints

### 1. Get Wallet with Transactions
Get the authenticated user's wallet balance and transaction history.

**Endpoint:** `GET /me`

**Authentication:** Required (JWT token)

**Query Parameters:**
- `page` (optional, default: 1) - Page number for pagination
- `limit` (optional, default: 20) - Number of transactions per page

**Request Example:**
```bash
curl -X GET "https://finmatrix-api-830293a85dd8.herokuapp.com/api/wallet/me?page=1&limit=20" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Success Response (200):**
```json
{
  "success": true,
  "wallet": {
    "balance": 50.00,
    "currency": "usd"
  },
  "transactions": [
    {
      "_id": "transaction_id",
      "wallet": "wallet_id",
      "type": "credit",
      "amount": 50.00,
      "currency": "usd",
      "description": "Stripe wallet top-up",
      "status": "completed",
      "source": "stripe_topup",
      "stripeSessionId": "cs_test_...",
      "stripePaymentIntentId": "pi_test_...",
      "metadata": {},
      "createdAt": "2026-05-04T07:42:09.228Z",
      "updatedAt": "2026-05-04T07:42:09.639Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

**Error Response (401):**
```json
{
  "success": false,
  "error": "Not authorized to access this route"
}
```

---

### 2. Create Stripe Checkout Session
Create a Stripe checkout session for wallet top-up. Returns a Stripe checkout URL that the user can use to complete the payment.

**Endpoint:** `POST /topup/checkout`

**Authentication:** Required (JWT token)

**Request Body:**
```json
{
  "amount": 25.50
}
```

**Validation:**
- `amount` must be a number between 1 and 10000

**Request Example:**
```bash
curl -X POST "https://finmatrix-api-830293a85dd8.herokuapp.com/api/wallet/topup/checkout" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount": 25.50}'
```

**Success Response (200):**
```json
{
  "success": true,
  "sessionId": "cs_test_a1JG9ZIVcyGBAzyXBrW4O6v0xB3Qh8fDkdVMfOh4JOfRUBLp8UGLT7Wh3X",
  "url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

**Error Response (400):**
```json
{
  "success": false,
  "error": "Amount must be between 1 and 10000"
}
```

**Notes:**
- A pending transaction is created immediately so users can see it in their history
- The actual balance is only credited when the Stripe webhook confirms payment completion
- Redirect the user to the `url` field to complete the payment

---

### 3. Top-Up Success Page (Public)
HTML page that displays after successful Stripe checkout and redirects to the app.

**Endpoint:** `GET /topup/success`

**Authentication:** Not required (public)

**Query Parameters:**
- `session_id` - Stripe checkout session ID

**Request Example:**
```bash
curl "https://finmatrix-api-830293a85dd8.herokuapp.com/api/wallet/topup/success?session_id=cs_test_123"
```

**Response:**
- Returns HTML page with success message
- Auto-redirects to app deep link after 2 seconds
- Deep link format: `metromatrix://wallet/topup-success?session_id=<session_id>`

**Notes:**
- This page does NOT update the wallet balance - the webhook handles that
- Used as a redirect target from Stripe checkout success

---

### 4. Top-Up Cancel Page (Public)
HTML page that displays when Stripe checkout is cancelled and redirects to the app.

**Endpoint:** `GET /topup/cancel`

**Authentication:** Not required (public)

**Request Example:**
```bash
curl "https://finmatrix-api-830293a85dd8.herokuapp.com/api/wallet/topup/cancel"
```

**Response:**
- Returns HTML page with cancellation message
- Auto-redirects to app deep link after 2 seconds
- Deep link format: `metromatrix://wallet/topup-cancel`

**Notes:**
- Used as a redirect target from Stripe checkout cancel

---

### 5. Stripe Webhook Handler
Handles Stripe webhook events for checkout session completion, expiration, and payment failures.

**Endpoint:** `POST /webhook`

**Authentication:** Not required (public - verified via Stripe signature)

**Headers:**
- `stripe-signature` - Stripe webhook signature for verification

**Events Handled:**
- `checkout.session.completed` - Credits wallet with top-up amount
- `checkout.session.expired` - Marks transaction as failed
- `checkout.session.async_payment_failed` - Marks transaction as failed

**Request:**
- Raw JSON body (parsed by Stripe SDK for signature verification)

**Success Response (200):**
```json
{
  "received": true
}
```

**Error Response (400):**
```json
{
  "success": false,
  "error": "Webhook Error: Invalid signature"
}
```

**Notes:**
- Idempotency: Duplicate webhook deliveries with same session ID won't double-credit wallet
- Must be configured in Stripe Dashboard with correct endpoint URL
- Uses raw body parsing for signature verification

---

## Transaction Status Values

- `pending` - Transaction initiated but not completed
- `completed` - Transaction successfully processed
- `failed` - Transaction failed
- `refunded` - Transaction was refunded

## Transaction Source Values

- `stripe_topup` - User added funds via Stripe
- `service_payment` - Payment for a service
- `refund` - Refund issued
- `admin_adjustment` - Manual adjustment by admin
- `payout` - Funds withdrawn to external account

## Stripe Test Cards

For testing in test mode, use these card numbers:
- **Success**: `4242 4242 4242 4242`
- **Failure**: `4000 0000 0000 0002`
- **Requires 3D Secure**: `4000 0025 0000 3155`

Use any future expiry date and any CVC.

## Error Handling

All endpoints follow consistent error response format:

```json
{
  "success": false,
  "error": "Error message"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid/missing token)
- `404` - Not Found
- `500` - Internal Server Error

## Webhook Configuration

To configure the webhook in Stripe Dashboard:

1. Go to https://dashboard.stripe.com/test/webhooks
2. Click "Add endpoint"
3. URL: `https://finmatrix-api-830293a85dd8.herokuapp.com/api/wallet/webhook`
4. Events to listen for:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_failed`
5. Copy the webhook signing secret and set it as `STRIPE_WEBHOOK_SECRET`

## Testing

Run the smoke test to verify wallet functionality:

```bash
npm run smoke:wallet
```

This will:
- Create test user and provider
- Create wallets for both
- Apply a mock top-up
- Verify idempotency
- Print wallet balances and transactions
