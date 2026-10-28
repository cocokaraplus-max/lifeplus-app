-- ============================================================
-- LIFE PLUS ホームページ  管理画面から変えられる所・求人（marker: lifeplus-site-cms-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU の DEV・本番ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  ・site_news     お知らせ（休み・イベントなど。トップと各事業のページに出る）
--  ・site_jobs     求人（どの事業の募集か・雇用の形・仕事の中身・給与など。募集中だけ採用ページに出る）
--  ・site_content  そのほかの変えられる所（デイの利用時間・ボディケアの説明文とおすすめ・写真の差し替え）
--  ・contact_messages に「アプリ開発（apps）」「採用（recruit）」のお問い合わせを足す
--  ・写真を置く入れ物（storage の site。だれでも見られる。書くのは関所だけ）
--  ★書くのは関所（booking）だけ。画面から直接は読み書きさせない（RLS をかけて、外の役割には何も許さない）
-- ============================================================

-- 管理画面の権限に「site（ホームページの変更）」を足す（LINE のスタッフ・お店の端末の両方）
alter table staff_members drop constraint if exists staff_perms_ok;
alter table staff_members add constraint staff_perms_ok
  check (perms <@ array['closures','bookings','customers','notify','site']::text[]);
alter table admin_devices drop constraint if exists device_perms_ok;
alter table admin_devices add constraint device_perms_ok
  check (perms <@ array['closures','bookings','customers','staff','settings','site']::text[]);

-- お問い合わせの種類を足す
alter table contact_messages drop constraint if exists contact_messages_business_check;
alter table contact_messages add constraint contact_messages_business_check
  check (business in ('day', 'sekkotsu', 'bodycare', 'apps', 'recruit', 'other'));

create table if not exists site_news (
  id          uuid primary key default gen_random_uuid(),
  news_date   date not null,
  title       text not null,
  body        text,
  business    text not null default 'all' check (business in ('all', 'day', 'sekkotsu', 'bodycare')),
  published   boolean not null default true,
  until_date  date,                 -- この日を過ぎたら出さない（任意）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists site_news_date_idx on site_news (news_date desc);

create table if not exists site_jobs (
  id           uuid primary key default gen_random_uuid(),
  business     text not null check (business in ('day', 'sekkotsu', 'bodycare', 'company')),
  title        text not null,       -- 職種（例：介護職員）
  employment   text not null,       -- 正社員・パートなど
  summary      text,                -- ひとこと
  duties       text,                -- 仕事の中身
  requirements text,                -- 資格・経験
  salary       text,
  hours        text,                -- 勤務時間
  holidays     text,
  benefits     text,                -- 待遇・手当
  is_open      boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists site_content (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table site_news enable row level security;
alter table site_jobs enable row level security;
alter table site_content enable row level security;
revoke all on site_news, site_jobs, site_content from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on site_news, site_jobs, site_content from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on site_news, site_jobs, site_content from authenticated';
  end if;
end $$;

-- はじめの中身（今のホームページと同じ）
insert into site_content (key, value) values
  ('day_hours', '{"am":"9:00〜12:00","pm":"13:30〜16:30","sun":"9:30〜16:30","days":"月曜〜金曜・日曜・祝日（土曜はお休み）"}'::jsonb)
on conflict (key) do nothing;
insert into site_content (key, value)
select 'menu_desc', coalesce(jsonb_object_agg(id::text, d), '{}'::jsonb) from (
  select m.id, case m.name
    when '慢性症状アプローチ' then 'トリガーポイントケアと筋膜トリートメント。痛みの原因を確かめながら進めます。'
    when 'ちょっとお試しコース' then 'はじめての方に。リラクゼーションのボディケアです。'
    when '眠れるボディケアコース' then 'リラクゼーションのボディケア。'
    when '至福のボディケアコース' then 'リラクゼーションのボディケア。時間をかけて全身を。'
  end as d
  from menus m where m.business_id = 'bodycare'
) x where d is not null
on conflict (key) do nothing;
insert into site_content (key, value)
select 'menu_featured', to_jsonb(id::text) from menus where business_id = 'bodycare' and name = '慢性症状アプローチ'
on conflict (key) do nothing;
insert into site_content (key, value) values ('photos', '{}'::jsonb) on conflict (key) do nothing;

-- 写真の入れ物（Supabase の storage がある所だけ。だれでも見られる・1枚3MBまで・写真だけ）
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('site', 'site', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;

select
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('site_news', 'site_jobs', 'site_content'))                      as tables_3,
  (select bool_and(relrowsecurity) from pg_class
     where relname in ('site_news', 'site_jobs', 'site_content'))                      as rls_on_true,
  (select count(*) from information_schema.role_table_grants
     where table_name in ('site_news', 'site_jobs', 'site_content')
       and grantee in ('anon', 'authenticated', 'PUBLIC'))                              as outside_grants_0,
  (select count(*) from site_content)                                                  as content_4,
  (select pg_get_constraintdef(oid) like '%recruit%' from pg_constraint
     where conname = 'contact_messages_business_check')                                as contact_ok_true,
  (select count(*) from pg_constraint where conname in ('staff_perms_ok', 'device_perms_ok')
     and pg_get_constraintdef(oid) like '%site%')                                      as perms_2;
