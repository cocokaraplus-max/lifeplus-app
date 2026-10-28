#!/usr/bin/env python3
"""lifeplus-day-flow-ex-v2:
  ・「1日の流れ」の訓練の例を、上の札（A：白い札に、点と区切り線で縦に並ぶ形）と同じ見た目にする
    白い札の中に1行ずつ、色の点と名前。行の間に点線。最後の「など」は右下に小さく
    パソコンでは2列、スマホでは1列
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_day_flow_ex_v2 を残す。
先に patch_lifeplus_day_flow_ex_v1.py が要ります。
"""
import os, re, shutil
MARK = "lifeplus-day-flow-ex-v2"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
CSS = """
/* ---------- 訓練の例を白い札に縦に並べる（lifeplus-day-flow-ex-v2）---------- */
.flow-ex.fx2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 28px; row-gap: 0; gap: 0 28px;
  background: #fff; border-radius: 18px; padding: 6px 20px 10px; box-shadow: 0 14px 28px -20px rgba(60,80,20,.6); }
.flow-ex.fx2 li { display: flex; align-items: center; gap: 12px; padding: 13px 2px; border-radius: 0; background: none;
  border-bottom: 1px dashed var(--line); font-size: 16px; font-weight: 700; color: var(--ink); white-space: normal; }
.flow-ex.fx2 li::before { width: 8px; height: 8px; box-shadow: 0 0 0 4px var(--orange-soft); }
.flow-ex.fx2 li:nth-child(4n+3)::before, .flow-ex.fx2 li:nth-child(4n+4)::before { background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
.flow-ex.fx2 li:nth-child(4n+1)::before, .flow-ex.fx2 li:nth-child(4n+2)::before { background: var(--orange); box-shadow: 0 0 0 4px var(--orange-soft); }
.flow-ex.fx2 li:nth-last-child(2), .flow-ex.fx2 li:nth-last-child(3) { border-bottom: 0; }
.flow-ex.fx2 li.etc { grid-column: 1 / -1; justify-content: flex-end; padding: 6px 2px 2px; border: 0; color: var(--sub); font-size: 13px; font-weight: 500; }
@media (max-width: 760px) {
  .flow-ex.fx2 { grid-template-columns: minmax(0, 1fr); padding: 4px 14px 8px; border-radius: 14px; }
  .flow-ex.fx2 li { font-size: 15px; padding: 11px 2px; gap: 11px; }
  .flow-ex.fx2 li::before { width: 7px; height: 7px; }
  .flow-ex.fx2 li:nth-last-child(3) { border-bottom: 1px dashed var(--line); }
  .flow-ex.fx2 li:nth-child(odd)::before { background: var(--orange); box-shadow: 0 0 0 4px var(--orange-soft); }
  .flow-ex.fx2 li:nth-child(even)::before { background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
}
"""
c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-day-flow-ex-v1" in cs, "先に patch_lifeplus_day_flow_ex_v1.py を流してください"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_day_flow_ex_v2")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
p = os.path.join(D, "dayservice", "index.html")
s = open(p, encoding="utf-8").read()
if 'site.css?v=20261028fy"' in s:
    print("済み dayservice/index.html")
else:
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, "site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_day_flow_ex_v2")
    open(p, "w", encoding="utf-8").write(re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261028fy"', s))
    print("直した dayservice/index.html")
assert MARK in open(c, encoding="utf-8").read() and 'site.css?v=20261028fy"' in open(p, encoding="utf-8").read()
print("OK: 訓練の例を白い札に縦に並べました（" + MARK + "）")
