#!/usr/bin/env python3
"""lifeplus-day-flow-sun-v1:
  ・「1日の流れ」の切り替えボタンに「日曜 1日型（9:30〜16:30）」を足して、午前の部・午後の部と横に並べる
  ・日曜を押すと、1日型の流れに切り替わる
  ・札の右上と帯の「120分」などの分数は出さない
    9:30 モーニングコーヒータイム／9:45 レベリー（昼食・屋外訓練の場所を全員で決める）／9:55 バイタル測定
    10:00 集団体操（棒体操・脳トレ体操・スチール体操・自重訓練など）／10:30 屋外訓練／12:00 昼食
    13:30 屋外訓練／15:00 おやつタイム／15:30 レク活動／16:20 帰りの支度
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_day_flow_sun_v1 を残す。
先に patch_lifeplus_day_flow_ex_v2.py が要ります。
"""
import os, re, shutil
MARK = "lifeplus-day-flow-sun-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")

ICON = {
 "coffee": '<path d="M4 9h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3c-.8 1 .8 2 0 3M12 3c-.8 1 .8 2 0 3"/>',
 "talk":   '<path d="M4 5h16v10H10l-5 4v-4H4z"/><path d="M8 9h8M8 12h5"/>',
 "vital":  '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
 "gym":    '<path d="M3 12h18M6 8v8M18 8v8M3.5 10v4M20.5 10v4"/>',
 "out":    '<path d="M12 3l5 7h-3l4 6H6l4-6H7z"/><path d="M12 16v5"/>',
 "meal":   '<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M9 4v4M12 3v5M15 4v4"/>',
 "snack":  '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r=".8"/><circle cx="14.5" cy="9.5" r=".8"/><circle cx="13" cy="14.5" r=".8"/><circle cx="8.5" cy="14" r=".8"/>',
 "rec":    '<circle cx="12" cy="12" r="8"/><path d="M4.5 9.5c4 1 11 1 15 0M4.5 14.5c4-1 11-1 15 0M12 4c-2.5 4-2.5 12 0 16"/>',
 "home":   '<path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/>',
}
# (アイコン, 時間, 名前, 分, 色, 説明)
STEPS = [
 ("coffee", "9:30",  "モーニングコーヒータイム", 15, "o", "コーヒーを飲みながら、ゆっくり1日を始めます。"),
 ("talk",   "9:45",  "レベリー",               10, "o", "その日の昼食と屋外訓練の場所を、利用者さん全員で話し合って決めます。"),
 ("vital",  "9:55",  "バイタル測定",            5, "o", "体温・血圧・脈を測って、その日の体調を確かめます。"),
 ("gym",    "10:00", "集団体操",               30, "x", "みんなで体を動かして、外へ出る準備をします。"),
 ("out",    "10:30", "屋外訓練",               90, "g", "みんなで決めた場所へ出かけて、実際の道を歩きます。"),
 ("meal",   "12:00", "昼食",                   90, "g", "みんなで決めたお昼ごはんを、いっしょに楽しみます。"),
 ("out",    "13:30", "屋外訓練",               90, "g", "午後も外へ。段差や坂のある道で、暮らしに使える体の力をつけます。"),
 ("snack",  "15:00", "おやつタイム",           30, "g", "ひと休みして、おやつと水分補給。"),
 ("rec",    "15:30", "レク活動",               50, "g", "頭と体をいっしょに使うレクリエーションを、みんなで。"),
 ("home",   "16:20", "帰りの支度",             10, "g", "忘れ物がないかを確かめて、ご自宅までお送りします。"),
]
GYM = ["棒体操", "脳トレ体操", "スチール体操", "自重訓練"]
BARC = {"coffee": "#f7b733", "talk": "#f4a62a", "vital": "#f0a51c", "gym": "#e88a00", "out": "#7bb83a", "meal": "#b9cf4a",
        "snack": "#8cc63f", "rec": "#4fa24a", "home": "#3b6c15"}
assert sum(m for *_, m, c, t in [(s[0], s[1], s[2], s[3], s[4], s[5]) for s in STEPS] for _ in [0]) if False else sum(s[3] for s in STEPS) == 420

def svg(k):
    return f'<svg viewBox="0 0 24 24" aria-hidden="true">{ICON[k]}</svg>'

bar = "".join(f'<span style="flex-grow:{m};background:{BARC[k]}" title="{n} {m}分">{("<b>" + n + "</b><i>" + str(m) + "分</i>") if m >= 60 else ""}</span>'
              for k, t, n, m, c, d in STEPS)
