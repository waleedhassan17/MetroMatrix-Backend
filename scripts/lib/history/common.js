/**
 * Shared machinery for scripts/seed-history.js — the 3-month history seed.
 *
 * Why documents are written directly instead of through the real services:
 * checkout, order transitions and booking payments send FCM pushes through
 * the realtime service (src/sockets/index.js pushToUser), use up product
 * stock and stamp everything "now". A history seed needs August dates and
 * must not buzz anyone's phone, so each module here reproduces the service's
 * side effects by hand (ledger rows, payouts, counters) with explicit dates.
 *
 * Every row the seed writes is recorded in the `seed_history_registry`
 * collection under a stable key. That registry is what makes a re-run a
 * no-op and what `--purge` walks to remove the history again — the app's
 * own documents carry no seed-only fields.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { DateTime } = require('luxon');

const Wallet = require('../../../src/models/Wallet');
const WalletTransaction = require('../../../src/models/WalletTransaction');
const { localToUtc } = require('../../../src/utils/time');

const TZ = 'Asia/Karachi';
const REGISTRY = 'seed_history_registry';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ── Deterministic randomness ─────────────────────────────────────────── */

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32, seeded from a string: the same key always yields the same draws. */
function makeRng(key) {
  let a = hashString(String(key));
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** weights: [[value, weight], ...] */
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [value, w] of pairs) {
        r -= w;
        if (r <= 0) return value;
      }
      return pairs[pairs.length - 1][0];
    },
  };
}

/** Pick from a list where earlier entries are likelier — gives repeat customers. */
function pickRepeat(rng, list) {
  const pairs = list.map((item, i) => [item, 1 / (1 + i * 0.35)]);
  return rng.weighted(pairs);
}

/* ── Time (Pakistan) ─────────────────────────────────────────────────── */

/** Wall clock in Lahore -> the UTC instant. */
const pkt = (dateKey, hhmm) => localToUtc(dateKey, hhmm, TZ);

const hhmm = (minutesOfDay) =>
  `${String(Math.floor(minutesOfDay / 60)).padStart(2, '0')}:${String(minutesOfDay % 60).padStart(2, '0')}`;

const addMin = (date, minutes) => new Date(date.getTime() + minutes * MIN);

const dateKeyOf = (date) => DateTime.fromJSDate(date, { zone: 'utc' }).setZone(TZ).toFormat('yyyy-MM-dd');

const todayKey = () => DateTime.now().setZone(TZ).toFormat('yyyy-MM-dd');

const shiftKey = (key, days) => DateTime.fromISO(key, { zone: TZ }).plus({ days }).toFormat('yyyy-MM-dd');

/** 1 = Monday … 7 = Sunday. */
const weekdayOf = (key) => DateTime.fromISO(key, { zone: TZ }).weekday;

function eachDayKey(fromKey, toKey) {
  const out = [];
  let cur = DateTime.fromISO(fromKey, { zone: TZ });
  const end = DateTime.fromISO(toKey, { zone: TZ });
  while (cur <= end && out.length < 400) {
    out.push(cur.toFormat('yyyy-MM-dd'));
    cur = cur.plus({ days: 1 });
  }
  return out;
}

/** An ObjectId whose embedded timestamp matches the (backdated) event, so _id order follows createdAt. */
function oidAt(date) {
  const seconds = Math.floor(new Date(date).getTime() / 1000);
  const hex = seconds.toString(16).padStart(8, '0') + crypto.randomBytes(8).toString('hex');
  return new mongoose.Types.ObjectId(hex);
}

const shortHex = (n = 8) => crypto.randomBytes(n).toString('hex');

