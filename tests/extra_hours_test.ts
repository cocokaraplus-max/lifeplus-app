// 臨時の受付日・期間の休みの中の1日だけ受付に戻す を本物の Postgres（テスト用）で確かめる  marker: lifeplus-extra-hours-v1
//   ★先に sql/lifeplus_closure_notice_v1.sql と sql/lifeplus_extra_hours_v1.sql を流し、DB の now() をテストの「今」（2026-10-16 12:00）にそろえること
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
const stateOf = async (mid: string, ym: string, d: string) => ((await call("pat", { action: "month", menuId: mid, month: ym })).days as Any[]).find((x) => x.date === d).state;
const closuresNow = async () => ((await call("hiro", { action: "admin_closures" })).closures as Any[]).map((c) => [c.date, c.endDate, c.notice]);

Deno.test({ name: "臨時の受付日", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from closures`; await sql`delete from staff_members`; await sql`delete from extra_hours`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  const init = await call("pat", { action: "init" });
  const mid = (init.menus as Any[]).find((m) => m.name === "施術（保険）").id;
  await call("pat", { action: "profile", name: "患者 一", nameKana: "かんじゃ はじめ", phone: "09011112222" });

  await t.step("受付のない火曜に臨時の受付日を足すと、お客さまが予約できる", async () => {
    eq(await stateOf(mid, "2026-10", "2026-10-20"), "off");
    const r = await call("hiro", { action: "admin_extra_add", date: "2026-10-20", from: "10:00", to: "12:00", note: "自分用", notice: "臨時で受付します" });
    eq(r.reopened, 0);
    eq(await stateOf(mid, "2026-10", "2026-10-20"), "open");
    const sl = (await call("pat", { action: "slots", menuId: mid, date: "2026-10-20" })).slots as Any[];
    eq([sl[0].time, sl[sl.length - 1].time, sl.length], ["10:00", "11:45", 8]);
    const b = (await call("pat", { action: "book", menuId: mid, startsAt: "2026-10-20T10:00:00+09:00", symptoms: ["腰"] })).booking as Any;
    eq(b.status, "pending");
  });

  await t.step("お知らせを付けた臨時の受付日は、予約カレンダーのお知らせに出る（メモは出ない）", async () => {
    const m = await call("pat", { action: "month", menuId: mid, month: "2026-10" });
    eq(m.notices, [{ date: "2026-10-20", endDate: "2026-10-20", label: "10/20（火） 10:00〜12:00", text: "臨時で受付します" }]);
    eq(JSON.stringify(m).includes("自分用"), false);
  });

  await t.step("管理画面：init・予約表・ひと月の数に臨時の受付日が出る", async () => {
    const i = await call("hiro", { action: "admin_init" });
    eq((i.extras as Any[]).map((x) => [x.date, x.kind, x.open, x.close, x.note]), [["2026-10-20", "public", "10:00", "12:00", "自分用"]]);
    const d = await call("hiro", { action: "admin_day", date: "2026-10-20" });
    eq(d.hours, [{ open: "10:00", close: "12:00" }]);
    eq((d.extras as Any[]).length, 1);
    const mo = await call("hiro", { action: "admin_month", month: "2026-10" });
    const x = (mo.days as Any[]).find((v) => v.date === "2026-10-20");
    eq([x.open, x.extra, x.count], [true, true, 1]);
  });

  await t.step("手入力だけの臨時は、お客さまには出ず、手で入れるときだけ選べる", async () => {
    await call("hiro", { action: "admin_extra_add", date: "2026-10-21", from: "09:00", to: "10:00", kind: "staff" });
    eq(await stateOf(mid, "2026-10", "2026-10-21"), "off");
    const s = (await call("hiro", { action: "admin_slots", date: "2026-10-21", menuId: mid })).slots as Any[];
    eq([s[0].time, s[0].kind], ["09:00", "staff"]);
  });

  await t.step("同じ日に重なる時間・今日より前・おかしな時間は入れられない", async () => {
    eq(await code(call("hiro", { action: "admin_extra_add", date: "2026-10-20", from: "11:00", to: "13:00" })), "extra_overlap");
    eq(await code(call("hiro", { action: "admin_extra_add", date: "2026-10-15", from: "10:00", to: "12:00" })), "bad_request");
    eq(await code(call("hiro", { action: "admin_extra_add", date: "2026-10-23", from: "12:00", to: "10:00" })), "bad_request");
    eq(await code(call("hiro", { action: "admin_extra_add", date: "2026-10-23", from: "10:10", to: "12:00" })), "bad_request");
  });

  await t.step("期間の休みの中の日に臨時の受付を足すと、その日だけ休みが抜ける（前後とお知らせは残る）", async () => {
    await call("hiro", { action: "admin_closure_add", date: "2026-10-27", endDate: "2026-10-29", notice: "秋休み", note: "旅行" });
    const r = await call("hiro", { action: "admin_extra_add", date: "2026-10-28", from: "09:00", to: "12:00" });
    eq(r.reopened, 1);
    eq(await closuresNow(), [["2026-10-27", "2026-10-27", "秋休み"], ["2026-10-29", "2026-10-29", "秋休み"]]);
    eq(await stateOf(mid, "2026-10", "2026-10-28"), "open");
    eq(await stateOf(mid, "2026-10", "2026-10-29"), "off");
  });

  await t.step("期間の休みの中の1日だけ、休みをやめて受付に戻せる", async () => {
    await call("hiro", { action: "admin_closure_add", date: "2026-11-02", endDate: "2026-11-07", notice: "研修" });
    const id = ((await call("hiro", { action: "admin_closures" })).closures as Any[]).find((c) => c.date === "2026-11-02").id;
    eq(await stateOf(mid, "2026-11", "2026-11-05"), "off");
    await call("hiro", { action: "admin_closure_open_day", id, date: "2026-11-05" });
    eq(await stateOf(mid, "2026-11", "2026-11-05"), "open");
    eq((await closuresNow()).filter((c) => c[0] >= "2026-11-01"), [["2026-11-02", "2026-11-04", "研修"], ["2026-11-06", "2026-11-07", "研修"]]);
    eq(await code(call("hiro", { action: "admin_closure_open_day", id, date: "2026-11-05" })), "closure_not_found");
  });

  await t.step("臨時の受付日を外すと、その時間に入っている予約を知らせる", async () => {
    const id = ((await call("hiro", { action: "admin_init" })).extras as Any[]).find((x) => x.date === "2026-10-20").id;
    const r = await call("hiro", { action: "admin_extra_del", id });
    eq((r.conflicts as Any[]).length, 1);
    eq(await stateOf(mid, "2026-10", "2026-10-20"), "off");
    eq(await code(call("hiro", { action: "admin_extra_del", id })), "extra_not_found");
  });

  await t.step("休みの権限がない人・お客さまは使えない", async () => {
    await sql`insert into staff_members (label, line_user_id, perms) values ('受付', 'Ustaff', array['bookings'])`;
    eq(await code(call("staff", { action: "admin_extra_add", date: "2026-10-23", from: "10:00", to: "12:00" })), "no_permission");
    eq(await code(call("pat", { action: "admin_closure_open_day", id: "00000000-0000-0000-0000-000000000000", date: "2026-10-23" })), "not_admin");
  });

  await sql`delete from bookings`; await sql`delete from closures`; await sql`delete from staff_members`; await sql`delete from extra_hours`;
  await sql.end();
}});
