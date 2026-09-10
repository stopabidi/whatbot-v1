# AskJoe V5 — Eval Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated test suite that runs 200 queries through the Node.js bridge, validates citation accuracy, checks content relevance, and outputs live results to the terminal.

**Architecture:** Standalone Node.js scripts in `eval/` directory. No new dependencies — uses built-in `http`/`https` modules and `fs`. Queries hit the Node.js bridge (port 3000) to test the full pipeline including `formatReply` and `sendLongMessage`.

**Tech Stack:** Node.js (vanilla, no frameworks), JSON for data, Markdown for reports.

**Spec:** `plans/eval-suite-plan.md` (this file)

---

## File Structure

| File | Purpose |
|------|---------|
| `eval/queries.json` | 200 test queries with expected results |
| `eval/run.js` | Test runner — sends queries, collects results |
| `eval/report.js` | Report generator — reads results, outputs summary |
| `eval/results/` | Timestamped result files (auto-created) |
| `eval/reports/` | Timestamped report files (auto-created) |

---

## Global Constraints

- No new npm dependencies — vanilla Node.js only
- Test runner hits `http://localhost:3000` (Node.js bridge)
- Auth via `DASHBOARD_API_KEY` from `.env` file
- Rate limit: max 2 concurrent requests to avoid overwhelming vLLM
- All queries use `POST /api/chat/:id/message` endpoint
- Results stored as JSON, reports as Markdown

---

## Task 1: Create the Query Set (`eval/queries.json`)

**Files:**
- Create: `eval/queries.json`

**Data sources:**
1. `OV3/QA/qa800_ov3/results/*.json` — 800 previous eval results. Select top 80 by: has sources, has answer, response_time < 10s, no refusal.
2. `v5/qa/WHATSAPP_QA_GUIDE.md` — Extract the ~40 curated test queries from the markdown tables.
3. Generated queries — Create 80 new queries from document categories.

**Query schema:**
```json
{
  "id": "001",
  "query": "What are the 7 layers of consulting?",
  "category": "research",
  "expected_files": ["7 Layers of Consulting High Performance.md"],
  "expected_topics": ["layers", "performance", "pyramid", "value proposition"],
  "follow_up": null,
  "notes": ""
}
```

**Categories (target count):**
| Category | Count | Description |
|----------|-------|-------------|
| `greeting` | 20 | Hello, hi, good morning, how are you, thanks, etc. |
| `research` | 60 | Core consulting topics (strategy, pricing, growth, exit, people) |
| `follow_up` | 30 | Second message in a conversation (depends on prior context) |
| `file_send` | 25 | "Send me the pricing paper", "Can you share the exit guide?" |
| `refusal` | 20 | Hacking, politics, quantum physics, poems, etc. |
| `edge_case` | 20 | Empty message, gibberish, SQL injection, XSS, very long message |
| `pricing` | 15 | Pricing-specific queries |
| `exit` | 10 | Exit planning queries |

**Generating queries from documents:**
Use the folder structure and `DOCUMENT_TOPICS` dict from `rag.py`:

```python
# Folder → topic mapping (from rag.py)
FOLDER_TO_CATEGORY = {
    "01 Vision & Strategy": "strategy",
    "02 Clients & Relationships": "clients",
    "03 Services & Pricing": "pricing",
    "04 Sales & Pipeline": "sales",
    "05 Cost Optimisation": "costs",
    "06 Market Profile & Marketing": "marketing",
    "07 People": "people",
    "08 Delivery": "delivery",
    "09 Leadership & Governance": "governance",
    "10 Exit Planning": "exit",
}
```

For each category, generate 8-10 queries like:
- "What are the key metrics for [category]?"
- "How do I improve [specific topic]?"
- "What's the best approach to [topic]?"
- "Tell me about [specific document topic]"

**Selecting from OV3 results:**
Read each `results/XXXX.json`. Keep query if:
- `answer` is not empty
- `sources` is not empty (has at least 1 source)
- `response_time` < 10.0
- Answer does not contain refusal patterns ("I cannot", "I don't have")
- Answer does not contain error patterns ("Error", "failed")

Map the `query` field to the new schema. Infer `expected_files` from the `sources` field. Infer `expected_topics` from the query text.

**- [ ] Step 1: Read OV3 results and select top 80**

