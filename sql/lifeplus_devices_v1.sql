-- =============================================================
-- LIFE PLUS 予約：お店の端末（LINE を使わずに管理画面を開く）  marker: lifeplus-devices-v1
-- 流す先：Supabase の lifeplus プロジェクト（LIFE PLUS 本番）。TASUKARU ではない。
-- 何度流しても同じ結果になる（冪等）。最後の SELECT が結果として返る。
--
-- ・HIROさんが管理画面（スタッフ → お店の端末）で6桁の番号を出す。15分だけ使える。
-- ・お店のPC・タブレットで管理画面を開いて番号を入れると、その端末が登録される。
-- ・番号も、端末に渡す合鍵も、ここにはハッシュ（元に戻せない形）だけ残す。
-- ・できること：closures（休み・×）／bookings（予約）／customers（お客さま）。通知は受け取れない。
-- ・180日開かなかった端末は使えなくなる。番号を出し直すと、それまでの端末は使えなくなる。
-- =============================================================
create table if not exists admin_devices (
  id              uuid primary key default gen_random_uuid(),
  label           text not null,                 -- HIROさんが付ける呼び名（例：受付PC）
  perms           text[] not null default '{}',
  token_hash      text unique,                   -- 登録が済むと入る
  pair_code_hash  text unique,                   -- 番号を出している間だけ入る
  pair_expires_at timestamptz,
  user_agent      text,                          -- どんな端末か（一覧で見分けるため）
  created_at      timestamptz not null default now(),
  paired_at       timestamptz,
  last_seen_at    timestamptz,
  constraint device_label_len check (char_length(label) between 1 and 30),
  constraint device_perms_ok check (perms <@ array['closures','bookings','customers']::text[])
);

-- 番号の入れ間違い（総当たりよけ。1時間に同じ所から10回・全体で50回まで）
create table if not exists device_pair_fails (
  id         bigserial primary key,
  ip_hash    text,
  created_at timestamptz not null default now()
);
create index if not exists device_pair_fails_idx on device_pair_fails (created_at desc, ip_hash);

alter table admin_devices enable row level security;
alter table device_pair_fails enable row level security;
revoke all on admin_devices, device_pair_fails from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on admin_devices, device_pair_fails from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on admin_devices, device_pair_fails from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on admin_devices, device_pair_fails to service_role';
    execute 'grant usage on sequence device_pair_fails_id_seq to service_role';
  end if;
end $$;

-- 確かめ（これが結果として返る）
--   tables_2 = 2・rls_on_2 = 2・outside_grants_0 = 0
select
  (select count(*) from information_schema.tables where table_name in ('admin_devices', 'device_pair_fails'))   as tables_2,
  (select count(*) from pg_class where relname in ('admin_devices', 'device_pair_fails') and relrowsecurity)    as rls_on_2,
  (select count(*) from information_schema.role_table_grants
     where table_name in ('admin_devices', 'device_pair_fails') and grantee in ('anon', 'authenticated', 'PUBLIC')) as outside_grants_0;
