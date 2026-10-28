#!/usr/bin/env python3
"""lifeplus-nav-v1:
  ・「メニュー」ボタンを、オレンジ→グリーンの丸いハンバーガーにする（開くと × に変わる）
  ・開いたメニューを、色の点と矢印のついた札の並びにする（デイ・ボディケアなどの行き先が一目で分かる）
  ・LINEで予約は緑の大きなボタン。メニューの行き先を押す・Esc を押すと閉じる
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_nav_v1 を残す。
"""
import os, shutil
MARK = "lifeplus-nav-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
PAGES = ["index.html", "dayservice/index.html", "sekkotsu/index.html", "bodycare/index.html", "apps/index.html", "privacy/index.html", "recruit/index.html"]
VER = [('site.css?v=20261028i"', 'site.css?v=20261028j"'), ('site.js?v=20261028h"', 'site.js?v=20261028j"')]
BTN_OLD = '<button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav">メニュー</button>'
BTN_NEW = ('<button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav" aria-label="メニューを開く">'
           '<span class="hb" aria-hidden="true"><i></i><i></i><i></i></span><span class="mb-lb en" aria-hidden="true">MENU</span></button>')

JS_OLD = '''    mb.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      mb.setAttribute("aria-expanded", open ? "true" : "false");
      mb.textContent = open ? "閉じる" : "メニュー";
    });'''
JS_NEW = '''    // lifeplus-nav-v1：丸いハンバーガー。行き先を押す・Esc で閉じる
    var setMenu = function (open) {
      nav.classList.toggle("open", open);
      mb.classList.toggle("on", open);
      mb.setAttribute("aria-expanded", open ? "true" : "false");
      mb.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
      var lb = mb.querySelector(".mb-lb");
      if (lb) lb.textContent = open ? "CLOSE" : "MENU";
    };
    mb.addEventListener("click", function () { setMenu(!nav.classList.contains("open")); });
    nav.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) setMenu(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) { setMenu(false); mb.focus(); }
    });'''

