-- lifeplus-chart-no-v1 : お客さまにカルテ番号を持たせる（同じ番号は2人に付けられない）
-- LIFE PLUS アプリの Supabase（lifeplus）に流す。上から1文ずつ。何度流しても同じ。
alter table customers add column if not exists chart_no text;

create unique index if not exists customers_chart_no_uq on customers (chart_no) where chart_no is not null;
