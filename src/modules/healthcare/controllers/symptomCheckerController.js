const Specialty = require('../models/Specialty');

/**
 * AI Symptom Checker (TC-19).
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
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

    // Map the recommendation onto a REAL specialty in the database
    const wanted = result.recommendedSpecialtyName.toLowerCase();
    let specialty =
      specialties.find((s) => s.name.toLowerCase() === wanted) ||
      specialties.find((s) => s.name.toLowerCase().includes(wanted.split(' ')[0])) ||
      specialties.find((s) => /general/i.test(s.name)) ||
      specialties[0] ||
      null;

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

module.exports = { checkSymptoms, ruleBasedCheck, DISCLAIMER };
