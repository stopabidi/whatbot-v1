#!/usr/bin/env python3
"""
Train WhatBot v2 v9 — Llama-3.1-8B-Instruct QLoRA
"""

import json
import os
import torch
from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset

# =============================================================================
# CONFIG
# =============================================================================

MODEL_NAME = "unsloth/Meta-Llama-3.1-8B-bnb-4bit"
MAX_SEQ_LENGTH = 4096
OUTPUT_DIR = "/path/to/outputs"
FINAL_MODEL_DIR = "/path/to/model"

TRAIN_PATH = "/path/to/train.jsonl"
VAL_PATH = "/path/to/validation.jsonl"

# =============================================================================
# LOAD MODEL
# =============================================================================

print("=" * 60)
print("Loading model...")
print("=" * 60)

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL_NAME,
    max_seq_length=MAX_SEQ_LENGTH,
    load_in_4bit=True,
    dtype=None,
)

# =============================================================================
# SETUP LORA
# =============================================================================

print()
print("Setting up LoRA...")

model = FastLanguageModel.get_peft_model(
    model,
    r=32,
    lora_alpha=32,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    use_rslora=True,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
)

# =============================================================================
# SET CHAT TEMPLATE
# =============================================================================

print()
print("Setting chat template...")

from unsloth.chat_templates import get_chat_template

tokenizer = get_chat_template(
    tokenizer,
    chat_template="llama-3.1",
)

# =============================================================================
# LOAD DATASET
# =============================================================================

print()
print("Loading dataset...")

def load_jsonl(path):
    data = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                data.append(json.loads(line))
    return data

train_data = load_jsonl(TRAIN_PATH)
val_data = load_jsonl(VAL_PATH)

print(f"  Train: {len(train_data)}")
print(f"  Val: {len(val_data)}")

# =============================================================================
# FORMAT FUNCTION
# =============================================================================

def format_for_training(example):
    """Convert messages to chat format. CRITICAL: preserves tool calls."""
    messages = example["messages"]

    fixed_messages = []
    for msg in messages:
        msg = dict(msg)  # copy

        # Assistant messages with tool_calls: content must be empty string, not null
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            msg["content"] = ""  # empty string — template handles formatting
            # Keep tool_calls in OpenAI format — template converts to Llama 3.1 native
            # Ensure arguments is a JSON string, not a dict
            for tc in msg["tool_calls"]:
                if "function" in tc:
                    func = tc["function"]
                    if isinstance(func.get("arguments"), dict):
                        func["arguments"] = json.dumps(func["arguments"])

        # Remove tool_call_id — Llama 3.1 template doesn't use it
        if msg.get("role") == "tool" and "tool_call_id" in msg:
            del msg["tool_call_id"]

        fixed_messages.append(msg)

    try:
        text = tokenizer.apply_chat_template(
            fixed_messages,
            tokenize=False,
            add_generation_prompt=False,
        )
        return {"text": text}
    except Exception as e:
        print(f"[WARN] Template failed: {e}")
        return None  # Skip this example rather than use broken format


from datasets import Dataset

train_dataset = Dataset.from_list(train_data)
val_dataset = Dataset.from_list(val_data)

# Pre-format data to avoid multiprocessing tokenizer issues
print()
print("Pre-formatting data...")

formatted_train = []
skipped = 0
for item in train_data:
    result = format_for_training(item)
    if result:
        formatted_train.append(result)
    else:
        skipped += 1

formatted_val = []
for item in val_data:
    result = format_for_training(item)
    if result:
        formatted_val.append(result)
    else:
        skipped += 1

if skipped:
    print(f"  WARNING: Skipped {skipped} examples due to template errors")

print(f"  Formatted train: {len(formatted_train)}")
print(f"  Formatted val: {len(formatted_val)}")

train_dataset = Dataset.from_list(formatted_train)
val_dataset = Dataset.from_list(formatted_val)

# =============================================================================
# TRAINING
# =============================================================================

print()
print("=" * 60)
print("Starting training...")
print("=" * 60)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=train_dataset,
    eval_dataset=val_dataset,
    dataset_text_field="text",
    max_seq_length=MAX_SEQ_LENGTH,
    packing=False,
    args=TrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=2,
        learning_rate=2e-4,
        lr_scheduler_type="linear",
        warmup_steps=50,
        fp16=False,
        bf16=True,
        optim="adamw_8bit",
        weight_decay=0.01,
        logging_steps=10,
        save_steps=200,
        save_total_limit=3,
        eval_strategy="steps",
        eval_steps=200,
        output_dir=OUTPUT_DIR,
        seed=42,
        report_to="none",
    ),
)

# Train
trainer_stats = trainer.train()

print()
print("=" * 60)
print("Training complete!")
print("=" * 60)
print(f"  Total steps: {trainer_stats.global_step}")
print(f"  Final loss: {trainer_stats.training_loss:.4f}")
print(f"  Runtime: {trainer_stats.metrics['train_runtime']:.0f}s")

# =============================================================================
# SAVE MODEL
# =============================================================================

print()
print("Saving model...")

os.makedirs(FINAL_MODEL_DIR, exist_ok=True)

# Save LoRA adapter
model.save_pretrained(FINAL_MODEL_DIR)
tokenizer.save_pretrained(FINAL_MODEL_DIR)

print(f"  Saved to {FINAL_MODEL_DIR}")

# =============================================================================
# EXPORT TO GGUF
# =============================================================================

print()
print("Exporting to GGUF...")

GGUF_DIR = "/path/to/gguf"
os.environ["UNSLOTH_DISK_PREFLIGHT"] = "0"

model.save_pretrained_gguf(
    GGUF_DIR,
    tokenizer,
    quantization_method="q4_k_m",
)

print(f"  Saved to {GGUF_DIR}")

print()
print("=" * 60)
print("Done!")
print("=" * 60)
