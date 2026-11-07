# Pulls the scoring calls out of saved lab calls (*-calls.jsonl.gz) and writes:
#   segments.jsonl  one line per scoring call: id, the exact request, the model's own reply
#   view-NNN.md     a readable digest of each segment, in batches, for writing verdicts
# Usage: python training/extract.py OUTDIR file1.jsonl.gz [file2 ...]
import gzip, json, re, sys, os, hashlib

out_dir, files = sys.argv[1], sys.argv[2:]
os.makedirs(out_dir, exist_ok=True)
SCORE = "TASK: Score how persuadable voters"
segs, seen = [], set()
for f in files:
    for line in gzip.open(f, "rt"):
        if not line.strip(): continue
        c = json.loads(line)
        msgs = c["body"].get("messages") or []
        if not msgs or not str(msgs[-1].get("content", "")).startswith(SCORE): continue
        if c.get("status") != 200 or not c.get("reply"): continue
        key = hashlib.sha1(json.dumps(msgs).encode()).hexdigest()[:10]
        if key in seen: continue
        seen.add(key)
        try: reply = json.loads(c["reply"])
        except Exception: continue
        segs.append({"id": key, "src": os.path.basename(f), "body": c["body"], "reply": reply})

def field(text, start, stop):
    i = text.find(start)
    if i < 0: return ""
    j = text.find(stop, i + len(start)) if stop else -1
    return text[i + len(start): j if j > 0 else None].strip()

with open(os.path.join(out_dir, "segments.jsonl"), "w") as w:
    for s in segs: w.write(json.dumps(s) + "\n")

def digest(s):
    msgs = s["body"]["messages"]; user = msgs[-1]["content"]; system = msgs[0]["content"]
    m = re.search(r'segment (\d+), "([^"]+)"', user); n = int(m.group(1)) if m else 0
    tag = f"[Segment {n}:"
    # The segment's lines are in the history messages that start with its tag (or inline in the task).
    hist = "\n".join(str(x.get("content", "")) for x in msgs[1:-1])
    lines = [l[len(tag):].split("]", 1)[-1].strip() for l in re.split(r"\n(?=\[)", hist) if l.startswith(tag)]
    seg_text = "\n".join(lines) if lines else field(user, "THIS SEGMENT", "ANALYST NOTES")
    world = field(system, "Since then, as of tonight:", "THE PLAYER")
    player = field(system, 'THE PLAYER ("you"):', 'THE OPPONENT')
    opp = field(system, 'THE OPPONENT ("opp"):', "Voice:")
    r = s["reply"]
    sh = "; ".join(f'{k} {v.get("toward")} {v.get("by")} ({v.get("why")})' for k, v in (r.get("shifts") or {}).items())
    return f"""## {s['id']}  ·  {m.group(2) if m else '?'}
WORLD: {world[:900]}
PLAYER: {player[:900]}
OPP: {opp[:500]}
LEANS: {field(user, "CURRENT LEANS:", chr(10))}
SEGMENT:
{seg_text[:4000]}
NOTES: {field(user, "ANALYST NOTES (measured):", "Reply as JSON")}
BASE MODEL SAID: winner {r.get('winner')} | fc: {r.get('fact_check')} | {r.get('summary')} | {sh}
"""

B = 12
for i in range(0, len(segs), B):
    with open(os.path.join(out_dir, f"view-{i // B:03d}.md"), "w") as w:
        w.write("\n".join(digest(s) for s in segs[i:i + B]))
print(f"{len(segs)} scoring calls from {len(files)} files")
