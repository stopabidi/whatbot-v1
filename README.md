# WhatBot v2 V5

WhatsApp-based RAG bot for querying consulting research.

## Architecture

```
WhatsApp (Twilio) → whatbot-v2-bridge (Node.js) → rag-api (FastAPI) → vLLM (Gemma-4-12B) → ChromaDB
```

## Quick Start

1. Copy `.env.example` to `.env` and fill in your values
2. `docker compose up --build -d`
3. Open dashboard at `http://localhost:3000`
4. Enter your `DASHBOARD_API_KEY` when prompted
5. Message the WhatsApp number — you'll get a pending code
6. Approve yourself in the dashboard

## Services

| Service | Port | Description |
|---------|------|-------------|
| `rag-api` | 8002 | RAG API (FastAPI + ChromaDB + embeddings) |
| `whatbot-v2-bridge` | 3000 | WhatsApp webhook + dashboard |
| `vllm` | 8000 | LLM inference (Gemma-4-12B) |

## Environment Variables

See `.env.example` for all required variables.

## Features

- **Tool calling** — LLM decides when to search documents
- **Pre-search** — Forces search for all research queries
- **Markdown converter** — Headings and bullets format cleanly for WhatsApp
- **File sending** — Resolves follow-up references ("send me that")
- **Web chat** — Dashboard chat interface with persistent conversations
- **Conversation context** — Follow-ups work without re-searching

## Eval

```bash
# Run 200-query eval
node eval/run.js

# Run 300-query heavy eval
node eval/run.js --queries=eval/queries-heavy.json

# Generate report
node eval/report.js
```

## Documentation

- `STATUS_REPORT.md` — Full system status and metrics
- `qa/WHATSAPP_QA_GUIDE.md` — Manual QA test cases
- `plans/` — Design specs and implementation plans

## License

Private — consulting research.
