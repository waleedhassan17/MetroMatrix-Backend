const crypto = require('crypto');

/**
 * Human-readable secondary id used across the shopping module
 * (ODX-B-xxxx brands, ODX-P-xxxx products, ODX-O-xxxx orders, ODX-G-xxxx order groups).
 */
const generateOdexId = (prefix) =>
  `ODX-${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

module.exports = { generateOdexId, slugify };
