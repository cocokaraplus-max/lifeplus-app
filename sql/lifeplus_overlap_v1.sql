-- ============================================================
-- LIFE PLUS 予約  手で入れる予約だけ、ほかの予約と時間が重なっても入れられる（marker: lifeplus-overlap-v1）
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）。TASUKARU の DEV・本番ではない。
-- まとめて流してよい（最後の SELECT が結果として返る。col_1・func_1・rule_1 がどれも 1 なら成功）。何度流しても同じ結果になる。
--  ・bookings.allow_overlap … 職員が「重なっても入れる」で入れた予約の印
--  ・重なり止め（bookings_no_overlap）は、その印のある予約を数えない
--  ・お客さまの予約ページの空き枠は今までどおり（どの予約がある時間も選べない）
--  ・lp_create_booking に p_allow_overlap を足す（手入力のときだけ効く）
-- ============================================================
alter table bookings add column if not exists allow_overlap boolean not null default false;

alter table bookings drop constraint if exists bookings_no_overlap;

alter table bookings add constraint bookings_no_overlap exclude using gist (tstzrange(starts_at, block_until, '[)') with &&) where (status in ('pending','confirmed') and not allow_overlap);

drop function if exists lp_create_booking(uuid, uuid, timestamptz, text[], text);

create or replace function lp_create_booking(p_customer_id uuid, p_menu_id uuid, p_starts_at timestamptz, p_symptoms text[] default null, p_source text default 'line', p_allow_overlap boolean default false) returns uuid language plpgsql as $$
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
                          status, price_yen, symptoms, source, confirmed_at, allow_overlap)
    values (p_customer_id, m.id, m.business_id, p_starts_at,
            p_starts_at + make_interval(mins => m.duration_min),
            p_starts_at + make_interval(mins => m.duration_min + m.buffer_after_min),
            case when v_conf then 'confirmed' else 'pending' end,
            m.price_yen, p_symptoms, p_source,
            case when v_conf then now() end,
            p_source = 'admin' and coalesce(p_allow_overlap, false))
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'slot_not_available';
  end;
  return v_id;
end $$;

revoke all on function lp_create_booking(uuid, uuid, timestamptz, text[], text, boolean) from public;

do $$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function lp_create_booking(uuid, uuid, timestamptz, text[], text, boolean) to service_role; end if; end $$;

select (select count(*) from information_schema.columns where table_name = 'bookings' and column_name = 'allow_overlap') as col_1, (select count(*) from pg_proc where proname = 'lp_create_booking') as func_1, (select count(*) from pg_constraint where conname = 'bookings_no_overlap') as rule_1;
