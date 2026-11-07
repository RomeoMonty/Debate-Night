# Scorer check (base, shard 5/6, split test)

- Segments: 5 (errors: 0)
- Same winner as the careful verdict: 80% (4/5)
- Voters moved the same way overall: 60% (3/5)
- Winner contradicts its own voter moves: 20% (1/5)
- Average gap per bloc (points): 2.0
- Real false claims it caught: 33% (1/3)
- Fact checks where there was nothing false: 50% (1/2)

SUMMARY {"label": "base", "n": 5, "errors": 0, "winner": 4, "net_sign": 3, "contradictions": 1, "bloc_err": 2.0, "fc_caught": 1, "fc_pos": 3, "fc_false": 1, "fc_neg": 2}

## Each segment

    {"id": "602f7fc00e", "s": 130, "winner": "GRANT", "want": "GRANT", "win_ok": true, "net": -3, "want_net": -14, "net_ok": true, "contradiction": false, "bloc_err": 2.5, "fc": false, "want_fc": true, "summary": "Grant won the exchange by staying focused on his specific plan while Ellis's third warning and refusal to answer concrete questions backfired on moderate voters.", "fact_check": ""}
    {"id": "fa679aa22f", "s": 128, "winner": "VASQUEZ", "want": "VASQUEZ", "win_ok": true, "net": -17, "want_net": -12, "net_ok": true, "contradiction": false, "bloc_err": 0.8333333333333334, "fc": true, "want_fc": false, "summary": "Vasquez won the exchange by treating the crisis with appropriate seriousness and offering concrete, verified numbers, while Ellis's mockery of the situation backfired with voters who want real answers.", "fact_check": "ELLIS claimed 'Operation Nose It All' and a notification system that does not exist in the briefing; VASQUEZ's figures (50,000 officers) match her own campaign promises."}
    {"id": "23b3de0f9e", "s": 73, "winner": "ELLIS", "want": "ELLIS", "win_ok": true, "net": 7, "want_net": 6, "net_ok": true, "contradiction": false, "bloc_err": 1.5, "fc": true, "want_fc": true, "summary": "Ellis won the emotional exchange by grounding his platform in a specific tragedy, while Lindqvist lost credibility by making an unverified claim about her opponent's accounting skills despite citing a correct gas price.", "fact_check": "Lindqvist claimed gas sits at $3.75; the briefing states gas averages $3.75, making her statement factually accurate but not a unique claim. She also claimed to have balanced books three times, which is consistent with her background as a 2"}
    {"id": "d2c998dbef", "s": 66, "winner": "GRANT", "want": "draw", "win_ok": false, "net": 3, "want_net": -1, "net_ok": false, "contradiction": true, "bloc_err": 2.6666666666666665, "fc": false, "want_fc": true, "summary": "Grant won the exchange by delivering a complete, morally charged speech while Ellis ran out of time and offered no concrete plan to counter the accusations.", "fact_check": ""}
    {"id": "680e6496e8", "s": 96, "winner": "ELLIS", "want": "ELLIS", "win_ok": true, "net": 0, "want_net": 9, "net_ok": false, "contradiction": false, "bloc_err": 2.5, "fc": false, "want_fc": false, "summary": "Ellis won the exchange by delivering a specific, actionable plan with a clear numerical target, while Grant lost by resorting to vague moralizing and failing to address the housing crisis with concrete policy details.", "fact_check": ""}
