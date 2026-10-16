-- ============================================================
-- LIFE PLUS 予約アプリ  ドタキャンが続いた人は仮予約／HIROさんのLINE  (marker: lifeplus-admin-v1)
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
-- ============================================================

-- 決めごと
insert into app_settings (key, value, note) values
  ('noshow_limit', '2', '直近の予約でドタキャンが何回続いたら、通院中でも仮予約に戻すか'),
  ('admin_line_user_ids', '', '新しい予約の知らせを受け取り、管理画面に入れる LINE の ID（カンマ区切り）')
on conflict (key) do nothing;

-- HIROさんの LINE ID を登録する
-- チャネルが「開発中」の今は、予約ページに入れたのは HIROさんだけ。
-- お客さまが1人だけのときに限り、その人を管理者にする（2人以上いたら何もしない）
update app_settings s
   set value = c.line_user_id
  from (select line_user_id from customers where line_user_id is not null) c
 where s.key = 'admin_line_user_ids'
   and s.value = ''
   and (select count(*) from customers where line_user_id is not null) = 1;

-- ドタキャンが続いているか（来院とドタキャンだけを新しい順に見て、直近 N 回がすべてドタキャン）
-- 直前キャンセル（連絡あり）は数えない。来院が1回入れば続きは切れる。
create or replace function lp_noshow_hold(p_customer_id uuid)
returns boolean language sql stable as $$
  with lim as (select greatest(lp_setting_int('noshow_limit', 2), 1) as n),
  last as (
    select b.status
      from bookings b
     where b.customer_id = p_customer_id and b.status in ('done', 'no_show')
     order by b.starts_at desc
     limit (select n from lim)
  )
  select count(*) = (select n from lim) and coalesce(bool_and(status = 'no_show'), false) from last;
$$;

-- 予約を入れる（lifeplus-functions-v1 の作り直し：ドタキャンが続いた人は仮予約）
create or replace function lp_create_booking(
  p_customer_id uuid,
  p_menu_id     uuid,
  p_starts_at   timestamptz,
  p_symptoms    text[] default null,
  p_source      text   default 'line'
) returns uuid
language plpgsql as $$
declare
  m       menus;
  cu      customers;
  v_id    uuid;
  v_ok    boolean;
  v_conf  boolean;
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

  v_conf := p_source = 'admin' or (cu.is_returning and not lp_noshow_hold(cu.id));

  begin
    insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until,
                          status, price_yen, symptoms, source, confirmed_at)
    values (p_customer_id, m.id, m.business_id, p_starts_at,
            p_starts_at + make_interval(mins => m.duration_min),
            p_starts_at + make_interval(mins => m.duration_min + m.buffer_after_min),
            case when v_conf then 'confirmed' else 'pending' end,
            m.price_yen, p_symptoms, p_source,
            case when v_conf then now() end)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'slot_not_available';
  end;
  return v_id;
end $$;

-- 権限：アプリの裏側だけ
revoke all on function lp_noshow_hold(uuid) from public;
revoke all on function lp_create_booking(uuid, uuid, timestamptz, text[], text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function lp_noshow_hold(uuid) to service_role;
    grant execute on function lp_create_booking(uuid, uuid, timestamptz, text[], text) to service_role;
  end if;
end $$;

-- 確認（これが結果として返る）
--   admin_set が 1 なら HIROさんの LINE が登録できた。0 なら、お客さまが2人以上いるので手で登録する
select
  (select count(*) from app_settings where key in ('noshow_limit', 'admin_line_user_ids')) as settings_2,
  (select count(*) from app_settings where key = 'admin_line_user_ids' and value <> '')   as admin_set,
  (select count(*) from pg_proc where proname = 'lp_noshow_hold')                         as hold_fn_1,
  (select count(*) from information_schema.routine_privileges
     where grantee in ('anon','authenticated','PUBLIC') and routine_name like 'lp\_%')   as outside_exec_0;
