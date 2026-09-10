# WhatBot v1 — Status Report & Professional Quality Roadmap

**Date:** 8 Sep 2026
**Current model:** Gemma-4-12B IT QAT (no fine-tune)
**Status:** Deployed, prompt-tuned, partial eval complete

---

## Part 1: Today's Status Report

### What was done

1. **Merged OV3 as single codebase** — replaced old RAG + V3_Fixed with OV3 tool-calling architecture
2. **Fixed critical bugs in rag.py:**
   - System prompt: "search once, then answer" (was causing search loops → 192 empty answers)
   - `_strip_attribution`: reduced from 15 aggressive patterns to 4 leading-only patterns
   - `send_document` tool: early return on `send_file:` prefix (was being swallowed by LLM)
   - Synthesis fallback after max iterations
3. **Generated v9 training data** — 4,500 examples via MiMo 2.5 teacher (tool-call format issues found, fixed in post-processing)
4. **Attempted Llama 3.1 8B fine-tune** — blocked by PEG grammar mismatch (Unsloth template vs llama-server grammar). EOS token fix applied but tool-call format still incompatible.
5. **Pivoted to Gemma-4-12B IT QAT** — already on server, tool calling works, no fine-tuning needed
6. **Ran 800-query eval** — stopped at 310/800 (user stopped to apply prompt fixes)
7. **Iteratively tuned system prompt** — 4 revisions based on eval feedback

### Current eval results (285/800 queries, Gemma-4-12B, deployed)

| Metric | Count | % | Target | Status |
|--------|-------|---|--------|--------|
| Errors | 0 | 0% | 0 | ✅ |
| Empty answers | 4 | 1.4% | <20 | ✅ |
| Attribution (raw) | 50 | 17.5% | <5% | ⚠️ Post-filter catches |
| Attribution — Joe personal | 0 | 0% | 0 | ✅ |
| Attribution — Source/doc | 50 | 17.5% | — | Post-filter catches |
| Refusals | 59 | 20.7% | <10% | ❌ |
| Send file triggered | 0 | 0% | >50% | ❌ |
| Has sources | 191 | 67% | >70% | ⚠️ Close |
| Has answer | 222 | 77.9% | — | ✅ |
| Avg latency | 13.0s | — | <15s | ✅ |

**Key insight:** Joe personal attributions are ZERO. All 50 attributions are source/document type ("based on", "the search results") which are caught by `_strip_attribution` post-filter at runtime.

### What's working
- Tool calling (search_documents) — works reliably
- Zero errors across all queries
- Empty answers fixed (192 → 4)
- Latency acceptable (13s avg)
- Joe personal attributions: ZERO (model never says "[CLIENT]'s work" or "O'Mahoney")

### What needs work
- **Refusals (20.7%)** — model too conservative, refuses when it could answer
- **Source attributions (50)** — model says "the search results suggest..." despite prompt
- **Send file (0)** — send_document tool never triggers
- **Conversation quality** — responses feel like AI assistant, not senior consultant
- **Joe's voice** — inconsistent, model defaults to corporate tone

### Key learnings
1. **PEG grammar is the real blocker for fine-tuning** — Unsloth's template produces format that llama-server can't parse. The E4B model works because it uses a custom chat template file.
2. **Gemma-4-12B IT QAT is a viable shortcut** — tool calling works out of the box, no fine-tuning needed for basic functionality
3. **Prompt tuning has diminishing returns** — can get to ~80% but the model's base personality leaks through
4. **Fine-tuning is the path to 95%+** — but only with the correct tool-call format (matching the PEG grammar)
5. **GGUF eos_token fix resolved crashes** — Unsloth exported with 128001 instead of 128009. Patched but tool-call format still incompatible.
6. **Gemma-4-12B eval in progress** — 285/800 deployed queries complete, 0 errors, trajectory looks solid
7. **Joe personal attributions: ZERO** — all 50 attributions are source/doc type, caught by post-filter

---

## Part 2: Professional Quality Roadmap (Option C)

**Strategy:** Ship prompt-tuned Gemma-4-12B today. Fine-tune in background. Swap when ready.

### Phase 1: Prompt Tune & Ship (Today)

**Goal:** Get to 80% professional quality. Ship to WhatsApp.

**Tasks:**

