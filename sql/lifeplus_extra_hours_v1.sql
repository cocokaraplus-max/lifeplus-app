-- ============================================================
-- LIFE PLUS 予約  臨時の受付日（marker: lifeplus-extra-hours-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU の DEV・本番ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  ・extra_hours  いつもは受付のない日（火・水・金・日など）に、その日だけ受付の時間を足す
--      kind   public＝お客さまの予約ページで選べる／staff＝手入力だけ（管理画面から手で入れるときだけ）
--      note   自分用のメモ（お客さまには見えない）
--      notice お客さまへのお知らせ（予約カレンダーの上に出る・60字まで・なくてもよい）
--  ・lp_available_slots（お客さまの空き枠）に、その日の臨時の受付時間（public）も入れる
--    ★いつもの受付時間・休み・予約の重なりの決まりは今までと同じ
--  ★書くのは関所（booking）だけ。外の役割には何も許さない
-- ============================================================

create table if not exists extra_hours (
  id         uuid primary key default gen_random_uuid(),
  day        date not null,
  open_time  time not null,
  close_time time not null,
  kind       text not null default 'public' check (kind in ('public', 'staff')),
  note       text,
  notice     text check (notice is null or char_length(notice) <= 60),
  created_at timestamptz not null default now(),
  check (open_time < close_time),   -- 夜中までは close_time = '24:00'
  unique (day, kind, open_time)
);
alter table extra_hours enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on extra_hours from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on extra_hours from authenticated';
  end if;
end $$;

-- 空き枠（お客さまの予約ページ）：いつもの受付時間（public）＋その日の臨時の受付時間（public）
--   ほかは lifeplus-hours-kind-v1 と同じ
create or replace function lp_available_slots(p_date date, p_menu_id uuid)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable as $$
declare
  m        menus;
  v_lead   interval := make_interval(mins => lp_setting_int('lead_minutes', 60));
  v_limit  date     := (now() at time zone 'Asia/Tokyo')::date + lp_setting_int('horizon_days', 60);
begin
  select * into m from menus where id = p_menu_id and is_active;
  if not found then return; end if;
  if p_date > v_limit then return; end if;

  return query
  with hours as (
    select ((p_date + h.open_time)  at time zone 'Asia/Tokyo') as op,
           ((p_date + h.close_time) at time zone 'Asia/Tokyo') as cl
    from business_hours h
    where h.weekday = extract(isodow from p_date)::int
      and h.kind = 'public'
    union
    select ((p_date + x.open_time)  at time zone 'Asia/Tokyo'),
           ((p_date + x.close_time) at time zone 'Asia/Tokyo')
    from extra_hours x
    where x.day = p_date and x.kind = 'public'
  ),
  cand as (
    select distinct gs as s,
           gs + make_interval(mins => m.duration_min)                      as e,
           gs + make_interval(mins => m.duration_min + m.buffer_after_min) as b
    from hours,
         generate_series(hours.op,
                         hours.cl - make_interval(mins => m.duration_min),
                         interval '15 minutes') gs
  )
  select c.s, c.e
  from cand c
  where c.s >= now() + v_lead
    and not exists (
      select 1 from bookings bk
      where bk.status in ('pending','confirmed')
        and tstzrange(bk.starts_at, bk.block_until, '[)') && tstzrange(c.s, c.b, '[)'))
    and not exists (
      select 1 from closures cz
      where tstzrange(cz.starts_at, cz.ends_at, '[)') && tstzrange(c.s, c.e, '[)'))
  order by c.s;
end $$;

revoke all on function lp_available_slots(date, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function lp_available_slots(date, uuid) to service_role;
  end if;
end $$;

-- 確認（これが結果として返る）
select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'extra_hours') as table_1,
  (select relrowsecurity from pg_class where relname = 'extra_hours')                                          as rls_on_true,
  (select count(*) from information_schema.role_table_grants
     where table_name = 'extra_hours' and grantee in ('anon', 'authenticated', 'PUBLIC'))                     as outside_grants_0,
  (select count(*) from information_schema.routine_privileges
     where grantee in ('anon','authenticated','PUBLIC') and routine_name like 'lp\_%')                         as outside_exec_0;
