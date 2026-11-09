// 店頭で入れた方と、あとからLINEで予約した方を1人にまとめる を本物の Postgres（テスト用）で確かめる  marker: lifeplus-cust-merge-v1
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
const cust = async (id: string) => (await sql`select * from customers where id = ${id}::uuid`)[0];

Deno.test({ name: "お客さまをまとめる", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from staff_members`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  const mid = ((await call("pat", { action: "init" })).menus as Any[]).find((m) => m.name === "施術（保険）").id;
  try {
    // 店頭で入れた方（LINEなし・カルテ番号あり・来院1回・これからの予約1件）
    const shop = (await sql`insert into customers (name, name_kana, phone, chart_no, memo, is_returning) values ('山田 花子', 'ヤマダ ハナコ', '09011112222', '1234', '腰が弱い', true) returning id`)[0].id;
    await sql`insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until, status, source)
      values (${shop}, ${mid}, 'mominoki', '2026-10-12T17:00:00+09:00', '2026-10-12T17:15:00+09:00', '2026-10-12T17:15:00+09:00', 'done', 'admin'),
             (${shop}, ${mid}, 'mominoki', '2026-10-19T17:00:00+09:00', '2026-10-19T17:15:00+09:00', '2026-10-19T17:15:00+09:00', 'confirmed', 'admin')`;
    // あとからLINEで予約した同じ方（フリガナはひらがなで入れた・電話は同じ）
    await call("hana", { action: "profile", name: "やまだ はなこ", nameKana: "やまだ　はなこ", phone: "090-1111-2222" });
    await call("hana", { action: "book", menuId: mid, startsAt: "2026-10-22T17:00:00+09:00", symptoms: ["腰"] });
    const line = (await sql`select id from customers where line_user_id = 'Uhana'`)[0].id;
    // 関係ない方
    await sql`insert into customers (name, name_kana, phone) values ('佐藤 一郎', 'サトウ イチロウ', '09099998888')`;

    await t.step("同じ電話番号・フリガナの登録を見つける", async () => {
      const d = (await call("hiro", { action: "admin_customer_dupes", customerId: line })).dupes as Any[];
      eq(d.map((x) => [x.name, x.hasLine, x.chartNo, x.visits, x.samePhone, x.sameKana]), [["山田 花子", false, "1234", 1, true, true]]);
    });

    await t.step("まとめると、LINEの方が残り、予約の履歴・カルテ番号・メモ・通院中が引き継がれる", async () => {
      const r = await call("hiro", { action: "admin_customer_merge", customerId: shop, otherId: line, nameFrom: "other" });
      eq([r.keepId, r.moved], [line, 2]);
      eq(await cust(shop), undefined);
      const c = await cust(line);
      eq([c.line_user_id, c.name, c.name_kana, c.chart_no, c.memo, c.is_returning], ["Uhana", "山田 花子", "ヤマダ ハナコ", "1234", "腰が弱い", true]);
      const n = (await sql`select status, count(*)::int as n from bookings where customer_id = ${line}::uuid group by status order by status`).map((x: Any) => [x.status, x.n]);
      eq(n, [["confirmed", 1], ["done", 1], ["pending", 1]]);
      const list = (await call("hiro", { action: "admin_customers", q: "1234" })).customers as Any[];
      eq(list.map((x) => [x.name, x.hasLine, x.visits]), [["山田 花子", true, 1]]);
      // まとめた方の LINE から、店頭で入れていた予約も見える
      eq(((await call("hana", { action: "init" })).bookings as Any[]).length, 2);
    });

    await t.step("両方にカルテ番号があって違うときは、どちらを残すか選ぶ", async () => {
      const a = (await sql`insert into customers (name, chart_no) values ('A', '1') returning id`)[0].id;
      const b = (await sql`insert into customers (name, chart_no) values ('A', '2') returning id`)[0].id;
      eq(await code(call("hiro", { action: "admin_customer_merge", customerId: a, otherId: b })), "merge_chart_choose");
      await call("hiro", { action: "admin_customer_merge", customerId: a, otherId: b, chartFrom: "other" });
      eq([(await cust(a)).chart_no, await cust(b)], ["2", undefined]);   // LINEがどちらにも無いときは、開いていた方が残る
    });

    await t.step("両方LINEありはまとめない・同じ人どうし・権限なしは止める", async () => {
      await call("taro", { action: "profile", name: "太郎", nameKana: "タロウ", phone: "09033334444" });
      const t2 = (await sql`select id from customers where line_user_id = 'Utaro'`)[0].id;
      eq(await code(call("hiro", { action: "admin_customer_merge", customerId: line, otherId: t2 })), "merge_both_line");
      eq(await code(call("hiro", { action: "admin_customer_merge", customerId: line, otherId: line })), "customer_not_found");
      await sql`insert into staff_members (label, line_user_id, perms) values ('受付', 'Ustaff', array['bookings'])`;
      eq(await code(call("staff", { action: "admin_customer_merge", customerId: line, otherId: t2 })), "no_permission");
      eq(await code(call("pat", { action: "admin_customer_dupes", customerId: line })), "not_admin");
    });
  } finally {
    await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from staff_members`;
    await sql.end();
  }
}});