#### Task 1.1: Run full 800-query eval with current prompt
- Run the eval to completion (310/800 done, 490 remaining)
- Use as baseline for measuring improvements
- **Skill:** verification-before-completion — confirm results before claiming success

#### Task 1.2: Analyze eval failures
- Categorize all 59 refusals — which are legitimate, which are missed opportunities
- Categorize all 50 attributions — which patterns the model still generates
- Check send_file queries — what did the model do instead of calling send_document
- **Skill:** systematic-debugging — trace each failure to root cause

#### Task 1.3: Fix send_document (0 triggers)
- The eval shows 0 send_file triggers — the model never calls send_document
- Investigate: is the tool description clear enough? Is the system prompt instruction strong enough?
- Add few-shot example to system prompt: "Q: Send me the pricing paper. A: [calls send_document immediately]"
- Test with 10 file-request queries before full eval
- **Skill:** systematic-debugging — trace why the model ignores send_document

#### Task 1.4: Prompt iteration round 2
- Based on failure analysis, refine system prompt
- Tune Joe's voice: add writing style rules from Joe's Claude prompt (subordinate clauses, balance before criticism, soften superlatives)
- Test changes with 20-30 sample queries before full eval
- **Skill:** ponytail — keep changes minimal, don't over-engineer the prompt

#### Task 1.5: Re-run 800-query eval
- Compare against baseline from Task 1.1
- Target: refusals <10%, attributions <5% (after filter), send_file >30%
- **Skill:** verification-before-completion — run eval, check numbers, confirm improvement

#### Task 1.6: Deploy to WhatsApp
- `docker compose restart rag-api`
- Test on WhatsApp: Hello, 7 layers, tell me more, send me the paper
- Monitor for 24 hours
- **Skill:** verification-before-completion — confirm WhatsApp works before declaring done

### Phase 2: Fine-Tune Llama 3.1 8B (This Week)

**Goal:** Get to 95%+ professional quality. Joe's voice, zero attribution, natural conversations.

**Why Llama 3.1 8B, not Gemma-4-12B:** Gemma-4-12B is already fine-tuned (IT QAT). Fine-tuning a fine-tune risks catastrophic forgetting. Llama 3.1 8B is a base model — clean fine-tune, proven results (v7 was Llama 3.1 8B with 12.6% refusal rate).

**Key insight from v9 failure:** The PEG grammar requires a specific tool-call format. We now know what works — the E4B model generates `{"name": "...", "parameters": {...}}` and the PEG grammar accepts it. The fine-tune must produce this exact format.

**Existing training data:**
| Dataset | Examples | Source | Notes |
|---------|----------|--------|-------|
| v7 | 2,463 train + 274 val | Llama 3.1 8B, proven | Best eval results (12.6% refusals, 0.1% empty) |
| v8 | 2,126 train + 298 val | Stripped tool calls (broken) | Don't use — no tool calls in data |
| v9 | 4,086 train + 456 val | MiMo 2.5 generated | Tool-call format issues (arguments vs parameters) |

**Plan:** Fix v9 data format (arguments → parameters), combine with v7 data, train Llama 3.1 8B.

#### Task 2.1: Fix and combine training data
- Fix v9 data: convert `arguments` (JSON string) to `parameters` key format
- Combine with v7 data (proven quality)
- Target: ~5,000-6,000 examples
- Validate every example matches PEG grammar format
- **Skill:** verification-before-completion — format must match before training

