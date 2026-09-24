/**
 * Chat variant of the symptom checker (POST /symptom-checker/chat).
 * No DB, no network: Specialty is mocked and GEMINI_API_KEY is unset in the
 * test env, so chatCheckSymptoms always exercises the Tier-2 fallback path —
 * exactly the path that must always work, same spirit as symptomChecker.test.js.
 */
jest.mock('../models/Specialty', () => ({ find: jest.fn() }));

const Specialty = require('../models/Specialty');
const {
  chatCheckSymptoms,
  ruleBasedChatFallback,
} = require('../controllers/symptomCheckerController');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const SPECIALTIES = [
  { _id: 'sp-cardio', name: 'Cardiology' },
  { _id: 'sp-derm', name: 'Dermatology' },
  { _id: 'sp-gp', name: 'General Physician' },
];

beforeEach(() => {
  jest.clearAllMocks();
  Specialty.find.mockReturnValue({ select: jest.fn().mockResolvedValue(SPECIALTIES) });
  delete process.env.GEMINI_API_KEY; // force Tier 2 in every test here
});

describe('ruleBasedChatFallback', () => {
  it('answers immediately (done=true) from everything the patient said', () => {
    const r = ruleBasedChatFallback([
      { role: 'user', text: 'I have chest pain' },
      { role: 'user', text: 'and I feel short of breath' },
    ]);
    expect(r.done).toBe(true);
    expect(r.recommendedSpecialtyName).toBe('Cardiology');
    expect(r.reply).toMatch(/thanks/i);
  });

  it('ignores bot turns when building the fallback verdict', () => {
    const r = ruleBasedChatFallback([
      { role: 'user', text: 'itchy rash' },
      { role: 'bot', text: 'How long has it been there?' },
      { role: 'user', text: 'about a week' },
    ]);
    expect(r.recommendedSpecialtyName).toBe('Dermatology');
  });
});

describe('chatCheckSymptoms validation', () => {
  it('rejects an empty messages array', async () => {
    const res = mockRes();
    await chatCheckSymptoms({ body: { messages: [] } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a transcript ending on a bot message', async () => {
    const res = mockRes();
    await chatCheckSymptoms(
      { body: { messages: [{ role: 'user', text: 'hi' }, { role: 'bot', text: 'hello' }] } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an over-long message', async () => {
    const res = mockRes();
    await chatCheckSymptoms(
      { body: { messages: [{ role: 'user', text: 'a'.repeat(2000) }] } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an excessively long conversation', async () => {
    const res = mockRes();
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'bot',
      text: `turn ${i}`,
    }));
    await chatCheckSymptoms({ body: { messages } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('chatCheckSymptoms happy path (Tier 2, no API key)', () => {
  it('resolves the recommendation onto a real Specialty and reports done=true', async () => {
    const res = mockRes();
    await chatCheckSymptoms(
      { body: { messages: [{ role: 'user', text: 'chest pain and palpitations' }] } },
      res,
      jest.fn()
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          done: true,
          recommendation: expect.objectContaining({
            recommendedSpecialty: { specialtyId: 'sp-cardio', name: 'Cardiology' },
          }),
        }),
      })
    );
  });

  it('always includes the disclaimer', async () => {
    const res = mockRes();
    await chatCheckSymptoms(
      { body: { messages: [{ role: 'user', text: 'itchy skin rash' }] } },
      res,
      jest.fn()
    );
    const [payload] = res.json.mock.calls[0];
    expect(payload.data.disclaimer).toMatch(/not a medical diagnosis/i);
  });
});
