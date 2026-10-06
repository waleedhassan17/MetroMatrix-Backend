/**
 * Refresh sessions for user and provider accounts — one per signed-in client.
 *
 * Accounts used to hold a single `refreshToken`, overwritten on every sign-in
 * and rotated on every refresh. Any second client therefore broke the first:
 *
 *  - The phone and a browser on the same account invalidated each other's
 *    refresh token, so whichever renewed second was signed out at its next
 *    access-token expiry (15 minutes) — "it works in the app, not on web".
 *  - Browser tabs share localStorage but each refreshes on its own. When the
 *    access token expired, two tabs presented the same refresh token; the
 *    loser got a 401 and its clearAuthData() wiped the session from every tab.
 *
 * Each sign-in now starts its own session, identified by the sha256 of its
 * current refresh token (the token itself is never stored). A refresh rotates
 * that one session. A token rotated less than REFRESH_REUSE_GRACE_MS ago is
 * honoured once more by opening a sibling session — that is the second tab
 * losing the race, not a replay. Older tokens are refused.
 *
 * Every write is a single atomic update of the account document: two
 * concurrent refreshes must never load-modify-save over each other.
 *
 * Admin sessions are separate (models/AdminSession.js) and untouched here.
 */
const crypto = require('crypto');

const DEFAULT_SESSION_LIMIT = 10;
const DEFAULT_REUSE_GRACE_MS = 60 * 1000;

const numberFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const sessionLimit = () => Math.max(1, numberFromEnv('REFRESH_SESSION_LIMIT', DEFAULT_SESSION_LIMIT));
const reuseGraceMs = () => numberFromEnv('REFRESH_REUSE_GRACE_MS', DEFAULT_REUSE_GRACE_MS);

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Least recently used goes first when the cap is reached, so a phone that
// renews every day outlives a burst of browser sign-ins on a shared account.
const pushSession = (entry) => ({
  $push: {
    refreshSessions: { $each: [entry], $sort: { lastUsedAt: 1 }, $slice: -sessionLimit() },
  },
});

// Accounts are User or Provider documents; the document's model does the write.
const modelOf = (account) => account.constructor;

/** Record a new session for a refresh token just issued at sign-in. Call after the account is saved. */
async function startRefreshSession(account, token) {
  const now = new Date();
  await modelOf(account).updateOne(
    { _id: account._id },
    pushSession({ hash: hashOf(token), createdAt: now, lastUsedAt: now })
  );
}

/**
 * Swap `oldToken` for `newToken`. Resolves to how it was accepted —
 * 'rotated', 'sibling' (inside the reuse grace window) or 'migrated' (a
 * pre-sessions token) — or null when `oldToken` is not a live session.
 */
async function rotateRefreshSession(account, oldToken, newToken) {
  const Model = modelOf(account);
  const now = new Date();
  const oldHash = hashOf(oldToken);
  const newHash = hashOf(newToken);

  const rotated = await Model.updateOne(
    { _id: account._id, 'refreshSessions.hash': oldHash },
    {
      $set: {
        'refreshSessions.$.hash': newHash,
        'refreshSessions.$.prevHash': oldHash,
        'refreshSessions.$.rotatedAt': now,
        'refreshSessions.$.lastUsedAt': now,
      },
    }
  );
  if (rotated.modifiedCount === 1) return 'rotated';

  const rotatedSince = new Date(now.getTime() - reuseGraceMs());
  const sibling = await Model.updateOne(
    {
      _id: account._id,
      refreshSessions: { $elemMatch: { prevHash: oldHash, rotatedAt: { $gte: rotatedSince } } },
    },
    pushSession({ hash: newHash, prevHash: oldHash, rotatedAt: now, createdAt: now, lastUsedAt: now })
  );
  if (sibling.modifiedCount === 1) return 'sibling';

  // Sessions issued before refreshSessions existed sit in the legacy single
  // slot. Accept that token once and move it into a session, so the deploy
  // signs nobody out. Recording prevHash lets a racing second tab through.
  const migrated = await Model.updateOne(
    { _id: account._id, refreshToken: oldToken },
    {
      $unset: { refreshToken: 1 },
      ...pushSession({ hash: newHash, prevHash: oldHash, rotatedAt: now, createdAt: now, lastUsedAt: now }),
    }
  );
  if (migrated.modifiedCount === 1) return 'migrated';

  return null;
}

/** Sign out the one client holding `token`; every other session stays. */
async function endRefreshSession(account, token) {
  const Model = modelOf(account);
  await Model.updateOne({ _id: account._id }, { $pull: { refreshSessions: { hash: hashOf(token) } } });
  await Model.updateOne({ _id: account._id, refreshToken: token }, { $unset: { refreshToken: 1 } });
}

/** Sign out everywhere — password reset, deactivation, a logout that names no session. */
async function endAllRefreshSessions(account) {
  await modelOf(account).updateOne({ _id: account._id }, { $unset: { refreshSessions: 1, refreshToken: 1 } });
}

module.exports = {
  startRefreshSession,
  rotateRefreshSession,
  endRefreshSession,
  endAllRefreshSessions,
  hashOf,
};
