#!/usr/bin/env python3
"""lifeplus-zip-v1:
  ・トップの「アクセス」で、郵便番号（〒471-0832）を住所のすぐ上に小さく出す
    下の説明文の頭にあった「〒471-0832。」は外す
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_zip_v1 を残す。
"""
import os, re, shutil
MARK = "lifeplus-zip-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
ADDR_OLD = '<p class="addr">愛知県豊田市丸山町<br>7丁目49番地6</p>'
ADDR_NEW = '<p class="addr" data-v="' + MARK + '"><span class="zip">〒471-0832</span>愛知県豊田市丸山町<br>7丁目49番地6</p>'
MUTED_OLD = '<p class="muted">〒471-0832。デイサービス'
MUTED_NEW = '<p class="muted">デイサービス'
CSS = """
/* ---------- 郵便番号を住所の上に（lifeplus-zip-v1）---------- */
.addr .zip { display: block; font-size: 15px; font-weight: 500; letter-spacing: .06em; color: var(--sub); line-height: 1.4; margin-bottom: 2px; }
"""
c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_zip_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
p = os.path.join(D, "index.html")
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み index.html")
else:
    assert s.count(ADDR_OLD) == 1, "トップの住所の所が想定と違います"
    assert s.count(MUTED_OLD) == 1, "トップの郵便番号の文が想定と違います"
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, "site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_zip_v1")
    s = s.replace(ADDR_OLD, ADDR_NEW).replace(MUTED_OLD, MUTED_NEW)
    s = re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261028zp"', s)
    open(p, "w", encoding="utf-8").write(s)
    print("直した index.html")
s = open(p, encoding="utf-8").read()
assert ADDR_NEW in s and "〒471-0832。" not in s and MARK in open(c, encoding="utf-8").read()
print("OK: 郵便番号を住所の上にしました（" + MARK + "）")
