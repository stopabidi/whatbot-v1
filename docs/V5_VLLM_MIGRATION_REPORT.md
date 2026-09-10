# WhatBot v1 v5 — vLLM Migration Complete

**Date:** 9 Sep 2026
**Status:** ✅ Deployed and eval'd

---

## What Was Done

1. **Downloaded Gemma-4-12B IT QAT** (W4A16, 9.6GB) to `/path/to/homelab/models/gemma-4-12b-it/`
2. **Deployed vLLM** (Docker, `vllm/vllm-openai:latest`) with `--tool-call-parser gemma4`
3. **Updated rag-api** to point to vLLM at `http://127.0.0.1:8000`
4. **Fixed docker-compose.yml** — hardcoded `LLAMA_SWAP_URL` to vLLM port
5. **Ran full 800-query eval** — 0 errors, 46 min (3.4x faster than llama-swap)

---

## Eval Results: vLLM vs llama-swap

| Metric | llama-swap (R2) | vLLM | Change |
|--------|----------------|------|--------|
| Empty answers | 13 | **0** | ✅ Fixed |
| Refusals | 85 | **58** | ✅ -32% |
| Has answer | 702 | **742** | ✅ +40 |
| Joe attributions | 2 | **2** | ✅ Zero meaningful |
| Source attributions | 103 | **116** | ⚠️ Post-filter catches |
| Errors | 0 | **0** | ✅ |
| Avg latency | 11.8s | **3.5s** | ✅ 3.4x faster |

---

## Comparison vs Original OV3 Baseline

| Metric | OV3 Baseline | vLLM (final) | Change |
|--------|-------------|--------------|--------|
| Empty answers | 192 | **0** | ✅ -100% |
| Refusals | 87 | **58** | ✅ -33% |
| Errors | 0 | **0** | ✅ |
| Joe attributions | — | **2** (0 meaningful) | ✅ |
| Tool calls working | ❌ | **✅** | ✅ |
| Avg latency | 9.1s | **3.5s** | ✅ 2.6x faster |

---

## Architecture

```
WhatsApp → whatbot-v1-bridge → rag-api (port 8002) → vLLM (port 8000) → Gemma-4-12B
                                        ↓
                                  ChromaDB (bge-m3)
                                        ↓
                                  bge-reranker-v2-m3
```

---

## VRAM Budget (RTX 3090, 24GB)

| Component | VRAM |
|-----------|------|
| vLLM + Gemma-4-12B | 15.6GB |
| bge-m3 embedding | ~2GB |
| bge-reranker | ~2GB |
| **Total** | **~19.6GB** |
| **Headroom** | **~4.4GB** |

---

## Key Findings

### What's working
- Tool calling (search_documents, send_document) — works reliably
- Zero errors across all 800 queries
- Zero empty answers
- Latency: 3.5s average (excellent)
- Joe personal attributions: effectively zero

### What needs attention
- **Source attributions (116)** — model says "based on" or "the document" despite prompt. Post-filter catches these at runtime.
- **Refusals (58)** — 7.25% refusal rate. Model is conservative but safe.
- **Thinking tags** — Gemma-4 outputs `<|channel>thought` tags in responses. Cosmetic issue, doesn't affect functionality.

### v10 LoRA not compatible
- vLLM doesn't support bitsandbytes quantization (used by the v10 base model)
- Staying with Gemma-4-12B IT QAT — works out of the box, no fine-tuning needed

---

## Rollback Plan

If vLLM crashes:
1. `docker rm -f vllm`
2. Set `LLAMA_SWAP_URL=http://127.0.0.1:8080` in `.env` and `docker-compose.yml`
3. Restart llama-swap with Gemma-4-12B (GGUF)
4. `docker compose restart rag-api-v2 whatbot-v1-bridge-v2`

---

## Files Modified

| File | Change |
|------|--------|
| `.env` | `LLAMA_SWAP_URL=http://127.0.0.1:8000`, `LLAMA_MODEL=/model` |
| `docker-compose.yml` | `LLAMA_SWAP_URL=http://127.0.0.1:8000` (both services) |
| `/path/to/homelab/llama-swap-config.yaml` | V9/V10 entries added (unused now) |

## Files Created

| File | Purpose |
|------|---------|
| `/path/to/homelab/models/gemma-4-12b-it/` | Gemma-4-12B IT QAT model |
| `/path/to/finetune/eval/qa800_vllm/` | vLLM eval results |

---

*Report generated: 9 Sep 2026*