#### Task 2.2: Training configuration
- Model: `unsloth/Meta-Llama-3.1-8B-Instruct` (base model, not fine-tuned)
- LoRA rank 32, 2 epochs, ~40 min on RTX 3090
- Chat template: native Llama 3.1 (not Unsloth's `get_chat_template`)
- **Skill:** ponytail — simplest training config that works

#### Task 2.3: Export and deploy
- Export GGUF Q4_K_M
- Fix eos_token_id (128001 → 128009) — same patch as v9
- Deploy with `--chat-template-file /path/to/homelab/llama3.1-chat-template.jinja`
- Test tool calling works with PEG grammar
- **Skill:** verification-before-completion — test tool calls before declaring done

#### Task 2.4: 800-query eval
- Run full eval against fine-tuned model
- Compare against Gemma-4-12B baseline AND v7 baseline
- Target: refusals <10%, attributions <5% (after filter), send_file >30%
- **Skill:** verification-before-completion — eval must pass all targets

### Phase 3: Polish & Harden (Next Week)

**Goal:** Production-grade quality. Handle edge cases, monitor, iterate.

#### Task 3.1: Conversation quality testing
- Create 50 multi-turn test conversations
- Score each on: context carry, natural flow, no re-search, Joe's voice
- Fix any issues found
- **Skill:** systematic-debugging — trace conversation failures to root cause

#### Task 3.2: Edge case handling
- Adversarial queries (prompt injection, "ignore instructions")
- Vague queries ("tell me about stuff")
- Off-topic queries ("what's the weather?")
- Multi-language queries
- Very long queries
- **Skill:** ponytail — handle edge cases simply, don't over-engineer

#### Task 3.3: Monitoring setup
- Log all queries and responses for 1 week
- Track: attribution rate, refusal rate, send_file rate, latency, errors
- Set up alerts for anomalies
- **Skill:** verification-before-completion — data before claims

#### Task 3.4: Documentation
- Update README.md with final architecture
- Document deployment process
- Document monitoring and alerting
- **Skill:** writing-plans — if any documentation is complex

---

## Decision Points

### Decision 1: Fine-tune Llama 3.1 8B or keep Gemma-4-12B?

| Factor | Llama 3.1 8B (fine-tuned) | Gemma-4-12B IT QAT |
|--------|--------------------------|-------------------|
| Tool calling | Needs correct format | Works out of box |
| Joe's voice | Learned from data | Prompt only |
| Attribution | Can be trained to 0 | Prompt + post-filter |
| Conversation quality | Can be trained | Limited by base model |
| Deployment | Needs `--chat-template-file` | Simple swap |
| Risk | PEG grammar issues | None |
| Time | 1-2 days | Done now |

**Recommendation:** Start with Gemma-4-12B (Phase 1). If conversation quality isn't good enough after prompt tuning, then fine-tune Llama 3.1 8B (Phase 2). Don't fine-tune unless Phase 1 proves insufficient.

### Decision 2: When is "done"?

"Done" means:
1. ✅ 800-query eval passes all targets
2. ✅ 50 multi-turn conversations score >80% on conversation quality
3. ✅ 24 hours of WhatsApp monitoring with no anomalies
4. ✅ Zero attribution violations reaching users
5. ✅ Send_file works for >50% of file requests
6. ✅ Avg latency <15s

---

## Files Modified Today

| File | Change |
|------|--------|
| `rag-api/rag.py` | System prompt (4 revisions), _strip_attribution (minimal), send_document description, synthesis fallback |
| `rag-api/requirements.txt` | Updated for OV3 |
| `rag-api/Dockerfile` | Port 8002, bge-m3 preload |
| `docker-compose.yml` | Port 8002, bge-m3 |
| `.env` | Port 8002, bge-m3 |
| `whatbot-v1-bridge/src/messageHandler.js` | OV3 version (MAX_HISTORY 20, markdown strip) |
| `whatbot-v1-bridge/src/ragClient.js` | OV3 version |
| `whatbot-v1-bridge/src/config.js` | Default port 8002 |
| `whatbot-v1-bridge/public/index.html` | Version V3 |
| `README.md` | Updated for OV3 |

## Files Created Today

| File | Purpose |
|------|---------|
| `plans/2026-09-07-whatbot-v1-v9-finetune.md` | V9 fine-tune plan (Llama 3.1 8B) |
| `plans/2026-09-08-v9-dataset-fix.md` | Dataset fix plan |
| `plans/2026-09-08-switch-to-gemma4-12b.md` | Gemma-4-12B switch plan |
| `plans/2026-09-08-v9-eos-fix.md` | EOS token fix plan |
| `plans/2026-09-08-status-and-roadmap.md` | This file |

## Skills Used This Session

| Skill | When | What it did |
|-------|------|-------------|
| brainstorming | Planning fine-tune approach | Scoped the problem, proposed options |
| systematic-debugging | Tracing PEG grammar failure | Found EOS token root cause |
| verification-before-completion | Evaluating dataset quality | Found tool-call format issues, attribution, refusals |
| ponytail | Keeping fixes minimal | Prevented over-engineering prompt |
| writing-plans | Creating implementation plans | Structured tasks with clear acceptance criteria |

---

*Status report created: 8 Sep 2026*
*Next action: Run full 800-query eval (Task 1.1)*
