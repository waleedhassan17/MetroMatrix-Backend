/**
 * Symptom checker Tier-2 (deterministic) logic — the tier that must always work.
 */
const { ruleBasedCheck, DISCLAIMER } = require('../controllers/symptomCheckerController');

describe('ruleBasedCheck', () => {
  it('maps chest pain to a cardiology recommendation', () => {
    const r = ruleBasedCheck('I have chest pain and shortness of breath');
    expect(r.recommendedSpecialtyName).toBe('Cardiology');
    expect(r.conditions[0].confidence).toBeGreaterThan(0);
    expect(r.conditions[0].confidence).toBeLessThanOrEqual(90);
  });

  it('maps skin symptoms to dermatology', () => {
    const r = ruleBasedCheck('itchy rash on my skin');
    expect(r.recommendedSpecialtyName).toBe('Dermatology');
  });

  it('unknown symptoms degrade to General Physician (graceful default)', () => {
    const r = ruleBasedCheck('zzzz unusual gibberish complaint');
    expect(r.recommendedSpecialtyName).toBe('General Physician');
    expect(r.conditions.length).toBeGreaterThan(0);
  });

  it('never returns more than 3 conditions and never >90 confidence', () => {
    const r = ruleBasedCheck(
      'fever cough headache stomach pain joint pain rash anxiety ear pain tooth ache'
    );
    expect(r.conditions.length).toBeLessThanOrEqual(3);
    r.conditions.forEach((c) => expect(c.confidence).toBeLessThanOrEqual(90));
  });

  it('conditions are phrased as concerns, never diagnoses', () => {
    const r = ruleBasedCheck('chest pain');
    r.conditions.forEach((c) => expect(c.condition).toMatch(/concern|assessment|illness/i));
  });
});

describe('disclaimer', () => {
  it('exists and says it is not a diagnosis', () => {
    expect(DISCLAIMER).toMatch(/not a medical diagnosis/i);
    expect(DISCLAIMER).toMatch(/consult a qualified doctor/i);
  });
});
