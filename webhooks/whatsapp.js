// webhooks/whatsapp.js
// WhatsApp Cloud API webhook handler

const crypto = require('crypto');
const { pool } = require('../models');

// =====================================================
// GET /webhooks/whatsapp - Meta webhook verification
// =====================================================
function verify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WhatsApp Webhook] Verification successful');
    return res.status(200).send(challenge);
  }

  console.log('[WhatsApp Webhook] Verification failed - token mismatch');
  return res.sendStatus(403);
}

// =====================================================
// POST /webhooks/whatsapp - Handle incoming webhook
// =====================================================
async function handle(req, res) {
  // Respond to Meta immediately (required)
  res.status(200).send('OK');

  // Verify signature in production
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret && process.env.NODE_ENV === 'production') {
    const signature = req.get('X-Hub-Signature-256');
    if (!signature || !verifySignature(req._rawBody, signature, appSecret)) {
      console.error('[WhatsApp Webhook] Invalid signature - rejecting');
      return;
    }
  }

  const payload = req.body;
  console.log('[WhatsApp Webhook] Received:', JSON.stringify(payload).slice(0, 500));

  // Process asynchronously (don't block the response)
  setImmediate(() => processWebhookPayload(payload));
}

// =====================================================
// Signature verification (HMAC-SHA256)
// =====================================================
function verifySignature(rawBody, signature, appSecret) {
  if (!rawBody || !signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// =====================================================
// Process webhook payload asynchronously
// =====================================================
async function processWebhookPayload(payload) {
  try {
    // WhatsApp Cloud API payload structure:
    // { object: "whatsapp_business_account", entry: [...] }
    if (payload.object !== 'whatsapp_business_account') {
      console.log('[WhatsApp Webhook] Unknown object type:', payload.object);
      return;
    }

    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];

        for (const msg of messages) {
          await saveIncomingMessage(msg, value);
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp Webhook] Error processing payload:', err);
  }
}

// =====================================================
// Save incoming message to database
// =====================================================
async function saveIncomingMessage(msg, value) {
  const messageId = msg.id;
  const phone = msg.from;
  const fromName = msg.profile?.name || value.contacts?.[0]?.profile?.name || null;
  const appId = value.metadata?.phone_number_id || null;
  const now = String(Date.now());

  // Idempotency: message_id is unique, duplicate will be rejected
  const sql = `
    INSERT IGNORE INTO incoming_whatsapp_messages
      (message_id, phone, from_name, app_id, payload, processed, created_at)
    VALUES
      (?, ?, ?, ?, ?, 0, ?)
  `;

  try {
    const [result] = await pool.execute(sql, [
      messageId,
      phone,
      fromName,
      appId,
      JSON.stringify({ msg, value }),
      now,
    ]);

    if (result.affectedRows === 1) {
      console.log(`[WhatsApp Webhook] Saved message ${messageId} from ${phone}`);
    } else {
      console.log(`[WhatsApp Webhook] Duplicate message ${messageId} - skipped`);
    }
  } catch (err) {
    // Duplicate entry (ER_DUP_ENTRY) is expected for idempotency
    if (err.code !== 'ER_DUP_ENTRY') {
      console.error('[WhatsApp Webhook] DB error:', err.message);
    }
  }
}

module.exports = { verify, handle };
