import { startServer } from './server.js';

console.log('[INIT] WhatBot v2 — WhatsApp Bridge');
console.log('[INIT] Webhook endpoint ready at /webhook');

// Start Express server
startServer();

// Crash resilience
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack?.split('\n')[1]);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Received SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[SHUTDOWN] Received SIGINT');
  process.exit(0);
});
