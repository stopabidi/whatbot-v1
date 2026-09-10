# WhatBot v1 v5 — vLLM Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace llama-server with vLLM for inference. Eliminate PEG grammar issues. Deploy fine-tuned model with working tool calling.

**Architecture:** vLLM Docker container serves HuggingFace models with native tool calling. rag-api connects via OpenAI-compatible API (same endpoints, different port).

**Tech Stack:** vLLM, Llama 3.1 8B + LoRA adapter (v10), Gemma-4-12B IT QAT, Docker, FastAPI, Node.js bridge

**Spec:** `docs/2026-09-08-status-and-roadmap.md` — status report and roadmap

## Global Constraints

- Server: (your server), RTX 3090 (24GB VRAM)
- vLLM endpoint: `http://localhost:8000/v1` (OpenAI-compatible)
- rag-api: port 8002
- MiMo 2.5 API key: `(set via environment variable)`
- Training data: v7 (2,463), v9 (4,086) at `/path/to/finetune/data/`
- v10 LoRA adapter: `/path/to/finetune/model_v10/`
- Base model: `unsloth/Meta-Llama-3.1-8B-bnb-4bit`
- Demo: Friday

---

## Phase 0: Download Models (P0 — do first)

### Task 0.1: Download Gemma-4-12B IT (HuggingFace format)

**Model:** `google/gemma-4-12B-it-qat-w4a16-ct` — W4A16 safetensors (~6.5GB)
**Location:** `/path/to/homelab/models/gemma-4-12b-it/`

- [ ] **Step 1: Create directory**

```bash
ssh user@server "mkdir -p /path/to/homelab/models/gemma-4-12b-it"
```

- [ ] **Step 2: Download model**

```bash
ssh user@server "huggingface-cli download google/gemma-4-12B-it-qat-w4a16-ct \
  --local-dir /path/to/homelab/models/gemma-4-12b-it \
  --local-dir-use-symlinks False"
```

Or if huggingface-cli isn't installed:
```bash
ssh user@server "pip install huggingface_hub && \
  python3 -c \"from huggingface_hub import snapshot_download; snapshot_download('google/gemma-4-12B-it-qat-w4a16-ct', local_dir='/path/to/homelab/models/gemma-4-12b-it')\""
```

- [ ] **Step 3: Verify download**

```bash
ssh user@server "ls -la /path/to/homelab/models/gemma-4-12b-it/*.safetensors"
```

Expected: ~6-7GB in safetensors files.

### Task 0.2: Download Llama 3.1 8B (HuggingFace format)

**Model:** `unsloth/Meta-Llama-3.1-8B-Instruct` — bnb-4bit (~4.5GB)
**Location:** `/path/to/homelab/models/llama-3.1-8b/`

- [ ] **Step 1: Create directory**

```bash
ssh user@server "mkdir -p /path/to/homelab/models/llama-3.1-8b"
```

- [ ] **Step 2: Download model**

```bash
ssh user@server "python3 -c \"from huggingface_hub import snapshot_download; snapshot_download('unsloth/Meta-Llama-3.1-8B-Instruct', local_dir='/path/to/homelab/models/llama-3.1-8b')\""
```

Note: Requires HuggingFace token for Llama 3.1 (gated model). Set `HF_TOKEN` env var.

- [ ] **Step 3: Verify download**

```bash
ssh user@server "ls -la /path/to/homelab/models/llama-3.1-8b/*.safetensors"
```

**Estimated download time:** ~15-30 min depending on bandwidth.
**Total download:** ~11GB.

---

## Phase 1: Deploy vLLM (After downloads complete)

### Task 1.1: Stop llama-server, start vLLM

**Files:**
- Create: `docker-compose.yml` (rewrite)

**What to do:**

- [ ] **Step 1: Stop existing llama-swap**

```bash
ssh user@server "pkill llama-swap || true"
```

- [ ] **Step 2: Pull vLLM Docker image**

```bash
ssh user@server "docker pull vllm/vllm-openai:latest"
```

- [ ] **Step 3: Start vLLM with Gemma-4-12B**

```bash
ssh user@server "docker run -d \
  --name vllm \
  --gpus all \
  --network host \
  -v /path/to/homelab/models/gemma-4-12b-it:/model \
  vllm/vllm-openai:latest \
  --model /model \
  --dtype half \
  --tool-call-parser hermes \
  --max-model-len 65536 \
  --gpu-memory-utilization 0.60 \
  --port 8000"
```

**Flags explained:**
- `--dtype half` — use FP16 (no AWQ needed, model is already QAT-quantized)
- `--tool-call-parser hermes` — vLLM's tool calling format (Gemma/Llama compatible)
- `--max-model-len 65536` — 64K context (Gemma-4-12B supports 131K)
- `--gpu-memory-utilization 0.60` — 14.4GB for vLLM, leaves 9.6GB for embedding (~500MB) + reranker (~500MB) + headroom

**VRAM budget (RTX 3090, 24GB):**
| Component | VRAM |
|-----------|------|
| vLLM + Gemma-4-12B (60%) | 14.4GB |
| bge-m3 embedding | ~0.5GB |
| bge-reranker-v2-m3 | ~0.5GB |
| rag-api overhead | ~0.3GB |
| **Total** | **~15.7GB** |
| **Headroom** | **~8.3GB** |

- [ ] **Step 4: Verify vLLM is running**

```bash
ssh user@server "curl -s http://localhost:8000/v1/models | python3 -m json.tool"
```

Expected: model name in response.

**Deliverable:** vLLM running with Gemma-4-12B, tool calling available.

---

### Task 1.2: Update rag-api and docker-compose for vLLM

