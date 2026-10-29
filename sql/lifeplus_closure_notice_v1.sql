-- ============================================================
-- LIFE PLUS 予約  休みにお客さま向けのお知らせを付ける（marker: lifeplus-closure-notice-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU の DEV・本番ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  ・closures.notice  お客さまの予約カレンダーに出すお知らせ（例：年末年始のお休み）。60字まで。空ならお知らせは出さない
--    note（自分用のメモ・お客さまには見えない）とは別
-- ============================================================

alter table closures add column if not exists notice text;
alter table closures drop constraint if exists closures_notice_len;
alter table closures add constraint closures_notice_len check (notice is null or char_length(notice) <= 60);

select
  (select count(*) from information_schema.columns
     where table_name = 'closures' and column_name = 'notice')                                 as notice_column_1,
  (select count(*) from pg_constraint where conname = 'closures_notice_len')                    as notice_check_1,
  (select bool_and(relrowsecurity) from pg_class where relname = 'closures')                    as rls_on_true;
