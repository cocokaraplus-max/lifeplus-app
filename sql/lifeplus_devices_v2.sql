-- =============================================================
-- LIFE PLUS 予約：お店の端末に「スタッフ・端末の管理」「設定」を持たせられるようにする  marker: lifeplus-devices-v2
-- 流す先：Supabase の lifeplus プロジェクト（vjnfhpgmscrjjgggrgfk）。TASUKARU ではない。
-- 何度流しても同じ結果になる。最後の SELECT が結果として返る。
-- =============================================================
alter table admin_devices drop constraint if exists device_perms_ok;
alter table admin_devices add constraint device_perms_ok
  check (perms <@ array['closures','bookings','customers','staff','settings']::text[]);

-- 確かめ：ok_1 = 1
select count(*) as ok_1 from pg_constraint
 where conname = 'device_perms_ok' and pg_get_constraintdef(oid) like '%settings%';
