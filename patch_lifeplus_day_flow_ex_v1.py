#!/usr/bin/env python3
"""lifeplus-day-flow-ex-v1:
  ・「1日の流れ」の個別機能訓練の例を、実際の訓練10個に差し替える
    歩行訓練／トレッドミル／踏み台昇降訓練／平行棒周回訓練／立ち上がり訓練／ランジ／タンデム歩行／バランスパッド／痛みのセルフケア／自宅でできる訓練
  ・例は名前だけの丸い札にして、折り返して並べる（スマホでも崩れない）。最後に「など」
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_day_flow_ex_v1 を残す。
先に patch_lifeplus_day_flow_v1.py が要ります。
"""
import os, re, shutil
MARK = "lifeplus-day-flow-ex-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
EX = ["歩行訓練", "トレッドミル", "踏み台昇降訓練", "平行棒周回訓練", "立ち上がり訓練", "ランジ",
      "タンデム歩行", "バランスパッド", "痛みのセルフケア", "自宅でできる訓練"]
UL_NEW = ('<ul class="flow-ex fx2" aria-label="訓練の例" data-v="' + MARK + '">'
          + "".join(f"<li>{x}</li>" for x in EX) + '<li class="etc">など</li></ul>')
CSS = """
/* ---------- 訓練の例を丸い札に（lifeplus-day-flow-ex-v1）---------- */
.flow-ex.fx2 { display: flex; flex-wrap: wrap; gap: 8px; }
.flow-ex.fx2 li { display: inline-flex; align-items: center; gap: 7px; flex-direction: row; padding: 8px 14px 8px 12px; border-radius: 999px;
  font-family: var(--head); font-weight: 700; font-size: 15px; line-height: 1.3; white-space: nowrap; background: rgba(255,255,255,.94); color: var(--ink); }
.flow-ex.fx2 li::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--orange); flex: none; }
.flow-ex.fx2 li:nth-child(even)::before { background: var(--green); }
.flow-ex.fx2 li.etc { background: none; color: #fff; padding-left: 4px; font-weight: 500; }
.flow-ex.fx2 li.etc::before { display: none; }
@media (max-width: 760px) {
  .flow-ex.fx2 { gap: 6px; }
  .flow-ex.fx2 li { font-size: 13.5px; padding: 7px 11px 7px 10px; gap: 6px; }
  .flow-ex.fx2 li::before { width: 6px; height: 6px; }
  .flow-ex.fx2 li span { padding: 0; }
}
"""
c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-day-flow-v1" in cs, "先に patch_lifeplus_day_flow_v1.py を流してください"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_day_flow_ex_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
p = os.path.join(D, "dayservice", "index.html")
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み dayservice/index.html")
else:
    pat = r'<ul class="flow-ex" aria-label="訓練の例">.*?</ul>'
    assert len(re.findall(pat, s)) == 1, "訓練の例の所が想定と違います"
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, "site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_day_flow_ex_v1")
    s = re.sub(pat, lambda m: UL_NEW, s)
    s = re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261028fx"', s)
    open(p, "w", encoding="utf-8").write(s)
    print("直した dayservice/index.html")
s = open(p, encoding="utf-8").read()
assert UL_NEW in s and MARK in open(c, encoding="utf-8").read()
print("OK: 訓練の例を10個に差し替えました（" + MARK + "）")
