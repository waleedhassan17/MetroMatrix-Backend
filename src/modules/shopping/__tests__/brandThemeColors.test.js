/**
 * Brand theme colour validation.
 *
 * primaryColor / secondaryColor / accentColor were on the editable allowlist
 * with no validation, so PATCH /vendor/brand happily stored 'blue' or a
 * paragraph. The client then fed that to a hex parser, got nothing, and painted
 * the storefront header transparent with unreadable text on it.
 */
const { validateThemeColors, isHexColor, normaliseHex } = require('../utils/colors');

describe('isHexColor', () => {
  it.each(['#fff', '#FFF', '#e67e22', '#E67E22', '  #abc  '])('accepts %s', (v) => {
    expect(isHexColor(v)).toBe(true);
  });

  it.each([
    'blue',
    'E67E22',
    '#E67E2',
    '#E67E222',
    'rgb(230,126,34)',
    '#GGGGGG',
    // Alpha is rejected: these are opaque brand surfaces, and a translucent
    // primary makes the computed text colour meaningless.
    '#E67E22FF',
    '',
    null,
    undefined,
    123,
    {},
  ])('rejects %p', (v) => {
    expect(isHexColor(v)).toBe(false);
  });
});

describe('normaliseHex', () => {
  it('expands the three-digit form so the data has one shape', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc');
  });

  it('lowercases the six-digit form', () => {
    expect(normaliseHex('#E67E22')).toBe('#e67e22');
  });
});

describe('validateThemeColors', () => {
  it('passes a body with no colours at all', () => {
    const body = { name: 'Outfitters' };
    expect(validateThemeColors(body)).toBeNull();
    expect(body).toEqual({ name: 'Outfitters' });
  });

  it('normalises in place when every colour is valid', () => {
    const body = { primaryColor: '#ABC', secondaryColor: '#D35400', name: 'X' };
    expect(validateThemeColors(body)).toBeNull();
    expect(body.primaryColor).toBe('#aabbcc');
    expect(body.secondaryColor).toBe('#d35400');
  });

  it('names the offending field so the vendor can fix it', () => {
    const error = validateThemeColors({ accentColor: 'goldenrod' });
    expect(error).toMatch(/accentColor/);
    expect(error).toMatch(/goldenrod/);
  });

  it('rejects on the first bad colour even when others are fine', () => {
    expect(validateThemeColors({ primaryColor: '#E67E22', secondaryColor: 'nope' }))
      .toMatch(/secondaryColor/);
  });

  it('allows an explicit clear — that means "use the shopping default"', () => {
    const body = { primaryColor: '', secondaryColor: null };
    expect(validateThemeColors(body)).toBeNull();
  });
});
