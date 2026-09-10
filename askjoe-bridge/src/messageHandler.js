import { isApproved, registerPending } from './approval.js';
import { queryRag } from './ragClient.js';
import { findDocument, listLocalDocuments } from './fileHandler.js';
import { isRateLimited } from './rateLimiter.js';
import { draftMessage } from './draft.js';
import { sendTextMessageWithRetry, sendDocumentMessage, normalizePhone } from './twilioClient.js';
import { config } from './config.js';
import { generateRequestId, logWithRequestId } from './requestId.js';
import { trackError } from './notifications.js';
import { recordMetric } from './metrics.js';
import { logger } from './logger.js';
import { validateMessage, sanitizeInput } from './validation.js';

const MAX_MSG_LENGTH = 1600;

async function sendLongMessage(phone, text) {
  if (text.length <= MAX_MSG_LENGTH) {
    await sendTextMessageWithRetry(phone, text);
    return;
  }
  // Split into chunks at sentence boundaries
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Find a good break point (sentence end, then newline, then space)
    let breakAt = remaining.lastIndexOf('. ', MAX_MSG_LENGTH - 1);
    if (breakAt < MAX_MSG_LENGTH * 0.5) breakAt = remaining.lastIndexOf('\n', MAX_MSG_LENGTH - 1);
    if (breakAt < MAX_MSG_LENGTH * 0.5) breakAt = remaining.lastIndexOf(' ', MAX_MSG_LENGTH - 1);
    if (breakAt < 100) breakAt = MAX_MSG_LENGTH - 1;
    chunks.push(remaining.substring(0, breakAt + 1));
    remaining = remaining.substring(breakAt + 1).trimStart();
  }
  for (const chunk of chunks) {
    await sendTextMessageWithRetry(phone, chunk);
  }
}

const lastOfferedFile = new Map(); // phone -> { filename, timestamp }
const OFFER_TTL = 30 * 60 * 1000; // 30 minutes
const processedMessages = new Set();
const MAX_DEDUP = 1000;

const conversationHistory = new Map(); // phone -> [{role, text}]
const MAX_HISTORY = 20; // 10 exchanges (10 user + 10 bot)
const HISTORY_TTL = 30 * 60 * 1000; // 30 minutes

function addToHistory(phone, role, text) {
  const history = conversationHistory.get(phone) || [];
  history.push({ role, text, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) history.shift();
  conversationHistory.set(phone, history);
}

function getHistory(phone) {
  const history = conversationHistory.get(phone) || [];
  const now = Date.now();
  const fresh = history.filter(h => now - h.timestamp < HISTORY_TTL);
  if (fresh.length < history.length) conversationHistory.set(phone, fresh);
  return fresh.map(h => ({ role: h.role, text: h.text }));
}

// Cleanup stale offers every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of lastOfferedFile.entries()) {
    if (now - entry.timestamp > OFFER_TTL) {
      lastOfferedFile.delete(phone);
    }
  }
}, 10 * 60 * 1000);

function dedup(msgId) {
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  if (processedMessages.size > MAX_DEDUP) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }
  return false;
}

