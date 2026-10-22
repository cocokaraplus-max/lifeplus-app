-- ============================================================
-- LIFE PLUS 予約アプリ  表の作成  (marker: lifeplus-schema-v1)
-- 流す先: LIFE PLUS 用の新しい Supabase プロジェクト（TASUKARUではない）
-- 何度流しても同じ結果になる（if not exists / on conflict do nothing）
-- 最後の SELECT が結果として返る（表の数と初期データの件数）
-- ============================================================

create extension if not exists btree_gist;

-- ---------- 事業 ----------
create table if not exists businesses (
  id              text primary key,            -- 'mominoki' / 'bodycare' / 'cocokara'
  name            text not null,
  color           text not null default '#888888',  -- 予定表での色
  accepts_booking boolean not null default false,
  sort_order      int not null default 0
);

-- ---------- メニュー ----------
create table if not exists menus (
  id               uuid primary key default gen_random_uuid(),
  business_id      text not null references businesses(id),
  name             text not null,
  description      text,
  duration_min     int  not null check (duration_min > 0 and duration_min % 15 = 0),
  buffer_after_min int  not null default 0 check (buffer_after_min >= 0 and buffer_after_min % 15 = 0),
  price_yen        int  check (price_yen is null or price_yen >= 0),   -- 保険は null
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  unique (business_id, name)
);

-- ---------- 受付時間（予定表は1本なので事業ごとに分けない） ----------
-- weekday: 1=月 ... 7=日（ISO）
create table if not exists business_hours (
  id         uuid primary key default gen_random_uuid(),
  weekday    smallint not null check (weekday between 1 and 7),
  open_time  time not null,
  close_time time not null,
  check (open_time < close_time),
  unique (weekday, open_time)
);

-- ---------- 休み（HIROさんが任意で入れる。祝日は自動では休みにしない） ----------
-- 1日まるごと休み = その日の 00:00〜翌日 00:00（日本時間）
create table if not exists closures (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  note       text,
  created_at timestamptz not null default now(),
  check (starts_at < ends_at)
);

-- ---------- お客さま（LINEで予約した人） ----------
create table if not exists customers (
  id             uuid primary key default gen_random_uuid(),
  line_user_id   text unique,
  line_name      text,            -- LINEの表示名
  name           text,
  name_kana      text,
  phone          text,
  is_returning   boolean not null default false,  -- 来院歴あり → 予約をすぐ確定
  is_blocked     boolean not null default false,  -- 予約させない（業者など）
  memo           text,
  created_at     timestamptz not null default now()
);

-- ---------- 予約 ----------
-- starts_at〜ends_at が施術、ends_at〜block_until が片付け。
-- 重なり判定は starts_at〜block_until で行う。
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id),
  menu_id       uuid not null references menus(id),
  business_id   text not null references businesses(id),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  block_until   timestamptz not null,
  status        text not null default 'pending'
                check (status in ('pending','confirmed','cancelled','rejected','done','no_show')),
  price_yen     int,              -- 予約時点の料金（メニュー変更の影響を受けない）
  symptoms      text[],           -- 選択式の症状・部位（自由記述は置かない）
  source        text not null default 'line' check (source in ('line','admin')),
  admin_memo    text,
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  cancelled_at  timestamptz,
  check (starts_at < ends_at and ends_at <= block_until),
  check (extract(second from starts_at) = 0 and extract(minute from starts_at)::int % 15 = 0)
);

-- 仮予約・確定の予約どうしは1分でも重ならない（同時に押されても止まる）
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') then
    alter table bookings add constraint bookings_no_overlap
      exclude using gist (tstzrange(starts_at, block_until, '[)') with &&)
      where (status in ('pending','confirmed'));
  end if;
end $$;

create index if not exists bookings_starts_at_idx on bookings (starts_at);
create index if not exists bookings_customer_idx  on bookings (customer_id);

-- ---------- 業者の方の窓口（予約とは別の箱） ----------
create table if not exists vendor_inquiries (
  id           uuid primary key default gen_random_uuid(),
  company      text,
  contact_name text,
  email        text,
  phone        text,
  body         text,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------- RLS（全表 on・ポリシーは書かない。サーバはサービスキーで繋ぐ） ----------
alter table businesses       enable row level security;
alter table menus            enable row level security;
alter table business_hours   enable row level security;
alter table closures         enable row level security;
alter table customers        enable row level security;
alter table bookings         enable row level security;
alter table vendor_inquiries enable row level security;

-- ---------- 権限（「Automatically expose new tables」を外したので、裏側のサービスキーにだけ付ける） ----------
-- anon / authenticated には何も付けない（外から表は見えない）
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant all on all tables    in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant all on all functions in schema public to service_role;
    alter default privileges in schema public grant all on tables    to service_role;
    alter default privileges in schema public grant all on sequences to service_role;
    alter default privileges in schema public grant all on functions to service_role;
  end if;
  -- Supabase は anon / authenticated に自動で権限を付けることがあるので外す
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables    in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    alter default privileges in schema public revoke all on tables    from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end $$;

-- ---------- 初期データ ----------
insert into businesses (id, name, color, accepts_booking, sort_order) values
  ('mominoki', 'もみの木接骨院',                 '#2E7D5B', true,  1),
  ('bodycare', 'HIROボディケアスタジオ',          '#E8743B', true,  2),
  ('cocokara', '機能訓練型デイサービスココカラプラス', '#3B6FB6', false, 3)
on conflict (id) do nothing;

insert into menus (business_id, name, duration_min, buffer_after_min, price_yen, sort_order) values
  ('mominoki', '施術（保険）',             15,  0, null,  1),
  ('bodycare', 'ちょっとお試しコース',       30, 15, 4000,  1),
  ('bodycare', '眠れるボディケアコース',     60, 15, 8000,  2),
  ('bodycare', '至福のボディケアコース',     90, 15, 13000, 3),
  ('bodycare', '慢性症状アプローチ',         60, 15, 10000, 4)
on conflict (business_id, name) do nothing;

insert into business_hours (weekday, open_time, close_time) values
  (1, '17:00', '20:00'),   -- 月
  (4, '17:00', '20:00'),   -- 木
  (6, '09:00', '12:00')    -- 土
on conflict do nothing;   -- lifeplus-hours-kind-v1: 一意の組み合わせが (weekday, kind, open_time) に変わったので、列を指定しない

-- ---------- 確認（これが結果として返る） ----------
select
  (select count(*) from businesses)     as businesses_3,
  (select count(*) from menus)          as menus_5,
  (select count(*) from business_hours) as hours_3,
  (select count(*) from pg_constraint where conname = 'bookings_no_overlap') as no_overlap_1,
  (select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema = 'public') as anon_grants_0;
