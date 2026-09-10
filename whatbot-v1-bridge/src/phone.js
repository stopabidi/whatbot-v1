/**
 * Phone number normalization utilities.
 * 
 * IMPORTANT: Use normalizePhoneForComparison() for ALL phone comparisons
 * (approved users, pending checks, etc.)
 * 
 * Use normalizePhoneForTwilio() ONLY when calling Twilio API.
 */

/**
 * Normalize phone number to digits-only format for comparison.
 * Strips ALL non-digit characters including +.
 * 
 * @param {string} phone - Phone number in any format
 * @returns {string} Digits-only phone number
 */
export function normalizePhoneForComparison(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.replace(/[^0-9]/g, '');
}

/**
 * Normalize phone number for Twilio API (keeps + prefix).
 * Use this ONLY when calling Twilio API.
 * 
 * @param {string} phone - Phone number in any format
 * @returns {string} Phone number with + prefix
 */
export function normalizePhoneForTwilio(phone) {
  if (!phone || typeof phone !== 'string') return '';
  let normalized = phone.replace(/[^0-9+]/g, '');
  if (!normalized.startsWith('+')) normalized = '+' + normalized;
  return normalized;
}