```bash
# Run this to extract good queries from OV3
cd /path/to/project
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'OV3/QA/qa800_ov3/results';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const good = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (d.answer && d.sources && d.sources.length > 0 && d.response_time < 10 &&
      !d.answer.match(/I cannot|I don't have|Error|failed/i)) {
    good.push({
      id: String(good.length + 1).padStart(3, '0'),
      query: d.query,
      category: 'research',
      expected_files: d.sources.map(s => s.file_name || s),
      expected_topics: d.query.toLowerCase().split(/\s+/).filter(w => w.length > 4),
      follow_up: null,
      notes: 'from OV3 eval'
    });
  }
}
// Take first 80
console.log(JSON.stringify(good.slice(0, 80), null, 2));
" > eval/queries_ov3.json
```

**- [ ] Step 2: Extract QA guide queries**

Manually extract the queries from `v5/qa/WHATSAPP_QA_GUIDE.md`. Each test row has a query in backticks. Map to schema:

```json
{
  "id": "Q01",
  "query": "Hello",
  "category": "greeting",
  "expected_files": [],
  "expected_topics": [],
  "follow_up": null,
  "notes": "from QA guide"
}
```

**- [ ] Step 3: Generate category queries**

For each document category, create 8-10 queries. Use this template:

```javascript
const categories = {
  strategy: ["growth", "inflection", "plateau", "scaling", "framework", "differentiation"],
  clients: ["retention", "satisfaction", "referral", "account", "relationship"],
  pricing: ["fee", "rate", "charge", "value-based", "retainer", "blended"],
  sales: ["pipeline", "prospect", "closing", "negotiation", "win rate"],
  costs: ["utilisation", "overhead", "leverage", "efficiency"],
  marketing: ["brand", "content", "thought leadership", "website", "social media"],
  people: ["talent", "team", "competence", "training", "culture", "delegation"],
  delivery: ["project management", "implementation", "execution", "quality"],
  governance: ["board", "leadership", "oversight", "accountability"],
  exit: ["sale", "merger", "acquisition", "valuation", "readiness", "MBO"]
};
```

For each topic, generate queries like:
- "How do I improve [topic] in my consultancy?"
- "What are the best practices for [topic]?"
- "Tell me about [topic] in professional services"
- "What metrics should I track for [topic]?"

**- [ ] Step 4: Merge all sources into `eval/queries.json`**

Combine OV3 queries + QA guide queries + generated queries. Renumber IDs sequentially. Cap at 200 total.

**- [ ] Step 5: Validate the query set**

Run a quick sanity check:
- All IDs unique
- All categories have at least 10 queries
- No empty queries
- `expected_files` are valid filenames (exist in documents dir)

---

## Task 2: Build the Test Runner (`eval/run.js`)

**Files:**
- Create: `eval/run.js`

**Features:**
- Reads `eval/queries.json`
- Creates a new chat via `POST /api/chat/new`
- Sends each query via `POST /api/chat/:id/message`
- Tracks: response time, sources, answer length, errors
- Live terminal output per query
- Saves results to `eval/results/{timestamp}.json`
- Concurrency: max 2 in-flight requests
- Graceful shutdown on Ctrl+C (save partial results)

**Interfaces:**
- Consumes: `eval/queries.json`, `DASHBOARD_API_KEY` from `.env`
- Produces: `eval/results/{timestamp}.json`

**- [ ] Step 1: Create the runner skeleton**

```javascript
#!/usr/bin/env node
// eval/run.js — AskJoe V5 Test Runner

const fs = require('fs');
const path = require('path');
const http = require('http');

// Config
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3000';
const API_KEY = process.env.DASHBOARD_API_KEY || '';
const CONCURRENCY = 2;
const QUERIES_FILE = path.join(__dirname, 'queries.json');
const RESULTS_DIR = path.join(__dirname, 'results');

// Ensure results dir exists
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Load queries
const queries = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
console.log(`[RUNNER] Loaded ${queries.length} queries`);
console.log(`[RUNNER] Target: ${BRIDGE_URL}`);
console.log(`[RUNNER] Concurrency: ${CONCURRENCY}`);
console.log('');

// ... (implementation in Step 2-5)
```

**- [ ] Step 2: Implement HTTP helper**

```javascript
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
      timeout: 180000, // 3 minutes max per query
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}
```

**- [ ] Step 3: Implement query execution**

```javascript
async function runQuery(chatId, query) {
  const start = Date.now();
  try {
    const result = await apiPost(`/api/chat/${chatId}/message`, {
      question: query.query,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return {
      id: query.id,
      query: query.query,
      category: query.category,
      answer: result.answer || '',
      sources: (result.sources || []).map(s => s.file_name || s),
      offer_file: result.offer_file || null,
      response_time: parseFloat(elapsed),
      error: null,
      answer_length: (result.answer || '').length,
    };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return {
      id: query.id,
      query: query.query,
      category: query.category,
      answer: '',
      sources: [],
      offer_file: null,
      response_time: parseFloat(elapsed),
      error: err.message,
      answer_length: 0,
    };
  }
}
```

