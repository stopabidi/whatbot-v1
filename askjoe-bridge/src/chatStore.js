import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { loadJson, saveJson } from './persistence.js';

const CHATS_FILE = path.join(config.storageDir, 'chats.json');
const MAX_CHATS = 50;

function load() {
  const data = loadJson(CHATS_FILE);
  if (!data.chats) data.chats = {};
  if (!data.meta) data.meta = { lastId: 0 };
  return data;
}

function save(data) {
  saveJson(CHATS_FILE, data);
}

export function listChats() {
  const { chats } = load();
  return Object.values(chats)
    .sort((a, b) => b.updated - a.updated)
    .map(c => ({
      id: c.id,
      title: c.title,
      updated: c.updated,
      count: c.messages.length,
    }));
}

export function getChat(id) {
  const { chats } = load();
  return chats[id] || null;
}

export function createChat() {
  const data = load();
  const now = Date.now();
  const id = `chat_${now}`;
  data.chats[id] = {
    id,
    title: 'New Chat',
    created: now,
    updated: now,
    messages: [],
  };
  // Cap chats: remove oldest if over limit
  const ids = Object.keys(data.chats).sort((a, b) => data.chats[a].updated - data.chats[b].updated);
  while (ids.length > MAX_CHATS) {
    delete data.chats[ids.shift()];
  }
  save(data);
  return data.chats[id];
}

export function appendMessage(chatId, userMsg, assistantMsg) {
  const data = load();
  const chat = data.chats[chatId];
  if (!chat) return null;
  const now = Date.now();
  chat.messages.push(
    { role: 'user', text: userMsg.text, timestamp: now },
    { role: 'assistant', text: assistantMsg.text, sources: assistantMsg.sources || [], offer_file: assistantMsg.offer_file || null, timestamp: now + 1 }
  );
  chat.updated = now;
  // Auto-title from first user message
  if (chat.title === 'New Chat' && userMsg.text) {
    chat.title = userMsg.text.slice(0, 40) + (userMsg.text.length > 40 ? '…' : '');
  }
  save(data);
  return chat;
}

export function deleteChat(id) {
  const data = load();
  if (!data.chats[id]) return false;
  delete data.chats[id];
  save(data);
  return true;
}

export function renameChat(id, title) {
  const data = load();
  const chat = data.chats[id];
  if (!chat) return false;
  chat.title = title.slice(0, 80);
  chat.updated = Date.now();
  save(data);
  return true;
}
