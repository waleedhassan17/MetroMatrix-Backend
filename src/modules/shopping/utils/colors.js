/**
 * Brand theme colour validation.
 *
 * A brand's primaryColor drives the tab bar, the store header and the text
 * colour computed against it on the client. Those fields were on the editable
 * allowlist with no validation at all, so `PATCH /vendor/brand` accepted any
 * string — 'blue', '', 'rgb(1,2,3)', a paragraph — and stored it. The app then
 * fed it to a hex parser, got nothing back, and painted a brand-coloured
 * surface as transparent or black with unreadable text on top.
 *
 * Validate at the boundary and the client never has to defend against it.
 */

const THEME_COLOR_FIELDS = ['primaryColor', 'secondaryColor', 'accentColor'];

/** #RGB or #RRGGBB. Alpha is rejected: these are opaque brand surfaces. */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const isHexColor = (value) => typeof value === 'string' && HEX.test(value.trim());

/** Normalise for storage so `#ABC` and `#aabbcc` do not both appear in the data. */
const normaliseHex = (value) => {
  const hex = value.trim().toLowerCase();
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
};

/**
 * Validates any theme colours present in `body` and rewrites them in place to
 * the normalised form.
 *
 * @returns {string|null} An error message naming the offending field, or null.
 */
const validateThemeColors = (body) => {
  for (const field of THEME_COLOR_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;

    // Clearing a colour is legitimate — it means "fall back to the shopping
    // default" — so an empty value is allowed through as an explicit unset.
    if (value === null || value === '') continue;

    if (!isHexColor(value)) {
      return `${field} must be a hex colour like #E67E22 (received ${JSON.stringify(value)})`;
    }
    body[field] = normaliseHex(value);
  }
  return null;
};

module.exports = { THEME_COLOR_FIELDS, isHexColor, normaliseHex, validateThemeColors };
