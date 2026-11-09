// 休みの日に「年末年始」「臨時休業」などの言葉を出す を本物の Postgres（テスト用）で確かめる  marker: lifeplus-off-label-v1
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { handle, offShort } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const call = (tok: string, body: Record<string, unknown>) => handle({ ...body, idToken: "tok-" + tok }, { sql, verifyIdToken, now: () => NOW, notify: () => Promise.resolve() });
// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test({ name: "休みの日の言葉", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from closures`; await sql`delete from extra_hours`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  const mid = ((await call("pat", { action: "init" })).menus as Any[]).find((m) => m.name === "施術（保険）").id;
  try {
    await t.step("短い言葉にする", () => {
      eq(["年末年始のお休み", "臨時休業", "お盆休み", "研修のため休み", "夏季休業のお知らせです", "", "休み"].map(offShort),
         ["年末年始", "臨時休業", "お盆", "研修", "夏季休業のお", "", "休み"]);
    });
    await call("hiro", { action: "admin_closure_add", date: "2026-10-26", endDate: "2026-10-29", notice: "年末年始のお休み", note: "家族旅行" });
    await call("hiro", { action: "admin_closure_add", date: "2026-10-31", note: "研修" });
    await call("hiro", { action: "admin_closure_add", date: "2026-10-19", from: "17:00", to: "18:00", notice: "臨時休業" });

    await t.step("お客さまのカレンダー：お知らせのある1日休みだけ短い言葉（メモは出さない）", async () => {
      const m = await call("pat", { action: "month", menuId: mid, month: "2026-10" });
      const L = (d: string) => (m.days as Any[]).find((x) => x.date === d);
      eq([L("2026-10-26").state, L("2026-10-26").label, L("2026-10-29").label], ["off", "年末年始", "年末年始"]);
      eq([L("2026-10-31").state, L("2026-10-31").label], ["off", ""]);   // メモだけの休みは「休」のまま
      eq(L("2026-10-19").label, "");   // 時間だけの休みは出さない
      eq(L("2026-10-22").label, "");   // 受付日
    });
    await t.step("予約表の月のカレンダー：お知らせかメモを短く", async () => {
      const m = await call("hiro", { action: "admin_month", month: "2026-10" });
      const L = (d: string) => (m.days as Any[]).find((x) => x.date === d);
      eq([L("2026-10-26").offLabel, L("2026-10-31").offLabel, L("2026-10-19").offLabel, L("2026-10-22").offLabel], ["年末年始", "研修", "", ""]);
    });
    await t.step("その日の予約表：お知らせとメモの両方が来る", async () => {
      const d = await call("hiro", { action: "admin_day", date: "2026-10-26" });
      eq((d.closures as Any[]).map((c) => [c.from, c.to, c.notice, c.note]), [["00:00", "24:00", "年末年始のお休み", "家族旅行"]]);
    });
  } finally {
    await sql`delete from closures`;
    await sql.end();
  }
}});
