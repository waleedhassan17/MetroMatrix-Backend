/**
 * Retry an assertion until it passes or `timeoutMs` runs out — for effects the
 * code deliberately does not await (best-effort notifications after a save).
 */
async function eventually(assertion, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await assertion();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { eventually };
