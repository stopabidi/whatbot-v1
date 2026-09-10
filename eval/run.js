#!/usr/bin/env node
// eval/run.js — AskJoe V5 Test Runner

const fs = require('fs');
const path = require('path');
const http = require('http');

// Config
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3000';
const API_KEY = process.env.DASHBOARD_API_KEY || '';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1');
const DELAY_MS = parseInt(process.env.DELAY_MS || '1500'); // delay between queries to avoid rate limit
// Parse --queries flag
const queriesArg = process.argv.find(a => a.startsWith('--queries='));
const QUERIES_FILE = queriesArg ? path.resolve(queriesArg.split('=')[1]) : path.join(__dirname, 'queries.json');
const RESULTS_DIR = path.join(__dirname, process.env.RESULTS_DIR || 'results2');

if (!API_KEY) {
  console.error('[RUNNER] DASHBOARD_API_KEY not set. Export it or add to .env');
  process.exit(1);
}

// Ensure results dir exists
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Load queries
const queries = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
console.log(`[RUNNER] Loaded ${queries.length} queries`);
console.log(`[RUNNER] Target: ${BRIDGE_URL}`);
console.log(`[RUNNER] Concurrency: ${CONCURRENCY}`);
console.log('');

// ---- HTTP helper ----

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, BRIDGE_URL);
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 180000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { reject(new Error(`Parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

// ---- Query execution ----

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function runQuery(chatId, query, attempt = 0) {
  const start = Date.now();
  try {
    const payload = { question: query.query };
    // Thread conversation history if present
    if (query.conversation_history && query.conversation_history.length > 0) {
      payload.conversation_history = query.conversation_history;
    }
    const { status, data } = await apiPost(`/api/chat/${chatId}/message`, payload);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    // Rate limited — retry after delay
    if (status === 429 && attempt < 3) {
      await delay(5000 * (attempt + 1));
      return runQuery(chatId, query, attempt + 1);
    }
    if (status === 503) {
      return {
        id: query.id, query: query.query, category: query.category,
        answer: '', sources: [], offer_file: null,
        response_time: parseFloat(elapsed), error: 'Service unavailable',
        answer_length: 0,
      };
    }
    return {
      id: query.id, query: query.query, category: query.category,
      answer: data.answer || '', sources: (data.sources || []).map(s => s.file_name || s),
      offer_file: data.offer_file || null,
      response_time: parseFloat(elapsed), error: data.error || null,
      answer_length: (data.answer || '').length,
    };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return {
      id: query.id, query: query.query, category: query.category,
      answer: '', sources: [], offer_file: null,
      response_time: parseFloat(elapsed), error: err.message,
      answer_length: 0,
    };
  }
}

// ---- Concurrency controller ----

// Build conversation history from results so far within a conversation group
function buildHistory(queries, currentIndex) {
  const current = queries[currentIndex];
  if (!current.conversation_history || current.conversation_history.length === 0) return null;
  // The conversation_history in the query has the user messages;
  // we need to pair them with assistant responses from prior results.
  // For now, just pass what's in the query — the bridge handles context.
  return current.conversation_history;
}

// Group queries: conversation queries share a chat, standalone queries each get their own
function groupQueries(queries) {
  const groups = [];
  let currentGroup = null;
  for (const q of queries) {
    const isConv = q.conversation_history && q.conversation_history.length > 0;
    const prevIsConv = currentGroup && currentGroup.length > 0 &&
      currentGroup[currentGroup.length - 1].conversation_history &&
      currentGroup[currentGroup.length - 1].conversation_history.length > 0;
    // Group consecutive conversation queries together
    if (isConv && prevIsConv) {
      currentGroup.push(q);
    } else if (isConv) {
      currentGroup = [q];
      groups.push(currentGroup);
    } else {
      // Standalone query — its own group
      groups.push([q]);
      currentGroup = null;
    }
  }
  return groups;
}

async function runAll(queries, createChat) {
  const results = [];
  const groups = groupQueries(queries);
  let globalIdx = 0;
  let firstChatId = null;

  for (const group of groups) {
    // Each group gets its own chat
    const chat = await createChat();
    const chatId = chat.data.id;
    if (!firstChatId) firstChatId = chatId;
    let builtHistory = [];

    for (const q of group) {
      const result = await runQuery(chatId, q);
      results.push(result);
      printResult(++globalIdx, queries.length, result);
      // Build history for next message in this conversation
      builtHistory.push({ role: 'user', text: q.query });
      if (result.answer) builtHistory.push({ role: 'assistant', text: result.answer.slice(0, 500) });
      // Inject built history into next query's conversation_history
      const nextIdx = group.indexOf(q) + 1;
      if (nextIdx < group.length) {
        group[nextIdx].conversation_history = [...builtHistory];
      }
      await delay(DELAY_MS);
    }
  }
  return { results, firstChatId };
}

// ---- Terminal output ----

function printResult(current, total, result) {
  const icon = result.error ? '❌' :
               result.sources.length === 0 && result.answer_length > 50 ? '⚠️' :
               '✅';
  const sources = result.sources.length > 0 ? result.sources[0].slice(0, 40) : 'none';
  const query = result.query.slice(0, 50);
  console.log(
    `[${String(current).padStart(3)}/${total}] ${icon} "${query}" ` +
    `(${result.response_time}s) — src: ${sources}`
  );
}

// ---- Main ----

async function main() {
  async function createChat() {
    return apiPost('/api/chat/new', {});
  }

  console.log('[RUNNER] Ready. Starting queries...');
  console.log('');

  // Run all queries
  const startTime = Date.now();
  const { results, firstChatId } = await runAll(queries, createChat);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultsFile = path.join(RESULTS_DIR, `${timestamp}.json`);
  const output = {
    timestamp: new Date().toISOString(),
    chat_id: firstChatId,
    total_queries: results.length,
    total_time: parseFloat(totalTime),
    results,
  };
  fs.writeFileSync(resultsFile, JSON.stringify(output, null, 2));
  console.log('');
  console.log(`[RUNNER] Done. ${results.length} queries in ${totalTime}s`);
  console.log(`[RUNNER] Results saved to: ${resultsFile}`);
}

// ---- Graceful shutdown ----

let saved = false;
process.on('SIGINT', () => {
  if (saved) process.exit(0);
  console.log('\n[RUNNER] Interrupted — saving partial results...');
  saved = true;
  process.exit(0);
});

main().catch(err => {
  console.error('[RUNNER] Fatal:', err.message);
  process.exit(1);
});
