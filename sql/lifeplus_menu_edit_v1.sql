-- ============================================================
-- LIFE PLUS 予約  予約メニューを管理画面から作る・直す（marker: lifeplus-menu-edit-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU の DEV・本番ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  ・menus.price_label  料金の所に出す言葉（例：来院時にご案内）。入っていれば、料金・「保険診療」の代わりにこれを出す
-- ============================================================

alter table menus add column if not exists price_label text;
alter table menus drop constraint if exists menus_price_label_len;
alter table menus add constraint menus_price_label_len check (price_label is null or char_length(price_label) <= 30);

select
  (select count(*) from information_schema.columns where table_name = 'menus' and column_name = 'price_label') as price_label_1,
  (select count(*) from menus where is_active)                                                                   as active_menus;
