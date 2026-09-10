/**
 * Request tracing utility.
 * Generates unique IDs for each request to trace through the system.
 */

let counter = 0;

/**
 * Generate a unique request ID.
 * Format: req_<timestamp>_<counter>
 * @returns {string} Request ID
 */
export function generateRequestId() {
  counter = (counter + 1) % 10000;
  return `req_${Date.now().toString(36)}_${counter}`;
}

/**
 * Log a message with request ID.
 * @param {string} requestId - The request ID
 * @param {string} component - The component name (e.g., 'messageHandler', 'ragApi')
 * @param {string} message - The log message
 */
export function logWithRequestId(requestId, component, message) {
  console.log(`[${requestId}] [${component}] ${message}`);
}
