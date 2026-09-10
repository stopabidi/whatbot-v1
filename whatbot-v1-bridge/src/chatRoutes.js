import express from 'express';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { queryRag } from './ragClient.js';
import * as chatStore from './chatStore.js';

const router = express.Router();

// List all chats
router.get('/list', (req, res) => {
  res.json(chatStore.listChats());
});

// Get a single chat
router.get('/:id', (req, res) => {
  const chat = chatStore.getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  res.json(chat);
});

// Create new chat
router.post('/new', (req, res) => {
  const chat = chatStore.createChat();
  res.json({ id: chat.id, title: chat.title });
});

// Send a message
router.post('/:id/message', async (req, res) => {
  const chat = chatStore.getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Missing question' });
  }

  try {
    // Send last 20 messages as context
    const history = chat.messages.slice(-20).map(m => ({
      role: m.role,
      content: m.text,
    }));

    const result = await queryRag(question.trim(), history);

    const saved = chatStore.appendMessage(
      req.params.id,
      { text: question.trim() },
      { text: result.answer || '', sources: result.sources || [], offer_file: result.offer_file || null }
    );

    res.json({
      answer: result.answer || '',
      sources: result.sources || [],
      offer_file: result.offer_file || null,
    });
  } catch (err) {
    console.error('[CHAT] Query failed:', err.message);
    if (err.code === 'ECONNABORTED' || err.response?.status === 503) {
      return res.status(503).json({ error: 'Service unavailable. Check that rag-api is running.' });
    }
    res.status(500).json({ error: 'Failed to get answer. Please try again.' });
  }
});

// Delete a chat
router.delete('/:id', (req, res) => {
  const ok = chatStore.deleteChat(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Chat not found' });
  res.json({ status: 'deleted' });
});

// Rename a chat
router.patch('/:id', (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Missing title' });
  }
  const ok = chatStore.renameChat(req.params.id, title.trim());
  if (!ok) return res.status(404).json({ error: 'Chat not found' });
  res.json({ status: 'renamed' });
});

// Send file download
router.post('/send-file', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Missing filename' });

  // Path traversal protection
  const resolved = path.resolve(config.documentsDir, filename);
  const docsDir = path.resolve(config.documentsDir) + path.sep;
  if (!resolved.startsWith(docsDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };

  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filename)}"`);
  fs.createReadStream(resolved).pipe(res);
});

export default router;
