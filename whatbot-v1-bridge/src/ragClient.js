import axios from 'axios';
import { config } from './config.js';

const client = axios.create({
  baseURL: config.ragApiUrl,
  timeout: 120_000,
  headers: {
    'Authorization': `Bearer ${config.ragApiKey}`,
  },
});

client.interceptors.response.use(null, async (error) => {
  const isIdempotent = error.config?.method === 'get' || error.config?.url === '/reload';
  if (isIdempotent && (error.code === 'ECONNABORTED' || error.response?.status >= 500)) {
    await new Promise(r => setTimeout(r, 2000));
    return client.request(error.config);
  }
  throw error;
});

export async function queryRag(question, history = []) {
  const { data } = await client.post('/query', { question, conversation_history: history });
  return data;
}

export async function ingestDocument(filePath) {
  const { data } = await client.post('/ingest', { file_path: filePath });
  return data;
}

export async function reloadIndex() {
  const { data } = await client.post('/reload');
  return data;
}

const statusClient = axios.create({
  baseURL: config.ragApiUrl,
  timeout: 3_000,
  headers: { 'Authorization': `Bearer ${config.ragApiKey}` },
});

export async function reingest() {
  const { data } = await client.post('/reingest');
  return data;
}

export async function reingestStatus() {
  const { data } = await statusClient.get('/reingest/status');
  return data;
}
