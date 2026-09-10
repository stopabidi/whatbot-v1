import 'dotenv/config';
import fs from 'fs';

export const config = {
  // RAG API
  ragApiUrl: process.env.RAG_API_URL || 'http://localhost:8002',
  ragApiKey: process.env.RAG_API_KEY || '',

  // Files
  documentsDir: process.env.DOCUMENTS_DIR || './documents',
  storageDir: './storage',

  // Bot
  botName: process.env.BOT_NAME || "WhatBot v2 V5, Document Assistant",
  welcomeMessage: process.env.WELCOME_MESSAGE || "Hello! I help answer questions about the published research.",

  // Dashboard
  dashboardApiKey: process.env.DASHBOARD_API_KEY || '',

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioWhatsAppNumber: process.env.TWILIO_WHATSAPP_NUMBER || '',

  // llama-swap
  vllmUrl: process.env.LLAMA_SWAP_URL || 'http://127.0.0.1:8000',
  
};

// Fail-fast
if (!config.twilioAccountSid || !config.twilioAuthToken) {
  console.error('FATAL: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set.');
  process.exit(1);
}
if (!config.ragApiKey) {
  console.error('FATAL: RAG_API_KEY is not set. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// Ensure documents directory exists
if (!fs.existsSync(config.documentsDir)) {
  fs.mkdirSync(config.documentsDir, { recursive: true });
  console.log(`[CONFIG] Created documents directory: ${config.documentsDir}`);
}

console.log(`[CONFIG] Bot name: ${config.botName}`);
console.log(`[CONFIG] Twilio WhatsApp: ${config.twilioWhatsAppNumber}`);
console.log(`[CONFIG] RAG API: ${config.ragApiUrl}`);
console.log(`[CONFIG] vLLM: ${config.vllmUrl}`);
