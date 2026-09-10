/**
 * Input validation and sanitization module.
 * Validates message format and sanitizes user input.
 */

/**
 * Validate an incoming message.
 * @param {object} message - The message object
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMessage(message) {
  const errors = [];
  
  // Check message exists
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Invalid message object'] };
  }
  
  // Check required fields
  if (!message.from) errors.push('Missing "from" field');
  if (!message.id) errors.push('Missing "id" field');
  
  // Validate phone number
  if (message.from) {
    const phone = message.from.replace(/[^0-9+]/g, '');
    if (phone.length < 10 || phone.length > 15) {
      errors.push('Invalid phone number length');
    }
  }
  
  // Validate message length
  if (message.text && message.text.length > 10000) {
    errors.push('Message too long (max 10000 characters)');
  }
  
  // Check for null bytes (injection attempt)
  if (message.text && message.text.includes('\0')) {
    errors.push('Message contains null bytes');
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Sanitize user input.
 * @param {string} text - Raw input text
 * @returns {string} Sanitized text
 */
export function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  
  return text
    .replace(/\0/g, '')  // Remove null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // Remove control chars
    .trim()
    .substring(0, 10000);  // Limit length
}
