# Measures whether a free GitHub machine can fine-tune the Standard model (Qwen 3.5 4B) with LoRA,
# and how long one training step takes at the length of a real scoring prompt.
import os, time, json, sys, resource
import torch
from transformers import AutoConfig, AutoTokenizer, AutoModelForCausalLM
import transformers, peft
from peft import LoraConfig, get_peft_model
repo = os.environ.get("BASE", "Qwen/Qwen3.5-4B")
out = {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__, "threads": torch.get_num_threads()}
cfg = AutoConfig.from_pretrained(repo)
out["model_type"] = cfg.model_type; out["arch"] = getattr(cfg, "architectures", None)
tc = getattr(cfg, "text_config", cfg)
out["layers"] = getattr(tc, "num_hidden_layers", None); out["layer_types"] = (getattr(tc, "layer_types", None) or [])[:8]
print(json.dumps(out), flush=True)
tok = AutoTokenizer.from_pretrained(repo)
t0 = time.time()
model = AutoModelForCausalLM.from_pretrained(repo, dtype=torch.bfloat16, low_cpu_mem_usage=True)
out["load_s"] = round(time.time() - t0, 1)
names = sorted({n.split(".")[-1] for n, m in model.named_modules() if isinstance(m, torch.nn.Linear)})
out["linear_names"] = names
print(json.dumps(out), flush=True)
targets = [n for n in ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj", "in_proj_qkvz", "in_proj_ba", "in_proj_qkv", "in_proj_z", "out_proj"] if n in names]
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, target_modules=targets, lora_dropout=0.0, task_type="CAUSAL_LM"))
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False}); model.enable_input_require_grads()
out["trainable"] = sum(p.numel() for p in model.parameters() if p.requires_grad)
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-4)
for n in [int(x) for x in os.environ.get("LENS", "512,2048,4096").split(",")]:
    ids = torch.randint(100, 50000, (1, n)); labels = ids.clone(); labels[:, : n - 400] = -100
    t0 = time.time(); loss = model(input_ids=ids, labels=labels).loss; t1 = time.time(); loss.backward(); opt.step(); opt.zero_grad(); t2 = time.time()
    out[f"step_{n}"] = {"fwd_s": round(t1 - t0, 1), "bwd_s": round(t2 - t1, 1), "maxrss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1)}
    print(json.dumps(out), flush=True)
print("RESULT " + json.dumps(out))
