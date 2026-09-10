import fs from 'fs';
import path from 'path';
import { config } from './config.js';

function ensureDirs() {
  if (!fs.existsSync(config.storageDir)) {
    fs.mkdirSync(config.storageDir, { recursive: true });
  }
}

export function loadJson(file) {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveJson(file, data) {
  ensureDirs();
  const tmpFile = file + '.tmp';
  const serialized = JSON.stringify(data, null, 2);
  
  // Only log in debug mode
  if (process.env.DEBUG_PERSISTENCE === 'true') {
    console.log(`[PERSISTENCE] Writing to ${file}: ${serialized.substring(0, 100)}...`);
  }
  
  try {
    fs.writeFileSync(tmpFile, serialized);
    fs.renameSync(tmpFile, file);
    
    if (process.env.DEBUG_PERSISTENCE === 'true') {
      const readback = fs.readFileSync(file, 'utf8');
      console.log(`[PERSISTENCE] Verify read: ${readback.substring(0, 100)}...`);
      if (readback !== serialized) {
        console.error(`[PERSISTENCE] MISMATCH! Written ${serialized.length} bytes, read ${readback.length} bytes`);
      }
    }
  } catch (err) {
    console.error(`[PERSISTENCE] Write failed for ${file}:`, err.message);
    try {
      fs.writeFileSync(file, serialized);
      console.log(`[PERSISTENCE] Fallback direct write succeeded for ${file}`);
    } catch (e) {
      console.error(`[PERSISTENCE] Fallback write also failed:`, e.message);
    }
  }
}
