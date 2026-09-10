import path from 'path';
import { config } from './config.js';
import { loadJson, saveJson } from './persistence.js';
import { normalizePhoneForComparison } from './phone.js';

const APPROVED_FILE = path.join(config.storageDir, 'approved_users.json');
const PENDING_FILE = path.join(config.storageDir, 'pending_codes.json');

const PENDING_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function cleanupStalePending() {
  const pending = loadJson(PENDING_FILE);
  const now = Date.now();
  let changed = false;
  for (const [phone, entry] of Object.entries(pending)) {
    if (entry.created && now - entry.created > PENDING_TTL) {
      delete pending[phone];
      changed = true;
    }
  }
  if (changed) saveJson(PENDING_FILE, pending);
}

// Run cleanup every hour
setInterval(cleanupStalePending, 60 * 60 * 1000);
cleanupStalePending();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function isApproved(phone) {
  const approved = loadJson(APPROVED_FILE);
  const normalizedPhone = normalizePhoneForComparison(phone);

  for (const [key] of Object.entries(approved)) {
    if (normalizePhoneForComparison(key) === normalizedPhone) {
      return true;
    }
  }
  return false;
}

export function registerPending(phone) {
  const pending = loadJson(PENDING_FILE);
  if (pending[phone]) return pending[phone].code;
  const code = generateCode();
  pending[phone] = { code, created: Date.now() };
  saveJson(PENDING_FILE, pending);
  return code;
}

export function approveByCode(code, alias) {
  const pending = loadJson(PENDING_FILE);
  for (const [phone, entry] of Object.entries(pending)) {
    if (entry.code === code) {
      const approved = loadJson(APPROVED_FILE);
      approved[phone] = { added: Date.now(), code, ...(alias ? { alias } : {}) };
      saveJson(APPROVED_FILE, approved);
      delete pending[phone];
      saveJson(PENDING_FILE, pending);
      return phone;
    }
  }
  return null;
}

export function approvePhone(phone, alias) {
  const pending = loadJson(PENDING_FILE);
  if (!pending[phone]) return false;
  const approved = loadJson(APPROVED_FILE);
  approved[phone] = { added: Date.now(), code: pending[phone].code, ...(alias ? { alias } : {}) };
  saveJson(APPROVED_FILE, approved);
  delete pending[phone];
  saveJson(PENDING_FILE, pending);
  return true;
}

export function rejectPhone(phone) {
  const pending = loadJson(PENDING_FILE);
  if (!pending[phone]) return false;
  delete pending[phone];
  saveJson(PENDING_FILE, pending);
  return true;
}

export function removeApproved(phone) {
  const approved = loadJson(APPROVED_FILE);
  if (!approved[phone]) return false;
  delete approved[phone];
  saveJson(APPROVED_FILE, approved);
  return true;
}

export function getPendingUsers() {
  return loadJson(PENDING_FILE);
}

export function getApprovedUsers() {
  return loadJson(APPROVED_FILE);
}

export function findByAlias(alias) {
  if (!alias) return null;
  const approved = loadJson(APPROVED_FILE);
  const lower = alias.toLowerCase();
  for (const [phone, entry] of Object.entries(approved)) {
    if (entry.alias && entry.alias.toLowerCase() === lower) return phone;
  }
  return null;
}

export function isAliasTaken(alias) {
  return findByAlias(alias) !== null;
}
