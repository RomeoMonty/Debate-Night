# Picks a mix of the game's other AI calls (the opponent speaking, voter reactions, the moderator,
# news coverage...) with the model's own replies, so training on verdicts doesn't change how the
# model does everything else: the add-on is always loaded, so it touches every call.
# Usage: python training/build_replay.py OUT.jsonl.gz calls1.jsonl.gz [calls2 ...]
import gzip, json, sys, random, hashlib, re, collections

out, files = sys.argv[1], sys.argv[2:]
# How many of each kind of call to keep.
WANT = {"opponent": 45, "reactions": 40, "classify": 30, "stage": 15, "moderator": 15, "news": 10, "research": 15}
def kind(task):
    if task.startswith("TASK: Score how persuadable"): return None          # the verdicts are labeled by hand
    if "(the player) says" in task: return None                             # the lab's test player, not the game
    if task.startswith("TASK: Write only what"): return "opponent"
    if task.startswith("TASK: Voice real people's reactions"): return "reactions"
    if task.startswith("TASK: Classify what"): return "classify"
    if task.startswith("TASK: Write the next few seconds on stage"): return "stage"
    if task.startswith("TASK: Write moderator"): return "moderator"
    if task.startswith("TASK: Write election-night news"): return "news"
    if task.startswith("TASK: You run opposition research"): return "research"
    return None
pool, seen = collections.defaultdict(list), set()
for f in files:
    for line in gzip.open(f, "rt"):
        c = json.loads(line); msgs = c["body"].get("messages") or []
        if not msgs or c.get("status") != 200 or not c.get("reply"): continue
        k = kind(str(msgs[-1].get("content", "")))
        if not k: continue
        h = hashlib.sha1(json.dumps(msgs).encode()).hexdigest()
        if h in seen: continue
        seen.add(h)
        pool[k].append({"kind": k, "messages": msgs, "target": c["reply"], "src": f.rsplit("/", 1)[-1]})
rng = random.Random(7); rows = []
for k, n in WANT.items():
    items = pool.get(k, []); rng.shuffle(items); rows += items[:n]
    print(f"{k}: kept {min(n, len(items))} of {len(items)}")
with gzip.open(out, "wt") as w:
    for r in rows: w.write(json.dumps(r, ensure_ascii=False) + "\n")
print(len(rows), "replay examples")
