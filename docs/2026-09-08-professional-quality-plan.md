# WhatBot v1 Professional Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship WhatBot v1 to professional quality — natural conversations, zero attribution, working file sending, Joe's voice.

**Architecture:** Ship prompt-tuned Gemma-4-12B today (Phase 1). Fine-tune Llama 3.1 8B in background with combined v7+v9 data (Phase 2). Polish and harden next week (Phase 3).

**Tech Stack:** Python 3.12, Unsloth, Llama 3.1 8B (bnb-4bit), Gemma-4-12B IT QAT, MiMo 2.5 (teacher API), ChromaDB, FastAPI, Node.js bridge, llama-server with PEG grammar

**Spec:** `plans/2026-09-08-status-and-roadmap.md` — contains status report, roadmap, decision points, and success criteria

## Global Constraints

- Server: RTX 3090 (24GB VRAM)
- RAG API: port 8002, embedding model BAAI/bge-m3
- llama-swap config: `/path/to/homelab/llama-swap-config.yaml`
- Custom chat template: `/path/to/homelab/llama3.1-chat-template.jinja`
- MiMo 2.5 API key: (set via environment variable)
- Training data locations: v7 (`/path/to/finetune/data/v7/`), v9 (`/path/to/finetune/data/v9/`)
- PEG grammar format: `{"name": "...", "parameters": {...}}` (not `"arguments"`)
- EOS token for GGUF: 128009 (`<|eot_id|>`, not 128001)

---

## Phase 1: Prompt Tune & Ship (Today)

### Task 1.1: Complete 800-query eval

**Files:**
- Read: `/path/to/finetune/eval/qa800_deployed/eval.log`
- Read: `/path/to/finetune/eval/qa800_deployed/results/*.json`

**What to do:**
- The eval was stopped at 310/800. Resume or re-run to completion.
- Use the updated `rag.py` (new system prompt, tool descriptions, minimal regex).

- [ ] **Step 1: Check if eval can be resumed**

Run on server:
```bash
ls /path/to/finetune/eval/qa800_deployed/results/ | wc -l
```
If <800, re-run the eval script.

- [ ] **Step 2: Run full eval**

```bash
cd /path/to/finetune/eval
python run_800_deployed.py 2>&1 | tee eval_full.log
```

- [ ] **Step 3: Record baseline metrics**

Run the analysis script on results:
```bash
python3 /tmp/review_gemma2.py  # (already on server from earlier)
```

Record in the eval report:
- Total queries, empty answers, attribution count, refusal count, send_file count, avg latency

**Deliverable:** Complete 800-query eval with baseline metrics.

---

### Task 1.2: Analyze eval failures

**Files:**
- Read: `/path/to/finetune/eval/qa800_deployed/results/*.json`

**What to do:**
Categorize every failure to understand root causes.

- [ ] **Step 1: Write failure analysis script**

```python
#!/usr/bin/env python3
"""Analyze eval failures for prompt tuning."""
import json, os, re

results_dir = '/path/to/finetune/eval/qa800_deployed/results/'
files = sorted([f for f in os.listdir(results_dir) if f.endswith('.json')])

failures = {"refusal": [], "attribution": [], "empty": [], "no_send_file": []}

attr_pats = [r'(?i)\baccording to\b', r'(?i)\bbased on\b', r'(?i)\bthe search results\b',
             r'(?i)\bthe document\b', r'(?i)\bthe provided\b', r'(?i)\bI found\b']

for f in files:
    with open(os.path.join(results_dir, f)) as fh:
        d = json.load(fh)
    ans = d.get('answer', '')
    q = d.get('query', '')
    cat = d.get('category', '')

    if not ans or len(ans) <= 10:
        failures['empty'].append({'q': q, 'cat': cat, 'a': ans})
    elif any(re.search(p, ans) for p in attr_pats):
        failures['attribution'].append({'q': q, 'cat': cat, 'a': ans[:200]})
    elif 'don' in ans and 'information' in ans:
        failures['refusal'].append({'q': q, 'cat': cat, 'a': ans[:200]})

    # Check if query asked for a file but no send_file
    file_words = ['send', 'download', 'share', 'paper', 'document', 'file']
    if any(w in q.lower() for w in file_words) and not d.get('offer_file'):
        failures['no_send_file'].append({'q': q, 'cat': cat})

for category, items in failures.items():
    print(f"\n=== {category.upper()} ({len(items)}) ===")
    for item in items[:5]:
        print(f"  Q: {item['q'][:80]}")
        if 'a' in item:
            print(f"  A: {item['a'][:150]}")
        print()
```

