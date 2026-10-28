#!/usr/bin/env python3
"""lifeplus-day-flow-v1:
  ・デイサービスのページに「1日の流れ」を作る（「大切にしていること」と「日曜の1日型」の間）
    午前の部・午後の部をボタンで切り替え（時間だけが変わる。JSなしで動く）
    上に3時間の割合の帯、下に時間の縦の流れ。個別機能訓練は大きな札にして、訓練の例を並べる
  ・時間：9:00 バイタル測定／9:15 個別機能訓練／11:15 お茶休憩／11:30 レク活動／11:50 帰りの支度
    午後は同じ流れを4時間30分あと（13:30〜）にしています
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_day_flow_v1 を残す。
"""
import os, re, shutil
MARK = "lifeplus-day-flow-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
ANCHOR = '<section class="oneday" id="oneday">'

ICON = {
 "vital": '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
 "train": '<circle cx="12" cy="4.5" r="2"/><path d="M12 7v6l-3 7M12 13l3 7M7 10l5-2 5 2"/>',
 "tea":   '<path d="M4 9h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3c-.8 1 .8 2 0 3M12 3c-.8 1 .8 2 0 3"/>',
 "rec":   '<circle cx="12" cy="12" r="8"/><path d="M4.5 9.5c4 1 11 1 15 0M4.5 14.5c4-1 11-1 15 0M12 4c-2.5 4-2.5 12 0 16"/>',
 "home":  '<path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/>',
}
def svg(k):
    return f'<svg viewBox="0 0 24 24" aria-hidden="true">{ICON[k]}</svg>'

# (アイコン, 午前, 午後, 名前, 分, 説明)
STEPS = [
 ("vital", "9:00",  "13:30", "バイタル測定", 15,  "体温・血圧・脈を測って、その日の体調を確かめます。訓練の内容も、ここで決めます。"),
 ("train", "9:15",  "13:45", "個別機能訓練", 120, "お一人おひとりの体に合わせて、職員が手を添えながら訓練します。"),
 ("tea",   "11:15", "15:45", "お茶休憩",     15,  "ひと息ついて水分補給。おしゃべりも楽しみのひとつです。"),
 ("rec",   "11:30", "16:00", "レク活動",     20,  "頭と体をいっしょに使うレクリエーションを、みんなで。"),
 ("home",  "11:50", "16:20", "帰りの支度",   10,  "忘れ物がないかを確かめて、ご自宅までお送りします。"),
]
EXAMPLES = [("歩く練習", "平らな床から、屋外の道まで"), ("立ち上がりの練習", "いすから立つ・座る"),
            ("段差・階段の練習", "家の上がりかまちを想定して"), ("ストレッチ", "固くなった所をゆっくり伸ばす"),
            ("手と指の運動", "つまむ・にぎる・ひねる"), ("家でできる体操", "身近な物を使って")]

def tm(am, pm):
    return f'<span class="t-am">{am}</span><span class="t-pm">{pm}</span>'

bar = "".join(f'<span class="fb-{k}" style="flex-grow:{m}" title="{n} {m}分">{("<b>" + n + "</b><i>" + str(m) + "分</i>") if m >= 60 else ""}</span>'
              for k, a, p, n, m, t in STEPS)
items = ""
for k, a, p, n, m, t in STEPS:
    ex = ""
    if k == "train":
        ex = ('<ul class="flow-ex" aria-label="訓練の例">' +
              "".join(f'<li><b>{x}</b><span>{y}</span></li>' for x, y in EXAMPLES) + '</ul>')
    items += (f'\n        <li class="flow-step s-{k}"><time class="flow-t">{tm(a, p)}</time><span class="flow-dot" aria-hidden="true"></span>'
              f'<div class="flow-card"><div class="flow-hd"><span class="flow-ic">{svg(k)}</span><h3>{n}</h3><span class="flow-min">{m}分</span></div>'
              f'<p>{t}</p>{ex}</div></li>')

SECTION = ('<section class="flow" id="flow"><!-- ' + MARK + ' -->\n  <div class="wrap">\n'
           '    <div class="flow-top"><div class="sec-head"><span class="en">Schedule</span><h2>1日の流れ</h2></div>\n'
           '      <p class="muted flow-note">平日は午前・午後の2つの部。どちらも3時間です。<br>日曜は9:30〜16:30の1日型です（<a href="#oneday">日曜の1日型へ</a>）。</p></div>\n'
           '    <div class="flow-box">\n'
           '      <input class="flow-r" type="radio" name="flow-u" id="flow-am" checked>\n'
           '      <input class="flow-r" type="radio" name="flow-u" id="flow-pm">\n'
           '      <div class="flow-tabs"><label for="flow-am"><b>午前の部</b><span>9:00〜12:00</span></label>'
           '<label for="flow-pm"><b>午後の部</b><span>13:30〜16:30</span></label></div>\n'
           f'      <div class="flow-bar" aria-hidden="true"><div class="fb-line">{bar}</div>'
           f'<div class="fb-ends"><span>{tm("9:00", "13:30")}</span><span>{tm("12:00", "16:30")}</span></div></div>\n'
           f'      <ol class="flow-list">{items}\n      </ol>\n    </div>\n  </div>\n</section>\n\n')

