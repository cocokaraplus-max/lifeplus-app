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

## 2026-10-23 お店の端末（LINE を使わずに予約管理を開く）（marker: admin-device-v1）
- HIROさんの管理画面：スタッフ → お店の端末 → 「番号を出す」。6桁の番号（15分・1回だけ）が出る
- お店のPC・タブレットのブラウザで `https://cocokaraplus-max.github.io/lifeplus-app/admin/` を開き、番号を入れると登録。次からは開くだけ
- 端末にできること：休み・予約・お客さまから選ぶ（予約表を見るのは全員）。設定・スタッフはHIROさんだけ。LINE の通知は受け取れない
- 外す：HIROさんの一覧から／端末の「登録を外す」。番号を出し直すと、それまでの端末は使えなくなる。180日開かなかった端末も使えなくなる
- 番号の入れ間違いは同じ所から1時間に10回・全体で50回まで
- 表：`sql/lifeplus_devices_v1.sql`（admin_devices・device_pair_fails。番号も合鍵もハッシュだけ）
- 確かめ：`tests/device_test.ts`（関所 12項目）・`tests/e2e_device_test.py`（画面 11項目）

## 2026-10-28 ホームページを管理画面から変える・採用ページ（marker: lifeplus-site-cms-v1 / lifeplus-insta-v2）
- 管理画面に「HP」タブ（権限 `site`。HIROさん・権限を渡したスタッフ・お店の端末）
  | 変えられる所 | 中身 |
  |---|---|
  | お知らせ | 日付・出す場所（すべて／デイ／接骨院／ボディケア）・題名・くわしく・この日まで・下書き。トップは5件、各事業のページは3件 |
  | 求人 | どの事業の募集か（デイ／接骨院／ボディケア／会社全体）・職種・雇用の形・仕事の内容・条件・給与・時間・休日・待遇・募集中かどうか |
  | デイの時間 | 平日の午前・午後・日曜・営業日（デイのページの「ご利用の案内」） |
  | ボディケアの料金 | 名前・料金（★予約ページの menus と同じ）・ホームページの説明・おすすめ。時間（分）は変えない |
  | 写真 | 決まった12か所（`PHOTO_SLOTS`）。端末で長い辺1800に小さくしてから送る。storage の `site`（だれでも見られる）に置く |
- 接骨院・ボディケアの受付時間は、設定の受付時間（kind=public）をそのまま出す（`data-rsv-cell`・`data-rsv-hours`）
- だれでも読める関所 `action: "site"`。ページは元の中身を持っていて、読めたら差し替える（`site.js` の後半）
- 採用ページ `docs/recruit/`。応募は `contact`（business=recruit・jobId）→ contact_messages に残して LINE で知らせる
- アプリ開発のお問い合わせはフォーム（business=apps）。メールアドレスはページに書かず、画面で組み立てる（`data-mail`）
- 表：`sql/lifeplus_site_v1.sql`（site_news・site_jobs・site_content、権限に site、storage の site）
- 確かめ：`tests/site_test.ts`（関所 10項目）・`tests/e2e_cms_test.py`（画面 37項目）
  ★テスト用DBは `now()` をテストの「今」にそろえる：`create function public.now() …` と `alter database … set search_path = public, pg_catalog`

## 2026-10-29 期間の休み・お休みのお知らせ（marker: lifeplus-closure-notice-v1）
- 管理画面の「休み」に「期間で休みを入れる（お盆・年末年始など）」。カレンダーで始まりの日 → 終わりの日を押す（月をまたいでよい・受付のない日も押せる）と、期間・何日間（受付日が何日か）が出る
- 休みに「お客さまへのお知らせ」（60字まで・なくてもよい）を付けられる。例のボタン：年末年始のお休み／お盆休み／臨時休業／研修のため休み。1日の休みにも付けられる。一覧の「お知らせ」から、あとで変える・空にして消すこともできる（休みはそのまま）
- お知らせのある休みは、お客さまの予約カレンダーの上に「お休みのお知らせ」として出る（これからの休みで、予約できる日までに始まるもの・5件まで）。メモ（自分用）は出ない
- お客さまのカレンダーは、見せる受付時間（kind=public）のある曜日だけを受付日にする（手入力だけの曜日が「×満席」に見えていたのを「休」に）
- 表：`sql/lifeplus_closure_notice_v1.sql`（closures に notice）。★関所より先に流す（流さないうちに関所を入れ替えると、予約カレンダーが開かなくなる）
- 関所：`month` に notices、`admin_closures` に notice、`admin_closure_add` が notice を受ける、`admin_closure_update`（お知らせだけ変える・権限 closures）
- 確かめ：`tests/closure_notice_test.ts`（関所 7項目）・`tests/e2e_closure_test.py`（画面 18項目）
