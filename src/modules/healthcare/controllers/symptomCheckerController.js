const Specialty = require('../models/Specialty');

/**
 * AI Symptom Checker (TC-19), plus a conversational chat variant of the same
 * feature.
 *
 * Constraints enforced regardless of tier:
 *  - never states a diagnosis (phrasing: "possible areas to discuss with a doctor")
 *  - ALWAYS returns the medical disclaimer
 *  - recommendedSpecialty maps to a real Specialty in the database
 *  - degrades gracefully to "see a general physician" when no API key / call fails
 *
 * Tier 1: Gemini (GEMINI_API_KEY) with a strict JSON contract.
 * Tier 2: deterministic keyword→specialty mapping (zero cost, always available).
 */

// 'gemini-1.5-flash' (the original Tier-1 model here) has since been retired
// on this project's API key — every LLM call was silently falling through to
// Tier 2. 'gemini-flash-lite-latest' is a Google-maintained alias (Google's
// own 404 on the 1.5 call pointed at its current flash line), so it keeps
// resolving to a live model without this needing another hardcoded-version
// fire drill. It's also the lite tier: fast and cheap for a bounded
// strict-JSON classification task like this, and empirically returns no
// "thinking" token overhead the way the bare flash line briefly did.
const GEMINI_MODEL = 'gemini-flash-lite-latest';

const DISCLAIMER =
  'This is not a medical diagnosis. The suggestions below are informational only. ' +
  'Always consult a qualified doctor about your symptoms. If this is an emergency, ' +
  'call your local emergency number immediately.';

// Curated keyword → { condition areas, specialty } mapping (Tier 2)
const RULES = [
  { keywords: ['chest pain', 'palpitation', 'heart', 'breathless', 'shortness of breath'], condition: 'Cardiovascular concern', specialty: 'Cardiology', confidence: 70 },
  { keywords: ['rash', 'itch', 'skin', 'acne', 'eczema', 'pimple'], condition: 'Dermatological concern', specialty: 'Dermatology', confidence: 75 },
  { keywords: ['headache', 'migraine', 'dizzi', 'seizure', 'numbness', 'memory'], condition: 'Neurological concern', specialty: 'Neurology', confidence: 65 },
  { keywords: ['stomach', 'abdominal', 'nausea', 'vomit', 'diarrhea', 'constipation', 'acidity', 'heartburn'], condition: 'Digestive concern', specialty: 'Gastroenterology', confidence: 70 },
  { keywords: ['joint', 'knee', 'back pain', 'bone', 'fracture', 'muscle', 'shoulder'], condition: 'Musculoskeletal concern', specialty: 'Orthopedics', confidence: 70 },
  { keywords: ['child', 'baby', 'infant', 'toddler'], condition: 'Paediatric concern', specialty: 'Pediatrics', confidence: 60 },
  { keywords: ['pregnan', 'period', 'menstrual', 'gynae'], condition: 'Obstetric/gynaecological concern', specialty: 'Gynecology', confidence: 70 },
  { keywords: ['eye', 'vision', 'blurr'], condition: 'Ophthalmic concern', specialty: 'Ophthalmology', confidence: 75 },
  { keywords: ['tooth', 'teeth', 'gum', 'dental'], condition: 'Dental concern', specialty: 'Dentistry', confidence: 80 },
  { keywords: ['ear', 'throat', 'nose', 'sinus', 'hearing', 'tonsil'], condition: 'ENT concern', specialty: 'ENT', confidence: 70 },
  { keywords: ['anxiety', 'depress', 'stress', 'sleep', 'panic', 'mood'], condition: 'Mental-health concern', specialty: 'Psychiatry', confidence: 65 },
  { keywords: ['urine', 'kidney', 'bladder'], condition: 'Urological concern', specialty: 'Urology', confidence: 70 },
  { keywords: ['fever', 'flu', 'cough', 'cold', 'fatigue', 'weakness'], condition: 'General/viral illness', specialty: 'General Physician', confidence: 60 },
];