const rupees = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString('en-PK')}`;

/* ── Run context: registry, idempotent inserts, ledger ───────────────── */

class SeedContext {
  constructor({ dryRun, now }) {
    this.dryRun = dryRun;
    this.now = now;
    this.db = mongoose.connection.db;
    this.registry = this.db.collection(REGISTRY);
    this.reg = new Map(); // seedKey -> docId
    this.stats = {}; // collection -> { created, skipped }
    this.balances = new Map(); // walletId -> balance as this run sees it
    this.touchedWallets = new Map(); // walletId -> label
    this.warnings = [];
  }

  async load() {
    if (!this.dryRun) {
      const exists = await this.db.listCollections({ name: REGISTRY }).hasNext();
      if (!exists) await this.db.createCollection(REGISTRY);
    }
    const rows = await this.registry.find({}, { projection: { docId: 1 } }).toArray();
    rows.forEach((r) => this.reg.set(r._id, r.docId));
  }

  count(coll, what) {
    if (!this.stats[coll]) this.stats[coll] = { created: 0, skipped: 0 };
    this.stats[coll][what] += 1;
  }

  has(key) {
    return this.reg.has(key);
  }

  warn(msg) {
    this.warnings.push(msg);
  }

  /**
   * Insert one document unless `key` was already seeded. The doc goes
   * through the Mongoose model's validation (enums, required fields,
   * pre-validate hooks such as odexId) and is then written with the raw
   * driver so the backdated createdAt/updatedAt survive — Mongoose drops a
   * backdated createdAt on create()/updateOne().
   *
   * The registry row is written first: a crash between the two writes then
   * leaves a missing row (harmless) rather than an untracked one.
   */
  async put(Model, key, doc) {
    const coll = Model.collection.name;
    if (this.reg.has(key)) {
      this.count(coll, 'skipped');
      return { _id: this.reg.get(key), created: false };
    }
    const createdAt = doc.createdAt || this.now;
    const _id = doc._id || oidAt(createdAt);
    const full = { ...doc, _id, createdAt, updatedAt: doc.updatedAt || createdAt };
    const instance = new Model(full);
    await instance.validate();
    const raw = instance.toObject({ virtuals: false, transform: false, getters: false, depopulate: true });
    raw.createdAt = full.createdAt;
    if (Model.schema.path('updatedAt')) raw.updatedAt = full.updatedAt;
    else delete raw.updatedAt;
    if (raw.__v === undefined) raw.__v = 0;

    if (!this.dryRun) {
      await this.registry.insertOne({ _id: key, coll, docId: _id, kind: 'doc', at: new Date() });
      await Model.collection.insertOne(raw);
    }
    this.reg.set(key, _id);
    this.count(coll, 'created');
    return { _id, created: true, doc: raw };
  }

  /** Mark an existing (template) slot booked; remembered so --purge can release it. */
  async bookExistingSlot(key, slotId) {
    if (this.reg.has(key)) {
      this.count('slots(booked)', 'skipped');
      return false;
    }
    if (!this.dryRun) {
      const res = await this.db
        .collection('slots')
        .updateOne({ _id: slotId, status: 'available' }, { $set: { status: 'booked', bookedCount: 1 } });
      if (!res.modifiedCount) return false;
      await this.registry.insertOne({ _id: key, coll: 'slots', docId: slotId, kind: 'booked', at: new Date() });
    }
    this.reg.set(key, slotId);
    this.count('slots(booked)', 'created');
    return true;
  }

  /* ── Wallets ── */

  async wallet(ownerId, ownerType, label) {
    let w = await Wallet.findOne({ owner: ownerId, ownerType }).lean();
    if (!w) {
      if (this.dryRun) {
        w = { _id: new mongoose.Types.ObjectId(), owner: ownerId, ownerType, balance: 0 };
      } else {
        const WalletService = require('../../../src/services/walletService');
        w = (await WalletService.getOrCreateWallet(ownerId, ownerType)).toObject();
      }
    }
    const id = String(w._id);
    if (!this.balances.has(id)) this.balances.set(id, w.balance || 0);
    if (label && !this.touchedWallets.has(id)) this.touchedWallets.set(id, label);
    return { _id: w._id, owner: ownerId, ownerType };
  }

  balanceOf(wallet) {
    return this.balances.get(String(wallet._id)) || 0;
  }

  /**
   * One ledger row and its balance effect, atomically: the wallet $inc,
   * the WalletTransaction and the registry row commit together, so
   * balance == Σ completed credits − Σ completed debits can never be broken
   * by this seed (pre-existing drift is left exactly as it was).
   */
  async ledger(key, wallet, entry) {
    if (this.reg.has(key)) {
      this.count('wallettransactions', 'skipped');
      return this.reg.get(key);
    }
    const amount = Math.round(entry.amount * 100) / 100;
    if (!(amount > 0)) return null;
    const at = entry.at;
    const _id = entry._id || oidAt(at);
    const doc = {
      _id,
      wallet: wallet._id,
      type: entry.type,
      amount,
      description: entry.description,
      status: 'completed',
      source: entry.source,
      createdAt: at,
      updatedAt: at,
    };
    if (entry.relatedTo) doc.relatedTo = entry.relatedTo;
    if (entry.counterparty) doc.counterparty = entry.counterparty;
    if (entry.transferGroupId) doc.transferGroupId = entry.transferGroupId;
    if (entry.metadata) doc.metadata = entry.metadata;

    const instance = new WalletTransaction(doc);
    await instance.validate();
    const raw = instance.toObject({ virtuals: false, transform: false, getters: false });
    raw.createdAt = at;
    raw.updatedAt = at;
    if (raw.__v === undefined) raw.__v = 0;

    const delta = entry.type === 'credit' ? amount : -amount;
    const id = String(wallet._id);
    const current = this.balances.get(id) || 0;
    if (current + delta < 0) {
      throw new Error(`Ledger ${key}: would take wallet ${id} below zero (${current} ${delta})`);
    }

    if (!this.dryRun) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const filter = delta < 0 ? { _id: wallet._id, balance: { $gte: -delta } } : { _id: wallet._id };
          const res = await this.db.collection('wallets').updateOne(filter, { $inc: { balance: delta } }, { session });
          if (!res.modifiedCount) throw new Error(`Ledger ${key}: insufficient balance in wallet ${id}`);
          await this.registry.insertOne(
            { _id: key, coll: 'wallettransactions', docId: _id, kind: 'ledger', walletId: wallet._id, delta, at: new Date() },
            { session }
          );
          await this.db.collection('wallettransactions').insertOne(raw, { session });
        });
      } finally {
        await session.endSession();
      }
    }
    this.balances.set(id, Math.round((current + delta) * 100) / 100);
    this.reg.set(key, _id);
    this.count('wallettransactions', 'created');
    return _id;
  }

  /**
   * A customer debit that first tops the wallet up if the debit would
   * overdraw it. On a re-run the debit already exists, so no top-up either.
   */
  async customerDebit(key, wallet, entry) {
    if (this.reg.has(key)) return this.ledger(key, wallet, entry);
    const balance = this.balanceOf(wallet);
    if (balance < entry.amount) {
      const topUp = Math.ceil((entry.amount - balance + 5000) / 5000) * 5000;
      await this.ledger(`${key}:topup`, wallet, {
        type: 'credit',
        amount: topUp,
        source: 'admin_adjustment',
        description: 'Wallet top-up',
        at: addMin(entry.at, -15),
      });
    }
    return this.ledger(key, wallet, { ...entry, type: 'debit' });
  }
}

/** balance − Σ(completed credits − completed debits) for each wallet id. */
async function walletDrift(walletIds) {
  const ids = walletIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const [wallets, sums] = await Promise.all([
    Wallet.find({ _id: { $in: ids } }).select('balance').lean(),
    WalletTransaction.aggregate([
      { $match: { wallet: { $in: ids }, status: 'completed' } },
      {
        $group: {
          _id: '$wallet',
          net: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$amount', { $multiply: ['$amount', -1] }] } },
        },
      },
    ]),
  ]);
  const net = new Map(sums.map((s) => [String(s._id), s.net]));
  const out = new Map();
  wallets.forEach((w) => {
    const ledgerNet = net.get(String(w._id)) || 0;
    out.set(String(w._id), { balance: w.balance, ledger: Math.round(ledgerNet * 100) / 100, drift: Math.round((w.balance - ledgerNet) * 100) / 100 });
  });
  return out;
}

module.exports = {
  TZ,
  REGISTRY,
  MIN,
  HOUR,
  DAY,
  makeRng,
  pickRepeat,
  pkt,
  hhmm,
  addMin,
  dateKeyOf,
  todayKey,
  shiftKey,
  weekdayOf,
  eachDayKey,
  oidAt,
  shortHex,
  rupees,
  SeedContext,
  walletDrift,
};
