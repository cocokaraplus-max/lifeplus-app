#!/usr/bin/env python3
"""lifeplus-day-flow-home-v1:
  ・「1日の流れ」の「帰りの支度」の説明を差し替える（平日・日曜の両方）
    前：忘れ物がないかを確かめて、ご自宅までお送りします。
    後：帰宅前には認知機能の賦活化も含め1日の出来事などを振り返ります。
何度流しても同じ結果になる。直す前に .bak_day_flow_home_v1 を残す。
"""
import os, shutil
MARK = "lifeplus-day-flow-home-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(HERE, "docs", "dayservice", "index.html")
OLD = "<p>忘れ物がないかを確かめて、ご自宅までお送りします。</p>"
NEW = "<p>帰宅前には認知機能の賦活化も含め1日の出来事などを振り返ります。</p>"
s = open(p, encoding="utf-8").read()
if OLD not in s and NEW in s:
    print("済み dayservice/index.html")
else:
    assert s.count(OLD) in (1, 2), "帰りの支度の説明が想定と違います（先に patch_lifeplus_day_flow_v1.py が要ります）"
    shutil.copyfile(p, p + ".bak_day_flow_home_v1")
    open(p, "w", encoding="utf-8").write(s.replace(OLD, NEW))
    print("直した dayservice/index.html")
s = open(p, encoding="utf-8").read()
assert OLD not in s and NEW in s
print("OK: 帰りの支度の説明を差し替えました（" + MARK + "）")
