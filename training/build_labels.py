# Expands careful verdict labels into exact training targets (compact JSON in the grammar's key order)
# and splits them by game into training and test sets (a whole game stays on one side).
# Usage: python training/build_labels.py segments.jsonl[.gz] labels.txt out.jsonl [segments2 labels2 ...]
#   labels.txt: one block per segment, written by hand:
#     @<id> P|O|D            winner: the player, the opponent or a draw
#     A: analysis            F: fact check ("-" if none)   S: summary   H: headline
#     sub X# why | wor X# why | lat X# why | you X# why | sen X# why | rur X# why   (X = P, O or n)
import json, re, sys, gzip, hashlib
def opener(p): return gzip.open(p, "rt") if p.endswith(".gz") else open(p)
pairs = list(zip(sys.argv[1:-1:2], sys.argv[2:-1:2])) if len(sys.argv) > 4 else [(sys.argv[1], sys.argv[2])]
OUT = sys.argv[-1] if len(sys.argv) > 4 else sys.argv[3]
segs = {}
for sp_, _ in pairs:
    for l in opener(sp_): d = json.loads(l); segs[d["id"]] = d
def game_of(s):
    sy = s["body"]["messages"][0]["content"]
    who = re.findall(r'THE (?:PLAYER|OPPONENT) \("(?:you|opp)"\): ([^(]+)', sy)
    return s["src"].split("-calls")[0] + "|" + "|".join(w.strip() for w in who)
BL = {"sub": "suburban", "wor": "working", "lat": "latino", "you": "young", "sen": "seniors", "rur": "rural"}
LIM = {"analysis": 420, "fact_check": 240, "summary": 240, "why": 70, "headline": 110}
blocks = [b for _, lp in pairs for b in re.split(r"\n(?=@)", open(lp).read())]
out, errs = [], 0
STOP = set("the a an and or of to in on for with by at from is are be will we i my our that this it as not no".split())
def words(t): return [w for w in re.findall(r"[a-z0-9$%]+", t.lower()) if w not in STOP]
for b in blocks:
    if not b.startswith("@"): continue
    lines = b.strip().split("\n"); head = lines[0][1:].split()
    sid, w = head[0], head[1]
    s = segs.get(sid)
    if not s: print("unknown id", sid); errs += 1; continue
    g = s["body"]["grammar"]; m = re.search(r'r4 ::= \("\\"(\w+)\\"" \| "\\"(\w+)\\""', g); P, O = m.group(1), m.group(2)
    f = {l[:1]: l[3:].strip() for l in lines[1:] if re.match(r"^[AFSH]: ", l)}
    shl = [l for l in lines[1:] if l.startswith("sub ")]
    if len(shl) != 1 or set(f) != set("AFSH"): print(sid, "missing fields"); errs += 1; continue
    shifts, net, tot = {}, 0, 0
    for part in shl[0].split("|"):
        mm = re.match(r"\s*(\w{3}) ([PОOn])(\d) (.+?)\s*$", part)
        if not mm: print(sid, "bad shift", part); errs += 1; continue
        k, side, by, why = mm.groups(); by = int(by)
        tw = {"P": P, "O": O, "n": "neither"}[side]
        if side == "n" and by: print(sid, "neither with by", part); errs += 1
        if side != "n" and not by: print(sid, "side with 0", part); errs += 1
        shifts[BL[k]] = {"why": why, "toward": tw, "by": by}
        net += by if side == "P" else -by if side == "O" else 0; tot += by
        if len(why) > LIM["why"]: print(sid, "why too long", why); errs += 1
    if list(shifts) != list(BL.values()): print(sid, "shift order/blocs", list(shifts)); errs += 1; continue
    if tot > 15: print(sid, "total", tot); errs += 1
    if (w == "P" and net <= 0) or (w == "O" and net >= 0) or (w == "D" and abs(net) > 4): print(sid, "winner/net mismatch", w, net); errs += 1
    winner = {"P": P, "O": O, "D": "draw"}[w]
    fc = "" if f["F"] == "-" else f["F"]
    for k, v in (("analysis", f["A"]), ("fact_check", fc), ("summary", f["S"]), ("headline", f["H"])):
        if len(v) > LIM[k]: print(sid, k, "too long", len(v)); errs += 1
    # Claims: keep the base model's, minus any its speaker didn't actually say in this segment.
    msgs = s["body"]["messages"]; n = re.search(r"segment (\d+)", msgs[-1]["content"]).group(1)
    hist = "\n".join(str(x.get("content", "")) for x in msgs[1:-1])
    said = {P: "", O: ""}
    for l in re.split(r"\n(?=\[)", hist):
        if l.startswith(f"[Segment {n}:"):
            body = l.split("]", 1)[-1].strip()
            for nm in (P, O):
                if body.startswith(nm + ":"): said[nm] += " " + body
    nc = s["reply"].get("new_claims") or {}
    def keep(items, nm):
        sw = set(words(said[nm])); r = []
        for it in (items or [])[:3]:
            ws = words(it)
            if ws and sum(x in sw for x in ws) / len(ws) >= 0.6: r.append(it[:120])
        return r
    claims = {"you": keep(nc.get("you"), P), "opp": keep(nc.get("opp"), O)}
    tgt = {"analysis": f["A"], "fact_check": fc, "summary": f["S"], "winner": winner, "shifts": shifts, "headline": f["H"], "new_claims": claims}
    keys = re.findall(r'\\"(\w+)\\":', g.split("\n")[0])
    if "next_question" in keys: tgt["next_question"] = s["reply"].get("next_question", "")
    if keys != list(tgt): print(sid, "grammar keys", keys); errs += 1
    out.append({"id": sid, "game": game_of(s), "messages": msgs, "body": s["body"], "target": json.dumps(tgt, ensure_ascii=False, separators=(",", ":"))})
# Every fourth game (in a fixed, shuffled order) is held out for testing.
games = sorted({o["game"] for o in out}, key=lambda g: hashlib.sha1(g.encode()).hexdigest())
test = set(games[::4])
for o in out: o["split"] = "test" if o["game"] in test else "train"
with open(OUT, "w") as wf:
    for o in out: wf.write(json.dumps(o, ensure_ascii=False) + "\n")
print(len(out), "labels,", errs, "problems;", sum(o["split"] == "test" for o in out), "held out for testing in", len({o["game"] for o in out if o["split"] == "test"}), "games")
