const crypto = require('crypto');
const axios = require('axios');

function verifyNotionSignature(rawBody, signature) {
  const secret = process.env.NOTION_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

async function forwardToN8N(webhookUrl, payload) {
  try {
    await axios.post(webhookUrl, payload);
    console.log(`[Webhook] Forwarded to n8n: ${webhookUrl}`);
  } catch (err) {
    console.error(`[Webhook] Failed to forward to n8n: ${err.message}`);
  }
}

module.exports = { verifyNotionSignature, forwardToN8N };
