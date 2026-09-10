# WhatBot v1 OV3

Document RAG AI bot for querying Joe O'Mahoney's published work via WhatsApp.

## Architecture

```
WhatsApp (Twilio) → whatbot-v1-bridge (Node.js) → rag-api (Python/FastAPI) → ChromaDB + llama-swap
Dashboard (HTML) → whatbot-v1-bridge API → rag-api
```

**OV3 = Tool-Calling Architecture.** The LLM decides when to search. RAG is a tool, not the driver.

## Services

| Service | Port | Description |
|---------|------|-------------|
| `rag-api` | 8002 | RAG API (FastAPI + ChromaDB + embeddings) |
| `whatbot-v1-bridge` | 3000 | WhatsApp webhook + dashboard |

## Setup

1. Copy `.env.example` to `.env` and fill in your values
2. `docker compose up --build -d`
3. Open dashboard at `http://localhost:3000`
4. Enter your `DASHBOARD_API_KEY` when prompted
5. Add your phone number via the Allowlist tab
6. Message the WhatsApp number — you'll get a pending code
7. Approve yourself in the dashboard
8. Start querying

## Environment Variables

See `.env` for all required variables.

## Key Changes (OV3)

- **Tool-calling architecture**: LLM uses `search_documents` and `send_document` tools
- **bge-m3 embeddings**: Better multilingual and semantic understanding
- **bge-reranker-v2-m3**: Improved reranking accuracy
- **Joe's writing style**: System prompt incorporates Joe's voice
- **No CRITICAL RULES**: Natural conversation, not rigid pipeline
