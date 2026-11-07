# Grades the scorer against careful verdicts: replays the game's exact scoring requests to a running
# llama-server and compares each reply with the verdict written for that segment.
#   python training/score_eval.py LABELED.jsonl OUT.md [--url http://127.0.0.1:18600] [--shard i/n] [--split test|train|all]
# LABELED.jsonl rows: {id, game, split, messages, body, target} (from training/build_labels.py).
import json, sys, time, argparse, urllib.request, os, re

ap = argparse.ArgumentParser()
ap.add_argument("data"); ap.add_argument("out")
ap.add_argument("--url", default="http://127.0.0.1:18600")
ap.add_argument("--shard", default="0/1")
ap.add_argument("--split", default="test")
ap.add_argument("--label", default=os.environ.get("EVAL_LABEL", "base"))
a = ap.parse_args()
si, sn = map(int, a.shard.split("/"))
rows = [json.loads(l) for l in open(a.data) if l.strip()]
rows = [r for r in rows if a.split == "all" or r.get("split") == a.split]
rows = [r for i, r in enumerate(rows) if i % sn == si]

# The game clears notes like "None" or "No false claims found" before showing a fact check.
EMPTY_FC = re.compile(r"^\s*[\"']?(none|n/?a|nothing|null|no (false|misleading|inaccurate)\b.*|no claims?\b.*|-+)\s*\.?[\"']?\s*$", re.I | re.S)
def has_fc(v): v = str(v or "").strip(); return bool(v) and not EMPTY_FC.match(v)
def side(v, P, O): v = str(v or "").upper(); return 1 if v == P else -1 if v == O else 0
def moves(j, P, O): return {k: side(v.get("toward"), P, O) * int(v.get("by") or 0) for k, v in (j.get("shifts") or {}).items()}

res = []
for r in rows:
    body = dict(r["body"]); body["stream"] = False
    t0 = time.time()
    try:
        req = urllib.request.Request(a.url + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        out = json.loads(urllib.request.urlopen(req, timeout=1800).read())
        reply = out["choices"][0]["message"]["content"]; j = json.loads(reply)
    except Exception as e:
        res.append({"id": r["id"], "error": str(e)[:200]}); print(r["id"], "error", e, flush=True); continue
    tgt = json.loads(r["target"])
    m = re.search(r'r4 ::= \("\\"(\w+)\\"" \| "\\"(\w+)\\""', r["body"]["grammar"]); P, O = m.group(1), m.group(2)
    mv, tv = moves(j, P, O), moves(tgt, P, O)
    net, tnet = sum(mv.values()), sum(tv.values())
    w, tw = side(j.get("winner"), P, O), side(tgt["winner"], P, O)
    item = {"id": r["id"], "s": round(time.time() - t0), "winner": j.get("winner"), "want": tgt["winner"],
            "win_ok": w == tw, "net": net, "want_net": tnet, "net_ok": (net > 0) == (tnet > 0) and (net < 0) == (tnet < 0),
            "contradiction": (w > 0 and net < 0) or (w < 0 and net > 0) or (w == 0 and abs(net) > 4),
            "bloc_err": sum(abs(mv.get(k, 0) - tv[k]) for k in tv) / max(1, len(tv)),
            "fc": has_fc(j.get("fact_check")), "want_fc": bool(tgt["fact_check"]),
            "summary": j.get("summary", ""), "fact_check": j.get("fact_check", "")}
    res.append(item); print(json.dumps({k: item[k] for k in ("id", "s", "winner", "want", "net", "want_net")}), flush=True)

ok = [x for x in res if "error" not in x]
def pct(n, d): return f"{100 * n / d:.0f}% ({n}/{d})" if d else "n/a"
fc_pos = [x for x in ok if x["want_fc"]]; fc_neg = [x for x in ok if not x["want_fc"]]
summary = {
    "label": a.label, "n": len(ok), "errors": len(res) - len(ok),
    "winner": sum(x["win_ok"] for x in ok), "net_sign": sum(x["net_ok"] for x in ok),
    "contradictions": sum(x["contradiction"] for x in ok),
    "bloc_err": round(sum(x["bloc_err"] for x in ok) / max(1, len(ok)), 2),
    "fc_caught": sum(x["fc"] for x in fc_pos), "fc_pos": len(fc_pos),
    "fc_false": sum(x["fc"] for x in fc_neg), "fc_neg": len(fc_neg),
}
with open(a.out, "w") as w:
    w.write(f"# Scorer check ({a.label}, shard {a.shard}, split {a.split})\n\n")
    w.write(f"- Segments: {len(ok)} (errors: {len(res) - len(ok)})\n")
    w.write(f"- Same winner as the careful verdict: {pct(summary['winner'], len(ok))}\n")
    w.write(f"- Voters moved the same way overall: {pct(summary['net_sign'], len(ok))}\n")
    w.write(f"- Winner contradicts its own voter moves: {pct(summary['contradictions'], len(ok))}\n")
    w.write(f"- Average gap per bloc (points): {summary['bloc_err']}\n")
    w.write(f"- Real false claims it caught: {pct(summary['fc_caught'], len(fc_pos))}\n")
    w.write(f"- Fact checks where there was nothing false: {pct(summary['fc_false'], len(fc_neg))}\n\n")
    w.write("SUMMARY " + json.dumps(summary) + "\n\n## Each segment\n\n")
    for x in res: w.write("    " + json.dumps(x) + "\n")
print("SUMMARY", json.dumps(summary))
