# V10 GGUF Re-Export Fix — Builder Instructions

## Problem

V10 was trained successfully but the GGUF export used Unsloth's `get_chat_template("llama-3.1")` which injects a chat template that produces a different tool-call format than what llama-server's PEG grammar expects. The model generates Unsloth's format → PEG grammar rejects it → 500 errors.

**The E4B model works** because it uses `--chat-template-file /path/to/homelab/llama3.1-chat-template.jinja` which overrides the embedded template. V10 needs the same treatment, but the GGUF must NOT have Unsloth's template embedded.

## What's already done

- ✅ v10 model trained (LoRA adapter at `/path/to/finetune/model_v10/`)
- ✅ v10 GGUF exists but with wrong template (`/path/to/finetune/gguf_v10/`)
- ❌ GGUF has Unsloth's template embedded → PEG grammar fails

## What needs to happen

Re-export the GGUF using the **raw tokenizer** (no `get_chat_template()` call). Same trained weights, different export format.

---

## Step 1: Re-export GGUF with raw tokenizer

Run on server:

```bash
python3 << 'EOF'
import os
from unsloth import FastLanguageModel

print("Loading v10 model...")
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="/path/to/finetune/model_v10",
    max_seq_length=4096,
    load_in_4bit=True,
)

# DO NOT call get_chat_template() — use raw tokenizer
# The GGUF won't have an embedded template
# --chat-template-file at serve time handles all formatting

print("Exporting to GGUF (raw tokenizer, no template injection)...")
GGUF_DIR = "/path/to/finetune/gguf_v10_raw"
os.makedirs(GGUF_DIR, exist_ok=True)

model.save_pretrained_gguf(
    GGUF_DIR,
    tokenizer,
    quantization_method="q4_k_m",
)

print(f"Done! Saved to {GGUF_DIR}")
EOF
```

**Expected time:** ~10-15 minutes

**Verify:**
```bash
ls -la /path/to/finetune/gguf_v10_raw/
# Should contain: Meta-Llama-3.1-8B.Q4_K_M.gguf (~4.9GB)
```

---

## Step 2: Fix eos_token_id

The raw export sets eos_token_id to 128001 (`<|end_of_text|>`). PEG grammar expects 128009 (`<|eot_id|>`).

```bash
python3 << 'EOF'
import struct, shutil

GGUF = "/path/to/finetune/gguf_v10_raw/Meta-Llama-3.1-8B.Q4_K_M.gguf"
BACKUP = GGUF + ".bak"

shutil.copy2(GGUF, BACKUP)

with open(GGUF, "rb") as f:
    data = bytearray(f.read())

idx = data.find(b"tokenizer.ggml.eos_token_id")
if idx == -1:
    print("ERROR: eos_token_id not found")
    exit(1)

val_off = idx + len(b"tokenizer.ggml.eos_token_id") + 4
old = struct.unpack_from("<I", data, val_off)[0]
print(f"Old eos_token_id: {old}")

struct.pack_into("<I", data, val_off, 128009)

new = struct.unpack_from("<I", data, val_off)[0]
print(f"New eos_token_id: {new}")

with open(GGUF, "wb") as f:
    f.write(data)

print("Patched!")
EOF
```

**Verify:**
```bash
python3 -c "
import struct
with open('/path/to/finetune/gguf_v10_raw/Meta-Llama-3.1-8B.Q4_K_M.gguf', 'rb') as f:
    data = f.read()
idx = data.find(b'tokenizer.ggml.eos_token_id')
val = struct.unpack_from('<I', data, idx + len(b'tokenizer.ggml.eos_token_id') + 4)[0]
print(f'eos_token_id: {val} (should be 128009)')
"
```

---

## Step 3: Copy to models directory

```bash
cp /path/to/finetune/gguf_v10_raw/Meta-Llama-3.1-8B.Q4_K_M.gguf /path/to/models/whatbot-v1-v10.gguf
```

---

## Step 4: Add to llama-swap config

Edit `/path/to/homelab/llama-swap-config.yaml` and add:

```yaml
  WhatBot v1 V10:
    aliases:
    - whatbot-v1-v10
    capabilities:
      context: 32768
      in:
      - text
      out:
      - text
      tools: true
    cmd: "${llama_server} --port ${PORT} --model /path/to/models/whatbot-v1-v10.gguf --chat-template-file /path/to/homelab/llama3.1-chat-template.jinja --ctx-size 32768 --parallel 4 -fa on -ctk q8_0 -ctv q8_0 -t 4 --temp 0.6 --min-p 0.0 -b 2048 -ub 2048 --n-gpu-layers 99"
    name: WhatBot v1 V10 (Llama-3.1-8B Fine-tuned)
    ttl: 300
```

**Key:** The `--chat-template-file` flag is what makes this work. It overrides any embedded template.

---

## Step 5: Restart llama-swap

```bash
pkill llama-swap
# Restart however llama-swap is started on this server
```

---

## Step 6: Test plain text (no tools)

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "whatbot-v1-v10",
    "messages": [{"role": "user", "content": "Hello"}],
    "temperature": 0.1,
    "max_tokens": 50
  }'
```

Expected: non-empty content, no error.

---

## Step 7: Test tool calling

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "whatbot-v1-v10",
    "messages": [{"role": "user", "content": "Search for consulting pricing"}],
    "tools": [{"type": "function", "function": {"name": "search_documents", "description": "Search documents", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
    "tool_choice": "auto",
    "temperature": 0.1,
    "max_tokens": 200
  }'
```

Expected: tool_calls array with `search_documents`, no error. Response should look like:
```json
{
  "tool_calls": [{
    "type": "function",
    "function": {
      "name": "search_documents",
      "arguments": "{\"query\": \"consulting pricing\"}"
    }
  }]
}
```

**If this fails:** The GGUF still has the wrong format. Check that `get_chat_template()` was NOT called during export. Check that `--chat-template-file` is in the llama-swap config.

---

## Step 8: Test send_document

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "whatbot-v1-v10",
    "messages": [{"role": "user", "content": "Send me the pricing paper"}],
    "tools": [
      {"type": "function", "function": {"name": "search_documents", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
      {"type": "function", "function": {"name": "send_document", "description": "Send a file", "parameters": {"type": "object", "properties": {"filename": {"type": "string"}}, "required": ["filename"]}}}
    ],
    "tool_choice": "auto",
    "temperature": 0.1,
    "max_tokens": 200
  }'
```

Expected: tool_calls with `send_document` (may also call search first — that's OK).

---

## Step 9: Deploy to rag-api

Update `.env` or rag-api config to use `whatbot-v1-v10`:

```bash
# In the rag-api container, update LLAMA_MODEL or equivalent
docker compose restart rag-api
```

---

## Step 10: Smoke test on WhatsApp

Send:
1. "Hello" — greeting
2. "What are the 7 layers?" — should return all 7
3. "Send me the pricing paper" — should trigger send_document

---

## Troubleshooting

### If plain text works but tools fail:
- The PEG grammar isn't configured for v10
- Check `--chat-template-file` is in the llama-swap config
- Check the template file exists at `/path/to/homelab/llama3.1-chat-template.jinja`

### If everything fails with 500 errors:
- The GGUF might still have Unsloth's template
- Re-export with the raw tokenizer script (Step 1)
- Verify no `get_chat_template()` call in the export

### If tools work but format is wrong:
- Check the tool_calls response format
- Should be `{"name": "...", "parameters": {...}}` (not `"arguments"`)
- If it shows `"arguments"`, the template isn't being applied

---

*Plan created: 9 Sep 2026*