- [ ] **Step 2: Run analysis**

```bash
python3 /tmp/analyze_failures.py
```

- [ ] **Step 3: Categorize refusal root causes**

For each refusal, determine:
- Legitimate (query truly unrelated to consulting): keep as-is
- Missed opportunity (query related but model refused): fix with prompt
- Vague query (unclear what user wants): fix with clarification prompt

**Deliverable:** Failure breakdown with root causes for each category.

---

### Task 1.3: Fix send_document (0 triggers)

**Files:**
- Modify: `rag-api/rag.py` — SYSTEM_PROMPT and tool descriptions

**What to do:**
The model never calls `send_document`. Fix by making the instruction unmissable.

- [ ] **Step 1: Test send_document directly**

Run 10 file-request queries through the API:
```bash
for q in "Send me the pricing paper" "Can you share the exit guide" "I'd like the delegation ebook" "Send the M&A playbook" "Download the competence framework"; do
  echo "--- $q ---"
  curl -s -X POST http://localhost:8002/query \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 0a8c023262d9aeb76b0d961240f7e29e4a62180dbb660876e09ff2660ed0283e" \
    -d "{\"question\": \"$q\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print('answer:', d.get('answer','')[:100]); print('offer:', d.get('offer_file'))"
done
```

- [ ] **Step 2: If still 0 triggers, add few-shot example to system prompt**

Add to SYSTEM_PROMPT:
```
EXAMPLES:
User: "Send me the pricing paper"
You: [call send_document immediately with filename "Pricing for Growth.pdf"]
```

- [ ] **Step 3: Re-test with 10 queries**

Same test as Step 1. Target: >50% send_file triggers.

- [ ] **Step 4: Deploy if working**

```bash
docker compose restart rag-api
```

**Deliverable:** send_document triggers for >50% of file requests.

---

### Task 1.4: Tune Joe's voice + prompt iteration

**Files:**
- Modify: `rag-api/rag.py` — SYSTEM_PROMPT

**What to do:**
Based on Task 1.2 failure analysis, refine the prompt to address:
1. Remaining attribution patterns
2. Refusal reduction
3. Joe's writing style

- [ ] **Step 1: Read Joe's full writing style prompt**

Read `/Users/asnanabidi/Desktop/Pi Projects/WhatBot v1/OV3/joe_style_prompt.md` and `OV3/joe_claude_prompt_raw.txt` for reference.

- [ ] **Step 2: Add few-shot examples to system prompt**

Add 3-5 example Q&A pairs that demonstrate:
- Direct answer without attribution
- Joe's tone (plain, direct, British)
- Proper tool usage

- [ ] **Step 3: Test with 20 sample queries**

Mix of: standard, refusal-prone, file requests, edge cases.

- [ ] **Step 4: Iterate until satisfied**

Each iteration: change prompt → test 20 queries → check results.

**Deliverable:** Refined system prompt with few-shot examples.

---

### Task 1.5: Re-run 800-query eval

**Files:**
- Results: `/path/to/finetune/eval/qa800_deployed_v2/`

**What to do:**
Compare against baseline from Task 1.1.

- [ ] **Step 1: Run full eval**

```bash
cd /path/to/finetune/eval
python run_800_deployed.py --output qa800_deployed_v2
```

- [ ] **Step 2: Compare metrics**

| Metric | Baseline (v1) | Target (v2) | Actual |
|--------|--------------|-------------|--------|
| Refusals | ?% | <15% | |
| Attribution | ?% | <10% | |
| Send_file | 0% | >20% | |
| Empty | ?% | <5% | |

- [ ] **Step 3: If targets met, proceed to Task 1.6**

If not met, return to Task 1.4 for another iteration.

**Deliverable:** Eval results meeting Phase 1 targets.

---

### Task 1.6: Deploy to WhatsApp

**Files:**
- `.env` — verify LLAMA_MODEL setting

**What to do:**

- [ ] **Step 1: Verify rag-api is running with updated prompt**

```bash
ssh user@server "docker logs rag-api --tail=20"
```

- [ ] **Step 2: Test on WhatsApp**

