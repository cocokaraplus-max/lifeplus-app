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
