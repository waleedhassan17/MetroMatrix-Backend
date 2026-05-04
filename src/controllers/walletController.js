const asyncHandler = require('express-async-handler');
const WalletService = require('../services/walletService');
const stripe = require('../config/stripe');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const Provider = require('../models/Provider');

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
    return res.status(400).json({
      success: false,
      error: `Webhook Error: ${err.message}`,
    });
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await WalletService.applyTopUp(event.data.object);
        break;

      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        await WalletTransaction.findOneAndUpdate(
          { stripeSessionId: session.id },
          { status: 'failed' }
        );
        break;
      }

      // ===== Stripe Connect events (from connected accounts) =====
      case 'account.updated': {
        const account = event.data.object;
        const provider = await Provider.findOne({ stripeConnectAccountId: account.id });
        if (provider) {
          provider.stripeChargesEnabled = !!account.charges_enabled;
          provider.stripePayoutsEnabled = !!account.payouts_enabled;
          provider.stripeDetailsSubmitted = !!account.details_submitted;
          if (account.charges_enabled && account.payouts_enabled && account.details_submitted) {
            provider.stripeConnectStatus = 'active';
          } else if (account.requirements && (account.requirements.disabled_reason || (account.requirements.currently_due || []).length > 0)) {
            provider.stripeConnectStatus = account.details_submitted ? 'restricted' : 'pending';
          } else {
            provider.stripeConnectStatus = 'pending';
          }
          await provider.save({ validateBeforeSave: false });
        }
        break;
      }

      case 'payout.paid': {
        const payout = event.data.object;
        await WalletService.markPayoutSucceeded(payout.id);
        break;
      }

      case 'payout.failed':
      case 'payout.canceled': {
        const payout = event.data.object;
        await WalletService.markPayoutFailedAndRefund(
          payout.id,
          payout.failure_message || event.type
        );
        break;
      }

      default:
        // Unhandled event type - log and move on
        // console.log(`Unhandled Stripe event type: ${event.type}`);
        break;
    }
  } catch (err) {
    console.error('Error handling Stripe event', event.type, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }

  res.status(200).json({ received: true });
});

// @desc    Transfer funds to another user or provider
// @route   POST /api/wallet/transfer
// @access  Private
const transferToWallet = asyncHandler(async (req, res) => {
  const {
    receiverId,
    receiverType,
    amount,
    description,
    idempotencyKey,
  } = req.body;

  if (!receiverId || !receiverType) {
    res.status(400);
    throw new Error('receiverId and receiverType are required');
  }
  if (!['User', 'Provider'].includes(receiverType)) {
    res.status(400);
    throw new Error("receiverType must be 'User' or 'Provider'");
  }

  // Confirm receiver exists
  const Model = receiverType === 'User' ? User : Provider;
  const receiver = await Model.findById(receiverId).select('_id fullName email');
  if (!receiver) {
    res.status(404);
    throw new Error(`${receiverType} not found`);
  }

  const senderId = req.user._id;
  const senderType = req.isProvider ? 'Provider' : 'User';

  const feePercent = parseFloat(process.env.WALLET_TRANSFER_FEE_PERCENT || '0');

  try {
    const result = await WalletService.transferFunds({
      senderOwnerId: senderId,
      senderOwnerType: senderType,
      receiverOwnerId: receiverId,
      receiverOwnerType: receiverType,
      amount: Number(amount),
      description: description || `Transfer to ${receiver.fullName || receiverType}`,
      idempotencyKey,
      feePercent,
    });

    return res.status(200).json({
      success: true,
      alreadyProcessed: result.alreadyProcessed,
      transferGroupId: result.transferGroupId,
      senderWallet: result.senderWallet
        ? { balance: result.senderWallet.balance, currency: result.senderWallet.currency }
        : undefined,
      senderTransaction: result.senderTransaction,
      receiverTransaction: result.receiverTransaction,
      feeTransaction: result.feeTransaction,
    });
  } catch (err) {
    const message = err.message || 'Transfer failed';
    const status = /insufficient|invalid|same wallet|positive/i.test(message) ? 400 : 500;
    return res.status(status).json({ success: false, error: message });
  }
});

