# WhatBot v1 V5 — Status Report

**Date:** 10 Sep 2026
**Status:** ✅ Stable and deployed
**Model:** Gemma-4-12B IT QAT (W4A16) via vLLM

---

## Executive Summary

WhatBot v1 V5 is a WhatsApp-based RAG bot for querying [CLIENT]'s consulting research. The system uses vLLM for inference, Gemma-4-12B for responses, and ChromaDB + bge-m3 for document retrieval. All services are healthy, tool calling works, and the 800-query eval passes targets.

---

## Architecture

```
WhatsApp (Twilio) → whatbot-v1-bridge (Node.js, port 3000)
                          ↓
                    rag-api (Python/FastAPI, port 8002)
                          ↓
                    vLLM (Gemma-4-12B, port 8000)
                          ↓
                    ChromaDB (bge-m3 embeddings + bge-reranker)
```

| Component | Technology | Port | Status |
|-----------|-----------|------|--------|
| WhatsApp bridge | Node.js + Express | 3000 | ✅ Running |
| RAG API | Python + FastAPI | 8002 | ✅ Healthy |
| LLM inference | vLLM (Docker) | 8000 | ✅ Running |
| Vector DB | ChromaDB | embedded | ✅ 2,381 chunks |
| Embedding | BAAI/bge-m3 | GPU | ✅ Running |
| Reranker | BAAI/bge-reranker-v2-m3 | GPU | ✅ Running |
| WhatsApp | Twilio | cloud | ✅ Connected |

---

## Server Configuration

| Setting | Value |
|---------|-------|
| Hostname | (server) |
| GPU | NVIDIA RTX 3090 (24GB VRAM) |
| VRAM used | 20.9GB / 24GB (87%) |
| Model | google/gemma-4-12b-it-qat-w4a16-ct |
| Max context | 65,536 tokens |
| Tool parser | gemma4 |
| Disk | 11GB free (98% used) |

---

## Eval Results (800-query, vLLM)

| Metric | OV3 baseline | V5 (vLLM) | Change |
|--------|-------------|-----------|--------|
| Empty answers | 192 (24%) | **0** | ✅ -100% |
| Refusals | 87 (11%) | **58 (7.25%)** | ✅ -33% |
| Has answer | 642 (80%) | **742 (93%)** | ✅ +16% |
| Joe attributions | — | **2 (0.25%)** | ✅ Effectively zero |
| Source attributions | 144 (18%) | **116 (14.5%)** | Post-filter catches |
| Errors | 0 | **0** | ✅ |
| Tool calls working | ❌ | **✅** | ✅ Fixed |
| Avg latency | 9.1s | **3.5s** | ✅ 2.6x faster |

---

## What Works

- ✅ **Tool calling** — search_documents and send_document work reliably
- ✅ **Zero errors** — 800 queries, 0 server errors
- ✅ **Zero empty answers** — every query gets a response
- ✅ **3.5s latency** — fast enough for WhatsApp
- ✅ **Thinking tags stripped** — `<|channel>` tags removed from answers
- ✅ **Bullet points** — render correctly in WhatsApp
- ✅ **Conversation context** — follow-ups work without re-searching
- ✅ **Refusals** — correctly blocks adversarial/out-of-scope queries
- ✅ **File sending** — send_document tool works when explicitly asked
- ✅ **Markdown → WhatsApp converter** — headings, bullets, bold all convert properly
- ✅ **Greeting handler** — brief greetings without "professional services" leak

---

## Markdown → WhatsApp Converter (NEW)

### What it does

The LLM outputs Markdown. WhatsApp doesn't render Markdown. The `_markdown_to_whatsapp()` function in `rag.py` converts LLM output to WhatsApp-compatible formatting.

### Pipeline

```
LLM Output (Markdown) → _strip_attribution() → _markdown_to_whatsapp() → WhatsApp
```

### Conversion Rules

| Step | Input | Output | Purpose |
|------|-------|--------|---------|
| Headings (pass 1) | `text. ## Heading body` | `text.\n## Heading body` | Ensure newline before headings |
| Headings (pass 2) | `## Heading body text\n` | `Heading\nbody text\n` | Split heading from inline body text |
| Headings (pass 3) | `## Heading` | `Heading` | Strip `#` markers, keep plain text |
| Bold | `**text**`, `**text*`, `*text:**` | `text` | Strip all `*` markers (LLM output too inconsistent to convert) |
| Bullets | `They are: • Text` | `They are:\n• Text` | Force `\n` before every bullet |
| Cleanup | `\n\n\n` | `\n\n` | Max 2 consecutive newlines |

### Why strip bold instead of converting?

The LLM outputs malformed bold markers:
- `**text**` (correct) — should convert to `*text*` for WhatsApp
- `**text*` (missing closing `*`) — regex can't reliably match
- `*text:**` (extra colon, wrong markers) — regex can't reliably match

Attempting to convert these with regex produces garbled output (e.g., `\u0001` control characters). Stripping all `*` is the lazy, reliable solution. Headings and bullets are the priority; bold is cosmetic.

### Files touched

