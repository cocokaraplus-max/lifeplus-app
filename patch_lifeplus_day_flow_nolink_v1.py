#!/usr/bin/env python3
"""lifeplus-day-flow-nolink-v1:
  ・「1日の流れ」の上の説明文から「（日曜の1日型へ）」のリンクを外す
何度流しても同じ結果になる。直す前に .bak_day_flow_nolink_v1 を残す。
"""
import os, shutil
MARK = "lifeplus-day-flow-nolink-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(HERE, "docs", "dayservice", "index.html")
OLD = '日曜は9:30〜16:30の1日型です（<a href="#oneday">日曜の1日型へ</a>）。</p>'
NEW = '日曜は9:30〜16:30の1日型です。<!-- ' + MARK + ' --></p>'
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み dayservice/index.html")
else:
    assert s.count(OLD) == 1, "1日の流れの説明文が想定と違います（先に patch_lifeplus_day_flow_v1.py が要ります）"
    shutil.copyfile(p, p + ".bak_day_flow_nolink_v1")
    open(p, "w", encoding="utf-8").write(s.replace(OLD, NEW))
    print("直した dayservice/index.html")
s = open(p, encoding="utf-8").read()
assert NEW in s and OLD not in s
print("OK: 1日型へのリンクを外しました（" + MARK + "）")