items = ""
for k, t, n, m, c, d in STEPS:
    cls = {"o": "", "g": " sg", "x": " s-train"}[c]
    ex = ""
    if k == "gym":
        ex = ('<ul class="flow-ex fx2" aria-label="集団体操の例">' + "".join(f"<li>{x}</li>" for x in GYM) + '<li class="etc">など</li></ul>')
    items += (f'\n        <li class="flow-step s-{k}{cls}"><time class="flow-t">{t}</time><span class="flow-dot" aria-hidden="true"></span>'
              f'<div class="flow-card"><div class="flow-hd"><span class="flow-ic">{svg(k)}</span><h3>{n}</h3><span class="flow-min">{m}分</span></div>'
              f'<p>{d}</p>{ex}</div></li>')
SUN = ('\n      <div class="flow-bar sun" aria-hidden="true"><div class="fb-line">' + bar + '</div>'
       '<div class="fb-ends"><span>9:30</span><span>16:30</span></div></div>\n'
       '      <ol class="flow-list sun"><!-- ' + MARK + ' -->' + items + '\n      </ol>')

REPL = [
 ('<input class="flow-r" type="radio" name="flow-u" id="flow-pm">',
  '<input class="flow-r" type="radio" name="flow-u" id="flow-pm">\n      <input class="flow-r" type="radio" name="flow-u" id="flow-sun">'),
 ('<label for="flow-pm"><b>午後の部</b><span>13:30〜16:30</span></label></div>',
  '<label for="flow-pm"><b>午後の部</b><span>13:30〜16:30</span></label><label for="flow-sun"><b>日曜 1日型</b><span>9:30〜16:30</span></label></div>'),
 ('<div class="flow-bar" aria-hidden="true">', '<div class="flow-bar wk" aria-hidden="true">'),
 ('<ol class="flow-list">', '<ol class="flow-list wk">'),
]
CSS = """
/* ---------- 1日の流れに日曜の1日型を足す（lifeplus-day-flow-sun-v1）---------- */
.flow .sun { display: none; }
.flow-min, .fb-line i { display: none; }
#flow-sun:checked ~ .wk { display: none; }
#flow-sun:checked ~ .flow-bar.sun { display: block; }
#flow-sun:checked ~ .flow-list.sun { display: block; }
#flow-sun:checked ~ .flow-tabs label[for="flow-sun"] {
  color: #fff; background: linear-gradient(135deg, #f7b733, #a7cf3c 55%, var(--green)); box-shadow: 0 8px 18px -10px rgba(110,185,44,.8); }
#flow-sun:focus-visible ~ .flow-tabs label[for="flow-sun"] { outline: 3px solid var(--orange); outline-offset: 2px; }
.flow-step.sg .flow-dot { border-color: var(--green); }
.flow-step.sg .flow-dot::after { background: var(--green); }
.flow-step.sg .flow-ic { background: var(--green-soft); color: var(--green-ink); }
@media (max-width: 760px) {
  .flow-tabs label { padding: 9px 4px 8px; }
  .flow-tabs b { font-size: 14.5px; white-space: nowrap; }
  .flow-tabs span { font-size: 11px; white-space: nowrap; }
  .flow-bar.sun .fb-line i { display: none; }
  .flow-bar.sun .fb-line > span { font-size: 11px; }
}
@media (max-width: 380px) { .flow-tabs b { font-size: 13.5px; } .flow-tabs span { font-size: 10.5px; letter-spacing: 0; } }
"""
c = os.path.join(D, "site.css")
cs = open(c, encoding="utf-8").read()
assert "lifeplus-day-flow-ex-v2" in cs, "先に patch_lifeplus_day_flow_ex_v2.py を流してください"
if MARK in cs:
    print("済み site.css")
else:
    shutil.copyfile(c, c + ".bak_day_flow_sun_v1")
    open(c, "w", encoding="utf-8").write(cs.rstrip("\n") + "\n" + CSS)
    print("直した site.css")
p = os.path.join(D, "dayservice", "index.html")
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み dayservice/index.html")
else:
    for a, b in REPL:
        assert s.count(a) == 1, f"想定と違います: {a[:40]}"
    i = s.find('<section class="flow"'); j = s.find('</section>', i)
    sec = s[i:j]
    END = '\n      </ol>\n    </div>'
    assert i >= 0 and sec.count(END) == 1, "1日の流れの終わりの所が想定と違います"
    assert len(re.findall(r'site\.css\?v=[0-9a-z]+"', s)) == 1, "site.css の版が想定と違います"
    shutil.copyfile(p, p + ".bak_day_flow_sun_v1")
    sec = sec.replace(END, '\n      </ol>' + SUN + '\n    </div>')
    s = s[:i] + sec + s[j:]
    for a, b in REPL:
        s = s.replace(a, b)
    s = re.sub(r'site\.css\?v=[0-9a-z]+"', 'site.css?v=20261028fs"', s)
    open(p, "w", encoding="utf-8").write(s)
    print("直した dayservice/index.html")
s = open(p, encoding="utf-8").read()
assert MARK in s and 'id="flow-sun"' in s and s.count('class="flow-step') == 15 and MARK in open(c, encoding="utf-8").read()
print("OK: 1日の流れに日曜の1日型を足しました（" + MARK + "）")
