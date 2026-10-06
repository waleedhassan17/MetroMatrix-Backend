const asyncHandler = require('express-async-handler');
const User = require('../../models/User');
const Post = require('../../models/Post');
const Wallet = require('../../models/Wallet');
const Booking = require('../../modules/homeservice/models/Booking');
const Appointment = require('../../modules/healthcare/models/Appointment');
const Order = require('../../modules/shopping/models/Order');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok } = require('../../utils/apiResponse');
const { parseListQuery, findPage, searchRegex } = require('../../utils/pagination');
const { audit } = require('../../services/auditService');
const { historyOf } = require('../../services/admin/history');
const { softDeleteAccount, restoreAccount } = require('../../services/admin/accountDeletion');
const { endAllRefreshSessions } = require('../../services/refreshSessions');

/*
 * Customer account management — /api/admin/users*.
 */

const SUMMARY_FIELDS = 'fullName email phoneNumber profilePhoto isActive isEmailVerified emailVerified createdAt lastLoginDate';

const summary = (u) => ({
  id: String(u._id),
  fullName: u.fullName,
  email: u.email,
  phoneNumber: u.phoneNumber || null,
  profilePhoto: u.profilePhoto || u.profileImage || null,
  isActive: u.isActive !== false,
  emailVerified: u.isEmailVerified === true || u.emailVerified === true || u.emailVerified === 'active',
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginDate || null,
});

// @route GET /api/admin/users?status=active|inactive&search=&sort=&page=&limit=&cursor=
const listUsers = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.status === 'active') filter.isActive = { $ne: false };
  else if (q.status === 'inactive') filter.isActive = false;
  if (q.search) {
    const re = searchRegex(q.search);
    filter.$or = [{ fullName: re }, { email: re }, { phoneNumber: re }];
  }
  const list = parseListQuery(q, { sortable: ['createdAt', 'fullName', 'lastLoginDate'], defaultSort: '-createdAt' });
  const [{ items, meta }, active, inactive] = await Promise.all([
    findPage(User, filter, list, { select: SUMMARY_FIELDS }),
    User.countDocuments({ isActive: { $ne: false } }),
    User.countDocuments({ isActive: false }),
  ]);
  ok(res, items.map(summary), { ...meta, counts: { active, inactive } });
});

async function loadUser(req) {
  const user = await User.findById(req.params.userId);
  if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found');
  return user;
}

// @route GET /api/admin/users/:userId
const getUser = asyncHandler(async (req, res) => {
  const user = await loadUser(req);
  const [bookings, appointments, orders, posts, wallet, history] = await Promise.all([
    Booking.countDocuments({ customer: user._id }),
    Appointment.countDocuments({ patientId: user._id }),
    Order.countDocuments({ userId: user._id }),
    Post.countDocuments({ author: user._id }),
    Wallet.findOne({ owner: user._id, ownerType: 'User' }).select('balance currency').lean(),
    historyOf('User', user._id),
  ]);
  ok(res, {
    ...summary(user),
    address: user.address || null,
    gender: user.gender || null,
    counts: { bookings, appointments, orders, posts },
    // The balance matters to account decisions (a funded wallet blocks
    // deletion); full wallet history needs canManageFinance.
    wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null,
    history,
  });
});

async function setActive(req, res, isActive) {
  const user = await loadUser(req);
  const before = { isActive: user.isActive !== false };
  if (before.isActive === isActive) {
    throw new AppError(ERROR_CODES.CONFLICT, `This user is already ${isActive ? 'active' : 'deactivated'}`);
  }
  user.isActive = isActive;
  await user.save();
  // Deactivation also ends their ability to renew a session (protect
  // refuses inactive accounts on every request already).
  if (!isActive) await endAllRefreshSessions(user);
  await audit(req, {
    action: isActive ? 'user.activate' : 'user.deactivate',
    targetType: 'User',
    targetId: user._id,
    before,
    after: { isActive },
    reason: req.body?.reason,
  });
  ok(res, { ...summary(user), history: await historyOf('User', user._id) });
}

// @route PUT /api/admin/users/:userId/activate     { reason? }
const activateUser = asyncHandler((req, res) => setActive(req, res, true));
// @route PUT /api/admin/users/:userId/deactivate   { reason }
const deactivateUser = asyncHandler((req, res) => setActive(req, res, false));

// @route DELETE /api/admin/users/:userId   { reason }
const deleteUser = asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || req.query?.reason || '').trim();
  if (!reason) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A reason is required to delete an account');
  const user = await loadUser(req);
  const { deletedAt } = await softDeleteAccount('User', user, { admin: req.user, reason });
  await audit(req, {
    action: 'user.delete',
    targetType: 'User',
    targetId: user._id,
    before: { email: user.email, isActive: user.isActive },
    after: { deletedAt },
    reason,
  });
  ok(res, { id: String(user._id), deletedAt, restorable: true });
});

// @route POST /api/admin/users/:userId/restore   (super admin)
const restoreUser = asyncHandler(async (req, res) => {
  const restored = await restoreAccount('User', req.params.userId);
  await audit(req, {
    action: 'user.restore',
    targetType: 'User',
    targetId: req.params.userId,
    before: { deletedAt: restored.deletedAt },
    after: { deletedAt: null, email: restored.restoredEmail },
    reason: String(req.body?.reason || ''),
  });
  ok(res, { id: String(req.params.userId), restored: true, email: restored.restoredEmail });
});

module.exports = { listUsers, getUser, activateUser, deactivateUser, deleteUser, restoreUser };
