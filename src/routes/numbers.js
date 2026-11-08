const express = require('express');
const sessionManager = require('../sessionManager');
const logger = require('../utils/logger');

const router = express.Router();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /numbers/check
 * Body: { session_key, numbers: [digits...] }
 * Max 50 numbers per request, small random delay between lookups
 */
router.post('/check', async (req, res) => {
  const { session_key, numbers } = req.body;

  if (!session_key || typeof session_key !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_or_invalid_session_key' });
  }

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ ok: false, error: 'numbers_must_be_non_empty_array' });
  }

  if (numbers.length > 50) {
    return res.status(400).json({ ok: false, error: 'maximum_50_numbers_allowed' });
  }

  const session = sessionManager.getSession(session_key.trim());
  if (!session || session.status !== 'connected' || !session.sock) {
    return res.status(409).json({ ok: false, error: 'session_not_connected' });
  }

  try {
    const results = [];

    for (const num of numbers) {
      const cleanDigits = String(num).replace(/[^0-9]/g, '');
      if (!cleanDigits || cleanDigits.length < 5) {
        results.push({ number: String(num), exists: false });
        continue;
      }

      const jid = `${cleanDigits}@s.whatsapp.net`;
      try {
        const [onWa] = await session.sock.onWhatsApp(jid);
        results.push({
          number: cleanDigits,
          exists: Boolean(onWa && onWa.exists),
          jid: onWa && onWa.jid ? onWa.jid : undefined
        });
      } catch (lookupErr) {
        logger.debug({ number: cleanDigits, error: lookupErr.message }, 'Failed single onWhatsApp lookup');
        results.push({ number: cleanDigits, exists: false });
      }

      // Small random delay between lookups (100ms - 350ms) to avoid WhatsApp rate limits
      const delayMs = Math.floor(Math.random() * 250) + 100;
      await sleep(delayMs);
    }

    return res.json({
      ok: true,
      results
    });
  } catch (err) {
    logger.error({ sessionKey: session_key, error: err.message }, 'Error in onWhatsApp numbers check');
    return res.status(500).json({ ok: false, error: err.message || 'check_failed' });
  }
});

module.exports = router;
