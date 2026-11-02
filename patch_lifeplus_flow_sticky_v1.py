#!/usr/bin/env python3
"""lifeplus-flow-sticky-v1:
  ・デイの「1日の流れ」の切り替えボタン（午前の部・午後の部・日曜 1日型）を、下へ読み進めても画面の上に付いてくるようにする
    （上のメニューの帯のすぐ下に止まる。1日の流れを読み終えると、いっしょに流れていく）
  ・「大切にしていること」の「外での実践も」の文を差し替える
    前：屋外での活動も取り入れて、暮らしの中で使える体の力を保ちます。
    後：屋外での活動も取り入れて、生活に必要な心身の機能を維持向上します。
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_flow_sticky_v1 を残す。
"""
import os, re, shutil
MARK = "lifeplus-flow-sticky-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
T_OLD = "<p>屋外での活動も取り入れて、暮らしの中で使える体の力を保ちます。</p>"
T_NEW = "<p>屋外での活動も取り入れて、生活に必要な心身の機能を維持向上します。<!-- " + MARK + " --></p>"
CSS = """
/* ---------- 1日の流れの切り替えボタンを上に付いてこさせる（lifeplus-flow-sticky-v1）---------- */
.flow-tabs { position: sticky; top: 84px; z-index: 20; }
.flow-tabs { box-shadow: 0 10px 28px -14px rgba(35,38,43,.45); }
@media (max-width: 1200px) { .flow-tabs { top: 76px; } }
@media (max-width: 760px) { .flow-tabs { top: 74px; } }
"""
c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-day-flow-sun-v1" in cs, "先に 1日の流れ（patch_lifeplus_day_flow_sun_v1.py）が要ります"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_flow_sticky_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
p = os.path.join(D, "dayservice", "index.html")
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み dayservice/index.html")
else:
    assert s.count(T_OLD) == 1, "「外での実践も」の文が想定と違います"
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, "site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_flow_sticky_v1")
    s = s.replace(T_OLD, T_NEW)
    s = re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261102st"', s)
    open(p, "w", encoding="utf-8").write(s)
    print("直した dayservice/index.html")
assert T_NEW in open(p, encoding="utf-8").read() and MARK in open(c, encoding="utf-8").read()
print("OK: 切り替えボタンを上に付いてこさせ、外での実践の文を差し替えました（" + MARK + "）")
