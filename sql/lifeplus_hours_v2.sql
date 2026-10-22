-- ============================================================
-- LIFE PLUS 予約アプリ  受付時間の「種類」  (marker: lifeplus-hours-kind-v1)
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU ではない。
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
--
--  受付時間に「種類」を足す
--    public … お客さまに見せる受付時間（予約ページで選べる）＝ いままでの受付時間
--    staff  … 手入力だけの時間（予約表にうっすら出て、管理画面から手で入れるときだけ選べる。
--             知り合いなどを時間外に入れるため。お客さまの予約ページには出ない）
--  ★いま入っている受付時間は、すべて public のまま（お客さまから見える時間は変わらない）
-- ============================================================

alter table business_hours add column if not exists kind text not null default 'public';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_hours_kind_check') then
    alter table business_hours add constraint business_hours_kind_check check (kind in ('public', 'staff'));
  end if;
  -- 同じ曜日・同じ開始でも、種類が違えば別の行として持てるようにする
  if exists (select 1 from pg_constraint where conname = 'business_hours_weekday_open_time_key') then
    alter table business_hours drop constraint business_hours_weekday_open_time_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_hours_weekday_kind_open_key') then
    alter table business_hours add constraint business_hours_weekday_kind_open_key unique (weekday, kind, open_time);
  end if;
end $$;

-- 空き枠（お客さまの予約ページ）：★お客さまに見せる受付時間（public）だけから作る
--   ほかは lifeplus-functions-v1 と同じ
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
  ),
  cand as (
    select gs as s,
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

-- 権限：アプリの裏側だけ（create or replace で付け直しておく）
revoke all on function lp_available_slots(date, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function lp_available_slots(date, uuid) to service_role;
  end if;
end $$;

-- 確認（これが結果として返る）
--   kind_col_1 = 1・unique_new_1 = 1・unique_old_0 = 0・staff_rows は今は 0（設定画面で足すまで）
select
  (select count(*) from information_schema.columns where table_name = 'business_hours' and column_name = 'kind') as kind_col_1,
  (select count(*) from pg_constraint where conname = 'business_hours_weekday_kind_open_key')                  as unique_new_1,
  (select count(*) from pg_constraint where conname = 'business_hours_weekday_open_time_key')                  as unique_old_0,
  (select count(*) from business_hours where kind = 'public')                                                 as public_rows,
  (select count(*) from business_hours where kind = 'staff')                                                  as staff_rows,
  (select count(*) from information_schema.routine_privileges
     where grantee in ('anon','authenticated','PUBLIC') and routine_name like 'lp\_%')                         as outside_exec_0;
