/**
 * "My AC is dripping water and not cooling, need someone today"
 *   → { category: 'ac-repairers', availableNow: true }.
 *
 * Customers describe a problem, not a trade. Rules first: weighted keyword
 * signals per trade (English and Roman-Urdu — bijli, pankha, nalka, thanda…),
 * strong words (the trade's own nouns) outweighing weak ones that several
 * trades share ("water", "motor"). Urgency words (urgent, abhi, jaldi, today)
 * ask for providers available right now. Gemini is consulted only when the
 * rules found no trade at all in a sentence-length description, and its
 * answer must be one of the three trades or it is ignored. Cached for a day.
 */
const crypto = require('crypto');
const { getOrSet } = require('../../../lib/cache');
const { k } = require('../../../lib/redis');
const { generateJson } = require('../../../lib/gemini');

const LABELS = { electricians: 'Electrician', plumbers: 'Plumber', 'ac-repairers': 'AC technician' };

const SIGNALS = {
  'ac-repairers': {
    strong: ['ac', 'acs', 'aircon', 'air conditioner', 'air conditioning', 'split', 'hvac', 'gas refill', 'gas filling', 'compressor'],
    weak: ['cooling', 'thanda', 'thandi', 'condenser', 'remote', 'outdoor unit', 'indoor unit'],
  },
  plumbers: {
    strong: [
      'plumber', 'plumbing', 'leak', 'leaks', 'leaking', 'leakage', 'pipe', 'pipes', 'tap', 'taps', 'faucet', 'drain',
      'clogged', 'toilet', 'flush', 'commode', 'geyser', 'nalka', 'nali', 'gutter', 'sewer', 'sewerage', 'washbasin',
      'basin', 'sink', 'shower', 'water tank',
    ],
    weak: ['water', 'pani', 'motor', 'pump', 'tank', 'bathroom', 'blocked', 'drip', 'dripping', 'pressure'],
  },
  electricians: {
    strong: [
      'electrician', 'electric', 'electrical', 'wiring', 'rewiring', 'short circuit', 'breaker', 'fuse', 'socket',
      'switch', 'switches', 'switchboard', 'db box', 'distribution board', 'bijli', 'ups', 'earthing', 'tripping',
      'spark', 'sparking', 'sparks',
    ],
    weak: ['light', 'lights', 'bulb', 'tube light', 'fan', 'pankha', 'plug', 'power', 'inverter', 'generator', 'voltage', 'wire', 'wires', 'shock', 'meter'],
  },
};
const URGENT = ['urgent', 'urgently', 'emergency', 'asap', 'now', 'right now', 'immediately', 'today', 'tonight', 'abhi', 'jaldi', 'foran', 'fori', 'turant'];

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\ba[./]c\b\.?/g, 'ac') // a.c / a/c / a.c.
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const has = (text, phrase) => new RegExp(`(^| )${phrase.replace(/ /g, ' +')}( |$)`).test(text);

/** Scores per trade, best first. */
function scoreTrades(text) {
  return Object.entries(SIGNALS)
    .map(([category, { strong, weak }]) => ({
      category,
      score: strong.filter((w) => has(text, w)).length * 3 + weak.filter((w) => has(text, w)).length,
    }))
    .sort((a, b) => b.score - a.score);
}

function parseRules(input) {
  const text = normalise(input);
  const scores = scoreTrades(text);
  const [top, second] = scores;
  const confident = top.score > 0 && top.score > second.score && (top.score >= 2 || second.score === 0);
  return {
    category: confident ? top.category : null,
    // When it is a toss-up, offer the contenders instead of guessing.
    candidates: confident ? [] : scores.filter((s) => s.score > 0 && s.score === top.score).map((s) => s.category),
    availableNow: URGENT.some((w) => has(text, w)),
  };
}

function cleanLlm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = Object.prototype.hasOwnProperty.call(LABELS, raw.category) ? raw.category : null;
  if (!category) return null;
  return { category, candidates: [], availableNow: raw.urgent === true };
}

async function understandService(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { interpreted: { category: null, candidates: [], availableNow: false }, source: 'rules' };
  const key = k('nlq', 'svc', 'v1', crypto.createHash('sha1').update(normalise(q)).digest('hex'));
  return getOrSet(key, 24 * 60 * 60, async () => {
    const rules = parseRules(q);
    if (rules.category || rules.candidates.length || q.split(/\s+/).length < 3) return { interpreted: rules, source: 'rules' };
    const llm = cleanLlm(
      await generateJson(
        'A customer in Pakistan describes a home repair problem (English or Roman Urdu). ' +
          'Classify it as one of: "electricians", "plumbers", "ac-repairers", or "none". ' +
          'Answer JSON only: {"category": string, "urgent": boolean}. ' +
          `Description: ${JSON.stringify(q)}`
      )
    );
    if (llm) return { interpreted: { ...llm, availableNow: llm.availableNow || rules.availableNow }, source: 'llm' };
    return { interpreted: rules, source: 'rules' };
  });
}

module.exports = { understandService, parseRules, cleanLlm, normalise, LABELS, SIGNALS };