**- [ ] Step 4: Implement concurrency controller**

```javascript
async function runAll(queries, chatId) {
  const results = [];
  let index = 0;
  let active = 0;
  let completed = 0;

  return new Promise((resolve) => {
    function next() {
      while (active < CONCURRENCY && index < queries.length) {
        const q = queries[index++];
        active++;
        runQuery(chatId, q).then(result => {
          results.push(result);
          active--;
          completed++;
          printResult(completed, queries.length, result);
          if (completed === queries.length) resolve(results);
          else next();
        });
      }
    }
    next();
  });
}
```

**- [ ] Step 5: Implement terminal output**

```javascript
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
```

**- [ ] Step 6: Implement main flow with chat lifecycle**

```javascript
async function main() {
  // Create a test chat
  console.log('[RUNNER] Creating test chat...');
  const chat = await apiPost('/api/chat/new', {});
  const chatId = chat.id;
  console.log(`[RUNNER] Chat ID: ${chatId}`);
  console.log('');

  // Run all queries
  const startTime = Date.now();
  const results = await runAll(queries, chatId);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultsFile = path.join(RESULTS_DIR, `${timestamp}.json`);
  const output = {
    timestamp: new Date().toISOString(),
    chat_id: chatId,
    total_queries: results.length,
    total_time: parseFloat(totalTime),
    results,
  };
  fs.writeFileSync(resultsFile, JSON.stringify(output, null, 2));
  console.log('');
  console.log(`[RUNNER] Done. ${results.length} queries in ${totalTime}s`);
  console.log(`[RUNNER] Results saved to: ${resultsFile}`);
}

main().catch(err => {
  console.error('[RUNNER] Fatal:', err.message);
  process.exit(1);
});
```

**- [ ] Step 7: Add graceful shutdown**

```javascript
let saved = false;
process.on('SIGINT', () => {
  if (saved) process.exit(0);
  console.log('\n[RUNNER] Interrupted — saving partial results...');
  // Save whatever we have
  saved = true;
  process.exit(0);
});
```

---

## Task 3: Build the Report Generator (`eval/report.js`)

**Files:**
- Create: `eval/report.js`

**Features:**
- Reads a results JSON file
- Citation check: `expected_files` vs `sources`
- Content check: `expected_topics` keywords in answer
- Summary stats per category
- Outputs to terminal + saves Markdown report

**- [ ] Step 1: Create the report skeleton**

```javascript
#!/usr/bin/env node
// eval/report.js — AskJoe V5 Eval Report Generator

const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, 'results');
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

// Get latest results file or accept CLI arg
const resultsFile = process.argv[2] || getLatestFile();
if (!resultsFile) {
  console.error('Usage: node report.js [results-file.json]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
// ... (implementation in Step 2-5)
```

**- [ ] Step 2: Implement citation checker**

```javascript
function checkCitation(result, query) {
  if (!query.expected_files || query.expected_files.length === 0) {
    return { pass: true, reason: 'no expected files' };
  }
  if (result.sources.length === 0) {
    return { pass: false, reason: 'no sources returned' };
  }
  const matched = query.expected_files.some(expected =>
    result.sources.some(source =>
      source.toLowerCase().includes(expected.toLowerCase().slice(0, 20))
    )
  );
  return {
    pass: matched,
    reason: matched ? 'source matched' : `expected: ${query.expected_files[0]}, got: ${result.sources[0] || 'none'}`,
  };
}
```

**- [ ] Step 3: Implement content checker**

```javascript
function checkContent(result, query) {
  if (!query.expected_topics || query.expected_topics.length === 0) {
    return { pass: true, score: 1, reason: 'no expected topics' };
  }
  const answerLower = result.answer.toLowerCase();
  const matched = query.expected_topics.filter(topic =>
    answerLower.includes(topic.toLowerCase())
  );
  const score = matched.length / query.expected_topics.length;
  return {
    pass: score >= 0.5,
    score,
    matched: matched.length,
    total: query.expected_topics.length,
    reason: `${matched.length}/${query.expected_topics.length} topics found`,
  };
}
```

**- [ ] Step 4: Implement summary generator**

```javascript
function generateSummary(data) {
  const results = data.results;
  const byCategory = {};

  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, errors: 0, no_sources: 0, avg_time: 0, times: [] };
    }
    const cat = byCategory[r.category];
    cat.total++;
    if (r.error) cat.errors++;
    if (r.sources.length === 0) cat.no_sources++;
    cat.times.push(r.response_time);
  }

  // Calculate averages
  for (const cat of Object.values(byCategory)) {
    cat.avg_time = (cat.times.reduce((a, b) => a + b, 0) / cat.times.length).toFixed(1);
  }

  return {
    total: results.length,
    errors: results.filter(r => r.error).length,
    avg_time: (results.reduce((a, r) => a + r.response_time, 0) / results.length).toFixed(1),
    by_category: byCategory,
  };
}
```

