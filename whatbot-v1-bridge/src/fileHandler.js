import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.pptx', '.ppt', '.png', '.jpg', '.jpeg'];

export function findDocument(query) {
  const docsDir = config.documentsDir;
  const lower = query.toLowerCase();

  // Search recursively through all subdirectories
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (ALLOWED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        const relPath = path.relative(docsDir, fullPath);
        matches.push({ name: entry.name, relPath, fullPath });
      }
    }
  }
  walk(docsDir);

  // Exact filename match (case-insensitive)
  const exact = matches.find(m => m.name.toLowerCase() === lower);
  if (exact) return exact.fullPath;

  // Partial match on filename
  const partial = matches.find(m => m.name.toLowerCase().includes(lower));
  if (partial) return partial.fullPath;

  // Partial match on full relative path (e.g., "pricing/paper_name")
  const pathMatch = matches.find(m => m.relPath.toLowerCase().includes(lower));
  if (pathMatch) return pathMatch.fullPath;

  return null;
}

export function listLocalDocuments() {
  const docsDir = config.documentsDir;
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (ALLOWED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(docsDir, fullPath));
      }
    }
  }
  walk(docsDir);
  return files;
}