| File | Change |
|------|--------|
| `rag-api/rag.py` | `_markdown_to_whatsapp()` function (~25 lines) |
| `rag-api/rag.py` | Simplified prompt — uses `## headings` and `• bullets` |
| `rag-api/rag.py` | Applied in both return paths (normal + max-iterations fallback) |

### Prompt changes

**Before:**
```
Plain English. Short sentences. Bullets where suitable — start a new line with • for EVERY bullet, including the first one. Never put a bullet inline after introductory text like "They are:". Each bullet must begin on its own line.
```

**After:**
```
Plain English. Short sentences. Bullets where suitable (use • for bullets, numbered lists for steps). Use Markdown headings (## Section Name) to separate sections.
```

The converter handles formatting — no need for fragile prompt instructions.

---

## What Needs Attention

- ⚠️ **Source attributions (116)** — model says "based on" or "the document" despite prompt. Post-filter catches these at runtime. Real-world attribution reaching users: ~0.
- ⚠️ **Refusals (58)** — 7.25% refusal rate. Model is conservative but safe. Most are legitimate.
- ⚠️ **Disk space** — 11GB free (98% used). Docker images are large (vLLM: 30.5GB).
- ⚠️ **VRAM tight** — 20.9GB / 24GB used. No room for additional models.
- ⚠️ **Extra blank lines between bullets** — cosmetic. LLM outputs `\n\n•` instead of `\n•`. Can be cleaned up if needed.
- ⚠️ **Bold stripped** — WhatsApp won't show bold text. Cosmetic only.

---

## Files

### Code (local: `v5/`)

| File | Purpose |
|------|---------|
| `rag-api/rag.py` | Core RAG logic (tool calling, search, attribution strip, markdown converter) |
| `rag-api/app.py` | FastAPI endpoints (query, ingest, health) |
| `rag-api/config.py` | Configuration (env vars, defaults) |
| `rag-api/ingest.py` | Document ingestion (LlamaIndex + ChromaDB) |
| `rag-api/reingest.py` | Full reindex trigger |
| `rag-api/Dockerfile` | Container build |
| `whatbot-v1-bridge/src/server.js` | Express server, dashboard, API routes |
| `whatbot-v1-bridge/src/messageHandler.js` | WhatsApp message handling |
| `whatbot-v1-bridge/src/ragClient.js` | RAG API client |
| `whatbot-v1-bridge/src/chatStore.js` | Persistent chat storage (JSON file) |
| `whatbot-v1-bridge/src/chatRoutes.js` | Chat API routes |
| `whatbot-v1-bridge/src/config.js` | Bridge configuration |
| `whatbot-v1-bridge/src/healthCheck.js` | Service health checks |
| `whatbot-v1-bridge/public/index.html` | Dashboard UI (includes Chat tab) |
| `docker-compose.yml` | Service orchestration |
| `.env.example` | Environment variables template |
| `plans/webchat-design.md` | Webchat feature design spec |

### Server

| Path | Purpose |
|------|---------|
| `/path/to/WhatBot v1-V2/` | Main deployment directory |
| `/path/to/models/gemma-4-12b-it/` | Gemma-4-12B model (HuggingFace format) |
| `/path/to/finetune/data/v7/` | v7 training data (2,463 examples) |
| `/path/to/finetune/data/v9/` | v9 training data (4,086 examples) |
| `/path/to/finetune/model_v10/` | v10 LoRA adapter (not deployed) |

---

## Key Decisions Made

1. **vLLM over llama-server** — PEG grammar in llama-server is incompatible with fine-tuned models. vLLM handles tool calling natively.
2. **Gemma-4-12B IT QAT over Llama 3.1 8B** — Gemma works out of the box, no fine-tuning needed. Llama 3.1 fine-tune had PEG grammar issues.
3. **No AWQ needed** — Model is already QAT-quantized. vLLM loads with `--dtype half`.
4. **Prompt engineering over fine-tuning** — System prompt handles attribution, style, tool usage. Fine-tuning reserved for future if needed.
5. **Markdown → WhatsApp converter** — Post-processing conversion instead of fragile prompt instructions. Handles headings, bullets, bold in one pass.
6. **Strip bold instead of convert** — LLM output too inconsistent for reliable bold conversion. Headings and bullets are the priority.

---

## Deployment Commands

```bash
# Start services
cd /path/to/WhatBot v1-V2
docker compose up -d

# Check health
curl http://localhost:3000/health

# Test query
curl -X POST http://localhost:8002/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"question": "What are the 7 layers?"}'

# Restart specific service
docker restart rag-api
docker restart whatbot-v1-bridge
docker restart vllm
```

---

## Backups

Local backups exist at:
- `rag-api.bak/` — pre-converter rag-api code
- `whatbot-v1-bridge.bak/` — pre-chat whatbot-v1-bridge code

---

## Next Steps

1. **QA remaining tests** — Complete the WhatsApp QA guide
2. **Extra blank lines** — Clean up `\n\n` between bullets (cosmetic)
3. **Bold rendering** — Investigate reliable WhatsApp bold conversion if needed
4. **Monitoring** — Set up metrics logging and alerts
5. **Conversation quality testing** — 50 multi-turn test conversations

---

*Report generated: 10 Sep 2026*
*System verified: all services healthy, markdown converter deployed*
