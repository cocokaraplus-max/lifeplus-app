#!/usr/bin/env python3
"""lifeplus-flow-text-v1:
  ・デイの「1日の流れ」の個別機能訓練の説明を差し替える
    前：お一人おひとりの体に合わせて、職員が手を添えながら訓練します。
    後：お一人おひとりの状態に合わせて機能訓練指導員がプランを作成いたします。
  ・トップのいちばん上の「LINEで予約」ボタンを外す（「事業を見る」だけにする。メニューの中の LINEで予約 はそのまま）
何度流しても同じ結果になる。直す前に .bak_flow_text_v1 を残す。
"""
import os, re, shutil
MARK = "lifeplus-flow-text-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "docs")
T_OLD = "<p>お一人おひとりの体に合わせて、職員が手を添えながら訓練します。</p>"
T_NEW = "<p>お一人おひとりの状態に合わせて機能訓練指導員がプランを作成いたします。</p>"
B_PAT = r'(<div class="btn-row"><a class="btn dark" href="#services">事業を見る</a>)<a class="btn line" href="[^"]*">.*?LINEで予約</a>(</div>)'
B_NEW = '<div class="btn-row" data-v="' + MARK + '"><a class="btn dark" href="#services">事業を見る</a></div>'

p = os.path.join(D, "dayservice", "index.html")
s = open(p, encoding="utf-8").read()
if T_NEW in s and T_OLD not in s:
    print("済み dayservice/index.html")
else:
    assert s.count(T_OLD) == 1, "個別機能訓練の説明が想定と違います"
    shutil.copyfile(p, p + ".bak_flow_text_v1")
    open(p, "w", encoding="utf-8").write(s.replace(T_OLD, T_NEW))
    print("直した dayservice/index.html")

p2 = os.path.join(D, "index.html")
s = open(p2, encoding="utf-8").read()
if MARK in s:
    print("済み index.html")
else:
    assert len(re.findall(B_PAT, s)) == 1, "トップの上のボタンの所が想定と違います"
    shutil.copyfile(p2, p2 + ".bak_flow_text_v1")
    open(p2, "w", encoding="utf-8").write(re.sub(B_PAT, lambda m: B_NEW, s))
    print("直した index.html")

assert T_NEW in open(p, encoding="utf-8").read()
s = open(p2, encoding="utf-8").read()
assert B_NEW in s and 'class="rsv"' in s
print("OK: 訓練の説明を差し替え、トップの上の予約ボタンを外しました（" + MARK + "）")