**Files:**
- Modify: `rag-api/config.py` — update LLAMA_SWAP_URL default to port 8000
- Modify: `.env` — update LLAMA_SWAP_URL
- Rewrite: `docker-compose.yml` — vLLM service

**What to do:**

- [ ] **Step 1: Update rag-api config**

In `rag-api/config.py`:
```python
LLAMA_SWAP_URL = os.getenv("LLAMA_SWAP_URL", "http://127.0.0.1:8000")
```

Update `.env`:
```
LLAMA_SWAP_URL=http://127.0.0.1:8000
```

- [ ] **Step 2: Update docker-compose.yml** (see Task 1.2 in plan body)

- [ ] **Step 2: Update docker-compose.yml**

Replace llama-swap service with vLLM:

```yaml
services:
  vllm:
    image: vllm/vllm-openai:latest
    container_name: vllm
    network_mode: host
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    volumes:
      - /path/to/homelab/models:/models
    command: >
      --model google/gemma-4-12B-it-qat-w4a16-ct
      --quantization awq
      --tool-call-parser hermes
      --max-model-len 8192
      --gpu-memory-utilization 0.60
      --port 8000
    restart: unless-stopped

  rag-api:
    build: ./rag-api
    container_name: rag-api
    network_mode: host
    depends_on:
      vllm:
        condition: service_started
    volumes:
      - ./documents:/app/documents
      - ./storage:/app/storage
      - ./chroma_db:/app/chroma_db
      - ./logs:/app/logs
    env_file: .env
    environment:
      - LLAMA_SWAP_URL=http://127.0.0.1:8000
      - EMBED_MODEL_NAME=BAAI/bge-m3
    restart: unless-stopped

  whatbot-v1-bridge:
    build: ./whatbot-v1-bridge
    container_name: whatbot-v1-bridge
    network_mode: host
    depends_on:
      rag-api:
        condition: service_started
    volumes:
      - ./storage:/app/storage
      - ./documents:/app/documents
      - ./logs:/app/logs
    env_file: .env
    environment:
      - RAG_API_URL=http://127.0.0.1:8002
    restart: unless-stopped
```

- [ ] **Step 3: Restart services**

```bash
cd /path/to/WhatBot v1-v5
docker compose up -d
```

- [ ] **Step 4: Test rag-api → vLLM pipeline**

```bash
curl -s -X POST http://localhost:8002/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"question": "What are the 7 layers of consulting?"}'
```

Expected: complete answer with all 7 layers, no errors.

**Deliverable:** rag-api working with vLLM backend.

---

### Task 1.3: Test tool calling

**Files:** None — test only

**What to do:**

- [ ] **Step 1: Test search_documents**

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemma-4-12B-it-qat-w4a16-ct",
    "messages": [{"role": "user", "content": "Search for consulting pricing"}],
    "tools": [{"type": "function", "function": {"name": "search_documents", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
    "tool_choice": "auto"
  }'
```

Expected: tool_calls with `search_documents`, no error.

- [ ] **Step 2: Test send_document**

Same test with both tools.

- [ ] **Step 3: Test on WhatsApp**

Send "What are the 7 layers?" and "Send me the pricing paper."

**Deliverable:** Tool calling working end-to-end.

---

## Phase 2: Deploy Fine-Tuned v10 Model (After Phase 1)

### Task 2.1: Test v10 LoRA on vLLM

**Files:** None — test only

**What to do:**

- [ ] **Step 1: Start vLLM with v10 LoRA**

```bash
docker stop vllm && docker rm vllm

docker run -d \
  --name vllm \
  --gpus all \
  --network host \
  -v /path/to/homelab/models:/models \
  -v /path/to/finetune/model_v10:/adapter \
  vllm/vllm-openai:latest \
  --model unsloth/Meta-Llama-3.1-8B-bnb-4bit \
  --enable-lora \
  --lora-modules v10=/adapter \
  --max-lora-rank 32 \
  --tool-call-parser hermes \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.60 \
  --port 8000
```

- [ ] **Step 2: Test tool calling with v10**

Same tests as Task 1.3.

- [ ] **Step 3: If v10 works, use it. If not, stay with Gemma-4-12B.**

**Deliverable:** v10 LoRA tested on vLLM.

---

## Phase 3: Polish & Demo Prep (Tomorrow)

### Task 3.1: Run 800-query eval

```bash
cd /path/to/finetune/eval
python run_800_deployed.py --model vllm
```

### Task 3.2: Fix any remaining issues

Based on eval results.

### Task 3.3: Final smoke test

WhatsApp test: Hello, 7 layers, tell me more, send paper, edge cases.

### Task 3.4: Demo prep

- Verify all services running
- Test on multiple devices
- Prepare demo script

---

## Rollback Plan

If vLLM crashes or OOMs:
1. `pkill -9 -f vllm` (kill vLLM process)
2. `docker start rag-api-v2 whatbot-v1-bridge-v2` (restart containers)
3. Reduce GPU: re-start vLLM with `--gpu-memory-utilization 0.60`
4. Verify WhatsApp works

If vLLM fundamentally doesn't work:
1. `pkill -9 -f vllm`
2. Set `LLAMA_SWAP_URL=http://127.0.0.1:8080` (point back to llama-swap port)
3. `pkill llama-swap; llama-swap` (restart llama-swap with Gemma-4-12B)
4. `docker start rag-api-v2 whatbot-v1-bridge-v2`
5. This restores the pre-vLLM state

The rollback restores the LIVE working state, not a downgrade.

---

*Plan created: 9 Sep 2026*
*Demo: Friday*