const ruleBasedCheck = (symptoms) => {
  const text = symptoms.toLowerCase();
  const hits = [];
  for (const rule of RULES) {
    const matched = rule.keywords.filter((k) => text.includes(k));
    if (matched.length > 0) {
      hits.push({
        condition: rule.condition,
        confidence: Math.min(90, rule.confidence + (matched.length - 1) * 8),
        matchedSymptoms: matched,
        specialty: rule.specialty,
      });
    }
  }
  hits.sort((a, b) => b.confidence - a.confidence);
  if (hits.length === 0) {
    return {
      conditions: [
        { condition: 'General assessment recommended', confidence: 50, matchedSymptoms: [] },
      ],
      recommendedSpecialtyName: 'General Physician',
      source: 'rules',
    };
  }
  return {
    conditions: hits.slice(0, 3).map(({ condition, confidence, matchedSymptoms }) => ({
      condition,
      confidence,
      matchedSymptoms,
    })),
    recommendedSpecialtyName: hits[0].specialty,
    source: 'rules',
  };
};

const llmCheck = async (symptoms, specialtyNames) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const prompt = `You are a triage assistant. You NEVER diagnose. Given patient-described symptoms, return STRICT JSON only (no markdown) with this exact shape:
{"conditions":[{"condition":"<possible area of concern, phrased as 'possible X concern'>","confidence":<int 1-90>}],"recommendedSpecialty":"<one of: ${specialtyNames.join(', ')}>"}
Max 3 conditions. Confidence must never exceed 90. If unsure, recommend "General Physician".
Symptoms: ${symptoms}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal,
      }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.conditions) || !parsed.recommendedSpecialty) return null;
    return {
      conditions: parsed.conditions.slice(0, 3).map((c) => ({
        condition: String(c.condition),
        confidence: Math.min(90, Math.max(1, parseInt(c.confidence, 10) || 50)),
        matchedSymptoms: [],
      })),
      recommendedSpecialtyName: String(parsed.recommendedSpecialty),
      source: 'llm',
    };
  } catch {
    return null; // graceful degradation to rules
  } finally {
    clearTimeout(timer);
  }
};

// Map a recommendation string (from either tier) onto a REAL specialty in the
// database — shared by the single-shot checker and the chat variant below, so
// both degrade to the same "closest real match, else General Physician, else
// whatever exists" order.
function resolveSpecialty(specialties, wantedName) {
  const wanted = String(wantedName || '').toLowerCase();
  return (
    specialties.find((s) => s.name.toLowerCase() === wanted) ||
    specialties.find((s) => s.name.toLowerCase().includes(wanted.split(' ')[0])) ||
    specialties.find((s) => /general/i.test(s.name)) ||
    specialties[0] ||
    null
  );
}

// @desc  POST /api/v1/healthcare/symptom-checker { symptoms }
// @access Private (patient)
const checkSymptoms = async (req, res, next) => {
  try {
    const symptoms = String(req.body.symptoms || '').trim();
    if (symptoms.length < 5) {
      return res
        .status(400)
        .json({ success: false, error: 'Please describe your symptoms (at least a few words)' });
    }

    const specialties = await Specialty.find({}).select('name');
    const names = specialties.map((s) => s.name);

    let result = await llmCheck(symptoms, names.length ? names : ['General Physician']);
    if (!result) result = ruleBasedCheck(symptoms);

    const specialty = resolveSpecialty(specialties, result.recommendedSpecialtyName);

    return res.json({
      success: true,
      data: {
        disclaimer: DISCLAIMER,
        conditions: result.conditions,
        recommendedSpecialty: specialty
          ? { specialtyId: specialty._id, name: specialty.name }
          : { specialtyId: null, name: 'General Physician' },
        source: result.source,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// Chat variant — the same triage, held as a back-and-forth instead of one
// textarea + one verdict. The client holds the transcript (stateless server,
// same as every other LLM chat integration) and resends it each turn; this
// endpoint answers with either a follow-up question or, once it has enough to
// go on, the same {conditions, recommendedSpecialty} shape checkSymptoms
// returns, so the screen can render the identical recommendation card inline
// as a chat bubble.
// ============================================================================

const MAX_CHAT_TURNS = 12; // user + bot messages combined — bounds cost/abuse
const MAX_MESSAGE_LENGTH = 1000;
// After this many things the PATIENT has said, force a verdict even if the
// model would rather keep asking — a triage chat that never converges is
// worse than one that guesses early and lets the doctor take it from there.
const FORCE_DONE_AFTER_USER_TURNS = 4;

function buildChatSystemPrompt(specialtyNames, forceDone) {
  return `You are a caring, concise medical triage assistant inside a healthcare app's chat. You NEVER diagnose.
