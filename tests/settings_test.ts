// 設定画面（受付時間の種類・決まりごと）を本物の Postgres（テスト用）で確かめる  marker: lifeplus-settings-v1
//   ★DB の now() もテストの「今」（2026-10-16 12:00）にそろえてから流すこと（空き枠は DB の now() で決まるため）
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const notify = () => Promise.resolve();
const call = (tok: string, body: Record<string, unknown>) => handle({ ...body, idToken: "tok-" + tok }, { sql, verifyIdToken, now: () => NOW, notify });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

const HOURS = [
  { weekday: 1, kind: "public", open: "17:00", close: "20:00" },   // 月：お客さまに見せる
  { weekday: 1, kind: "staff", open: "20:00", close: "21:00" },    // 月：手入力だけ
  { weekday: 4, kind: "public", open: "17:00", close: "20:00" },   // 木
  { weekday: 6, kind: "public", open: "09:00", close: "12:00" },   // 土
  { weekday: 3, kind: "staff", open: "10:00", close: "12:00" },    // 水：手入力だけの日
];

Deno.test({ name: "設定画面", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from closures`; await sql`delete from staff_members`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  const saved = await sql`select weekday, kind, open_time, close_time from business_hours`;
  const savedSet = await sql`select key, value from app_settings`;
  try {
    const init = await call("pat", { action: "init" });
    // deno-lint-ignore no-explicit-any
    const menus = init.menus as any[];
    const mid = (n: string) => menus.find((m) => m.name === n).id;
    await call("pat", { action: "profile", name: "患者 一", nameKana: "かんじゃ はじめ", phone: "09011112222" });

    await t.step("設定はHIROさんだけ（招待した人・お客さまは使えない）", async () => {
      await sql`insert into staff_members (label, line_user_id, perms) values ('受付', 'Ustaff', array['bookings','closures','customers'])`;
      eq(await code(call("staff", { action: "admin_settings" })), "no_permission");
      eq(await code(call("staff", { action: "admin_settings_save", hours: HOURS, leadMinutes: 60, horizonDays: 60, noshowLimit: 2 })), "no_permission");
      eq(await code(call("pat", { action: "admin_settings" })), "not_admin");
    });

    await t.step("おかしな時間・重なる時間は保存しない", async () => {
      const base = { leadMinutes: 60, horizonDays: 60, noshowLimit: 2 };
      eq(await code(call("hiro", { action: "admin_settings_save", ...base, hours: [{ weekday: 1, kind: "public", open: "17:10", close: "20:00" }] })), "hours_invalid");
      eq(await code(call("hiro", { action: "admin_settings_save", ...base, hours: [{ weekday: 1, kind: "public", open: "20:00", close: "17:00" }] })), "hours_invalid");
      eq(await code(call("hiro", { action: "admin_settings_save", ...base, hours: [{ weekday: 8, kind: "public", open: "17:00", close: "20:00" }] })), "hours_invalid");
      eq(await code(call("hiro", { action: "admin_settings_save", ...base, hours: [{ weekday: 1, kind: "vip", open: "17:00", close: "20:00" }] })), "hours_invalid");
      eq(await code(call("hiro", { action: "admin_settings_save", ...base, hours: [
        { weekday: 1, kind: "public", open: "17:00", close: "20:00" }, { weekday: 1, kind: "staff", open: "19:45", close: "21:00" }] })), "hours_overlap");
      eq(await code(call("hiro", { action: "admin_settings_save", hours: HOURS, leadMinutes: -1, horizonDays: 60, noshowLimit: 2 })), "settings_invalid");
      // ★失敗しても、いまの受付時間は消えていない
      const r = await call("hiro", { action: "admin_settings" });
      eq((r.hours as unknown[]).length, 3);
    });

    await t.step("保存すると、受付時間（種類つき）と決まりごとが入れ替わる", async () => {
      const r = await call("hiro", { action: "admin_settings_save", hours: HOURS, leadMinutes: 30, horizonDays: 90, noshowLimit: 3 });
      eq([(r.hours as unknown[]).length, r.leadMinutes, r.horizonDays, r.noshowLimit], [5, 30, 90, 3]);
      const g = await call("hiro", { action: "admin_settings" });
      eq(g, r);
    });

    await t.step("お客さまの予約ページには、手入力だけの時間は出ない（月曜は20時まで・水曜は出ない）", async () => {
      const r = await call("pat", { action: "days", menuId: mid("施術（保険）"), from: "2026-10-19" });
      // deno-lint-ignore no-explicit-any
      const days = r.days as any[];
      const mon = days.find((d) => d.date === "2026-10-19");
      eq([mon.slots[0].time, mon.slots[mon.slots.length - 1].time, mon.slots.length], ["17:00", "19:45", 12]);
      eq(days.some((d) => d.date === "2026-10-21"), false);   // 水曜（手入力だけ）は出ない
    });

    await t.step("お客さまは手入力だけの時間に予約できない", async () => {
      eq(await code(call("pat", { action: "book", menuId: mid("施術（保険）"), startsAt: "2026-10-19T20:15:00+09:00", symptoms: ["腰"] })), "slot_not_available");
    });

    await t.step("管理画面の候補：受付時間＋手入力だけの時間。any でそれ以外も", async () => {
      const r = await call("hiro", { action: "admin_slots", date: "2026-10-19", menuId: mid("施術（保険）") });
      // deno-lint-ignore no-explicit-any
      const sl = r.slots as any[];
      eq([sl[0].time, sl[0].kind, sl[sl.length - 1].time, sl[sl.length - 1].kind, sl.length], ["17:00", "public", "20:45", "staff", 16]);
      const a = await call("hiro", { action: "admin_slots", date: "2026-10-19", menuId: mid("施術（保険）"), any: true });
      // deno-lint-ignore no-explicit-any
      const al = a.slots as any[];
      eq([al[0].time, al[0].kind, al[al.length - 1].time, al.length], ["06:00", "other", "22:45", 68]);
      eq(al.filter((x) => x.time === "17:00")[0].kind, "public");   // 重なった時刻は public のまま
      eq(al.filter((x) => x.time === "20:30")[0].kind, "staff");
      // 水曜：手入力だけの日
      const w = await call("hiro", { action: "admin_slots", date: "2026-10-21", menuId: mid("施術（保険）") });
      // deno-lint-ignore no-explicit-any
      eq(((w.slots as any[]).map((x) => x.kind)).every((k) => k === "staff"), true);
    });

    await t.step("手入力だけの時間に、HIROさんは手で入れられる。招待した人（予約の権限あり）も入れられる", async () => {
      const r = await call("hiro", { action: "admin_book", menuId: mid("施術（保険）"), startsAt: "2026-10-19T20:15:00+09:00", name: "知り合い 一" });
      eq(r.ok, true);
      const s = await call("staff", { action: "admin_book", menuId: mid("施術（保険）"), startsAt: "2026-10-21T10:00:00+09:00", name: "知り合い 二" });
      eq(s.ok, true);
      // 入れた時間は、候補から消える
      const sl = await call("hiro", { action: "admin_slots", date: "2026-10-19", menuId: mid("施術（保険）") });
      // deno-lint-ignore no-explicit-any
      eq((sl.slots as any[]).some((x) => x.time === "20:15"), false);
    });

    await t.step("予約表：手入力だけの時間を別に返す。月のカレンダーは手入力だけの日に印", async () => {
      const d = await call("hiro", { action: "admin_day", date: "2026-10-19" });
      eq([d.hours, d.staffHours], [[{ open: "17:00", close: "20:00" }], [{ open: "20:00", close: "21:00" }]]);
      const w = await call("hiro", { action: "admin_day", date: "2026-10-21" });
      eq([(w.hours as unknown[]).length, (w.staffHours as unknown[]).length, (w.bookings as unknown[]).length], [0, 1, 1]);
      const m = await call("hiro", { action: "admin_month", month: "2026-10" });
      // deno-lint-ignore no-explicit-any
      const wed = (m.days as any[]).find((x) => x.date === "2026-10-21");
      eq([wed.open, wed.staff, wed.count], [false, true, 1]);
    });

    await t.step("決まりごと：締め切りを30分にすると、お客さまの予約ページもそれに従う", async () => {
      const v = await sql`select lp_setting_int('lead_minutes', 60) as n`;
      eq(v[0].n, 30);
    });
  } finally {
    // テスト用DBの受付時間・設定を元に戻す（ほかのテストのため）
    await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from staff_members`;
    await sql`delete from business_hours`;
    for (const h of saved) await sql`insert into business_hours (weekday, kind, open_time, close_time) values (${h.weekday}, ${h.kind}, ${h.open_time}, ${h.close_time})`;
    for (const r of savedSet) await sql`update app_settings set value = ${r.value} where key = ${r.key}`;
    await sql.end();
  }
} });
