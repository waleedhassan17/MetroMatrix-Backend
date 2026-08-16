/**
 * Shopping — variant size/colour normalisation.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/scrape-brands.py` used to read Outfitters' Shopify options
 * positionally (`option1` -> size, `option2` -> colour). Outfitters declares
 * its options as [Color, Size, Season], so every one of its 30 products was
 * stored with the colour in `size` and the size in `color`. The storefront
 * faithfully rendered "Size: Black" / "Color: L".
 *
 * The scraper is fixed at source, but this module is the durable guarantee:
 * the seed and the repair migration both run every variant through
 * `normaliseVariant`, so a colour can never again end up in `size` regardless
 * of what the catalog JSON says.
 *
 * The classifier is deliberately asymmetric. Sizes are a small, closed set;
 * colour names are unbounded. So we allowlist sizes and treat everything else
 * as a colour — never the other way round.
 */

/** Letter sizes: XS, S, M, L, XL, XXL, XXXL, 2XL-4XL. */
const LETTER_SIZE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-4]XL)$/;
/** Bare numeric sizes: 26, 30, 41 … */
const NUMERIC_SIZE = /^\d{1,2}$/;
/** Numeric ranges: 36-38, 39-41 */
const RANGE_SIZE = /^\d{1,2}\s*-\s*\d{1,2}$/;
/** Age ranges: "5-6 Y", "13-14 Y", "7-8 Yrs" */
const AGE_SIZE = /^\d{1,2}\s*-\s*\d{1,2}\s*Y(RS?)?$/;
/** Markers a store uses when a product has no real size. */
const NO_SIZE_LITERALS = new Set([
  'FREE',
  'FREE SIZE',
  'ONE SIZE',
  'OS',
  'DEFAULT',
]);

const ONE_SIZE = 'One Size';

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** True when `token` reads as a size rather than a colour. */
function isSizeToken(token) {
  const t = clean(token).toUpperCase();
  if (!t) return false;
  return (
    LETTER_SIZE.test(t) ||
    NUMERIC_SIZE.test(t) ||
    RANGE_SIZE.test(t) ||
    AGE_SIZE.test(t) ||
    NO_SIZE_LITERALS.has(t)
  );
}

/** True when the token is a "no real size" marker. */
function isNoSizeLiteral(token) {
  return NO_SIZE_LITERALS.has(clean(token).toUpperCase());
}

/**
 * Returns `{ size, color }` corrected. Pure and idempotent — after one pass
 * `size` always holds a size token, so a second pass takes the no-op branch.
 *
 *   both correct                  -> unchanged
 *   size=colour AND color=size    -> swapped
 *   size=colour AND color empty   -> colour moved out, size becomes One Size
 *   size is FREE/Default/etc      -> One Size
 *   size missing                  -> One Size
 */
function normaliseVariant(variant = {}) {
  let size = clean(variant.size);
  let color = clean(variant.color);

  const sizeLooksLikeSize = isSizeToken(size);
  const colorLooksLikeSize = isSizeToken(color);

  if (!sizeLooksLikeSize && size) {
    if (colorLooksLikeSize && color) {
      // Classic inverted pair — swap them.
      const swap = size;
      size = color;
      color = swap;
    } else if (!color) {
      // Accessory: a colour was stored as the size and there is no colour at
      // all. Move it across; the product genuinely has no size.
      color = size;
      size = ONE_SIZE;
    }
  }

  if (!size || isNoSizeLiteral(size)) size = ONE_SIZE;

  return { size, color: color || undefined };
}

/**
 * Canonical hex for the colours these two catalogues actually use, so swatches
 * render as the real colour instead of a uniform grey fallback.
 *
 * "Multi" / "Multi Color" are deliberately absent — no single hex is honest for
 * them, so they fall through to the client's neutral swatch.
 * "Mlik Rose" is the store's own typo; keyed verbatim so the lookup hits.
 */
const COLOR_HEX = {
  'anthracite grey': '#3A3A3C',
  beige: '#E8DCC4',
  black: '#000000',
  blue: '#3498DB',
  brown: '#8B5E3C',
  'chocolate brown': '#5C4033',
  'crimson red': '#B01B2E',
  'dark brown': '#4A322A',
  'dark olive': '#4F5A31',
  gold: '#C9A227',
  green: '#27AE60',
  grey: '#95A5A6',
  'light grey marl': '#C8CBCC',
  'mlik rose': '#E8B4B8',
  mushroom: '#BDB0A0',
  navy: '#1B2838',
  'off white': '#F5F2EA',
  pink: '#E91E63',
  purple: '#8B5CF6',
  sand: '#D8C9A3',
  silver: '#C0C0C0',
  taupe: '#B0A08E',
  teal: '#008080',
  twilight: '#4A5A75',
  'vanilla ice': '#F3E5D0',
  white: '#FFFFFF',
};

/** Hex for a colour name, or undefined when we have no honest answer. */
function colorHexFor(name) {
  const key = clean(name).toLowerCase();
  return key ? COLOR_HEX[key] : undefined;
}

module.exports = {
  isSizeToken,
  normaliseVariant,
  colorHexFor,
  COLOR_HEX,
  ONE_SIZE,
};
