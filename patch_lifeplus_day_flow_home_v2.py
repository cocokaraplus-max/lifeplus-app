#!/usr/bin/env python3
"""lifeplus-day-flow-home-v2:
  ・平日の「帰りの支度」の説明だけ元に戻す（日曜はそのまま）
    平日：忘れ物がないかを確かめて、ご自宅までお送りします。
    日曜：帰宅前には認知機能の賦活化も含め1日の出来事などを振り返ります。
何度流しても同じ結果になる。直す前に .bak_day_flow_home_v2 を残す。
先に patch_lifeplus_day_flow_home_v1.py が要ります。
"""
import os, shutil
MARK = "lifeplus-day-flow-home-v2"
HERE = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(HERE, "docs", "dayservice", "index.html")
WK = "<p>忘れ物がないかを確かめて、ご自宅までお送りします。</p>"
SUN = "<p>帰宅前には認知機能の賦活化も含め1日の出来事などを振り返ります。</p>"
s = open(p, encoding="utf-8").read()
i = s.find('<ol class="flow-list wk">'); j = s.find('</ol>', i)
assert i >= 0 and j > i, "平日の1日の流れが見つかりません"
wk = s[i:j]
if WK in wk and SUN not in wk:
    print("済み dayservice/index.html")
else:
    assert wk.count(SUN) == 1, "平日の帰りの支度の説明が想定と違います"
    shutil.copyfile(p, p + ".bak_day_flow_home_v2")
    s = s[:i] + wk.replace(SUN, WK) + s[j:]
    open(p, "w", encoding="utf-8").write(s)
    print("直した dayservice/index.html")
s = open(p, encoding="utf-8").read()
k = s.find('<ol class="flow-list sun">')
assert WK in s[s.find('<ol class="flow-list wk">'):k] and SUN in s[k:]
print("OK: 平日の帰りの支度を元に戻しました（" + MARK + "）")
