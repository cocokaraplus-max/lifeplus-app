-- ============================================================
-- LIFE PLUS ホームページ  はたらく人の声（採用ページ）（marker: lifeplus-site-voices-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU の DEV・本番ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  ・site_voices  いま働いている職員の声（呼び名・職種や年数・ひとこと・話・写真・動画）
--      video_id   YouTube の動画の番号（11文字。管理画面には YouTube の URL を貼る。限定公開の動画でもよい）
--      photo_url  写真（storage の site に置く。だれでも見られる）
--      published  「出す」にしたものだけ採用ページに出る。1件も出していなければ、採用ページにこの欄そのものが出ない
--  ★書くのは関所（booking）だけ。外の役割には何も許さない
-- ============================================================

create table if not exists site_voices (
  id           uuid primary key default gen_random_uuid(),
  business     text not null default 'company' check (business in ('day', 'sekkotsu', 'bodycare', 'company')),
  display_name text not null check (char_length(display_name) <= 20),   -- 呼び名（例：Aさん・山田さん）
  role         text check (role is null or char_length(role) <= 40),     -- 職種・年数（例：介護職員・3年目）
  headline     text check (headline is null or char_length(headline) <= 80),
  body         text check (body is null or char_length(body) <= 1200),
  photo_url    text,
  video_id     text check (video_id is null or video_id ~ '^[A-Za-z0-9_-]{11}$'),
  published    boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table site_voices enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on site_voices from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on site_voices from authenticated';
  end if;
end $$;

select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'site_voices') as table_1,
  (select relrowsecurity from pg_class where relname = 'site_voices')                                          as rls_on_true,
  (select count(*) from information_schema.role_table_grants
     where table_name = 'site_voices' and grantee in ('anon', 'authenticated', 'PUBLIC'))                     as outside_grants_0;
