// 期間の休み・お客さま向けのお知らせを本物の Postgres（テスト用）で確かめる  marker: lifeplus-closure-notice-v1
//   ★先に sql/lifeplus_closure_notice_v1.sql を流し、DB の now() をテストの「今」（2026-10-16 12:00）にそろえること
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const notify = () => Promise.resolve();
const call = (tok: string, body: Record<string, unknown>) => handle({ ...body, idToken: "tok-" + tok }, { sql, verifyIdToken, now: () => NOW, notify });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test({ name: "期間の休みとお知らせ", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from closures`; await sql`delete from staff_members`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  const init = await call("pat", { action: "init" });
  const menus = init.menus as Any[];
  const mid = menus.find((m) => m.name === "施術（保険）").id;

  await t.step("期間で休みにすると、お知らせも一緒に残る", async () => {
    await call("hiro", { action: "admin_closure_add", date: "2026-10-29", endDate: "2026-11-03", note: "自分用", notice: "秋の臨時休業" });
    const r = await call("hiro", { action: "admin_closures" });
    const c = (r.closures as Any[])[0];
    eq([c.date, c.endDate, c.from, c.to, c.note, c.notice], ["2026-10-29", "2026-11-03", "00:00", "24:00", "自分用", "秋の臨時休業"]);
  });

  await t.step("お客さまの予約カレンダーに、お知らせと休みの日が出る（自分用のメモは出ない）", async () => {
    const m = await call("pat", { action: "month", menuId: mid, month: "2026-10" });
    eq(m.notices, [{ date: "2026-10-29", endDate: "2026-11-03", label: "10/29（木）〜11/3（火）", text: "秋の臨時休業" }]);
    eq(JSON.stringify(m).includes("自分用"), false);
    const d29 = (m.days as Any[]).find((d) => d.date === "2026-10-29");
    eq(d29.state, "off");
    const n = await call("pat", { action: "month", menuId: mid, month: "2026-11" });
    eq((n.notices as Any[]).length, 1);   // 次の月を見ても同じお知らせが出る
    eq((n.days as Any[]).find((d) => d.date === "2026-11-02").state, "off");
  });

  await t.step("お知らせのない休み・終わった休みは出ない", async () => {
    await call("hiro", { action: "admin_closure_add", date: "2026-11-05", note: "研修" });
    await sql`insert into closures (starts_at, ends_at, notice) values ('2026-10-10T00:00:00+09:00', '2026-10-12T00:00:00+09:00', '終わった休み')`;
    const m = await call("pat", { action: "month", menuId: mid, month: "2026-11" });
    eq((m.notices as Any[]).map((x) => x.text), ["秋の臨時休業"]);
  });

  await t.step("時間だけの休みは時間も出る・60字より長いお知らせは60字で切る", async () => {
    await call("hiro", { action: "admin_closure_add", date: "2026-11-07", from: "09:00", to: "10:30", notice: "あ".repeat(80) });
    const m = await call("pat", { action: "month", menuId: mid, month: "2026-11" });
    const x = (m.notices as Any[]).find((v) => v.date === "2026-11-07");
    eq([x.label, x.text.length], ["11/7（土） 09:00〜10:30", 60]);
  });

  await t.step("お知らせはあとから変えられる・空にすると出なくなる", async () => {
    const id = ((await call("hiro", { action: "admin_closures" })).closures as Any[])[0].id;
    await call("hiro", { action: "admin_closure_update", id, notice: "年末年始のお休み" });
    let m = await call("pat", { action: "month", menuId: mid, month: "2026-10" });
    eq((m.notices as Any[])[0].text, "年末年始のお休み");
    await call("hiro", { action: "admin_closure_update", id, notice: "" });
    m = await call("pat", { action: "month", menuId: mid, month: "2026-10" });
    eq((m.notices as Any[]).some((v) => v.date === "2026-10-29"), false);
    eq((m.days as Any[]).find((d) => d.date === "2026-10-29").state, "off");   // 休みはそのまま
    eq(await code(call("hiro", { action: "admin_closure_update", id: "00000000-0000-0000-0000-000000000000", notice: "x" })), "closure_not_found");
  });

  await t.step("休みの権限がない人・お客さまはお知らせを変えられない", async () => {
    const id = ((await call("hiro", { action: "admin_closures" })).closures as Any[])[0].id;
    await sql`insert into staff_members (label, line_user_id, perms) values ('受付', 'Ustaff', array['bookings'])`;
    eq(await code(call("staff", { action: "admin_closure_update", id, notice: "x" })), "no_permission");
    eq(await code(call("pat", { action: "admin_closure_update", id, notice: "x" })), "not_admin");
  });

  await t.step("手入力だけの曜日は、お客さまのカレンダーで「休」になる（×満席にしない）", async () => {
    await sql`insert into business_hours (weekday, open_time, close_time, kind) values (2, '10:00', '12:00', 'staff')`;
    try {
      const m = await call("pat", { action: "month", menuId: mid, month: "2026-10" });
      eq((m.days as Any[]).find((d) => d.date === "2026-10-20").state, "off");   // 10/20 は火曜
      eq((m.days as Any[]).find((d) => d.date === "2026-10-19").state === "off", false);   // 月曜は受付
    } finally {
      await sql`delete from business_hours where weekday = 2 and kind = 'staff'`;
    }
  });

  await sql`delete from closures`; await sql`delete from staff_members`;
  await sql.end();
}});