**- [ ] Step 5: Implement Markdown report writer**

```javascript
function writeReport(data, summary, citations, contents) {
  const lines = [];
  lines.push('# AskJoe V5 — Eval Report');
  lines.push('');
  lines.push(`**Date:** ${data.timestamp}`);
  lines.push(`**Queries:** ${summary.total}`);
  lines.push(`**Total time:** ${data.total_time}s`);
  lines.push(`**Avg latency:** ${summary.avg_time}s`);
  lines.push(`**Errors:** ${summary.errors}`);
  lines.push('');

  // Citation accuracy
  const citPass = citations.filter(c => c.pass).length;
  lines.push('## Citation Accuracy');
  lines.push('');
  lines.push(`**${citPass}/${citations.length}** queries returned expected source (${(citPass/citations.length*100).toFixed(1)}%)`);
  lines.push('');

  // Content accuracy
  const conPass = contents.filter(c => c.pass).length;
  lines.push('## Content Accuracy');
  lines.push('');
  lines.push(`**${conPass}/${contents.length}** queries had expected topics in answer (${(conPass/contents.length*100).toFixed(1)}%)`);
  lines.push('');

  // By category
  lines.push('## By Category');
  lines.push('');
  lines.push('| Category | Total | Errors | No Sources | Avg Time |');
  lines.push('|----------|-------|--------|------------|----------|');
  for (const [name, cat] of Object.entries(summary.by_category)) {
    lines.push(`| ${name} | ${cat.total} | ${cat.errors} | ${cat.no_sources} | ${cat.avg_time}s |`);
  }
  lines.push('');

  // Failed citations
  const failed = citations.filter(c => !c.pass);
  if (failed.length > 0) {
    lines.push('## Failed Citations');
    lines.push('');
    for (const f of failed.slice(0, 20)) {
      lines.push(`- **${f.query}**: ${f.reason}`);
    }
    lines.push('');
  }

  // Failed content
  const failedContent = contents.filter(c => !c.pass);
  if (failedContent.length > 0) {
    lines.push('## Failed Content Checks');
    lines.push('');
    for (const f of failedContent.slice(0, 20)) {
      lines.push(`- **${f.query}**: ${f.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

**- [ ] Step 6: Wire up main flow**

```javascript
function getLatestFile() {
  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort();
  return files.length ? path.join(resultsDir, files[files.length - 1]) : null;
}

// Load queries for reference
const queriesFile = path.join(__dirname, 'queries.json');
const queries = JSON.parse(fs.readFileSync(queriesFile, 'utf8'));
const queryMap = Object.fromEntries(queries.map(q => [q.id, q]));

// Run checks
const citations = data.results.map(r => ({
  ...checkCitation(r, queryMap[r.id] || {}),
  query: r.query,
}));
const contents = data.results.map(r => ({
  ...checkContent(r, queryMap[r.id] || {}),
  query: r.query,
}));

const summary = generateSummary(data);
const report = writeReport(data, summary, citations, contents);

// Save report
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reportFile = path.join(reportsDir, `${timestamp}.md`);
fs.writeFileSync(reportFile, report);
console.log(report);
console.log(`\nReport saved to: ${reportFile}`);
```

---

## Task 4: Integration Test

**- [ ] Step 1: Run the test suite on the live server**

```bash
cd /path/to/project/v5
node eval/run.js
```

Expected: 200 queries run, results saved to `eval/results/`.

**- [ ] Step 2: Generate the report**

```bash
node eval/report.js
```

Expected: Summary printed, report saved to `eval/reports/`.

**- [ ] Step 3: Review results**

Check:
- Citation accuracy > 80%
- Content accuracy > 70%
- No errors
- Avg latency < 10s
- All categories represented

---

## Task 5: Deploy to Server

**- [ ] Step 1: Copy eval scripts to server**

```bash
scp -r eval/ user@YOUR_SERVER:/path/to/AskJoe-V2/eval/
```

**- [ ] Step 2: Run on server**

```bash
ssh user@YOUR_SERVER "cd /path/to/AskJoe-V2 && node eval/run.js"
```

**- [ ] Step 3: Generate report on server**

```bash
ssh user@YOUR_SERVER "cd /path/to/AskJoe-V2 && node eval/report.js"
```

---

*Plan complete. Ready for implementation.*