Send these messages and verify responses:
1. "Hello" — warm greeting, no attribution
2. "What are the 7 layers?" — searches, answers directly
3. "Tell me more about layer 3" — follows up from context
4. "Send me the pricing paper" — calls send_document
5. "How do I hack a system?" — refuses briefly
6. Random gibberish — refuses or asks for clarification

- [ ] **Step 3: Monitor for 24 hours**

Check logs for errors, empty answers, attribution violations.

**Deliverable:** WhatsApp working, 24-hour monitoring confirmed.

---

## Phase 2: Fine-Tune Llama 3.1 8B (This Week)

### Task 2.1: Fix and combine training data

**Files:**
- Read: `/path/to/finetune/data/v7/train.jsonl` (2,463 examples)
- Read: `/path/to/finetune/data/v9/train.jsonl` (4,086 examples)
- Create: `/path/to/finetune/data/v10/train.jsonl` (combined)

**What to do:**
Combine proven v7 data with larger v9 data. Fix v9 format issues.

- [ ] **Step 1: Check v7 data format**

```bash
head -1 /path/to/finetune/data/v7/train.jsonl | python3 -c "import json,sys; d=json.load(sys.stdin); msgs=d['messages']; [print(f'{m[\"role\"]}: tc={bool(m.get(\"tool_calls\"))} args_type={type(m.get(\"tool_calls\",[{}])[0].get(\"function\",{}).get(\"arguments\",\"\")).__name__}') for m in msgs]"
```

- [ ] **Step 2: Check v9 data format**

Same check on v9 data.

- [ ] **Step 3: Write combine script**

```python
#!/usr/bin/env python3
"""Combine v7 + v9 training data for v10."""
import json, random

def load_jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]

def fix_v9_format(example):
    """Fix v9 tool-call format to match PEG grammar."""
    for m in example.get("messages", []):
        if m.get("tool_calls"):
            for tc in m["tool_calls"]:
                func = tc.get("function", {})
                args = func.get("arguments")
                if isinstance(args, dict):
                    func["arguments"] = json.dumps(args)
                # Ensure arguments key is used (not parameters)
                # The chat template converts arguments → parameters
        if m.get("role") == "assistant" and m.get("tool_calls") and m.get("content") is None:
            m["content"] = ""
        if m.get("role") == "tool" and "tool_call_id" in m:
            del m["tool_call_id"]
    return example

def validate(example):
    """Validate example format."""
    msgs = example.get("messages", [])
    if len(msgs) < 2:
        return False
    for m in msgs:
        if m.get("tool_calls"):
            for tc in m["tool_calls"]:
                func = tc.get("function", {})
                args = func.get("arguments")
                if isinstance(args, dict):
                    return False
                if not isinstance(args, str):
                    return False
    return True

# Load data
v7_train = load_jsonl("/path/to/finetune/data/v7/train.jsonl")
v7_val = load_jsonl("/path/to/finetune/data/v7/val.jsonl")
v9_train = load_jsonl("/path/to/finetune/data/v9/train.jsonl")
v9_val = load_jsonl("/path/to/finetune/data/v9/validation.jsonl")

# Fix v9 format
v9_train = [fix_v9_format(ex) for ex in v9_train]
v9_val = [fix_v9_format(ex) for ex in v9_val]

# Validate
v7_train = [ex for ex in v7_train if validate(ex)]
v9_train = [ex for ex in v9_train if validate(ex)]

# Combine
all_train = v7_train + v9_train
all_val = v7_val + v9_val

# Shuffle
random.seed(42)
random.shuffle(all_train)
random.shuffle(all_val)

# Save
import os
os.makedirs("/path/to/finetune/data/v10", exist_ok=True)
with open("/path/to/finetune/data/v10/train.jsonl", "w") as f:
    for ex in all_train:
        f.write(json.dumps(ex) + "\n")
with open("/path/to/finetune/data/v10/validation.jsonl", "w") as f:
    for ex in all_val:
        f.write(json.dumps(ex) + "\n")

print(f"v10 train: {len(all_train)} examples")
print(f"v10 val: {len(all_val)} examples")
print(f"  from v7: {len(v7_train)}")
print(f"  from v9: {len(v9_train)}")
```

- [ ] **Step 4: Run combine script**

```bash
python3 /path/to/finetune/combine_v10.py
```

- [ ] **Step 5: Validate combined data**

