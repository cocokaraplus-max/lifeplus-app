#!/usr/bin/env python3
"""lifeplus-polaroid-hover-v1:
  ・ポラロイドの写真を、どれを触っても（マウスを乗せても・スマホで指で触っても）まっすぐになって浮き上がるようにする
    前は4枚目・5枚目の傾きの決まりが後から書かれていて、触っても動かなかった
  ・ボディケア・デイ・接骨院のポラロイドすべてに効く
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_polaroid_hover_v1 を残す。
"""
import os, re, shutil
MARK = "lifeplus-polaroid-hover-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
PAGES = ["index.html", "dayservice/index.html", "sekkotsu/index.html", "bodycare/index.html", "apps/index.html", "privacy/index.html", "recruit/index.html"]
CSS = """
/* ---------- ポラロイドはどれを触っても動く（lifeplus-polaroid-hover-v1）---------- */
.photos-band .photos.polaroid figure { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.photos-band .photos.polaroid figure:hover, .photos-band .photos.polaroid figure:active, .photos-band .photos.polaroid figure:focus-visible {
  transform: rotate(0deg) translateY(-6px) scale(1.04); z-index: 9; }
@media (prefers-reduced-motion: reduce) {
  .photos-band .photos.polaroid figure:hover, .photos-band .photos.polaroid figure:active { transform: none; }
}
"""
c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-polaroid-more-v1" in cs, "先にポラロイドの直しが要ります"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_polaroid_hover_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
for rel in PAGES:
    p = os.path.join(D, rel)
    s = open(p, encoding="utf-8").read()
    if 'site.css?v=20261028ph"' in s:
        print("済み", rel); continue
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, f"{rel}: site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_polaroid_hover_v1")
    open(p, "w", encoding="utf-8").write(re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261028ph"', s))
    print("直した", rel)
assert MARK in open(c, encoding="utf-8").read()
print("OK: ポラロイドをどれでも動くようにしました（" + MARK + "）")
