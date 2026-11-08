const express = require('express');
const axios = require('axios');
const sessionManager = require('../sessionManager');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Helper to download media from URL with 20MB limit and 30s timeout
 */
async function downloadMedia(url) {
  const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

  const response = await axios({
    method: 'get',
    url,
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES
  });

  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type']
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /messages/send
 * Body: {
 *   session_key,
 *   to,
 *   text,
 *   media_url?,
 *   media_type?, ("image"|"video"|"document")
 *   file_name?,
 *   typing_ms?,
 *   mark_read?,
 *   client_ref?
 * }
 */
router.post('/send', async (req, res) => {
  const {
    session_key,
    to,
    text,
    media_url,
    media_type,
    file_name,
    typing_ms,
    mark_read,
    client_ref
  } = req.body;

  // Validate inputs
  if (!session_key || typeof session_key !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_or_invalid_session_key' });
  }

  if (!to || typeof to !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_or_invalid_to' });
  }

  if (!text && !media_url) {
    return res.status(400).json({ ok: false, error: 'either_text_or_media_url_required' });
  }

  const session = sessionManager.getSession(session_key.trim());
  if (!session || session.status !== 'connected' || !session.sock) {
    return res.status(409).json({ ok: false, error: 'session_not_connected' });
  }

  // 1. Normalize recipient to JID (digits + @s.whatsapp.net)
  const cleanDigits = to.replace(/[^0-9]/g, '');
  if (!cleanDigits || cleanDigits.length < 5) {
    return res.status(400).json({ ok: false, error: 'invalid_recipient_number' });
  }
  const jid = `${cleanDigits}@s.whatsapp.net`;

  try {
    // Process message through per-session sequential mutex/queue
    const sendResult = await sessionManager.enqueueSessionTask(session.sessionKey, async () => {
      const sock = session.sock;

      // 2. If mark_read: send presence available and read chat messages
      if (mark_read) {
        try {
          await sock.sendPresenceUpdate('available');
          await sock.readMessages([{ remoteJid: jid, id: '', participant: undefined }]);
        } catch (e) {
          logger.debug({ error: e.message }, 'Ignored mark_read presence/read failure');
        }
      }

      // 3. Human-like typing presence
      const typingDuration = Math.min(15000, Math.max(1000, parseInt(typing_ms || 1000, 10)));
      try {
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(typingDuration);
        await sock.sendPresenceUpdate('paused', jid);
      } catch (e) {
        logger.debug({ error: e.message }, 'Ignored composing presence update error');
      }

      // 4. Construct message content
      let messageContent = {};

      if (media_url) {
        const { buffer, contentType } = await downloadMedia(media_url);

        if (media_type === 'image') {
          messageContent = {
            image: buffer,
            caption: text || undefined,
            mimetype: contentType || 'image/jpeg'
          };
        } else if (media_type === 'video') {
          messageContent = {
            video: buffer,
            caption: text || undefined,
            mimetype: contentType || 'video/mp4'
          };
        } else if (media_type === 'document') {
          messageContent = {
            document: buffer,
            caption: text || undefined,
            fileName: file_name || 'document',
            mimetype: contentType || 'application/octet-stream'
          };
        } else {
          // Default media type auto-detection or generic image
          if (contentType && contentType.startsWith('video/')) {
            messageContent = { video: buffer, caption: text || undefined, mimetype: contentType };
          } else if (contentType && contentType.startsWith('image/')) {
            messageContent = { image: buffer, caption: text || undefined, mimetype: contentType };
          } else {
            messageContent = {
              document: buffer,
              caption: text || undefined,
              fileName: file_name || 'file',
              mimetype: contentType || 'application/octet-stream'
            };
          }
        }
      } else {
        // Plain text message
        messageContent = { text: String(text) };
      }

      // Send via Baileys socket
      const sentMessage = await sock.sendMessage(jid, messageContent);
      const messageId = sentMessage?.key?.id;

      // 5. Store client_ref mapping to survive restarts & associate with webhook delivery events
      if (messageId && client_ref) {
        await sessionManager.saveMessageRef(session.sessionKey, messageId, client_ref);
      }

      return { messageId };
    });

    return res.json({
      ok: true,
      message_id: sendResult.messageId
    });
  } catch (err) {
    logger.error(
      { sessionKey: session.sessionKey, to: jid, error: err.message },
      'Failed to send message'
    );
    return res.status(500).json({ ok: false, error: err.message || 'send_failed' });
  }
});

module.exports = router;