Have a short back-and-forth with the patient: if their first message is vague, ask ONE clarifying question at a time (duration, severity, associated symptoms) — no more than 3 questions total across the whole conversation. Once you have enough to go on, stop asking and give your assessment.
${forceDone ? 'The patient has already answered several questions — you MUST finish now: set "done" to true and give your best assessment with what you have.' : ''}
Respond with STRICT JSON only (no markdown fences), in exactly this shape:
{"reply":"<your next message to the patient — a question, or a short empathetic summary if done, 1-3 sentences>","done":<true once you have enough information to suggest a specialist, otherwise false>,"conditions":[{"condition":"<possible area of concern, phrased as 'possible X concern', never a diagnosis>","confidence":<int 1-90>}],"recommendedSpecialty":"<one of: ${specialtyNames.join(', ')}>"}
"conditions" and "recommendedSpecialty" are only meaningful when done=true — send "conditions": [] and "recommendedSpecialty": "" while still asking questions. Max 3 conditions, confidence never above 90. If unsure once done, recommend "General Physician".`;
}

/**
 * @param {{role: 'user'|'bot', text: string}[]} messages full transcript, oldest first
 * @returns {Promise<{reply: string, done: boolean, conditions: object[], recommendedSpecialtyName: string, source: 'llm'} | null>} null → fall back to Tier 2
 */
async function llmChat(messages, specialtyNames) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const userTurns = messages.filter((m) => m.role === 'user').length;
  const forceDone = userTurns >= FORCE_DONE_AFTER_USER_TURNS;
  const contents = messages.map((m) => ({
    role: m.role === 'bot' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildChatSystemPrompt(specialtyNames, forceDone) }] },
          contents,
        }),
        signal: controller.signal,
      }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;

    const done = Boolean(parsed.done) || forceDone;
    return {
      reply: parsed.reply.trim(),
      done,
      conditions: done && Array.isArray(parsed.conditions)
        ? parsed.conditions.slice(0, 3).map((c) => ({
            condition: String(c.condition),
            confidence: Math.min(90, Math.max(1, parseInt(c.confidence, 10) || 50)),
            matchedSymptoms: [],
          }))
        : [],
      recommendedSpecialtyName: done ? String(parsed.recommendedSpecialty || 'General Physician') : '',
      source: 'llm',
    };
  } catch {
    return null; // graceful degradation to rules
  } finally {
    clearTimeout(timer);
  }
}

// Tier 2 fallback for the chat: no key, or the call failed. A deterministic
// keyword match can't hold a conversation, so it doesn't try — it answers
// immediately with a verdict from everything the patient has said so far,
// exactly like a very direct doctor who skips the small talk.
function ruleBasedChatFallback(messages) {
  const allUserText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .join('. ');
  const result = ruleBasedCheck(allUserText);
  return {
    reply: "Thanks for sharing that. Based on what you've described, here's what I'd suggest:",
    done: true,
    conditions: result.conditions,
    recommendedSpecialtyName: result.recommendedSpecialtyName,
    source: 'rules',
  };
}

// @desc  POST /api/v1/healthcare/symptom-checker/chat { messages: [{role, text}] }
// @access Private (patient)
const chatCheckSymptoms = async (req, res, next) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ success: false, error: 'messages must be a non-empty array' });
    }
    if (messages.length > MAX_CHAT_TURNS) {
      return res.status(400).json({ success: false, error: `Conversation is too long (max ${MAX_CHAT_TURNS} messages)` });
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || typeof last.text !== 'string' || !last.text.trim()) {
      return res.status(400).json({ success: false, error: 'The last message must be from the patient' });
    }
    if (messages.some((m) => typeof m.text !== 'string' || m.text.length > MAX_MESSAGE_LENGTH)) {
      return res.status(400).json({ success: false, error: `Each message must be under ${MAX_MESSAGE_LENGTH} characters` });
    }

    const specialties = await Specialty.find({}).select('name');
    const names = specialties.map((s) => s.name);

    let result = await llmChat(messages, names.length ? names : ['General Physician']);
    if (!result) result = ruleBasedChatFallback(messages);

    const specialty = result.done ? resolveSpecialty(specialties, result.recommendedSpecialtyName) : null;

    return res.json({
      success: true,
      data: {
        reply: result.reply,
        done: result.done,
        disclaimer: DISCLAIMER,
        recommendation: result.done
          ? {
              conditions: result.conditions,
              recommendedSpecialty: specialty
                ? { specialtyId: specialty._id, name: specialty.name }
                : { specialtyId: null, name: 'General Physician' },
              source: result.source,
            }
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  checkSymptoms,
  chatCheckSymptoms,
  ruleBasedCheck,
  ruleBasedChatFallback,
  DISCLAIMER,
};
