jest.mock('../../../lib/gemini', () => ({ generateJson: jest.fn() }));
const { generateJson } = require('../../../lib/gemini');
const { parseRules, cleanLlm, understandService, normalise } = require('../services/serviceIntent');

describe('service intent rules', () => {
  it.each([
    ['My AC is not cooling', 'ac-repairers', false],
    ['a.c dripping water, need someone today', 'ac-repairers', true],
    ['water dripping from the AC', 'ac-repairers', false],
    ['inverter ac gas refill urgent', 'ac-repairers', true],
    ['kitchen tap leaking', 'plumbers', false],
    ['toilet flush broken', 'plumbers', false],
    ['geyser not heating', 'plumbers', false],
    ['water motor not working', 'plumbers', false],
    ['bijli ka masla, switch se spark', 'electricians', false],
    ['pankha nahi chal raha abhi', 'electricians', true],
    ['fan and light not working', 'electricians', false],
  ])('%s → %s (now: %s)', (q, category, now) => {
    expect(parseRules(q)).toMatchObject({ category, availableNow: now });
  });

  it('finds no trade where there is none', () => {
    expect(parseRules('paint my bedroom wall')).toEqual({ category: null, candidates: [], availableNow: false });
  });

  it('offers the contenders on a tie instead of guessing', () => {
    // one strong word each: socket (electric) + pipe (plumbing)
    const r = parseRules('socket near the pipe');
    expect(r.category).toBeNull();
    expect(r.candidates.sort()).toEqual(['electricians', 'plumbers']);
  });

  it('matches whole words only ("back" is not "ac", "tapestry" is not "tap")', () => {
    expect(parseRules('back room tapestry').category).toBeNull();
  });

  it('normalises a/c and punctuation', () => {
    expect(normalise('A/C!! not   cooling')).toBe('ac not cooling');
  });
});

describe('Gemini second opinion', () => {
  beforeEach(() => generateJson.mockReset());

  it('keeps only one of the three trades', () => {
    expect(cleanLlm({ category: 'plumbers', urgent: true })).toEqual({ category: 'plumbers', candidates: [], availableNow: true });
    expect(cleanLlm({ category: 'carpenters' })).toBeNull();
    expect(cleanLlm({ category: 'none' })).toBeNull();
    expect(cleanLlm(null)).toBeNull();
    expect(cleanLlm('plumbers')).toBeNull();
  });

  it('is not asked when the rules already know', async () => {
    const r = await understandService('ceiling fan sparking');
    expect(r).toMatchObject({ source: 'rules', interpreted: { category: 'electricians' } });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('is not asked for one or two words', async () => {
    await understandService('help please');
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('classifies a description the rules could not', async () => {
    generateJson.mockResolvedValue({ category: 'ac-repairers', urgent: false });
    const r = await understandService('the room stays hot even on the lowest setting');
    expect(r).toEqual({ source: 'llm', interpreted: { category: 'ac-repairers', candidates: [], availableNow: false } });
    // only the text is sent — no user data
    expect(generateJson.mock.calls[0][0]).toContain('the room stays hot');
  });

  it('keeps an urgency the rules saw even if the model missed it', async () => {
    generateJson.mockResolvedValue({ category: 'plumbers', urgent: false });
    const r = await understandService('wet patch spreading on the ceiling right now');
    expect(r.interpreted).toMatchObject({ category: 'plumbers', availableNow: true });
  });

  it('falls back to the rules when the model fails or invents a trade', async () => {
    generateJson.mockResolvedValue(null);
    expect((await understandService('paint my bedroom wall please')).source).toBe('rules');
    generateJson.mockResolvedValue({ category: 'painters' });
    expect(await understandService('paint my living room wall please')).toEqual({
      source: 'rules',
      interpreted: { category: null, candidates: [], availableNow: false },
    });
  });
});