// @desc    Start (or refresh) Stripe Connect onboarding for a provider
// @route   POST /api/wallet/connect/onboard
// @access  Private (Provider only)
const startConnectOnboarding = asyncHandler(async (req, res) => {
  if (!req.isProvider) {
    res.status(403);
    throw new Error('Only providers can onboard for payouts');
  }

  const provider = await Provider.findById(req.user._id);
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  // Create Connect account if not exists
  if (!provider.stripeConnectAccountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: provider.email,
      capabilities: {
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: {
        providerId: String(provider._id),
      },
    });
    provider.stripeConnectAccountId = account.id;
    provider.stripeConnectStatus = 'pending';
    await provider.save({ validateBeforeSave: false });
  }

  const backendUrl = process.env.STRIPE_BACKEND_URL || `${req.protocol}://${req.get('host')}`;

  const accountLink = await stripe.accountLinks.create({
    account: provider.stripeConnectAccountId,
    refresh_url: `${backendUrl}/api/wallet/connect/refresh`,
    return_url: `${backendUrl}/api/wallet/connect/return`,
    type: 'account_onboarding',
  });

  res.status(200).json({
    success: true,
    url: accountLink.url,
    accountId: provider.stripeConnectAccountId,
    status: provider.stripeConnectStatus,
  });
});

// @desc    Get Stripe Connect account status for the current provider
// @route   GET /api/wallet/connect/status
// @access  Private (Provider only)
const getConnectStatus = asyncHandler(async (req, res) => {
  if (!req.isProvider) {
    res.status(403);
    throw new Error('Only providers can check payout status');
  }

  const provider = await Provider.findById(req.user._id);
  if (!provider) {
    res.status(404);
    throw new Error('Provider not found');
  }

  let live = null;
  if (provider.stripeConnectAccountId) {
    try {
      const account = await stripe.accounts.retrieve(provider.stripeConnectAccountId);
      // Sync local flags from live state
      provider.stripeChargesEnabled = !!account.charges_enabled;
      provider.stripePayoutsEnabled = !!account.payouts_enabled;
      provider.stripeDetailsSubmitted = !!account.details_submitted;
      if (account.charges_enabled && account.payouts_enabled && account.details_submitted) {
        provider.stripeConnectStatus = 'active';
      } else if (!account.details_submitted) {
        provider.stripeConnectStatus = 'pending';
      } else {
        provider.stripeConnectStatus = 'restricted';
      }
      await provider.save({ validateBeforeSave: false });

      live = {
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        requirementsDue: account.requirements ? account.requirements.currently_due : [],
      };
    } catch (err) {
      console.error('Failed to retrieve Stripe account:', err.message);
    }
  }

  res.status(200).json({
    success: true,
    status: provider.stripeConnectStatus,
    accountId: provider.stripeConnectAccountId || null,
    chargesEnabled: provider.stripeChargesEnabled,
    payoutsEnabled: provider.stripePayoutsEnabled,
    detailsSubmitted: provider.stripeDetailsSubmitted,
    live,
  });
});

// Public pages for Connect onboarding redirects
const connectRefresh = asyncHandler(async (req, res) => {
  const deepLinkUrl = `${process.env.APP_DEEP_LINK_SCHEME}://wallet/connect-refresh`;
  res.send(`<!DOCTYPE html><html><head><title>Refresh Required</title><meta http-equiv="refresh" content="1;url=${deepLinkUrl}"/></head><body style="font-family:sans-serif;text-align:center;padding:40px;">Redirecting back to app… <a href="${deepLinkUrl}">Tap here if not redirected</a></body></html>`);
});

const connectReturn = asyncHandler(async (req, res) => {
  const deepLinkUrl = `${process.env.APP_DEEP_LINK_SCHEME}://wallet/connect-return`;
  res.send(`<!DOCTYPE html><html><head><title>Onboarding Complete</title><meta http-equiv="refresh" content="1;url=${deepLinkUrl}"/></head><body style="font-family:sans-serif;text-align:center;padding:40px;">Onboarding complete. Redirecting back to app… <a href="${deepLinkUrl}">Tap here if not redirected</a></body></html>`);
});

