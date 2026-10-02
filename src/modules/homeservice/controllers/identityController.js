const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const { transition } = require('../services/bookingService');
const { STATUS } = require('../services/statusMap');
const identity = require('../services/identityService');

const ok = (res, data, message) => res.json({ success: true, data, message });
const idOf = (ref) => (ref && ref._id ? ref._id : ref);

/** At (or nearly at) the door — the only time a doorstep check makes sense. */
const CHECKABLE = [STATUS.EN_ROUTE, STATUS.ARRIVED];

const verifiedView = (ic) => (ic && ic.verifiedAt ? { verifiedAt: ic.verifiedAt, method: ic.method } : null);

// POST /api/provider/jobs/:jobId/identity-token
// A fresh 10-minute, single-use proof for this job: token (NFC/QR) + 6-digit code.
const issueIdentityToken = asyncHandler(async (req, res) => {
  const b = req.booking;
  if (String(idOf(b.provider)) !== String(req.user._id)) {
    res.status(403);
    throw new Error('You are not the assigned provider for this booking');
  }
  const done = verifiedView(b.identityCheck);
  if (done) return ok(res, { alreadyVerified: true, ...done }, 'The customer has already verified you');
  if (!CHECKABLE.includes(b.status)) {
    res.status(409);
    throw new Error('You can show your ID once you are on the way or at the door');
  }
  const t = identity.issue(b._id);
  // Replaces any earlier token: only the newest one is live.
  await Booking.updateOne({ _id: b._id }, { $set: { identityCheck: t.stored } });
  ok(res, {
    token: t.token,
    code: t.code,
    nfcUri: t.nfcUri,
    qrPayload: t.qrPayload,
    expiresAt: t.expiresAt,
    ttlSeconds: Math.round(identity.TOKEN_TTL_MS / 1000),
  });
});

// POST /api/bookings/:id/verify-identity   { token, method: 'nfc'|'qr' }  or  { code }
const verifyIdentity = asyncHandler(async (req, res) => {
  const b = req.booking;
  if (String(idOf(b.customer)) !== String(req.user._id)) {
    res.status(403);
    throw new Error('Only the customer can verify the provider');
  }
  const done = verifiedView(b.identityCheck);
  if (done) return ok(res, { verified: true, already: true, status: b.status, ...done });
  if (!CHECKABLE.includes(b.status)) {
    res.status(409);
    throw new Error('You can verify your provider once they are on the way or at your door');
  }

  const ic = b.identityCheck || {};
  const { token, code } = req.body || {};
  let method;
  let claim;
  if (token) {
    const t = identity.readToken(token);
    if (t.bookingId !== String(b._id)) throw new identity.IdentityError('That ID code is for a different job');
    if (!ic.nonceHash || ic.nonceHash !== t.nonceHash) {
      throw new identity.IdentityError('That ID code was replaced or already used — ask the provider to show it again');
    }
    method = req.body.method === 'nfc' ? 'nfc' : 'qr';
    claim = { _id: b._id, 'identityCheck.nonceHash': t.nonceHash, 'identityCheck.verifiedAt': null };
  } else if (code !== undefined) {
    if (!/^\d{6}$/.test(String(code).trim())) throw new identity.IdentityError('Enter the 6-digit code', 400);
    if (!ic.codeHash || !ic.expiresAt || new Date(ic.expiresAt).getTime() < Date.now()) {
      throw new identity.IdentityError('That code has expired — ask the provider to show a new one');
    }
    if (identity.codeHashFor(b._id, code) !== ic.codeHash) {
      // Count the miss atomically; the fifth one retires the code (and token).
      const after = await Booking.findOneAndUpdate(
        { _id: b._id, 'identityCheck.codeHash': ic.codeHash },
        { $inc: { 'identityCheck.attempts': 1 } },
        { new: true, projection: { 'identityCheck.attempts': 1 } }
      );
      const attempts = after ? after.identityCheck.attempts : identity.MAX_CODE_ATTEMPTS;
      if (attempts >= identity.MAX_CODE_ATTEMPTS) {
        await Booking.updateOne(
          { _id: b._id, 'identityCheck.codeHash': ic.codeHash },
          { $set: { 'identityCheck.nonceHash': null, 'identityCheck.codeHash': null } }
        );
        throw new identity.IdentityError('Too many wrong codes — ask the provider to show a new one', 429);
      }
      const left = identity.MAX_CODE_ATTEMPTS - attempts;
      throw new identity.IdentityError(`That code is not right — ${left} ${left === 1 ? 'try' : 'tries'} left`, 422, { attemptsLeft: left });
    }
    method = 'code';
    claim = { _id: b._id, 'identityCheck.codeHash': ic.codeHash, 'identityCheck.verifiedAt': null };
  } else {
    throw new identity.IdentityError('Scan the provider\'s ID or enter their 6-digit code', 400);
  }

  // Single use: the first check to land wins; the token and code die with it.
  const verifiedAt = new Date();
  const set = {
    'identityCheck.verifiedAt': verifiedAt,
    'identityCheck.method': method,
    'identityCheck.nonceHash': null,
    'identityCheck.codeHash': null,
  };
  const claimed = await Booking.updateOne(claim, { $set: set });
  if (!claimed.modifiedCount) throw new identity.IdentityError('That ID code was already used', 409);
  b.identityCheck = { ...(ic.toObject ? ic.toObject() : ic), verifiedAt, method, nonceHash: null, codeHash: null };

  // The provider is at the door: an EN_ROUTE booking becomes ARRIVED on the
  // provider's own credential (their app issued this token for this job),
  // without telling the customer "your provider has arrived" — they are
  // looking at them.
  if (b.status === STATUS.EN_ROUTE) {
    try {
      await transition(b, STATUS.ARRIVED, { id: idOf(b.provider), role: 'provider' }, {
        note: `Arrival confirmed by the customer's identity check (${method})`,
        suppressPush: true,
      });
    } catch (e) {
      // The verification stands even if the status move lost a race.
      console.error(`[identity] arrival after verification failed booking=${b._id}: ${e.message}`);
    }
  }

  const { emitToBooking, pushToUser } = require('../../../sockets');
  await Promise.allSettled([
    emitToBooking(b._id, 'identity_verified', { bookingId: String(b._id), method, verifiedAt: verifiedAt.toISOString() }),
    pushToUser(idOf(b.provider), 'provider', {
      type: 'identity_verified',
      title: 'Identity confirmed',
      body: `${(b.customer && b.customer.fullName) || 'Your customer'} confirmed it's you.`,
      data: { bookingId: String(b._id), roomType: 'homeservice', audience: 'provider' },
    }),
  ]);

  ok(res, { verified: true, method, verifiedAt, status: b.status }, 'Provider verified');
});

module.exports = { issueIdentityToken, verifyIdentity, verifiedView };
