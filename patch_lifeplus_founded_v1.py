#!/usr/bin/env python3
"""lifeplus-founded-v1:
  ・トップの会社の案内の「設立」を「2014年11月（法人設立）」にする
何度流しても同じ結果になる。直す前に .bak_founded_v1 を残す。
"""
import os, shutil
MARK = "lifeplus-founded-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(HERE, "docs", "index.html")
OLD = "<dt>設立</dt><dd>2014年11月</dd>"
NEW = "<dt>設立</dt><dd>2014年11月（法人設立）</dd>"
s = open(p, encoding="utf-8").read()
if NEW in s:
    print("済み index.html")
else:
    assert s.count(OLD) == 1, "設立の所が想定と違います"
    shutil.copyfile(p, p + ".bak_founded_v1")
    open(p, "w", encoding="utf-8").write(s.replace(OLD, NEW))
    print("直した index.html")
assert NEW in open(p, encoding="utf-8").read()
print("OK: 設立を「2014年11月（法人設立）」にしました（" + MARK + "）")
