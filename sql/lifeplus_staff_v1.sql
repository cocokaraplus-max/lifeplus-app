-- =============================================================
-- LIFE PLUS 予約：管理画面を使える人（スタッフ）  marker: lifeplus-staff-v1
-- 流す先：Supabase の lifeplus プロジェクト（LIFE PLUS 本番）。TASUKARU ではない。
-- 何度流しても同じ結果になる（冪等）。
--
-- ・HIROさん（app_settings.admin_line_user_ids）は今まで通り「持ち主」で、全部できる。
-- ・ここに入る人は、HIROさんが招待リンクを送って、本人が LINE で開くと参加になる。
-- ・できることは人ごとに選ぶ：
--     closures  休み・×の設定
--     bookings  予約の確定・お断り・取消・来院の記録・手で予約
--     customers お客さまの名簿・メモ・ブロック・LINE連絡
--     notify    予約・キャンセルの LINE 通知を受け取る
--   （予約表を見るのは全員できる）
-- =============================================================
create table if not exists staff_members (
  id                uuid primary key default gen_random_uuid(),
  label             text not null,                 -- HIROさんが付ける呼び名
  line_user_id      text unique,                   -- 参加すると入る
  line_name         text,
  perms             text[] not null default '{}',
  invite_code       text unique,                   -- 参加すると消える
  invite_expires_at timestamptz,
  created_at        timestamptz not null default now(),
  joined_at         timestamptz,
  last_seen_at      timestamptz,
  constraint staff_label_len check (char_length(label) between 1 and 30),
  constraint staff_perms_ok check (perms <@ array['closures','bookings','customers','notify']::text[])
);

alter table staff_members enable row level security;
revoke all on staff_members from anon, authenticated;
grant select, insert, update, delete on staff_members to service_role;

-- 確かめ（1行出れば OK）
select 'staff_members ready' as result, count(*) as rows from staff_members;