// @desc    Request a payout from wallet to bank account (Stripe Connect)
// @route   POST /api/wallet/payout
// @access  Private (Provider only)
const requestPayout = asyncHandler(async (req, res) => {
  if (!req.isProvider) {
    res.status(403);
    throw new Error('Only providers can request payouts');
  }

  const { amount, idempotencyKey, description } = req.body;
  const numAmount = Number(amount);

  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    res.status(400);
    throw new Error('Amount must be a positive number');
  }

  const provider = await Provider.findById(req.user._id);
  if (!provider || !provider.stripeConnectAccountId) {
    res.status(400);
    throw new Error('Stripe Connect account not set up. Please complete onboarding first.');
  }
  if (!provider.stripePayoutsEnabled) {
    res.status(400);
    throw new Error('Payouts are not yet enabled on your Stripe account. Complete onboarding.');
  }

  const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
  const amountCents = Math.round(numAmount * 100);

  // 1. Reserve funds in local wallet (debit pending)
  const { wallet, transaction, alreadyProcessed } = await WalletService.initiatePayout({
    providerId: provider._id,
    amount: numAmount,
    description: description || 'Payout to bank account',
    idempotencyKey,
  });

  if (alreadyProcessed) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      wallet: { balance: wallet.balance, currency: wallet.currency },
      transaction,
    });
  }

  try {
    // 2. Transfer funds from platform balance to connected account
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency,
        destination: provider.stripeConnectAccountId,
        description: description || 'Wallet payout',
        metadata: {
          providerId: String(provider._id),
          walletTransactionId: String(transaction._id),
        },
      },
      { idempotencyKey: `transfer_${transaction._id}` }
    );

    // 3. Create a payout on the connected account (to their bank)
    const payout = await stripe.payouts.create(
      {
        amount: amountCents,
        currency,
        metadata: {
          providerId: String(provider._id),
          walletTransactionId: String(transaction._id),
        },
      },
      {
        stripeAccount: provider.stripeConnectAccountId,
        idempotencyKey: `payout_${transaction._id}`,
      }
    );

    await WalletService.attachStripePayoutIds(transaction._id, {
      stripeTransferId: transfer.id,
      stripePayoutId: payout.id,
      stripeConnectAccountId: provider.stripeConnectAccountId,
    });

    const freshWallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');
    const freshTx = await WalletTransaction.findById(transaction._id);

    return res.status(200).json({
      success: true,
      wallet: { balance: freshWallet.balance, currency: freshWallet.currency },
      transaction: freshTx,
      stripe: {
        transferId: transfer.id,
        payoutId: payout.id,
        status: payout.status,
        arrivalDate: payout.arrival_date,
      },
    });
  } catch (err) {
    // Refund the wallet if Stripe call failed
    try {
      await WalletService.markPayoutFailedAndRefund(
        transaction.stripePayoutId || `local_${transaction._id}`,
        err.message || 'Stripe error'
      );
      // Fallback: refund by transaction id if no stripe id was attached yet
      const reloaded = await WalletTransaction.findById(transaction._id);
      if (reloaded && reloaded.status === 'pending') {
        const w = await WalletService.getOrCreateWallet(provider._id, 'Provider');
        await w.credit(numAmount);
        reloaded.status = 'failed';
        reloaded.metadata = {
          ...(reloaded.metadata || {}),
          failureReason: err.message,
          refundedAt: new Date(),
        };
        await reloaded.save();
      }
    } catch (refundErr) {
      console.error('Failed to refund wallet after payout error:', refundErr.message);
    }

    res.status(400);
    throw new Error(`Payout failed: ${err.message}`);
  }
});

module.exports = {
  getMyWallet,
  createCheckoutSession,
  topUpSuccess,
  topUpCancel,
  stripeWebhook,
  transferToWallet,
  startConnectOnboarding,
  getConnectStatus,
  connectRefresh,
  connectReturn,
  requestPayout,
};
