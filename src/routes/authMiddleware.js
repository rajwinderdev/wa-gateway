const crypto = require('crypto');

/**
 * Timing-safe API Key authentication middleware
 */
function authMiddleware(req, res, next) {
  const apiKeyHeader = req.headers['x-api-key'];
  const expectedApiKey = process.env.API_KEY;

  if (!apiKeyHeader || !expectedApiKey) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const clientKeyBuffer = Buffer.from(String(apiKeyHeader));
  const expectedKeyBuffer = Buffer.from(String(expectedApiKey));

  if (clientKeyBuffer.length !== expectedKeyBuffer.length) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const isMatch = crypto.timingSafeEqual(clientKeyBuffer, expectedKeyBuffer);
  if (!isMatch) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  next();
}

module.exports = {
  authMiddleware
};
