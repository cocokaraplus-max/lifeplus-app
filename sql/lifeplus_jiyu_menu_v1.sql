-- lifeplus-jiyu-menu-v1 : もみの木接骨院に保険外（自由診療）のメニューを3つ足す（料金は入れない）
--   保険外施術（自由診療）1部位 … 15分／2部位 … 15分／3部位以上 … 30分（あとの空きはどれも0分）
-- LIFE PLUS アプリの Supabase（lifeplus）に流す。何度流しても同じ（同じ名前があれば足さない）。
insert into menus (business_id, name, duration_min, buffer_after_min, price_yen, sort_order) values ('mominoki', '保険外施術（自由診療）1部位', 15, 0, null, 2), ('mominoki', '保険外施術（自由診療）2部位', 15, 0, null, 3), ('mominoki', '保険外施術（自由診療）3部位以上', 30, 0, null, 4) on conflict (business_id, name) do nothing;
