-- ============================================================
-- LIFE PLUS 予約アプリ  来院・ドタキャンの記録  (marker: lifeplus-noshow-v1)
-- 流す先: LIFE PLUS の Supabase（lifeplus プロジェクト）
-- 何度流しても同じ結果になる
-- 最後の SELECT が結果として返る
-- ============================================================
--  予約の結び（HIROさんが管理画面で付ける）
--    done        … 来院した
--    no_show     … 連絡なしで来なかった（ドタキャン）
--    late_cancel … 直前に連絡があって来なかった（直前キャンセル）
-- ============================================================

-- 状態の種類に late_cancel を足す
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending','confirmed','cancelled','rejected','done','no_show','late_cancel'));

-- 結びを付けた日時と、ひとことメモ
alter table bookings add column if not exists outcome_at   timestamptz;
alter table bookings add column if not exists outcome_note text;

create index if not exists bookings_customer_status_idx on bookings (customer_id, status);

-- お客さまごとの回数（名簿・予約票に出す）
create or replace view customer_stats as
select c.id as customer_id,
       count(*) filter (where b.status = 'done')        as visits,
       count(*) filter (where b.status = 'no_show')     as no_shows,
       count(*) filter (where b.status = 'late_cancel') as late_cancels,
       max(b.starts_at) filter (where b.status = 'no_show') as last_no_show
from customers c
left join bookings b on b.customer_id = c.id
group by c.id;

-- 予約に結びを付ける（来院・ドタキャン・直前キャンセル、または付け直し）
--   来院が付いたら、そのお客さまを「通院中」にする（次から仮予約なしで確定）
create or replace function lp_set_outcome(p_booking_id uuid, p_outcome text, p_note text default null)
returns text language plpgsql as $$
declare v_cust uuid;
begin
  if p_outcome not in ('done','no_show','late_cancel','confirmed') then
    raise exception 'bad_outcome';
  end if;
  update bookings
     set status = p_outcome,
         outcome_at = case when p_outcome = 'confirmed' then null else now() end,
         outcome_note = case when p_outcome = 'confirmed' then null else nullif(trim(p_note), '') end
   where id = p_booking_id
     and status in ('confirmed','done','no_show','late_cancel')
  returning customer_id into v_cust;
  if v_cust is null then raise exception 'booking_not_found'; end if;
  if p_outcome = 'done' then
    update customers set is_returning = true where id = v_cust and not is_returning;
  end if;
  return p_outcome;
end $$;

-- 権限：アプリの裏側だけ
revoke all on function lp_set_outcome(uuid, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on customer_stats to service_role;
    grant execute on function lp_set_outcome(uuid, text, text) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on customer_stats from anon, authenticated;
  end if;
end $$;

-- 確認（これが結果として返る）
select
  (select count(*) from pg_constraint
     where conname = 'bookings_status_check'
       and pg_get_constraintdef(oid) like '%late_cancel%')                    as status_ok_1,
  (select count(*) from information_schema.columns
     where table_name = 'bookings' and column_name in ('outcome_at','outcome_note')) as columns_2,
  (select count(*) from pg_views where viewname = 'customer_stats')            as view_1,
  (select count(*) from information_schema.table_privileges
     where table_name = 'customer_stats' and grantee in ('anon','authenticated')) as outside_0;
