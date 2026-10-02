/**
 * One small, defensive Gemini call that must answer with JSON.
 *
 * Same contract the symptom checker established: a hard timeout, strict JSON,
 * and `null` on ANY problem (no key, network, quota, malformed output) so the
 * caller always has a rules-based answer to fall back on. Never send personal
 * data — callers pass only the text they need understood.
 */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

async function generateJson(prompt, { timeoutMs = 2500 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
        signal: controller.signal,
      }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const text = (json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateJson, GEMINI_MODEL };
