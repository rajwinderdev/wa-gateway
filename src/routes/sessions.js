const express = require('express');
const sessionManager = require('../sessionManager');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /sessions/start
 * Body: { session_key }
 */
router.post('/start', async (req, res) => {
  const { session_key } = req.body;
  if (!session_key || typeof session_key !== 'string' || session_key.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'invalid_session_key' });
  }

  const cleanSessionKey = session_key.trim();

  try {
    const session = await sessionManager.startSession(cleanSessionKey);

    // If connected already
    if (session.status === 'connected') {
      return res.json({
        ok: true,
        status: 'connected',
        phone: session.phone || undefined,
        name: session.name || undefined
      });
    }

    // Wait up to ~18 sec for the first QR code
    const qrResult = await sessionManager.waitForFirstQR(session, 18000);

    return res.json({
      ok: true,
      status: qrResult.status,
      qr: qrResult.qr || undefined,
      phone: session.phone || undefined,
      name: session.name || undefined
    });
  } catch (err) {
    let errorMsg = err.message;
    if (err.errors && Array.isArray(err.errors)) {
      errorMsg = err.errors.map(e => e.message || e.toString()).join(' | ');
    } else if (!errorMsg) {
      errorMsg = (err.output && err.output.payload && err.output.payload.message) || err.toString() || 'Unknown error';
    }
    logger.error({ sessionKey: cleanSessionKey, error: errorMsg, stack: err.stack }, 'Error starting session');
    const statusCode = err.statusCode || (err.output && err.output.statusCode) || 500;
    return res.status(statusCode).json({
      ok: false,
      error: errorMsg,
      details: err.stack ? err.stack.split('\n').slice(0, 3) : undefined
    });
  }
});

/**
 * POST /sessions/request-otp
 * Direct SMS OTP Request for Virtual Numbers (DualSMS)
 * Body: { phone, name?, os? }
 */
router.post('/request-otp', async (req, res) => {
  const { phone, name, os } = req.body;
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_or_invalid_phone' });
  }

  try {
    const result = await sessionManager.requestOtp({ phone, name, os });
    return res.json(result);
  } catch (err) {
    logger.error({ phone, error: err.message }, 'Error in request-otp endpoint');
    return res.status(400).json({ ok: false, error: err.message || 'failed_to_request_otp' });
  }
});

/**
 * POST /sessions/verify-otp
 * Verify SMS OTP Code from DualSMS and Connect Virtual Number
 * Body: { phone, code }
 */
router.post('/verify-otp', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ ok: false, error: 'phone_and_code_required' });
  }

  try {
    const result = await sessionManager.verifyOtp({ phone, code });
    return res.json(result);
  } catch (err) {
    logger.error({ phone, code, error: err.message }, 'Error in verify-otp endpoint');
    return res.status(400).json({ ok: false, error: err.message || 'otp_verification_failed' });
  }
});

/**
 * GET /sessions/:session_key/status
 */
router.get('/:session_key/status', async (req, res) => {
  const { session_key } = req.params;
  const session = sessionManager.getSession(session_key);

  if (!session) {
    return res.json({
      ok: true,
      status: 'disconnected'
    });
  }

  return res.json({
    ok: true,
    status: session.status,
    qr: session.qrBase64 || undefined,
    phone: session.phone || undefined,
    name: session.name || undefined
  });
});

/**
 * POST /sessions/:session_key/logout
 */
router.post('/:session_key/logout', async (req, res) => {
  const { session_key } = req.params;
  try {
    await sessionManager.logoutSession(session_key);
    return res.json({ ok: true, status: 'logged_out' });
  } catch (err) {
    logger.error({ sessionKey: session_key, error: err.message }, 'Error during session logout');
    return res.status(500).json({ ok: false, error: 'logout_failed' });
  }
});

module.exports = router;
