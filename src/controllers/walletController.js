const asyncHandler = require('express-async-handler');
const WalletService = require('../services/walletService');
const stripe = require('../config/stripe');
const WalletTransaction = require('../models/WalletTransaction');

// @desc    Get user's wallet with transaction history
// @route   GET /api/wallet/me
// @access  Private
const getMyWallet = asyncHandler(async (req, res) => {
  const ownerId = req.user._id;
  const ownerType = req.isProvider ? 'Provider' : 'User';

  const limit = parseInt(req.query.limit) || 20;
  const page = parseInt(req.query.page) || 1;

  const { wallet, transactions, pagination } = await WalletService.getWalletWithTransactions(
    ownerId,
    ownerType,
    { limit, page }
  );

  res.status(200).json({
    success: true,
    wallet: {
      balance: wallet.balance,
      currency: wallet.currency,
    },
    transactions,
    pagination,
  });
});

// @desc    Create Stripe checkout session for wallet top-up
// @route   POST /api/wallet/topup/checkout
// @access  Private
const createCheckoutSession = asyncHandler(async (req, res) => {
  const { amount } = req.body;

  // Validate amount
  if (!amount || typeof amount !== 'number' || amount < 1 || amount > 10000) {
    res.status(400);
    throw new Error('Amount must be a number between 1 and 10000');
  }

  const ownerId = req.user._id;
  const ownerType = req.isProvider ? 'Provider' : 'User';

  // Get or create wallet first
  const wallet = await WalletService.getOrCreateWallet(ownerId, ownerType);

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: process.env.STRIPE_CURRENCY || 'usd',
          product_data: {
            name: 'MetroMatrix Wallet Top-Up',
          },
          unit_amount: Math.round(amount * 100), // Convert to cents
        },
        quantity: 1,
      },
    ],
    success_url: `${process.env.STRIPE_BACKEND_URL}/api/wallet/topup/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.STRIPE_BACKEND_URL}/api/wallet/topup/cancel`,
    metadata: {
      ownerId: String(ownerId),
      ownerType,
      amount: String(amount),
    },
  });

  // Pre-create a pending transaction so user sees it in history
  await WalletTransaction.create({
    wallet: wallet._id,
    type: 'credit',
    amount,
    description: 'Stripe wallet top-up',
    source: 'stripe_topup',
    status: 'pending',
    stripeSessionId: session.id,
    metadata: {
      stripeSessionId: session.id,
      originalAmountCents: Math.round(amount * 100),
    },
  });

  res.status(200).json({
    success: true,
    sessionId: session.id,
    url: session.url,
  });
});

// @desc    Top-up success page (redirects to app)
// @route   GET /api/wallet/topup/success
// @access  Public
const topUpSuccess = asyncHandler(async (req, res) => {
  const { session_id } = req.query;

  const deepLinkUrl = `${process.env.APP_DEEP_LINK_SCHEME}://wallet/topup-success?session_id=${session_id}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Top-Up Successful - MetroMatrix</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 48px 40px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 80px rgba(0,0,0,0.35);
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #6366f1;
      margin-bottom: 32px;
      letter-spacing: -0.5px;
    }
    .icon {
      width: 88px;
      height: 88px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      font-size: 44px;
      background: #d1fae5;
    }
    h1 {
      color: #059669;
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    p {
      color: #6b7280;
      font-size: 15px;
      line-height: 1.7;
      margin-bottom: 28px;
    }
    .btn {
      display: inline-block;
      padding: 16px 36px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }
    .btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.4);
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">MetroMatrix</div>
    <div class="icon">✓</div>
    <h1>Top-Up Successful!</h1>
    <p>Your wallet has been credited successfully. You can now use your balance for services on MetroMatrix.</p>
    <a href="${deepLinkUrl}" class="btn btn-primary">Return to App</a>
  </div>
  <script>
    // Auto-redirect after 2 seconds
    setTimeout(() => {
      window.location.href = "${deepLinkUrl}";
    }, 2000);
  </script>
</body>
</html>
  `;

  res.send(html);
});

// @desc    Top-up cancel page (redirects to app)
// @route   GET /api/wallet/topup/cancel
// @access  Public
const topUpCancel = asyncHandler(async (req, res) => {
  const deepLinkUrl = `${process.env.APP_DEEP_LINK_SCHEME}://wallet/topup-cancel`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Top-Up Cancelled - MetroMatrix</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 48px 40px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 80px rgba(0,0,0,0.35);
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #6366f1;
      margin-bottom: 32px;
      letter-spacing: -0.5px;
    }
    .icon {
      width: 88px;
      height: 88px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      font-size: 44px;
      background: #fee2e2;
    }
    h1 {
      color: #dc2626;
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    p {
      color: #6b7280;
      font-size: 15px;
      line-height: 1.7;
      margin-bottom: 28px;
    }
    .btn {
      display: inline-block;
      padding: 16px 36px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }
    .btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.4);
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">MetroMatrix</div>
    <div class="icon">✕</div>
    <h1>Top-Up Cancelled</h1>
    <p>Your wallet top-up was cancelled. No charges were made to your payment method.</p>
    <a href="${deepLinkUrl}" class="btn btn-primary">Return to App</a>
  </div>
  <script>
    // Auto-redirect after 2 seconds
    setTimeout(() => {
      window.location.href = "${deepLinkUrl}";
    }, 2000);
  </script>
</body>
</html>
  `;

  res.send(html);
});

// @desc    Stripe webhook handler
// @route   POST /api/wallet/webhook
// @access  Public
const stripeWebhook = asyncHandler(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400);
    throw new Error(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      // Apply the top-up to the wallet
      await WalletService.applyTopUp(event.data.object);
      break;

    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      // Mark the pending transaction as failed
      const session = event.data.object;
      await WalletTransaction.findOneAndUpdate(
        { stripeSessionId: session.id },
        { status: 'failed' }
      );
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.status(200).json({ received: true });
});

module.exports = {
  getMyWallet,
  createCheckoutSession,
  topUpSuccess,
  topUpCancel,
  stripeWebhook,
};
