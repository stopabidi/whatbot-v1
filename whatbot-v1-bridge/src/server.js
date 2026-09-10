import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { getApprovedUsers, getPendingUsers, approvePhone, approveByCode, rejectPhone, removeApproved, findByAlias } from './approval.js';
import { reingest, reingestStatus } from './ragClient.js';
import { checkServices } from './healthCheck.js';
import { parseWebhookMessage, verifyWebhookSignature, sendTextMessageWithRetry } from './twilioClient.js';
import { handleTwilioMessage } from './messageHandler.js';
import { loadJson, saveJson } from './persistence.js';
import { normalizePhoneForComparison } from './phone.js';
import chatRoutes from './chatRoutes.js';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({
  dest: '/tmp/uploads',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.pptx', '.ppt', '.png', '.jpg', '.jpeg'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type not allowed. Accepted: ${allowed.join(', ')}`));
  },
});

const rateLimits = {
  upload: { count: 0, reset: Date.now(), max: parseInt(process.env.RATE_LIMIT_UPLOAD || '5'), window: 60_000 },
  rebuild: { count: 0, reset: Date.now(), max: parseInt(process.env.RATE_LIMIT_REBUILD || '1'), window: 300_000 },
  users: { count: 0, reset: Date.now(), max: parseInt(process.env.RATE_LIMIT_USERS || '10'), window: 60_000 },
  default: { count: 0, reset: Date.now(), max: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30'), window: 60_000 },
};

function checkRateLimit(key) {
  const rl = rateLimits[key];
  if (!rl) return true;
  const now = Date.now();
  if (now - rl.reset > rl.window) { rl.count = 0; rl.reset = now; }
  if (rl.count >= rl.max) return false;
  rl.count++;
  return true;
}

function sanitizePath(p) {
  const resolved = path.resolve(config.documentsDir, p);
  const docsDir = path.resolve(config.documentsDir) + path.sep;
  if (!resolved.startsWith(docsDir) && resolved !== path.resolve(config.documentsDir)) return null;
  return resolved;
}

export function startServer() {
  const app = express();
  app.set('trust proxy', true);  // Trust X-Forwarded-* headers from Tailscale funnel

  // Capture raw body BEFORE urlencoded parsing (needed for Twilio HMAC verification)
  app.use('/webhook', express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  }));

  app.use(express.json());

  // Serve documents (authenticated for dashboard, public for Twilio media downloads)
  app.use('/documents', (req, res, next) => {
    const userAgent = req.headers['user-agent'] || '';
    if (userAgent.includes('Twilio')) return next();
    if (!config.dashboardApiKey) return next();
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token === config.dashboardApiKey) return next();
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (ip.startsWith('100.')) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });
  app.use('/documents', express.static(config.documentsDir));

  app.use(express.static(path.join(import.meta.dirname, '..', 'public')));

  // CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    const ip = req.ip || req.connection?.remoteAddress || '';
    const allowed = origin.includes('tail') ||
                    ip.startsWith('100.');
    if (allowed) { res.setHeader('Access-Control-Allow-Origin', origin); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // General rate limiting
  app.use('/api', (req, res, next) => {
    if (req.path === '/status') return next();
    if (!checkRateLimit('default')) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
  });

  // Path traversal protection — reject requests that escape /api after Express resolves the URL
  app.use((req, res, next) => {
    const resolved = path.resolve(req.originalUrl || req.url || '/');
    if (resolved.startsWith('/api') || resolved.startsWith('/webhook') || resolved.startsWith('/health') || resolved.startsWith('/documents') || resolved === '/') {
      next();
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }
  });
  // Path traversal protection
  app.use('/api/documents', (req, res, next) => {
    const url = req.url || '';
    const docsDir = path.resolve(config.documentsDir);
    if (url.includes('../') || url.includes('..\\') ||
        url.includes('%2e%2e') || url.includes('%2E%2E') ||
        url.includes('..%2f') || url.includes('..%5c')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const resolved = path.resolve(config.documentsDir, url.replace(/^\/?/, ''));
    if (!resolved.startsWith(docsDir + path.sep) && resolved !== docsDir) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  });

  // Dashboard auth + rate limiting for user management
  app.use('/api', (req, res, next) => {
    if (req.path === '/status') return next();
    if (!config.dashboardApiKey) return next();
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== config.dashboardApiKey) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
  });

  // Rate limit all /api/users endpoints
  app.use('/api/users', (req, res, next) => {
    if (!checkRateLimit('users')) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
    if (!checkRateLimit('default')) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
  });

  // =====================
  // Twilio Webhook
  // =====================

  app.get('/webhook', (req, res) => {
    res.sendStatus(200);
  });

  app.post('/webhook', async (req, res) => {
    res.setHeader('Content-Type', 'text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    if (!verifyWebhookSignature(req)) {
      return;
    }

    const message = parseWebhookMessage(req.body);
    if (!message) return;

    try {
      await handleTwilioMessage(message);
    } catch (err) {
      console.error('[ERROR] Failed to handle message:', err.message);
    }
  });

  // =====================
  // Health Check
  // =====================

  app.get('/health', async (req, res) => {
    const services = await checkServices();
    const healthy = services.rag === 'ok' && services.vllm === 'ok';

    let documentCount = 0;
    try {
      const docsDir = path.resolve(config.documentsDir);
      const walkDir = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g)$/i.test(entry.name)) {
            documentCount++;
          }
        }
      };
      walkDir(docsDir);
    } catch {}

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      services,
      documentCount,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  });

  // =====================
  // Dashboard API
  // =====================

  // =====================
  // Chat API
  // =====================

  app.use('/api/chat', chatRoutes);

  app.get('/api/status', async (req, res) => {
    const services = await checkServices();

    let knowledgeBase = null;
    try {
      const docsDir = path.resolve(config.documentsDir);
      const files = [];
      const categories = new Set();

      const walkDir = (dir, prefix = '') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            categories.add(entry.name);
            walkDir(fullPath, relPath);
          } else if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g)$/i.test(entry.name)) {
            files.push(relPath);
          }
        }
      };
      walkDir(docsDir);

      knowledgeBase = {
        documents: files.length,
        categories: categories.size,
        indexed: files.length > 0,
      };

      // Use filesystem count (accurate, no rate limit issues)
      knowledgeBase.indexedCount = files.length;
      knowledgeBase.indexed = files.length > 0;
    } catch {}

    // Get VRAM from host nvidia-smi (needs GPU access)
    let vram = null;
    try {
      const { execSync } = await import('child_process');
      const output = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', { timeout: 3000 }).toString().trim();
      const [used, total] = output.split(',').map(s => parseInt(s.trim()));
      if (used && total) vram = `${used} / ${total} MB (${Math.round(used/total*100)}%)`;
    } catch {}

    res.json({
      twilio: { configured: true, number: config.twilioWhatsAppNumber },
      services,
      knowledgeBase,
      botName: config.botName,
      uptime: process.uptime(),
      vram,
    });
  });

  app.get('/api/users', (req, res) => {
    res.json({ approved: getApprovedUsers(), pending: getPendingUsers() });
  });

  app.post('/api/users/approve', (req, res) => {
    const { jid, alias } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'Missing field: jid' });
    // Validate phone format
    const cleanJid = jid.replace(/[^0-9+]/g, '');
    if (cleanJid.length < 7 || cleanJid.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }
    if (!getPendingUsers()[jid]) return res.status(404).json({ error: 'User not found in pending list' });
    const cleanAlias = alias ? alias.replace(/[<>/"']/g, '').substring(0, 50) : null;
    if (!cleanAlias) {
      return res.status(400).json({ error: 'Name / alias is required' });
    }
    if (findByAlias(cleanAlias)) return res.status(409).json({ error: 'Alias already in use' });
    approvePhone(jid, cleanAlias);
    sendTextMessageWithRetry(jid, 'You have been approved! You can now ask me questions about the research.').catch(() => {});
    res.json({ status: 'approved', jid, alias: cleanAlias || null });
  });

  app.post('/api/users/approve-code', (req, res) => {
    const { code, alias } = req.body || {};
    if (!code || !/^\d{6}$/.test(code.trim())) {
      return res.status(400).json({ error: 'Please enter a valid 6-digit code' });
    }
    const cleanAlias = alias ? alias.replace(/[<>/"']/g, '').substring(0, 50) : null;
    if (!cleanAlias) {
      return res.status(400).json({ error: 'Name / alias is required' });
    }
    const phone = approveByCode(code.trim(), cleanAlias);
    if (!phone) {
      return res.status(404).json({ error: 'No pending user found for this code' });
    }
    sendTextMessageWithRetry(phone, 'You have been approved! You can now ask me questions about the research.').catch(() => {});
    res.json({ status: 'approved', phone });
  });

  app.post('/api/users/reject', (req, res) => {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'Missing field: jid' });
    if (!getPendingUsers()[jid]) return res.status(404).json({ error: 'User not found in pending list' });
    rejectPhone(jid);
    res.json({ status: 'rejected', jid });
  });

  app.post('/api/users/remove', (req, res) => {
    const { jid, alias } = req.body || {};
    let targetJid = jid;
    if (!targetJid && alias) targetJid = findByAlias(alias);
    if (!targetJid) return res.status(400).json({ error: 'Missing field: jid or alias' });
    if (!getApprovedUsers()[targetJid]) return res.status(404).json({ error: 'User not in approved list' });
    removeApproved(targetJid);
    res.json({ status: 'removed', jid: targetJid });
  });

  app.post('/api/users/add', (req, res) => {
    const { phone, alias } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Missing field: phone' });
    // Validate phone format: must be digits with optional + prefix, 7-15 digits
    const cleanPhone = phone.replace(/[^0-9+]/g, '').trim();
    const digits = cleanPhone.replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 15 || (!cleanPhone.startsWith('+') && cleanPhone !== digits)) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }
    const cleanAlias = alias ? alias.replace(/[<>/"']/g, '').substring(0, 50) : null;
    const APPROVED_FILE = path.join(config.storageDir, 'approved_users.json');
    const approved = loadJson(APPROVED_FILE);
    const normalized = normalizePhoneForComparison(cleanPhone);
    for (const [key] of Object.entries(approved)) {
      if (normalizePhoneForComparison(key) === normalized) {
        return res.status(409).json({ error: 'User already approved' });
      }
    }
    approved[cleanPhone] = { added: Date.now(), alias: cleanAlias };
    saveJson(APPROVED_FILE, approved);
    sendTextMessageWithRetry(cleanPhone, 'You have been approved! You can now ask me questions about the research.').catch(() => {});
    res.json({ status: 'added', phone: cleanPhone, alias: cleanAlias || null });
  });

  app.get('/api/documents', asyncHandler(async (req, res) => {
    const files = listDirRecursive(config.documentsDir, '');
    res.json(files);
  }));

  app.post('/api/documents/upload', upload.single('file'), asyncHandler(async (req, res) => {
    if (!checkRateLimit('upload')) return res.status(429).json({ error: 'Rate limit exceeded' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const allowed = ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.pptx', '.ppt', '.png', '.jpg', '.jpeg'];
    if (!allowed.includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `File type not allowed. Accepted: ${allowed.join(', ')}` });
    }
    // Validate MIME type matches extension
    const allowedMimes = {
      '.pdf': ['application/pdf'],
      '.doc': ['application/msword'],
      '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      '.xls': ['application/vnd.ms-excel'],
      '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      '.ppt': ['application/vnd.ms-powerpoint'],
      '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      '.png': ['image/png'],
      '.jpg': ['image/jpeg'],
      '.jpeg': ['image/jpeg'],
    };
    const mime = req.file.mimetype;
    const expected = allowedMimes[ext] || [];
    if (expected.length > 0 && !expected.includes(mime)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `File type mismatch: expected ${ext} but got ${mime}` });
    }
    const safeName = path.basename(req.file.originalname);
    const dest = path.join(config.documentsDir, safeName);
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
    let ingestResult = null;
    try {
      const { ingestDocument } = await import('./ragClient.js');
      ingestResult = await ingestDocument(dest);
      if (ingestResult.status === 'ok') {
        const { reloadIndex } = await import('./ragClient.js');
        await reloadIndex();
      }
    } catch (err) {
      console.error(`[WARN] Auto-ingest failed for ${safeName}:`, err.message);
    }
    res.json({ status: 'uploaded', filename: safeName, ingest: ingestResult?.status || 'skipped' });
  }));

  app.delete('/api/documents/*', asyncHandler(async (req, res) => {
    const relPath = req.params[0];
    if (!relPath) return res.status(400).json({ error: 'No path specified' });
    const resolved = sanitizePath(relPath);
    if (!resolved) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
    fs.rmSync(resolved, { recursive: true, force: true });
    res.json({ status: 'deleted', path: relPath });
  }));

  app.post('/api/documents/rebuild', asyncHandler(async (req, res) => {
    if (!checkRateLimit('rebuild')) return res.status(429).json({ error: 'Rate limit exceeded' });
    try {
      await reingest();
      res.status(202).json({ status: 'started' });
    } catch (err) {
      if (err.response?.status === 409) return res.status(409).json(err.response.data);
      throw err;
    }
  }));

  app.get('/api/documents/rebuild/status', asyncHandler(async (req, res) => {
    try {
      const status = await reingestStatus();
      res.json(status);
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.response?.status === 503) {
        return res.status(503).json({ error: 'Service unavailable' });
      }
      throw err;
    }
  }));

  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, _next) => {
    if (err.message && err.message.includes('File type not allowed')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max 50MB.' });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[SERVER ERROR]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(3000, '0.0.0.0', () => {
    console.log('[SERVER] Dashboard listening on 0.0.0.0:3000');
    console.log(`[SERVER] Documents served at /documents/`);
  });
}

function listDirRecursive(base, rel) {
  const entries = [];
  for (const name of fs.readdirSync(path.join(base, rel))) {
    const full = path.join(base, rel, name);
    const stat = fs.statSync(full);
    const relPath = path.join(rel, name).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      entries.push({ name, isDir: true, path: relPath, size: 0 });
      entries.push(...listDirRecursive(base, relPath));
    } else {
      entries.push({ name, isDir: false, path: relPath, size: stat.size });
    }
  }
  return entries;
}