CSS = r'''
/* ---------- メニュー（lifeplus-nav-v1）----------
   ・ボタンはオレンジ→グリーンの丸。3本線が、開くと × に変わる
   ・開いたメニューは、色の点（オレンジ・グリーンを交互）と矢印のついた札。LINEで予約は緑の大きなボタン */
.menu-btn { border: 0; background: none; padding: 0; border-radius: 999px; cursor: pointer;
  align-items: center; gap: 10px; color: var(--ink); -webkit-tap-highlight-color: transparent; }
.menu-btn .hb { position: relative; width: 46px; height: 46px; border-radius: 50%; flex: none;
  background: linear-gradient(135deg, var(--orange) 0%, #f7b733 38%, #a7cf3c 70%, var(--green) 100%);
  box-shadow: 0 6px 16px -6px rgba(110,185,44,.55), 0 2px 6px -2px rgba(243,152,0,.5);
  transition: transform .25s ease, box-shadow .25s ease; }
.menu-btn:hover .hb { transform: rotate(-8deg) scale(1.04); }
.menu-btn .hb i { position: absolute; left: 13px; width: 20px; height: 2.5px; border-radius: 2px; background: #fff;
  transition: transform .3s cubic-bezier(.6,.05,.3,1), opacity .2s, width .3s; }
.menu-btn .hb i:nth-child(1) { top: 16px; }
.menu-btn .hb i:nth-child(2) { top: 22px; width: 13px; }
.menu-btn .hb i:nth-child(3) { top: 28px; }
.menu-btn.on .hb i:nth-child(1) { transform: translateY(6px) rotate(45deg); }
.menu-btn.on .hb i:nth-child(2) { opacity: 0; transform: translateX(8px); }
.menu-btn.on .hb i:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
.menu-btn .mb-lb { font-size: 13px; font-weight: 500; letter-spacing: .14em; color: var(--sub); min-width: 3.6em; text-align: right; order: -1; }
.menu-btn.on .mb-lb { color: var(--green-ink); }
@keyframes lpNavIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@media (max-width: 1200px) {
  .menu-btn { display: flex; }
  .nav.open { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
    margin: 4px 0 12px; padding: 18px 16px 16px; border-radius: 22px; position: relative; overflow: hidden;
    background: linear-gradient(160deg, var(--orange-soft) 0%, #fff 48%, var(--green-soft) 100%);
    box-shadow: 0 18px 40px -24px rgba(35,38,43,.35); animation: lpNavIn .26s ease both; }
  .nav.open::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px;
    background: linear-gradient(90deg, var(--orange), var(--green)); }
  .nav.open a { display: flex; align-items: center; gap: 12px; background: #fff; border: 1px solid var(--line);
    border-radius: 14px; padding: 15px 16px; font-size: 17px; color: var(--ink); animation: lpNavIn .3s ease both;
    transition: transform .15s, border-color .15s, box-shadow .15s; }
  .nav.open a::before { content: ""; width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--orange);
    box-shadow: 0 0 0 4px var(--orange-soft); }
  .nav.open a:nth-child(even)::before { background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
  .nav.open a:not(.rsv)::after { content: ""; display: block; width: 8px; height: 8px; margin: 0 4px 0 auto; background: none;
    border-top: 2px solid #b9bfb4; border-right: 2px solid #b9bfb4; border-radius: 1px; transform: rotate(45deg); }
  .nav.open a:hover { transform: translateY(-1px); border-color: #cfd6c8; box-shadow: 0 6px 14px -10px rgba(35,38,43,.4); }
  .nav.open a[aria-current="page"] { background: var(--cs, var(--orange-soft)); border-color: transparent; color: var(--ci, var(--orange-ink)); }
  .nav.open a[aria-current="page"]::after { display: block; border-color: currentColor; }
  .nav.open a:nth-child(2) { animation-delay: .03s; } .nav.open a:nth-child(3) { animation-delay: .06s; }
  .nav.open a:nth-child(4) { animation-delay: .09s; } .nav.open a:nth-child(5) { animation-delay: .12s; }
  .nav.open a:nth-child(6) { animation-delay: .15s; } .nav.open a:nth-child(7) { animation-delay: .18s; }
  .nav.open .rsv { grid-column: 1 / -1; justify-content: center; margin: 4px 0 0; border: 0; color: #fff; font-size: 18px;
    padding: 17px 16px; background: linear-gradient(135deg, var(--line-green), #2fb84a);
    box-shadow: 0 10px 22px -12px rgba(6,199,85,.7); }
  .nav.open .rsv::before { display: none; }
  .nav.open .rsv:hover { background: linear-gradient(135deg, #05b54d, #28a842); }
  .site-top .nav.open ~ .size { margin: 0 auto 14px; }
}
@media (max-width: 560px) {
  .nav.open { grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 16px 12px 14px; }
  .nav.open a { padding: 14px 14px; }
  .menu-btn .mb-lb { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .nav.open, .nav.open a { animation: none; }
  .menu-btn .hb, .menu-btn .hb i { transition: none; }
}
'''

c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-layout-v1" in cs, "先に patch_lifeplus_layout_v1.py が要ります"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_nav_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")

j = os.path.join(D, "site.js")
js = open(j, encoding="utf-8").read()
if MARK in js:
    print("済み site.js")
else:
    assert js.count(JS_OLD) == 1, "site.js のメニューの所が想定と違います"
    shutil.copyfile(j, j + ".bak_nav_v1")
    open(j, "w", encoding="utf-8").write(js.replace(JS_OLD, JS_NEW))
    print("直した site.js")

for rel in PAGES:
    p = os.path.join(D, rel)
    s = open(p, encoding="utf-8").read()
    if BTN_NEW in s:
        print("済み", rel); continue
    assert s.count(BTN_OLD) == 1, f"{rel}: メニューのボタンが想定と違います"
    s2 = s.replace(BTN_OLD, BTN_NEW)
    for a, b in VER:
        assert s2.count(a) == 1, f"{rel}: {a} の版が想定と違います"
        s2 = s2.replace(a, b)
    shutil.copyfile(p, p + ".bak_nav_v1")
    open(p, "w", encoding="utf-8").write(s2)
    print("直した", rel)

assert MARK in open(c, encoding="utf-8").read() and MARK in open(j, encoding="utf-8").read()
for rel in PAGES:
    s = open(os.path.join(D, rel), encoding="utf-8").read()
    assert BTN_NEW in s and 'site.css?v=20261028h"' not in s and 'site.js?v=20261028h"' not in s, rel  # 後の直しで版が進んでいてもよい
print("OK: メニューをオレンジ×グリーンのハンバーガーにしました（" + MARK + "）")
