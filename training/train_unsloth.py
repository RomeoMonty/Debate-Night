# Trains the scorer add-on (a LoRA for the Standard model, Qwen 3.5 4B) on a graphics card with Unsloth.
# Meant to run inside training/train_colab.ipynb (free Google Colab or Kaggle GPU), which installs
# Unsloth first. The examples are the game's exact requests plus the reply it should have given; the
# loss is on the reply only.
#   python training/train_unsloth.py --scoring graded.jsonl --replay training/data/replay.jsonl.gz --out adapter
import argparse, gzip, json, random, re, time, collections
ap = argparse.ArgumentParser()
ap.add_argument("--scoring", required=True, help="graded.jsonl from build_labels.py (only the train split is used)")
ap.add_argument("--replay", default="", help="replay.jsonl.gz from build_replay.py")
ap.add_argument("--out", default="adapter")
ap.add_argument("--base", default="unsloth/Qwen3.5-4B")
ap.add_argument("--epochs", type=float, default=2.0)
ap.add_argument("--lr", type=float, default=1e-4)
ap.add_argument("--rank", type=int, default=16)
ap.add_argument("--accum", type=int, default=8)
ap.add_argument("--max_len", type=int, default=8192)
a = ap.parse_args()

from unsloth import FastVisionModel, is_bfloat16_supported   # must come before transformers
import torch
from datasets import Dataset
from transformers import Trainer, TrainingArguments

model, proc = FastVisionModel.from_pretrained(a.base, load_in_4bit=False, use_gradient_checkpointing="unsloth")
tok = getattr(proc, "tokenizer", proc)
model = FastVisionModel.get_peft_model(
    model, finetune_vision_layers=False, finetune_language_layers=True,
    finetune_attention_modules=True, finetune_mlp_modules=True,
    r=a.rank, lora_alpha=a.rank, lora_dropout=0, bias="none", random_state=3407)
wrapped = sorted({n.split(".lora_A")[0].split(".")[-1] for n, _ in model.named_parameters() if "lora_A" in n})
print("Add-on trains:", wrapped)
assert not any("visual" in n for n, _ in model.named_parameters() if "lora_A" in n), "vision layers should stay frozen"

def load(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f: return [json.loads(l) for l in f if l.strip()]

scoring = [r for r in load(a.scoring) if r.get("split", "train") == "train"]
replay = load(a.replay) if a.replay else []
# The lab's test players lose far more often than real players do, so verdicts where the player won
# or it was a draw are repeated to keep the model from learning "the opponent usually wins".
def side(r):
    w = json.loads(r["target"])["winner"]
    player = re.search(r'r4 ::= \("\\"(\w+)\\""', r["body"]["grammar"]).group(1)   # the grammar lists the player first
    return "draw" if w == "draw" else "player" if w == player else "opp"
by = collections.Counter(side(r) for r in scoring)
top = max(by.values())
reps = {k: max(1, min(3, round(top / (1.5 * v)))) for k, v in by.items()}
print("Verdicts by winner:", dict(by), "repeats:", reps)
rows = [r for r in scoring for _ in range(reps[side(r)])] + replay

END = "<|im_end|>"
def encode(r):
    prompt = tok.apply_chat_template(r["messages"], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    p = tok(prompt, add_special_tokens=False)["input_ids"]
    t = tok(r["target"] + END, add_special_tokens=False)["input_ids"]
    if len(p) + len(t) > a.max_len: return None
    return {"input_ids": p + t, "labels": [-100] * len(p) + t}
enc = [e for e in map(encode, rows) if e]
print(f"{len(enc)} examples ({len(rows) - len(enc)} too long, skipped); "
      f"average {sum(len(e['input_ids']) for e in enc) // len(enc)} tokens")
random.Random(3407).shuffle(enc)
ds = Dataset.from_list(enc)

def collate(batch):
    n = max(len(b["input_ids"]) for b in batch)
    pad = tok.pad_token_id if tok.pad_token_id is not None else 0
    ids = torch.tensor([b["input_ids"] + [pad] * (n - len(b["input_ids"])) for b in batch])
    lab = torch.tensor([b["labels"] + [-100] * (n - len(b["labels"])) for b in batch])
    att = torch.tensor([[1] * len(b["input_ids"]) + [0] * (n - len(b["input_ids"])) for b in batch])
    return {"input_ids": ids, "labels": lab, "attention_mask": att}

FastVisionModel.for_training(model)
args = TrainingArguments(
    output_dir="checkpoints", per_device_train_batch_size=1, gradient_accumulation_steps=a.accum,
    num_train_epochs=a.epochs, learning_rate=a.lr, lr_scheduler_type="cosine", warmup_ratio=0.05,
    weight_decay=0.0, optim="adamw_8bit", logging_steps=5, save_strategy="no", report_to="none",
    bf16=is_bfloat16_supported(), fp16=not is_bfloat16_supported(), remove_unused_columns=False, seed=3407)
trainer = Trainer(model=model, args=args, train_dataset=ds, data_collator=collate)
t0 = time.time()
trainer.train()
print(f"Trained in {(time.time() - t0) / 60:.0f} minutes")
model.save_pretrained(a.out); tok.save_pretrained(a.out)
print("Saved the add-on to", a.out)
