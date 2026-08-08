/**
 * task.md P0 — the double-hash bug that broke password login for everyone.
 *
 * The old pre('save') hook in User/Provider/Admin was:
 *
 *   if (!this.isModified('password')) { next(); }   // no `return`
 *   this.password = await bcrypt.hash(this.password, salt);
 *
 * so EVERY save() re-hashed the stored hash. loginUser/loginProvider both
 * `.select('+password')` and then save() (refreshToken + lastLoginDate), so
 * one successful login corrupted the hash and the next login returned
 * INVALID_CREDENTIALS.
 *
 * These tests drive the real shared hook with real bcrypt and no database:
 * a mongoose Document is simulated by the small `makeDoc` harness below,
 * which is enough because the hook only touches `isModified()` and
 * `this.password`. The DB-backed variant (a genuine save/re-save round trip)
 * lives at the bottom, gated on MONGODB_URI like the wallet suites.
 */
const bcrypt = require('bcryptjs');
const { hashPasswordPreSave } = require('../utils/hashPassword');

/**
 * Minimal stand-in for a mongoose Document as far as this hook can tell:
 * tracks which paths were assigned since the last "save".
 */
function makeDoc(initial = {}) {
  const doc = {
    ...initial,
    _modified: new Set(Object.keys(initial)),
    isModified(path) {
      return this._modified.has(path);
    },
    set(path, value) {
      this[path] = value;
      this._modified.add(path);
    },
    /**
     * Run the pre-save hook, then clear the dirty set like a real save().
     *
     * Completion mirrors mongoose: whichever happens first, next() being
     * called or the hook's returned promise settling. That matters — the
     * buggy version called next() early and then kept running, so a harness
     * that only waited on next() would miss the corruption. The trailing
     * timer lets any such orphaned continuation land before we assert,
     * which is exactly the window in which mongoose would persist it.
     */
    async save() {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          return err ? reject(err) : resolve();
        };
        const returned = hashPasswordPreSave.call(this, finish);
        if (returned && typeof returned.then === 'function') {
          returned.then(() => finish(), finish);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      this._modified.clear();
      return this;
    },
  };
  return doc;
}

/** Same body as the models' matchPassword. */
const matchPassword = (doc, entered) =>
  doc.password ? bcrypt.compare(entered, doc.password) : Promise.resolve(false);

describe('password pre-save hook (P0 double-hash fix)', () => {
  it('hashes the password on initial create', async () => {
    const doc = makeDoc({ password: 'secret123' });
    await doc.save();

    expect(doc.password).not.toBe('secret123');
    expect(doc.password).toMatch(/^\$2[aby]\$/);
    await expect(matchPassword(doc, 'secret123')).resolves.toBe(true);
  });

  it('survives a re-save that does not touch the password (the actual bug)', async () => {
    const doc = makeDoc({ email: 'waleedhassansfd@gmail.com', password: 'secret123' });
    await doc.save();
    const hashAfterCreate = doc.password;

    // Exactly what loginUser does: set login bookkeeping, save again.
    doc.set('lastLoginDate', Date.now());
    doc.set('refreshToken', 'some-refresh-token');
    await doc.save();

    expect(doc.password).toBe(hashAfterCreate);
    await expect(matchPassword(doc, 'secret123')).resolves.toBe(true);
  });

  it('still authenticates after many consecutive logins', async () => {
    const doc = makeDoc({ password: 'secret123' });
    await doc.save();

    for (let i = 0; i < 5; i += 1) {
      doc.set('lastLoginDate', Date.now());
      await doc.save();
      await expect(matchPassword(doc, 'secret123')).resolves.toBe(true);
    }
  });

  it('re-hashes when the password is genuinely changed (reset flow)', async () => {
    const doc = makeDoc({ password: 'secret123' });
    await doc.save();

    doc.set('password', 'newpassword456');
    await doc.save();

    await expect(matchPassword(doc, 'newpassword456')).resolves.toBe(true);
    await expect(matchPassword(doc, 'secret123')).resolves.toBe(false);
  });

  it('does not attempt to hash a social account with no password', async () => {
    const doc = makeDoc({ email: 'social@example.com', googleId: 'google-uid-1' });
    await expect(doc.save()).resolves.toBeDefined();
    expect(doc.password).toBeUndefined();
  });

  it('does not corrupt anything when the doc was loaded without +password', async () => {
    // findOne() without .select('+password') leaves password undefined; the
    // old hook called bcrypt.hash(undefined) here.
    const doc = makeDoc({ email: 'a@b.com' });
    doc.set('profileComplete', true);
    await expect(doc.save()).resolves.toBeDefined();
    expect(doc.password).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real round trip through mongoose + MongoDB, for when a DB is available.
// ---------------------------------------------------------------------------
const hasDb = !!process.env.MONGODB_URI;
const d = hasDb ? describe : describe.skip;
jest.setTimeout(30000);

d('password hook against real MongoDB', () => {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const Provider = require('../models/Provider');

  const email = `hashfix-${Date.now()}@example.com`;
  const providerEmail = `hashfix-provider-${Date.now()}@example.com`;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
  });

  afterAll(async () => {
    await User.deleteOne({ email });
    await Provider.deleteOne({ email: providerEmail });
    await mongoose.disconnect();
  });

  it('User: login-shaped re-save keeps the password valid', async () => {
    await User.create({
      fullName: 'Hash Fix',
      phoneNumber: '03001234567',
      email,
      password: '12345678',
    });

    const loaded = await User.findOne({ email }).select('+password');
    expect(await loaded.matchPassword('12345678')).toBe(true);

    loaded.lastLoginDate = Date.now();
    loaded.refreshToken = 'rt';
    await loaded.save();

    const reloaded = await User.findOne({ email }).select('+password');
    expect(await reloaded.matchPassword('12345678')).toBe(true);
  });

  it('Provider: login-shaped re-save keeps the password valid', async () => {
    await Provider.create({
      fullName: 'Hash Fix Provider',
      phoneNumber: '03007654321',
      email: providerEmail,
      password: '12345678',
      providerType: 'pending',
    });

    const loaded = await Provider.findOne({ email: providerEmail }).select('+password');
    expect(await loaded.matchPassword('12345678')).toBe(true);

    loaded.lastLoginDate = Date.now();
    loaded.refreshToken = 'rt';
    await loaded.save();

    const reloaded = await Provider.findOne({ email: providerEmail }).select('+password');
    expect(await reloaded.matchPassword('12345678')).toBe(true);
  });
});
