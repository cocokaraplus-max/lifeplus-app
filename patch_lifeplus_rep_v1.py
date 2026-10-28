#!/usr/bin/env python3
"""lifeplus-rep-v1:
  ・TOPの会社概要の「代表：岸本 洋幸（柔道整復師）」から（柔道整復師）を外す
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_rep_v1 を残す。
"""
import os, shutil
MARK = "lifeplus-rep-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(HERE, "docs", "index.html")
OLD = "<dt>代表</dt><dd>岸本 洋幸（柔道整復師）</dd>"
NEW = "<dt>代表</dt><dd>岸本 洋幸<!-- " + MARK + " --></dd>"
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み index.html")
else:
    assert s.count(OLD) == 1, "代表の所が想定と違います"
    shutil.copyfile(p, p + ".bak_rep_v1")
    open(p, "w", encoding="utf-8").write(s.replace(OLD, NEW))
    print("直した index.html")
s = open(p, encoding="utf-8").read()
assert MARK in s and OLD not in s
print("OK: 代表から（柔道整復師）を外しました（" + MARK + "）")
