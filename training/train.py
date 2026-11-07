# LoRA fine-tune of the Standard model (Qwen 3.5 4B) on the game's own requests.
# Each example is the exact message list the game sent plus the reply it should have given; the loss
# is on the reply only. Runs on a processor (slow, free machines) or a graphics card if there is one,
# and can stop and resume: progress is saved in OUT every few steps.
#   python training/train.py data.jsonl OUT [--steps N] [--hours H]
import os, sys, json, time, math, random, argparse, glob
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import LoraConfig, get_peft_model, PeftModel

ap = argparse.ArgumentParser()
ap.add_argument("data"); ap.add_argument("out")
ap.add_argument("--base", default=os.environ.get("BASE", "Qwen/Qwen3.5-4B"))
ap.add_argument("--epochs", type=float, default=2.0)
ap.add_argument("--lr", type=float, default=1e-4)
ap.add_argument("--rank", type=int, default=16)
ap.add_argument("--accum", type=int, default=4)
ap.add_argument("--hours", type=float, default=5.0, help="stop and save after this long (to resume in another job)")
ap.add_argument("--max_len", type=int, default=6144)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
dev = "cuda" if torch.cuda.is_available() else "cpu"
t_start = time.time()

tok = AutoTokenizer.from_pretrained(a.base)
rows = [json.loads(l) for l in open(a.data) if l.strip()]
def encode(r):
    prompt = tok.apply_chat_template(r["messages"], add_generation_prompt=True, tokenize=False, enable_thinking=False)
    p = tok(prompt, add_special_tokens=False)["input_ids"]
    t = tok(r["target"] + "<|im_end|>\n", add_special_tokens=False)["input_ids"]
    p = p[-(a.max_len - len(t)):]
    return p, t
data = [encode(r) for r in rows]
print(f"{len(data)} examples; prompt tokens avg {sum(len(p) for p, _ in data) // len(data)}, reply avg {sum(len(t) for _, t in data) // len(data)}", flush=True)

model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.bfloat16, low_cpu_mem_usage=True).to(dev)
lin = sorted({n.split(".")[-1] for n, m in model.named_modules() if isinstance(m, torch.nn.Linear) and "visual" not in n and "lm_head" not in n})
targets = [n for n in lin if n not in ("lm_head",)]
state_path = os.path.join(a.out, "state.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {"step": 0, "seed": 1234}
if os.path.exists(os.path.join(a.out, "adapter", "adapter_config.json")):
    model = PeftModel.from_pretrained(model, os.path.join(a.out, "adapter"), is_trainable=True)
    print(f"resuming at step {state['step']}", flush=True)
else:
    model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.0, target_modules=targets,
        exclude_modules=r".*visual.*", task_type="CAUSAL_LM"))
print("LoRA on:", targets, "trainable", sum(p.numel() for p in model.parameters() if p.requires_grad), flush=True)
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False}); model.enable_input_require_grads()
params = [p for p in model.parameters() if p.requires_grad]
opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0)
if os.path.exists(os.path.join(a.out, "opt.pt")): opt.load_state_dict(torch.load(os.path.join(a.out, "opt.pt")))

total = math.ceil(len(data) * a.epochs / a.accum)
order = []
rng = random.Random(state["seed"])
for e in range(math.ceil(a.epochs)): idx = list(range(len(data))); rng.shuffle(idx); order += idx
order = order[: total * a.accum]
def lr_at(s): w = max(1, total // 20); return a.lr * (s / w if s < w else 0.5 * (1 + math.cos(math.pi * (s - w) / max(1, total - w))))
def save():
    model.save_pretrained(os.path.join(a.out, "adapter")); torch.save(opt.state_dict(), os.path.join(a.out, "opt.pt"))
    json.dump(state, open(state_path, "w"))

model.train()
log = open(os.path.join(a.out, "log.txt"), "a")
while state["step"] < total:
    if time.time() - t_start > a.hours * 3600: print("out of time; saved for the next job", flush=True); break
    for g in opt.param_groups: g["lr"] = lr_at(state["step"])
    t0 = time.time(); tot = 0.0
    for k in range(a.accum):
        p, t = data[order[state["step"] * a.accum + k]]
        ids = torch.tensor([p + t], device=dev); lab = torch.tensor([[-100] * len(p) + t], device=dev)
        loss = model(input_ids=ids, labels=lab).loss / a.accum; loss.backward(); tot += loss.item()
    torch.nn.utils.clip_grad_norm_(params, 1.0); opt.step(); opt.zero_grad()
    state["step"] += 1
    msg = f"step {state['step']}/{total} loss {tot:.4f} lr {lr_at(state['step']):.2e} {time.time() - t0:.0f}s"
    print(msg, flush=True); log.write(msg + "\n"); log.flush()
    if state["step"] % 10 == 0: save()
save()
state["done"] = state["step"] >= total; json.dump(state, open(state_path, "w"))
print("DONE" if state["done"] else "PAUSED", flush=True)
