-- ============================================================
-- LIFE PLUS 予約アプリ  空き枠の計算と予約の受付  (marker: lifeplus-functions-v1)
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）
-- 何度流しても同じ結果になる（create or replace）
-- 最後の SELECT が結果として返る
-- ============================================================

-- ---------- 設定（あとから管理画面で変えられるように表にしておく） ----------
create table if not exists app_settings (
  key   text primary key,
  value text not null,
  note  text
);
alter table app_settings enable row level security;
insert into app_settings (key, value, note) values
  ('lead_minutes', '60', '予約の締め切り：開始の何分前まで受け付けるか'),
  ('horizon_days', '60', '何日先まで予約できるか')
on conflict (key) do nothing;

create or replace function lp_setting_int(p_key text, p_default int)
returns int language sql stable as $$
  select coalesce((select value::int from app_settings where key = p_key), p_default);
$$;

-- ---------- 空き枠 ----------
-- p_date の日（日本時間）に、p_menu_id のメニューを始められる時刻の一覧
-- ルール：
--   ・受付時間内に「施術」が終わること（後ろの片付けは閉店後にはみ出してよい）
--   ・開始は15分刻み
--   ・「施術＋片付け」の時間帯が、仮予約・確定の予約と1分でも重ならない
--   ・施術の時間帯が休み（closures）と重ならない
--   ・締め切り（lead_minutes）より後、予約できる期間（horizon_days）より前
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

-- ---------- 予約を入れる ----------
-- 来院歴のある人は確定、初めての人は仮予約（HIROさんが承認して確定）
-- p_source = 'admin' のとき（HIROさんが管理画面から入れる）は、締め切りを無視して確定で入れる
create or replace function lp_create_booking(
  p_customer_id uuid,
  p_menu_id     uuid,
  p_starts_at   timestamptz,
  p_symptoms    text[] default null,
  p_source      text   default 'line'
) returns uuid
language plpgsql as $$
declare
  m     menus;
  cu    customers;
  v_id  uuid;
  v_ok  boolean;
begin
  select * into cu from customers where id = p_customer_id;
  if not found then raise exception 'customer_not_found'; end if;
  if cu.is_blocked then raise exception 'customer_blocked'; end if;

  select * into m from menus where id = p_menu_id and is_active;
  if not found then raise exception 'menu_not_found'; end if;

  if p_source = 'line' then
    select exists (
      select 1 from lp_available_slots((p_starts_at at time zone 'Asia/Tokyo')::date, p_menu_id) s
      where s.starts_at = p_starts_at
    ) into v_ok;
    if not v_ok then raise exception 'slot_not_available'; end if;
  end if;

  begin
    insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until,
                          status, price_yen, symptoms, source, confirmed_at)
    values (p_customer_id, m.id, m.business_id, p_starts_at,
            p_starts_at + make_interval(mins => m.duration_min),
            p_starts_at + make_interval(mins => m.duration_min + m.buffer_after_min),
            case when cu.is_returning or p_source = 'admin' then 'confirmed' else 'pending' end,
            m.price_yen, p_symptoms, p_source,
            case when cu.is_returning or p_source = 'admin' then now() end)
    returning id into v_id;
  exception when exclusion_violation then
    -- 同時に別の人が同じ時間を押したとき
    raise exception 'slot_not_available';
  end;
  return v_id;
end $$;

-- ---------- 権限：関数はアプリの裏側だけが呼べる ----------
-- （Postgres は関数を誰でも呼べる状態で作るので、外してから付け直す）
revoke all on function lp_setting_int(text, int)                               from public;
revoke all on function lp_available_slots(date, uuid)                          from public;
revoke all on function lp_create_booking(uuid, uuid, timestamptz, text[], text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table app_settings to service_role;
    grant execute on function lp_setting_int(text, int)                               to service_role;
    grant execute on function lp_available_slots(date, uuid)                          to service_role;
    grant execute on function lp_create_booking(uuid, uuid, timestamptz, text[], text) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table app_settings from anon, authenticated;
  end if;
end $$;

-- ---------- 確認（これが結果として返る） ----------
select
  (select count(*) from app_settings) as settings_2,
  (select count(*) from pg_proc where proname like 'lp\_%') as functions_3,
  (select count(*) from information_schema.routine_privileges
     where grantee in ('anon','authenticated','PUBLIC') and routine_name like 'lp\_%') as outside_exec_0;