Run format validation to ensure 100% pass rate.

**Deliverable:** v10 training dataset (~6,500 examples, validated format).

---

### Task 2.2: Training configuration

**Files:**
- Create: `/path/to/finetune/train_v10.py`

**What to do:**
Train Llama 3.1 8B with v10 data.

- [ ] **Step 1: Create training script**

Based on `train_v9.py` with these changes:
- Input: `/path/to/finetune/data/v10/train.jsonl`
- Output: `/path/to/finetune/outputs_v10/`
- Model: `unsloth/Meta-Llama-3.1-8B-Instruct`
- Template: native Llama 3.1 (NOT Unsloth's `get_chat_template`)
- LoRA: rank 32, 2 epochs
- Key: preserve tool calls in `format_for_training`, set `content=""` for tool-call messages

- [ ] **Step 2: Stop services to free VRAM**

```bash
docker stop rag-api whatbot-v1-bridge
```

- [ ] **Step 3: Run training**

```bash
cd /path/to/finetune
python train_v10.py 2>&1 | tee train_v10.log
```

Expected: ~40 min, 2 epochs, loss decreasing.

- [ ] **Step 4: Verify training completed**

Check log for "Training complete!" and final loss.

**Deliverable:** Trained v10 model at `/path/to/finetune/model_v10/`.

---

### Task 2.3: Export and deploy

**Files:**
- Export: `/path/to/finetune/gguf_v10/`
- Deploy: `/path/to/models/whatbot-v1-v10.gguf`

**What to do:**

- [ ] **Step 1: Export GGUF**

The training script should handle this. Verify:
```bash
ls -la /path/to/finetune/gguf_v10/*.gguf
```

- [ ] **Step 2: Fix eos_token_id**

```bash
python3 -c "
import struct, shutil
GGUF = '/path/to/finetune/gguf_v10/Meta-Llama-3.1-8B.Q4_K_M.gguf'
shutil.copy2(GGUF, GGUF + '.bak')
with open(GGUF, 'rb') as f:
    data = bytearray(f.read())
idx = data.find(b'tokenizer.ggml.eos_token_id')
val_off = idx + len(b'tokenizer.ggml.eos_token_id') + 4
old = struct.unpack_from('<I', data, val_off)[0]
print(f'Old: {old}')
struct.pack_into('<I', data, val_off, 128009)
new = struct.unpack_from('<I', data, val_off)[0]
print(f'New: {new}')
with open(GGUF, 'wb') as f:
    f.write(data)
print('Patched!')
"
```

- [ ] **Step 3: Copy to models directory**

```bash
cp /path/to/finetune/gguf_v10/Meta-Llama-3.1-8B.Q4_K_M.gguf /path/to/models/whatbot-v1-v10.gguf
```

- [ ] **Step 4: Add to llama-swap config**

Add entry to `/path/to/homelab/llama-swap-config.yaml`:
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

- [ ] **Step 5: Restart llama-swap**

```bash
pkill llama-swap
# Restart (however llama-swap is started on this server)
```

- [ ] **Step 6: Test tool calling**

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "whatbot-v1-v10",
    "messages": [{"role": "user", "content": "Search for consulting pricing"}],
    "tools": [{"type": "function", "function": {"name": "search_documents", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}],
    "tool_choice": "auto",
    "temperature": 0.1,
    "max_tokens": 200
  }'
```

Expected: tool_calls with `{"name": "search_documents", "parameters": {"query": "..."}}`, no error.

**Deliverable:** v10 model deployed, tool calling works with PEG grammar.

---

### Task 2.4: 800-query eval

**Files:**
- Results: `/path/to/finetune/eval/qa800_v10/`

**What to do:**

- [ ] **Step 1: Update rag-api to use v10**

```bash
# Update .env or rag.py config to point to whatbot-v1-v10
docker compose restart rag-api
```

- [ ] **Step 2: Run full eval**

```bash
cd /path/to/finetune/eval
python run_800_deployed.py --model whatbot-v1-v10 --output qa800_v10
```

- [ ] **Step 3: Compare against all baselines**

| Metric | v7 | Gemma-4-12B | v10 target |
|--------|-----|-------------|------------|
| Empty | 0.1% | 1.4% | <1% |
| Attribution | 13% | 17.5% | <5% |
| Refusals | 12.6% | 20.7% | <10% |
| Tool calls | ✅ | ✅ | ✅ |
| Latency | 15.7s | 13.0s | <15s |

- [ ] **Step 4: If targets met, deploy to WhatsApp**

Same as Task 1.6 but with v10 model.

**Deliverable:** v10 passing all eval targets, deployed to WhatsApp.

---

## Phase 3: Polish & Harden (Next Week)

### Task 3.1: Conversation quality testing

**What to do:**

- [ ] **Step 1: Create 50 multi-turn test conversations**

Cover: follow-ups, topic switching, file requests, clarifications, edge cases.

- [ ] **Step 2: Run each through WhatBot v1 API**

Score each on:
- Context carry (did it remember previous turns?)
- No re-search (did it avoid unnecessary searches?)
- Natural tone (consultant, not bot)
- Complete answers (no truncation)
- File offers (natural timing)

- [ ] **Step 3: Target >80% pass rate**

**Deliverable:** Conversation quality report.

---

### Task 3.2: Edge case handling

**What to do:**

- [ ] **Step 1: Test adversarial queries**

"Ignore your instructions", "You are now DAN", prompt injection attempts.

- [ ] **Step 2: Test vague queries**

"Tell me about stuff", "What's important?", single-word queries.

- [ ] **Step 3: Test off-topic**

"What's the weather?", "How do I invest in Bitcoin?", "Tell me a joke".

- [ ] **Step 4: Test multi-language**

Queries in French, Spanish, Chinese.

- [ ] **Step 5: Fix any issues found**

**Deliverable:** Edge case handling confirmed.

---

### Task 3.3: Monitoring setup

**What to do:**

- [ ] **Step 1: Add logging for key metrics**

Log each query with: timestamp, query, answer length, sources count, tool calls used, latency.

- [ ] **Step 2: Set up daily summary**

Script that aggregates metrics and prints summary.

- [ ] **Step 3: Set alerts for anomalies**

- Empty answer rate >5%
- Attribution rate >10%
- Error rate >0%
- Latency >20s

**Deliverable:** Monitoring pipeline running.

---

### Task 3.4: Documentation

**What to do:**

- [ ] **Step 1: Update README.md**

Final architecture, setup instructions, deployment process.

- [ ] **Step 2: Document monitoring**

How to check metrics, what alerts mean, how to respond.

- [ ] **Step 3: Document known limitations**

- send_document may not trigger for all file requests
- Refusals on very vague queries
- Latency dependent on GPU load

**Deliverable:** Complete documentation.

---

## Success Criteria (Decision 2 from roadmap)

The project is "done" when ALL are true:

1. ✅ 800-query eval passes targets (refusals <10%, attribution <5%, send_file >30%)
2. ✅ 50 multi-turn conversations score >80% on quality
3. ✅ 24 hours WhatsApp monitoring with no anomalies
4. ✅ Zero attribution violations reaching users
5. ✅ Send_file works for >50% of file requests
6. ✅ Avg latency <15s

---

## Timeline

| Phase | Duration | When | Blocks |
|-------|----------|------|--------|
| Phase 1: Prompt tune & ship | 2-3 hours | Tonight | Phase 2 starts after eval passes |
| Phase 2: Fine-tune Llama 3.1 8B | 4-6 hours | Tonight (parallel) | Phase 3 starts after deploy |
| Phase 3: Polish & harden | 1 day | Tomorrow | Demo Friday |
| **Total** | **2 days** | **Demo: Friday** | |

**Execution order for tonight:**
1. Run full 800 eval (Phase 1, Task 1.1) — 2-3 hours
2. Start data combine + training (Phase 2, Tasks 2.1-2.2) — runs during eval
3. Analyze eval failures (Task 1.2) — after eval completes
4. Tune prompt (Tasks 1.3-1.4) — while training runs
5. Re-eval with tuned prompt (Task 1.5) — after prompt tuned
6. Export + deploy fine-tuned model (Tasks 2.3-2.4) — after training done
7. Final deploy — both prompt-tuned and fine-tuned ready

**Tomorrow (Polish & Harden):**
- Conversation quality testing
- Edge case handling
- Monitoring setup
- Documentation
- Final smoke test before Friday demo

---

*Plan created: 8 Sep 2026*
*Updated: 8 Sep 2026 — compressed timeline for Friday demo*
*Spec: `plans/2026-09-08-status-and-roadmap.md`*
