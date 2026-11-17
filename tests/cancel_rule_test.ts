// 取り消しの締め切り（予約と別）とキャンセルの案内を、本物の Postgres（テスト用）で確かめる  marker: lifeplus-cancel-rule-v1
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle, minText, CANCEL_NOTICE_DEFAULT } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const notify = () => Promise.resolve();
const call = (tok: string, body: Record<string, unknown>) => handle({ ...body, idToken: "tok-" + tok }, { sql, verifyIdToken, now: () => NOW, notify });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

Deno.test({ name: "取り消しの締め切りとキャンセルの案内", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from staff_members`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  await sql`delete from app_settings where key in ('cancel_minutes','cancel_notice')`;
  const savedSet = await sql`select key, value from app_settings`;
  try {
    await call("pat", { action: "init" });
    await call("pat", { action: "profile", name: "患者 一", nameKana: "かんじゃ はじめ", phone: "09011112222" });
    const cu = (await sql`select id from customers where line_user_id = 'Upat'`)[0].id;
    const m = (await sql`select id, business_id from menus where is_active order by sort_order limit 1`)[0];
    const add = async (hm: string) => (await sql`
      insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until, status, price_yen)
      values (${cu}, ${m.id}, ${m.business_id}, ${"2026-10-16T" + hm + ":00+09:00"}::timestamptz,
              ${"2026-10-16T" + hm + ":00+09:00"}::timestamptz + interval '20 minutes',
              ${"2026-10-16T" + hm + ":00+09:00"}::timestamptz + interval '20 minutes', 'confirmed', 0) returning id`)[0].id as string;
    const A = await add("14:30"), B = await add("13:00"), C = await add("18:00");   // 今は 12:00
    const can = async () => {
      const r = await call("pat", { action: "init" });
      // deno-lint-ignore no-explicit-any
      const by = Object.fromEntries((r.bookings as any[]).map((b) => [b.id, b.canCancel]));
      return [by[A], by[B], by[C]];
    };
    const HOURS = (await call("hiro", { action: "admin_settings" })).hours;
    const save = (o: Record<string, unknown>) => call("hiro", { action: "admin_settings_save", hours: HOURS, leadMinutes: 60, horizonDays: 60, noshowLimit: 2, ...o });

    await t.step("まだ決めていなければ、取り消しの締め切りは予約の締め切りと同じ", async () => {
      eq(await can(), [true, true, true]);                 // 60分前：13:00 はちょうど締め切り
      await save({ leadMinutes: 120 });
      eq(await can(), [true, false, true]);                // 120分前：13:00 は過ぎた
      eq((await call("hiro", { action: "admin_settings" })).cancelMinutes, 120);
    });

    await t.step("取り消しの締め切りを別に決められる（予約の締め切りは変わらない）", async () => {
      const r = await save({ leadMinutes: 120, cancelMinutes: 30 });
      eq([r.leadMinutes, r.cancelMinutes], [120, 30]);
      eq(await can(), [true, true, true]);
      await save({ leadMinutes: 120, cancelMinutes: 180 });
      eq(await can(), [false, false, true]);
      const v = await sql`select value from app_settings where key = 'lead_minutes'`;
      eq(v[0].value, "120");
    });

    await t.step("締め切りを過ぎた予約は、お客さまからは取り消せない（ボタンが無くても、直に送っても）", async () => {
      eq(await code(call("pat", { action: "cancel", bookingId: A })), "cancel_too_late");
      eq((await sql`select status from bookings where id = ${A}`)[0].status, "confirmed");
      const r = await call("pat", { action: "cancel", bookingId: C });
      // deno-lint-ignore no-explicit-any
      eq((r.bookings as any[]).some((b) => b.id === C), false);
    });

    await t.step("キャンセルの案内：まだ書いていなければ元の文。{取消}{回数} は今の設定に置きかわる", async () => {
      const s = (await call("pat", { action: "init" })).settings as Record<string, unknown>;
      eq(String(s.cancelNotice).includes("開始の3時間前まで"), true);
      eq(String(s.cancelNotice).includes("2回続いた方"), true);
      eq(s.cancelText, "3時間");
      const a = await call("hiro", { action: "admin_settings" });
      eq([a.cancelNotice, a.cancelNoticeDefault], [CANCEL_NOTICE_DEFAULT, CANCEL_NOTICE_DEFAULT]);
    });

    await t.step("案内を書きかえる・空にすると出さない", async () => {
      await save({ leadMinutes: 90, cancelMinutes: 1440, noshowLimit: 3, cancelNotice: "  予約は{予約}前／取消は{取消}前\r\n無断{回数}回で仮予約  " });
      const s = (await call("pat", { action: "init" })).settings as Record<string, unknown>;
      eq(s.cancelNotice, "予約は1時間30分前／取消は24時間前\n無断3回で仮予約");
      eq((await call("hiro", { action: "admin_settings" })).cancelNotice, "予約は{予約}前／取消は{取消}前\n無断{回数}回で仮予約");
      await save({ cancelNotice: "" });
      eq(((await call("pat", { action: "init" })).settings as Record<string, unknown>).cancelNotice, "");
      // 送らなければ今のまま
      await save({ cancelMinutes: 45 });
      eq((await call("hiro", { action: "admin_settings" })).cancelNotice, "");
    });

    await t.step("おかしな値は保存しない", async () => {
      eq(await code(save({ cancelMinutes: -1 })), "settings_invalid");
      eq(await code(save({ cancelMinutes: 10.5 })), "settings_invalid");
      eq(await code(save({ cancelNotice: "あ".repeat(601) })), "settings_invalid");
      eq(await code(call("pat", { action: "admin_settings_save", hours: HOURS, leadMinutes: 60, horizonDays: 60, noshowLimit: 2, cancelMinutes: 0 })), "not_admin");
    });

    await t.step("分の書き方", () => {
      eq([minText(0), minText(30), minText(60), minText(90), minText(120), minText(1440)], ["開始時刻", "30分", "1時間", "1時間30分", "2時間", "24時間"]);
    });
  } finally {
    await sql`delete from bookings`; await sql`delete from customers`;
    await sql`delete from app_settings`;
    for (const r of savedSet) await sql`insert into app_settings (key, value) values (${r.key}, ${r.value})`;
    await sql.end();
  }
} });
