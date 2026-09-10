import twilio from 'twilio';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
const TWILIO_NUMBER = config.twilioWhatsAppNumber;

// =====================
// Send Messages
// =====================

function normalizePhone(to) {
  // Strip whatsapp: prefix, whitespace, and ensure + prefix
  let phone = to.replace('whatsapp:', '').replace(/\s/g, '');
  if (!phone.startsWith('+')) phone = '+' + phone;
  // Validate: must be digits after +, at least 7 digits
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) {
    console.warn(`[TWILIO] Invalid phone number: ${to}`);
    return phone;
  }
  return phone;
}

export async function sendTextMessage(to, text) {
  const MAX_TEXT_LENGTH = 1600;
  let messageText = text;
  if (messageText.length > MAX_TEXT_LENGTH) {
    messageText = messageText.substring(0, MAX_TEXT_LENGTH - 3) + '...';
  }

  const fromNumber = TWILIO_NUMBER.startsWith('whatsapp:') ? TWILIO_NUMBER : `whatsapp:${TWILIO_NUMBER}`;
  const toNumber = `whatsapp:${normalizePhone(to)}`;

  try {
    const msg = await client.messages.create({
      from: fromNumber,
      to: toNumber,
      body: messageText,
    });
    console.log(`[TWILIO] Sent to ${normalizePhone(to)}: "${messageText.substring(0, 80)}${messageText.length > 80 ? '...' : ''}"`);
    return msg;
  } catch (err) {
    console.error(`[TWILIO] Send failed to ${normalizePhone(to)}:`, err.message);
    throw err;
  }
}

export async function sendTextMessageWithRetry(to, text, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await sendTextMessage(to, text);
    } catch (err) {
      lastError = err;
      
      // Don't retry client errors (except 429 rate limit)
      if (err.status >= 400 && err.status < 500 && err.status !== 429) {
        console.error(`[TWILIO] Client error ${err.status}, not retrying`);
        throw err;
      }
      
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = 1000 * Math.pow(2, attempt - 1);
        const reason = err.status === 429 ? 'rate limited' : `server error ${err.status}`;
        console.log(`[TWILIO] ${reason}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  // All retries failed — store for later
  console.error(`[TWILIO] Failed to send after ${maxRetries} retries`);
  storeFailedMessage(to, text);
  throw lastError;
}

function storeFailedMessage(phone, text) {
  try {
    const failedDir = path.join(config.storageDir, 'failed_messages');
    if (!fs.existsSync(failedDir)) fs.mkdirSync(failedDir, { recursive: true });
    
    const filename = `${Date.now()}_${phone.replace(/[^0-9]/g, '')}.json`;
    fs.writeFileSync(path.join(failedDir, filename), JSON.stringify({
      phone, text, timestamp: Date.now()
    }, null, 2));
    console.log(`[TWILIO] Stored failed message: ${filename}`);
  } catch (err) {
    console.error(`[TWILIO] Failed to store message:`, err.message);
  }
}

export async function sendDocumentMessage(to, filePath, filename) {
  const fromNumber = TWILIO_NUMBER.startsWith('whatsapp:') ? TWILIO_NUMBER : `whatsapp:${TWILIO_NUMBER}`;
  const toNumber = `whatsapp:${normalizePhone(to)}`;

  // Validate file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Twilio needs a publicly accessible URL for media
  const baseUrl = process.env.PUBLIC_URL || 'https://your-domain.com';
  // Build URL using relative path from documents dir (files may be in subdirectories)
  const relativePath = path.relative(config.documentsDir, filePath).replace(/\\/g, '/');
  const publicUrl = `${baseUrl}/documents/${encodeURIComponent(relativePath)}`;

  try {
    const msg = await client.messages.create({
      from: fromNumber,
      to: toNumber,
      mediaUrl: [publicUrl],
    });
    console.log(`[TWILIO] Document sent to ${normalizePhone(to)}: ${filename}`);
    return msg;
  } catch (err) {
    console.error(`[TWILIO] Document send failed to ${normalizePhone(to)}:`, err.message);
    throw err;
  }
}

// =====================
// Webhook Signature Verification
// =====================

export function verifyWebhookSignature(req) {
  if (process.env.TWILIO_SKIP_SIGNATURE_CHECK === 'true') {
    return true;
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) return false;

  // Support reverse proxies (Tailscale funnel, nginx, etc.)
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const url = `${proto}://${host}${req.originalUrl}`;

  return twilio.validateRequest(
    config.twilioAuthToken,
    twilioSignature,
    url,
    req.rawBody.toString()
  );
}

// =====================
// Parse Webhook Payload
// =====================

export function parseWebhookMessage(body) {
  const messageSid = body.SmsMessageSid || body.MessageSid;
  if (!messageSid) return null;

  // Filter out status updates (sent, delivered, read, failed)
  const smsStatus = body.SmsStatus || '';
  if (smsStatus && smsStatus !== 'received') {
    return null;
  }

  const from = normalizePhone(body.From || '');
  const to = normalizePhone(body.To || '');
  const text = body.Body || '';

  // Parse media
  const media = [];
  const numMedia = parseInt(body.NumMedia || '0', 10);
  for (let i = 0; i < numMedia; i++) {
    const url = body[`MediaUrl${i}`];
    const contentType = body[`MediaContentType${i}`];
    if (url) media.push({ url, contentType });
  }

  const messageType = body.MessageType || (numMedia > 0 ? 'media' : 'text');

  return {
    id: messageSid,
    from,
    to,
    text,
    type: messageType,
    media,
  };
}

export { normalizePhone };