export async function handleTwilioMessage(message) {
  const requestId = generateRequestId();
  const phone = normalizePhone(message.from);
  const msgId = message.id;
  const messageText = message.text || '';

  logWithRequestId(requestId, 'RECEIVED', `Message from ${phone}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
  recordMetric('messagesReceived');

  const validation = validateMessage(message);
  if (!validation.valid) {
    logWithRequestId(requestId, 'VALIDATION', `Invalid message: ${validation.errors.join(', ')}`);
    return;
  }

  const sanitizedText = sanitizeInput(messageText);

  if (dedup(msgId)) {
    logWithRequestId(requestId, 'DEDUP', 'Duplicate message, skipping');
    return;
  }

  const botNumber = normalizePhone(config.twilioWhatsAppNumber);
  if (phone === botNumber) {
    logWithRequestId(requestId, 'SELF', 'Message from bot, skipping');
    return;
  }

  // Unknown sender
  if (!isApproved(phone)) {
    const code = registerPending(phone);
    await sendTextMessageWithRetry(phone, await draftMessage('unknown_user', { code }));
    return;
  }

  // Ignore media messages
  if (message.type === 'media' || (message.media && message.media.length > 0)) {
    await sendTextMessageWithRetry(phone, 'File uploads via WhatsApp are not supported. Please use the dashboard to add documents.');
    return;
  }

  if (!sanitizedText) return;

  if (isRateLimited(phone)) {
    await sendTextMessageWithRetry(phone, await draftMessage('rate_limited'));
    return;
  }

  // "Send it" follow-up
  const fileRequest = detectFileRequest(sanitizedText);
  if (fileRequest) {
    await handleFileRequest(phone, fileRequest);
    return;
  }

  // Query — standalone, no history
  try {
    const result = await queryRag(sanitizedText, getHistory(phone));
    let reply = formatReply(result);

    if (result.offer_file && result.answer?.startsWith('send_file:')) {
      await handleFileRequest(phone, result.offer_file);
      return;
    }

    if (result.offer_file) {
      lastOfferedFile.set(phone, { filename: result.offer_file, timestamp: Date.now() });
    }

    await sendLongMessage(phone, reply);
    addToHistory(phone, 'user', sanitizedText);
    // Store only the answer portion (without citations) to avoid confusion
    const answerOnly = reply.split('\n\nReferences:')[0] || reply;
    addToHistory(phone, 'bot', answerOnly);
    recordMetric('messagesSent');
  } catch (err) {
    logger.error('messageHandler', `Query failed`, { phone, error: err.message });
    recordMetric('messagesFailed');
    trackError('messageHandler', err);
    await sendTextMessageWithRetry(phone, await draftMessage('error'));
  }
}

async function handleFileRequest(phone, requestedName) {
  if (requestedName === '__SEND_LAST_OFFERED__') {
    const entry = lastOfferedFile.get(phone);
    if (entry) {
      requestedName = entry.filename;
    } else {
      await sendTextMessageWithRetry(phone, await draftMessage('file_offer_confused'));
      return;
    }
  }

  const filePath = findDocument(requestedName);
  if (filePath) {
    const filename = filePath.split('/').pop();
    try {
      await sendDocumentMessage(phone, filePath, filename);
    } catch (err) {
      logger.error('fileHandler', `Failed to send file`, { filename, error: err.message });
      await sendTextMessageWithRetry(phone, `Failed to send "${filename}": ${err.message}`);
    }
  } else {
    const docs = listLocalDocuments();
    if (docs.length === 0) {
      await sendTextMessageWithRetry(phone, await draftMessage('no_documents'));
    } else {
      await sendTextMessageWithRetry(phone, await draftMessage('file_not_found', { name: requestedName, docs }));
    }
  }
}

function detectFileRequest(text) {
  const lower = text.toLowerCase().trim();

  if (/^(?:send\s+it|yes\s*,?\s*send\s+it|please\s+send(?:\s+it)?)$/i.test(lower)) {
    return '__SEND_LAST_OFFERED__';
  }

  const patterns = [
    /^(?:can\s+you\s+)?send\s+(?:me\s+)?(?:the\s+)?(?:full\s+)?(?:paper|document|file|report|study)\s+(?:on|about|titled|called|regarding)?\s*["']?(.+?)["']?\s*[?.!]*$/i,
    /^share\s+(?:the\s+)?(?:paper|document|file)\s+(?:on|about)?\s*["']?(.+?)["']?\s*[?.!]*$/i,
    /^(?:please\s+)?(?:send|share|forward)\s+(?:me\s+)?["']?(.+?\.(?:pdf|docx?))["']?\s*[?.!]*$/i,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) return match[1].trim();
  }

  return null;
}

function formatReply(result) {
  let reply = result.answer || '';

  // Strip non-WhatsApp markdown, preserve WhatsApp-compatible formatting
  reply = reply.replace(/#{1,6}\s/g, '');            // Remove headings
  reply = reply.replace(/`{3}[\s\S]*?`{3}/g, '');   // Remove code blocks
  reply = reply.replace(/`(.+?)`/g, '$1');           // Remove inline code
  reply = reply.replace(/\[(.+?)\]\(.+?\)/g, '$1'); // Remove links, keep text
  
  // Keep *bold* and _italic_ — WhatsApp renders these
  // Keep • bullets and numbered lists — WhatsApp renders these
  // Convert markdown bullets (- or *) to Unicode bullet
  reply = reply.replace(/^\s*[-*]\s+/gm, '• ');

  // Clean up extra whitespace
  reply = reply.replace(/\n{3,}/g, '\n\n').trim();

  return reply;
}


