# LIFE PLUS 予約（もみの木接骨院・HIROボディケアスタジオ）

LINE（LIFF）から開く予約ページと、その裏の関所。TASUKARU とは別のアプリ。

## 中身
| 場所 | 役割 |
|---|---|
| `docs/` | 予約ページ（GitHub Pages で公開）。`config.js` に LIFF ID と関所の URL |
| `supabase/functions/booking/index.ts` | 関所（Supabase Edge Function）。LINE に本人確認してから予約・取消・登録をする |
| `sql/lifeplus_schema_v1.sql` | 表の作成（流し済み 2026-10-16） |
| `sql/lifeplus_functions_v1.sql` | 空き枠の計算と予約の受付（流し済み 2026-10-16） |
| `tests/` | 確かめ用（本番には関係しない） |

## 決まりごと
- 受付：月・木 17:00〜20:00、土 9:00〜12:00。祝日も受付。休みは closures に入れる
- 接骨院は15分枠、ボディケアは施術時間＋片付け15分を占有。予定表は1本（重なりはDBの排他制約で止める）
- 初めての人は仮予約（HIROさんが承認して確定）、通院中（is_returning）の人は確定
- 症状は選択式だけ（自由記述なし＝営業文を書く場所がない）。1人3件まで
- 予約の締め切り・取消の締め切りは開始60分前、予約できるのは60日先まで（app_settings）

## 確かめ方（手元）
```
TEST_DB_URL=postgres://... deno test -A tests/booking_test.ts   # 関所 16項目
deno run -A tests/e2e_server.ts & python3 tests/e2e_test.py      # 画面 11項目
```

## 2026-10-22 設定画面・手入力だけの時間（marker: lifeplus-settings-v1 / lifeplus-hours-kind-v1）
- 管理画面に「設定」タブ（HIROさんだけ）：曜日ごとの受付時間と、予約の決まりごと（締め切り・何日先まで・ドタキャンの回数）
- 受付時間に種類：**見せる**（お客さまの予約ページで選べる）／**手入力だけ**（予約表にうっすら出て、管理画面から手で入れるときだけ選べる。知り合いなど）
- 手で予約を入れるときは「受付時間の外も出す」で、6時〜23時の空いている時間も選べる
- 表の直し：`sql/lifeplus_hours_v2.sql`（business_hours に kind。お客さまの空き枠は kind='public' だけ）
- 確かめ：`tests/settings_test.ts`（関所 9項目）・`tests/e2e_settings_test.py`（画面 16項目）
  ★空き枠は DB の now() で決まるので、テスト用DBでは now() をテストの「今」（2026-10-16 12:00）にそろえてから流す

## 2026-10-23 ホームページ（marker: lifeplus-site-v1 / site-contact-v1）
- `docs/` の入口をホームページにした。予約ページは `docs/yoyaku/` へ移した（中身は同じ。`config.js` は `docs/` に置いたまま、予約・管理画面の両方が読む）
  | 場所 | 中身 |
  |---|---|
  | `docs/index.html` | トップ（ひとつの建物に3つの入口・3事業・予約と問い合わせのしかた・アクセス・会社） |
  | `docs/dayservice/` | 機能訓練型デイサービス ココカラプラス（見学・相談のお問い合わせフォームつき） |
  | `docs/sekkotsu/` | もみの木接骨院（受付時間・保険・交通事故のQ&A） |
  | `docs/bodycare/` | HIROボディケアスタジオ（メニュー・プロフィール・Q&A） |
  | `docs/site.css` `docs/site.js` | ホームページ共通の見た目・文字の大きさ・メニュー・フォーム |
  | `docs/yoyaku/` | 予約ページ（LIFF） |
- 予約ボタンは `https://liff.line.me/2012042545-nlHLpIre/yoyaku/`。リッチメニューの古いリンク（`…/2012042545-nlHLpIre`）でトップが開いたときは、LIFF の中なら予約ページへ移る
- お問い合わせ：関所（booking）の `contact`。LINE のログインは要らない。`contact_messages` 表に残して、HIROさん（と「知らせ」の権限がある人）の LINE に知らせる
  - いたずら・営業よけ：URL を書いたものは断る／見えない欄が埋まっている・開いて3秒以内は捨てる／同じ所から1時間に3件・全体で1日50件まで
  - 表：`sql/lifeplus_contact_v1.sql`
- 確かめ：`tests/contact_test.ts`（関所 7項目）・`tests/e2e_site_test.py`（画面 38項目・スマホとパソコン）

## 2026-10-23 ホームページの作り直し（marker: lifeplus-site-v2）
- 色は会社のロゴ（オレンジ #f39800 × グリーン #6eb92c）から。デイ＝オレンジ／接骨院＝グリーン／ボディケア＝藤墨（#5a4b78）
- 書体：見出し Zen Kaku Gothic New・本文 BIZ UDPゴシック・英字 Outfit
- ロゴ：`docs/img/`（logo.png・wordmark.png・wordmark-w.png・mark.svg＝ロゴの＋を描き直したもの・icon-*.png）
- 見た目の確かめ：`FONTS_DIR=…（@fontsource の zen-kaku-gothic-new / outfit / biz-udpgothic を入れた所） python3 tests/e2e_site_test.py <写真の置き場>`

## 2026-10-23 スマホの配置・文言（marker: lifeplus-site-v3）
- スマホ：文字の大きさはメニューの中へ／トップの＋は見出しの右上／各ページの頭・営業時間の帯・メニュー・プロフィール・足もとを詰める
- ボディケアのメニュー：おすすめの行も、名前と金額の縦の列をほかとそろえる。コース名を「ちょっとお試しコース／眠れるボディケアコース／至福のボディケアコース」に
- デイ：種別に「介護予防通所サービス」、対象に要支援1・2を追加
- 接骨院：「症状別の対応」・亜急性症状は保険外の説明を追加。各ページの「場所」を「アクセス」に
- 確かめ：`tests/e2e_site_test.py`（画面 39項目）

## 2026-10-23 社訓とデイの時間（marker: lifeplus-site-v4）
- トップ：社訓「和顔愛語」を独立した帯で載せる（デイのページからは移した）
- デイ：ご利用時間を「平日2単位制 9:00〜12:00・13:30〜16:30／日曜1日型 9:30〜16:30」に