CSS = """
/* ---------- デイの1日の流れ（lifeplus-day-flow-v1）---------- */
.flow { background: radial-gradient(80% 60% at 100% 0%, var(--green-soft) 0%, transparent 60%), radial-gradient(70% 50% at 0% 100%, var(--orange-soft) 0%, transparent 60%), #fff; }
.flow-top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 32px; margin-bottom: clamp(20px, 3vw, 32px); }
.flow-top .sec-head { margin-bottom: 0; }
.flow-note { margin: 0; font-size: 15px; line-height: 1.8; }
.flow-note a { color: var(--orange-ink); }
.flow-box { max-width: 860px; }
.flow-r { position: absolute; opacity: 0; pointer-events: none; }
.flow-tabs { display: inline-flex; padding: 5px; gap: 4px; border-radius: 999px; background: #fff; border: 1px solid var(--line);
  box-shadow: 0 10px 24px -18px rgba(35,38,43,.5); margin-bottom: 22px; }
.flow-tabs label { cursor: pointer; display: flex; flex-direction: column; align-items: center; padding: 9px 26px 8px; border-radius: 999px;
  line-height: 1.3; color: var(--sub); transition: background .25s, color .25s, box-shadow .25s; -webkit-tap-highlight-color: transparent; }
.flow-tabs b { font-family: var(--head); font-size: 16px; }
.flow-tabs span { font-size: 12px; letter-spacing: .04em; font-variant-numeric: tabular-nums; }
#flow-am:checked ~ .flow-tabs label[for="flow-am"], #flow-pm:checked ~ .flow-tabs label[for="flow-pm"] {
  color: #fff; background: linear-gradient(135deg, var(--orange), #f7b733 55%, #a7cf3c); box-shadow: 0 8px 18px -10px rgba(243,152,0,.8); }
#flow-am:focus-visible ~ .flow-tabs label[for="flow-am"], #flow-pm:focus-visible ~ .flow-tabs label[for="flow-pm"] { outline: 3px solid var(--orange); outline-offset: 2px; }
.flow .t-pm { display: none; }
#flow-pm:checked ~ * .t-am { display: none; }
#flow-pm:checked ~ * .t-pm { display: inline; }
.flow-bar { margin: 0 0 clamp(26px, 4vw, 40px); }
.fb-line { display: flex; gap: 3px; height: 34px; border-radius: 12px; overflow: hidden; }
.fb-line > span { min-width: 8px; display: flex; align-items: center; justify-content: center; gap: 8px; color: #fff; font-size: 13px; white-space: nowrap; }
.fb-line b { font-family: var(--head); font-weight: 700; } .fb-line i { font-style: normal; opacity: .85; font-variant-numeric: tabular-nums; }
.fb-vital { background: #f7b733; } .fb-train { background: linear-gradient(90deg, var(--orange), #c9c636 60%, var(--green)); }
.fb-tea { background: #8cc63f; } .fb-rec { background: #4fa24a; } .fb-home { background: var(--green-ink); }
.fb-ends { display: flex; justify-content: space-between; margin-top: 6px; font-size: 13px; color: var(--sub); font-variant-numeric: tabular-nums; }
.flow-list { list-style: none; margin: 0; padding: 0; }
.flow-step { display: grid; grid-template-columns: 76px 22px minmax(0, 1fr); column-gap: 14px; position: relative; padding-bottom: 18px; }
.flow-step::before { content: ""; position: absolute; left: calc(76px + 14px + 10px); top: 14px; bottom: -14px; width: 2px;
  background: linear-gradient(180deg, var(--orange), var(--green)); opacity: .35; }
.flow-step:last-child::before { display: none; }
.flow-t { font-family: var(--head); font-weight: 700; font-size: clamp(24px, 2.6vw, 30px); line-height: 1; text-align: right; padding-top: 12px;
  color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: .01em; }
.flow-dot { width: 22px; height: 22px; margin-top: 12px; border-radius: 50%; background: #fff; border: 2px solid var(--orange); position: relative; z-index: 1;
  box-shadow: 0 0 0 5px #fff; }
.flow-dot::after { content: ""; position: absolute; inset: 4px; border-radius: 50%; background: var(--orange); }
.s-tea .flow-dot, .s-rec .flow-dot, .s-home .flow-dot { border-color: var(--green); }
.s-tea .flow-dot::after, .s-rec .flow-dot::after, .s-home .flow-dot::after { background: var(--green); }
.flow-card { background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 16px 20px 18px;
  box-shadow: 0 14px 30px -26px rgba(35,38,43,.55); transition: transform .25s ease, box-shadow .25s ease; }
.flow-card:hover { transform: translateY(-2px); box-shadow: 0 18px 34px -24px rgba(35,38,43,.55); }
.flow-hd { display: flex; align-items: center; gap: 12px; }
.flow-ic { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--orange-soft); color: var(--orange-ink); }
.s-tea .flow-ic, .s-rec .flow-ic, .s-home .flow-ic { background: var(--green-soft); color: var(--green-ink); }
.flow-ic svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.flow-hd h3 { font-size: 19px; margin: 0; }
.flow-min { margin-left: auto; font-size: 13px; color: var(--sub); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.flow-card > p { margin: 8px 0 0; font-size: 15px; line-height: 1.8; color: var(--sub); }
.s-train .flow-card { border: 0; color: #fff; padding: 22px 24px 24px; position: relative; overflow: hidden;
  background: linear-gradient(140deg, #e88a00 0%, #f0a51c 30%, #8dbd33 75%, #4f9a2a 100%); box-shadow: 0 24px 40px -26px rgba(110,140,30,.8); }
.s-train .flow-card::after { content: ""; position: absolute; right: -40px; top: -40px; width: 180px; height: 180px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,.28), transparent 70%); pointer-events: none; }
.s-train .flow-ic { background: rgba(255,255,255,.22); color: #fff; }
.s-train .flow-hd h3 { font-size: 22px; }
.s-train .flow-min { color: #fff; border-color: rgba(255,255,255,.55); }
.s-train .flow-card > p { color: rgba(255,255,255,.95); }
.flow-ex { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; position: relative; z-index: 1; }
.flow-ex li { background: rgba(255,255,255,.94); color: var(--ink); border-radius: 14px; padding: 10px 12px 11px; display: flex; flex-direction: column; gap: 2px; }
.flow-ex b { font-family: var(--head); font-size: 15px; display: block; line-height: 1.45; }
.flow-ex b::before { content: ""; display: inline-block; vertical-align: .2em; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--orange); }
.flow-ex li:nth-child(even) b::before { background: var(--green); }
.flow-ex span { font-size: 12.5px; color: var(--sub); line-height: 1.5; }
@media (max-width: 760px) {
  .flow-tabs { display: flex; width: 100%; }
  .flow-tabs label { flex: 1; padding: 9px 8px 8px; }
  .flow-step { grid-template-columns: 54px 18px minmax(0, 1fr); column-gap: 10px; padding-bottom: 14px; }
  .flow-step::before { left: calc(54px + 10px + 8px); }
  .flow-t { font-size: 19px; padding-top: 13px; }
  .flow-dot { width: 18px; height: 18px; margin-top: 12px; } .flow-dot::after { inset: 3px; }
  .flow-card { padding: 13px 14px 14px; border-radius: 16px; }
  .flow-ic { width: 34px; height: 34px; border-radius: 10px; } .flow-ic svg { width: 19px; height: 19px; }
  .flow-hd { gap: 10px; } .flow-hd h3 { font-size: 17px; }
  .s-train .flow-card { padding: 16px 12px 14px; } .s-train .flow-hd h3 { font-size: 17px; }
  .flow-card > p { font-size: 14px; line-height: 1.7; }
  .flow-ex { grid-template-columns: minmax(0, 1fr); gap: 5px; margin-top: 12px; }
  .flow-ex li { padding: 8px 12px 9px; border-radius: 11px; gap: 1px; }
  .flow-ex span { padding-left: 11px; }
  .s-train .flow-hd h3 { white-space: nowrap; }
  .flow-ex b { font-size: 14px; } .flow-ex span { font-size: 12px; line-height: 1.45; }
  .flow-ex b::before { width: 6px; height: 6px; margin-right: 5px; }
  .fb-line { height: 28px; border-radius: 10px; } .fb-line > span { font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) { .flow-card, .flow-tabs label { transition: none; } }
"""

c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-day-oneday-v1" in cs, "先に patch_lifeplus_day_oneday_v1.py が要ります"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_day_flow_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
p = os.path.join(D, "dayservice", "index.html")
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み dayservice/index.html")
else:
    assert s.count(ANCHOR) == 1, "日曜の1日型の所が想定と違います"
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, "site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_day_flow_v1")
    s = s.replace(ANCHOR, SECTION + ANCHOR)
    s = re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261028fl"', s)
    open(p, "w", encoding="utf-8").write(s)
    print("直した dayservice/index.html")
s = open(p, encoding="utf-8").read()
assert MARK in s and s.count('class="flow-step') == 5 and s.count("<li><b>") == 6 and MARK in open(c, encoding="utf-8").read()
print("OK: デイに1日の流れを入れました（" + MARK + "）")
