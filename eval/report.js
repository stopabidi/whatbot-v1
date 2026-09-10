#!/usr/bin/env node
// eval/report.js — AskJoe V5 Eval Report Generator

const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, 'results');
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

// Get latest results file or accept CLI arg
function getLatestFile() {
  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort();
  return files.length ? path.join(resultsDir, files[files.length - 1]) : null;
}

const resultsFile = process.argv[2] || getLatestFile();
if (!resultsFile) {
  console.error('Usage: node report.js [results-file.json]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));

// Load queries for reference
const queriesFile = path.join(__dirname, 'queries.json');
const queries = JSON.parse(fs.readFileSync(queriesFile, 'utf8'));
const queryMap = Object.fromEntries(queries.map(q => [q.id, q]));

// ---- Citation checker ----

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

// ---- Content checker ----

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

// ---- Summary generator ----

function generateSummary(data) {
  const results = data.results;
  const byCategory = {};

  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, errors: 0, no_sources: 0, times: [] };
    }
    const cat = byCategory[r.category];
    cat.total++;
    if (r.error) cat.errors++;
    if (r.sources.length === 0) cat.no_sources++;
    cat.times.push(r.response_time);
  }

  for (const cat of Object.values(byCategory)) {
    cat.avg_time = (cat.times.reduce((a, b) => a + b, 0) / cat.times.length).toFixed(1);
    delete cat.times;
  }

  return {
    total: results.length,
    errors: results.filter(r => r.error).length,
    avg_time: (results.reduce((a, r) => a + r.response_time, 0) / results.length).toFixed(1),
    by_category: byCategory,
  };
}

// ---- Markdown report writer ----

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
  const citTotal = citations.length || 1;
  lines.push('## Citation Accuracy');
  lines.push('');
  lines.push(`**${citPass}/${citations.length}** queries returned expected source (${(citPass / citTotal * 100).toFixed(1)}%)`);
  lines.push('');

  // Content accuracy
  const conPass = contents.filter(c => c.pass).length;
  const conTotal = contents.length || 1;
  lines.push('## Content Accuracy');
  lines.push('');
  lines.push(`**${conPass}/${contents.length}** queries had expected topics in answer (${(conPass / conTotal * 100).toFixed(1)}%)`);
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

// ---- Main ----

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
