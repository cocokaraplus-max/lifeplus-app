#!/usr/bin/env python3
"""lifeplus-tsk-prof-v1:
  ・アプリ開発のページの「タスカルくん」のプロフィールを直す
    得意わざ：記録と書類の下書きを、あっという間に！介護現場の時間を節約
    活躍の場：介護の現場ならどこへでも（「出動先」から名前を変える）
    好きな言葉：時は金なり（足す）
  ・「正体」「目印」はそのまま
何度流しても同じ結果になる（marker があれば飛ばす）。直す前に .bak_tsk_prof_v1 を残す。
"""
import os, shutil
MARK = "lifeplus-tsk-prof-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(HERE, "docs", "apps", "index.html")
OLD = ('        <dt>得意わざ</dt><dd>記録と書類の下書きを、あっという間に</dd>\n'
       '        <dt>出動先</dt><dd>介護の現場ならどこへでも</dd>\n')
NEW = ('        <dt>得意わざ</dt><dd>記録と書類の下書きを、あっという間に！介護現場の時間を節約</dd>\n'
       '        <dt>活躍の場</dt><dd>介護の現場ならどこへでも</dd>\n'
       '        <dt>好きな言葉</dt><dd>時は金なり</dd><!-- ' + MARK + ' -->\n')
s = open(p, encoding="utf-8").read()
if MARK in s:
    print("済み docs/apps/index.html")
else:
    assert s.count(OLD) == 1, "タスカルくんのプロフィールの所が想定と違います"
    shutil.copyfile(p, p + ".bak_tsk_prof_v1")
    open(p, "w", encoding="utf-8").write(s.replace(OLD, NEW))
    print("直した docs/apps/index.html")
assert NEW in open(p, encoding="utf-8").read()
print("OK: タスカルくんのプロフィールを直しました（" + MARK + "）")
