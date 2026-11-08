const crypto = require('crypto');
const axios = require('axios');
const logger = require('./utils/logger');

// Webhook sending queue to prevent unhandled rejection & handle retries with backoff
class WebhookQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.maxRetries = 3;
  }

  enqueue(payload) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      return;
    }
    this.queue.push({
      payload,
      attempts: 0,
      nextAttempt: Date.now()
    });
    this.process();
  }

  async process() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    try {
      const now = Date.now();
      const itemIndex = this.queue.findIndex(item => item.nextAttempt <= now);

      if (itemIndex === -1) {
        // Nothing ready yet; check again in 1s if queue not empty
        if (this.queue.length > 0) {
          setTimeout(() => this.process(), 1000);
        }
        this.isProcessing = false;
        return;
      }

      const item = this.queue.splice(itemIndex, 1)[0];
      const webhookUrl = process.env.WEBHOOK_URL;
      const secret = process.env.WEBHOOK_SECRET || '';

      const rawBody = JSON.stringify(item.payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      try {
        await axios.post(webhookUrl, rawBody, {
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signature,
            'X-Timestamp': timestamp
          },
          timeout: 10000
        });
        logger.debug({ event: item.payload.event, session: item.payload.session_key }, 'Webhook delivered successfully');
      } catch (err) {
        item.attempts += 1;
        if (item.attempts < this.maxRetries) {
          const delay = Math.pow(2, item.attempts) * 1000; // 2s, 4s...
          item.nextAttempt = Date.now() + delay;
          this.queue.push(item);
          logger.warn(
            { event: item.payload.event, attempt: item.attempts, error: err.message },
            'Webhook delivery failed, scheduled retry'
          );
        } else {
          logger.error(
            { event: item.payload.event, attempts: item.attempts, error: err.message },
            'Webhook delivery dropped after max retries'
          );
        }
      }
    } catch (e) {
      logger.error({ error: e.message }, 'Unexpected error in WebhookQueue process');
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setTimeout(() => this.process(), 500);
      }
    }
  }
}

const webhookQueue = new WebhookQueue();

function sendWebhook(payload) {
  webhookQueue.enqueue(payload);
}

module.exports = {
  sendWebhook
};
