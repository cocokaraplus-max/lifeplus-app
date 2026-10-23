-- ============================================================
-- LIFE PLUS ホームページ  お問い合わせ（marker: lifeplus-contact-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  ホームページのお問い合わせフォーム（デイサービスなど）から届いたものを残す表。
--  ★届いたら HIROさんの LINE にも知らせる。LINE が届かなくても、ここに残るので消えない
--  ★書くのは関所（booking）だけ。画面から直接は読み書きさせない（RLS をかけて、外の役割には何も許さない）
--  ★送り主の IP アドレスはそのまま残さない（いたずら止めのために、ぼかした値だけ）
-- ============================================================

create table if not exists contact_messages (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  business    text not null check (business in ('day', 'sekkotsu', 'bodycare', 'other')),
  kind        text not null,
  name        text not null,
  org         text,               -- ケアマネジャーさんの事業所名など（任意）
  phone       text,
  email       text,
  body        text,
  ip_hash     text,               -- いたずら止め（同じ所から何回も、を数える）
  status      text not null default 'new' check (status in ('new', 'done'))
);
create index if not exists contact_messages_created_idx on contact_messages (created_at desc);
create index if not exists contact_messages_ip_idx on contact_messages (ip_hash, created_at desc);

alter table contact_messages enable row level security;
revoke all on contact_messages from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on contact_messages from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on contact_messages from authenticated';
  end if;
end $$;

-- 確認（これが結果として返る）
--   table_1 = 1・rls_on_true = true・outside_grants_0 = 0
select
  (select count(*) from information_schema.tables where table_name = 'contact_messages')        as table_1,
  (select relrowsecurity from pg_class where relname = 'contact_messages')                     as rls_on_true,
  (select count(*) from information_schema.role_table_grants
     where table_name = 'contact_messages' and grantee in ('anon', 'authenticated', 'PUBLIC'))  as outside_grants_0;
