// 予約メニューを管理画面から作る・直す・止める・消す を本物の Postgres（テスト用）で確かめる  marker: lifeplus-menu-edit-v1
//   ★先に sql/lifeplus_menu_edit_v1.sql を流しておくこと
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const call = (tok: string, body: Record<string, unknown>) => handle({ ...body, idToken: "tok-" + tok }, { sql, verifyIdToken, now: () => NOW, notify: () => Promise.resolve() });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
// deno-lint-ignore no-explicit-any
type Any = any;
const NAME = "保険が使えるか分からない方";

Deno.test({ name: "予約メニューの編集", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from staff_members`;
  await sql`delete from menus where name like 'テスト%' or name = ${NAME}`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  await call("pat", { action: "profile", name: "患者 一", nameKana: "かんじゃ はじめ", phone: "09011112222" });
  let id = "";
  try {
    await t.step("接骨院にメニューを足すと、お客さまの予約ページに出る（料金の所に言葉）", async () => {
      const r = await call("hiro", { action: "admin_menu_save", businessId: "mominoki", name: NAME, description: "来院時に保険か保険外かをご説明します",
        durationMin: 30, bufferMin: 0, priceYen: null, priceLabel: "来院時にご案内", sort: 5, active: true });
      id = r.id as string;
      const m = ((await call("pat", { action: "init" })).menus as Any[]).find((x) => x.id === id);
      eq([m.businessId, m.name, m.description, m.durationMin, m.priceYen, m.priceLabel], ["mominoki", NAME, "来院時に保険か保険外かをご説明します", 30, null, "来院時にご案内"]);
    });
    await t.step("そのメニューで空き枠が出て、予約できる（30分ぶん）", async () => {
      const sl = (await call("pat", { action: "slots", menuId: id, date: "2026-10-19" })).slots as Any[];
      eq([sl[0].time, sl[sl.length - 1].time], ["17:00", "19:30"]);
      const b = (await call("pat", { action: "book", menuId: id, startsAt: "2026-10-19T17:00:00+09:00", symptoms: ["腰"] })).booking as Any;
      eq(b.menuName ?? b.menu ?? NAME, NAME);
    });
    await t.step("管理画面の一覧に、止めたものも含めて出る・これからの予約の数", async () => {
      const r = await call("hiro", { action: "admin_menus" });
      const m = (r.menus as Any[]).find((x) => x.id === id);
      eq([m.upcoming, m.used, m.active, m.priceLabel], [1, 1, true, "来院時にご案内"]);
      eq((r.businesses as Any[]).map((b) => b.id), ["mominoki", "bodycare"]);
    });
    await t.step("止めると予約ページから消える。予約に使ったメニューは消せない", async () => {
      await call("hiro", { action: "admin_menu_save", id, name: NAME, durationMin: 30, bufferMin: 0, priceYen: null, priceLabel: "来院時にご案内", sort: 5, active: false });
      eq(((await call("pat", { action: "init" })).menus as Any[]).some((x) => x.id === id), false);
      eq(await code(call("hiro", { action: "admin_menu_del", id })), "menu_in_use");
    });
    await t.step("使っていないメニューは消せる・同じ名前・おかしな時間・名前なしは止める", async () => {
      const r = await call("hiro", { action: "admin_menu_save", businessId: "bodycare", name: "テスト体験コース", durationMin: 45, bufferMin: 15, priceYen: 3000 });
      eq(await code(call("hiro", { action: "admin_menu_save", businessId: "bodycare", name: "テスト体験コース", durationMin: 45 })), "site_menu_dup");
      eq(await code(call("hiro", { action: "admin_menu_save", businessId: "bodycare", name: "テスト2", durationMin: 20 })), "menu_time_invalid");
      eq(await code(call("hiro", { action: "admin_menu_save", businessId: "bodycare", name: "", durationMin: 30 })), "menu_name_required");
      eq(await code(call("hiro", { action: "admin_menu_save", businessId: "nope", name: "テスト3", durationMin: 30 })), "bad_request");
      await call("hiro", { action: "admin_menu_del", id: r.id });
      eq(((await call("hiro", { action: "admin_menus" })).menus as Any[]).some((x) => x.id === r.id), false);
    });
    await t.step("設定の権限がない人・お客さまは使えない", async () => {
      await sql`insert into staff_members (label, line_user_id, perms) values ('受付', 'Ustaff', array['bookings','closures','customers','notify','site'])`;
      eq(await code(call("staff", { action: "admin_menu_save", businessId: "mominoki", name: "テスト4", durationMin: 30 })), "no_permission");
      eq(await code(call("pat", { action: "admin_menus" })), "not_admin");
    });
  } finally {
    await sql`delete from bookings`; await sql`delete from staff_members`;
    await sql`delete from menus where name like 'テスト%' or name = ${NAME}`;
    await sql.end();
  }
}});
