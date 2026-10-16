// 関所（booking）を本物の Postgres（テスト用）で動かして確かめる
// 実行: deno test -A tests/booking_test.ts  （環境変数 TEST_DB_URL が必要）
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as assertEquals, rejects as assertRejects } from "node:assert/strict";
import { ApiError, handle, normalizeKana, normalizePhone } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
// LINE の代わり：トークン "tok-xxx" → 本人 "Uxxx"。それ以外は偽物
const verifyIdToken = (t: string) =>
  Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE太郎" } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const sent: { to: string[]; text: string }[] = [];
const notify = (to: string[], text: string) => { sent.push({ to, text }); return Promise.resolve(); };
const call = (body: Record<string, unknown>) => handle(body, { sql, verifyIdToken, now: () => NOW, notify });
const code = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); }
};
// deno-lint-ignore no-explicit-any
let menus: any[] = [];
const menu = (n: string) => menus.find((m) => m.name === n).id;

Deno.test({ name: "関所", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from closures`;
  await sql`update app_settings set value = '' where key = 'admin_line_user_ids'`;

  await t.step("偽物のトークン・トークンなしは通さない", async () => {
    assertEquals(await code(call({ action: "init", idToken: "fake" })), "token_invalid");
    assertEquals(await code(call({ action: "init" })), "no_token");
  });

  await t.step("初めての人：init でお客さまが作られ、登録は未完了", async () => {
    const r = await call({ action: "init", idToken: "tok-new" });
    menus = r.menus as typeof menus;
    assertEquals((r.businesses as unknown[]).length, 2);           // ココカラプラスは出ない
    assertEquals(menus.length, 5);
    assertEquals((r.profile as { complete: boolean }).complete, false);
    assertEquals((r.bookings as unknown[]).length, 0);
  });

  await t.step("登録前は予約できない", async () => {
    assertEquals(await code(call({ action: "book", idToken: "tok-new", menuId: menu("施術（保険）"),
      startsAt: "2026-10-19T17:00:00+09:00" })), "profile_required");
  });

  await t.step("登録：電話・フリガナの形を整える／おかしいものは断る", async () => {
    assertEquals(await code(call({ action: "profile", idToken: "tok-new", name: "テスト", nameKana: "てすと", phone: "123" })), "phone_invalid");
    assertEquals(await code(call({ action: "profile", idToken: "tok-new", name: "テスト", nameKana: "test", phone: "090-1234-5678" })), "kana_invalid");
    const r = await call({ action: "profile", idToken: "tok-new", name: " テスト 花子 ", nameKana: "てすと　はなこ", phone: "０９０－１２３４－５６７８" });
    const p = r.profile as { name: string; nameKana: string; phone: string; complete: boolean };
    assertEquals([p.name, p.nameKana, p.phone, p.complete], ["テスト 花子", "テスト ハナコ", "09012345678", true]);
  });

  await t.step("空き枠：月・木・土だけ、月曜は接骨院12枠", async () => {
    const r = await call({ action: "days", idToken: "tok-new", menuId: menu("施術（保険）"), from: "2026-10-16" });
    const days = r.days as { date: string; weekday: string; slots: { time: string }[] }[];
    assertEquals(days.map((d) => d.date + d.weekday),
      ["2026-10-17土", "2026-10-19月", "2026-10-22木", "2026-10-24土", "2026-10-26月", "2026-10-29木"]);
    const mon = days.find((d) => d.date === "2026-10-19")!;
    assertEquals(mon.slots.length, 12);
    assertEquals([mon.slots[0].time, mon.slots[11].time], ["17:00", "19:45"]);
    assertEquals(r.next, "2026-10-30");
    assertEquals(r.prev, null);
  });

  await t.step("過去の日付を頼まれても今日から出す", async () => {
    const r = await call({ action: "days", idToken: "tok-new", menuId: menu("施術（保険）"), from: "2020-01-01" });
    assertEquals(r.from, "2026-10-16");
  });

  await t.step("初めての人の予約は仮予約。症状は決まった選択肢だけ残る", async () => {
    const r = await call({ action: "book", idToken: "tok-new", menuId: menu("眠れるボディケアコース"),
      startsAt: "2026-10-19T17:00:00+09:00", symptoms: ["腰", "腰", "営業のご案内です！", "肩"] });
    const b = r.booking as { status: string; time: string; endTime: string; priceYen: number; businessName: string };
    assertEquals([b.status, b.time, b.endTime, b.priceYen, b.businessName],
      ["pending", "17:00", "18:00", 8000, "HIROボディケアスタジオ"]);
    const s = await sql`select symptoms from bookings`;
    assertEquals(s[0].symptoms.sort(), ["肩", "腰"].sort());
  });

  await t.step("同じ時間を別の人が取ろうとしても入らない（片付けの15分も）", async () => {
    await call({ action: "profile", idToken: "tok-old", name: "通院", nameKana: "ツウイン", phone: "0565000000" });
    assertEquals(await code(call({ action: "book", idToken: "tok-old", menuId: menu("施術（保険）"),
      startsAt: "2026-10-19T18:00:00+09:00" })), "slot_not_available");
  });

  await t.step("通院中（is_returning）の人は確定で入る", async () => {
    await sql`update customers set is_returning = true where line_user_id = 'Uold'`;
    const r = await call({ action: "book", idToken: "tok-old", menuId: menu("施術（保険）"),
      startsAt: "2026-10-19T18:15:00+09:00" });
    assertEquals((r.booking as { status: string }).status, "confirmed");
  });

  await t.step("1人3件まで", async () => {
    for (const s of ["2026-10-22T17:00:00+09:00", "2026-10-24T09:00:00+09:00"]) {
      await call({ action: "book", idToken: "tok-new", menuId: menu("施術（保険）"), startsAt: s });
    }
    assertEquals(await code(call({ action: "book", idToken: "tok-new", menuId: menu("施術（保険）"),
      startsAt: "2026-10-26T17:00:00+09:00" })), "too_many_bookings");
  });

  await t.step("他人の予約は取り消せない", async () => {
    const mine = (await call({ action: "init", idToken: "tok-new" })).bookings as { id: string }[];
    assertEquals(await code(call({ action: "cancel", idToken: "tok-old", bookingId: mine[0].id })), "booking_not_found");
  });

  await t.step("自分の予約は取り消せて、枠が戻る", async () => {
    const mine = (await call({ action: "init", idToken: "tok-new" })).bookings as { id: string; date: string }[];
    const r = await call({ action: "cancel", idToken: "tok-new", bookingId: mine[0].id });
    assertEquals((r.bookings as unknown[]).length, 2);
    const d = await call({ action: "days", idToken: "tok-new", menuId: menu("施術（保険）"), from: "2026-10-19" });
    const mon = (d.days as { date: string; slots: { time: string }[] }[]).find((x) => x.date === "2026-10-19")!;
    assertEquals(mon.slots[0].time, "17:00");
    assertEquals(mon.slots.length, 11);   // 18:15 は通院の人が使っている
  });

  await t.step("締め切り（60分前）を過ぎたら取り消せない", async () => {
    const r = await call({ action: "book", idToken: "tok-old", menuId: menu("施術（保険）"), startsAt: "2026-10-22T17:15:00+09:00" });
    const id = (r.booking as { id: string }).id;
    const late = new Date("2026-10-22T16:30:00+09:00");
    assertEquals(await code(handle({ action: "cancel", idToken: "tok-old", bookingId: id },
      { sql, verifyIdToken, now: () => late })), "cancel_too_late");
  });

  await t.step("ブロックした人（業者など）は何もできない", async () => {
    await call({ action: "init", idToken: "tok-vendor" });
    await sql`update customers set is_blocked = true where line_user_id = 'Uvendor'`;
    assertEquals(await code(call({ action: "init", idToken: "tok-vendor" })), "customer_blocked");
  });

  await t.step("おかしな入力はエラーになるだけ（落ちない）", async () => {
    assertEquals(await code(call({ action: "days", idToken: "tok-new", menuId: "'; drop table bookings;--" })), "menu_not_found");
    assertEquals(await code(call({ action: "cancel", idToken: "tok-new", bookingId: "x" })), "booking_not_found");
    assertEquals(await code(call({ action: "book", idToken: "tok-new", menuId: menu("施術（保険）"), startsAt: "あした" })), "slot_not_available");
    assertEquals(await code(call({ action: "hack", idToken: "tok-new" })), "bad_request");
    await assertRejects(() => handle(null, { sql, verifyIdToken }));
  });

  await t.step("HIROさんのLINEに知らせが届く（登録前は届かない）", async () => {
    await sql`delete from bookings where customer_id = (select id from customers where line_user_id = 'Uold')`;
    sent.length = 0;
    await call({ action: "book", idToken: "tok-old", menuId: menu("施術（保険）"), startsAt: "2026-10-26T18:00:00+09:00" });
    assertEquals(sent.length, 0);
    await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
    await call({ action: "book", idToken: "tok-old", menuId: menu("施術（保険）"), startsAt: "2026-10-29T18:00:00+09:00" });
    assertEquals(sent.length, 1);
    assertEquals(sent[0].to, ["Uhiro"]);
    assertEquals(sent[0].text.startsWith("【予約が入りました】\n10/29（木）18:00〜"), true);
    assertEquals(sent[0].text.includes("通院 様（LINE名：LINE太郎）\n電話 0565-00-0000"), true);
  });

  await t.step("ドタキャンが2回続いたら、通院中でも仮予約。理由が画面に出る", async () => {
    await sql`delete from bookings where customer_id = (select id from customers where line_user_id = 'Uold')`;
    const cid = (await sql`select id from customers where line_user_id = 'Uold'`)[0].id;
    const mid = menu("施術（保険）");
    const past = async (ts: string, st: string) => {
      await sql`insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until, status)
        values (${cid}, ${mid}, 'mominoki', ${ts}::timestamptz, ${ts}::timestamptz + interval '15 min', ${ts}::timestamptz + interval '15 min', ${st})`;
    };
    await past("2026-10-01T17:00:00+09:00", "done");
    await past("2026-10-05T17:00:00+09:00", "no_show");
    let r = await call({ action: "init", idToken: "tok-old" });
    assertEquals((r.profile as { noShowHold: boolean }).noShowHold, false);   // 1回だけなら続いていない
    await past("2026-10-08T17:00:00+09:00", "late_cancel");                   // 直前キャンセルは数えない
    await past("2026-10-12T17:00:00+09:00", "no_show");
    r = await call({ action: "init", idToken: "tok-old" });
    const p = r.profile as { noShowHold: boolean; isReturning: boolean };
    assertEquals([p.noShowHold, p.isReturning], [true, false]);
    sent.length = 0;
    const b = await call({ action: "book", idToken: "tok-old", menuId: mid, startsAt: "2026-10-31T09:00:00+09:00" });
    assertEquals((b.booking as { status: string }).status, "pending");
    assertEquals(sent[0].text.includes("ドタキャンが続いている方"), true);
  });

  await t.step("来院が1回入れば、続きは切れて確定に戻る", async () => {
    const cid = (await sql`select id from customers where line_user_id = 'Uold'`)[0].id;
    await sql`insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until, status)
      values (${cid}, ${menu("施術（保険）")}, 'mominoki', '2026-10-15T17:00:00+09:00', '2026-10-15T17:15:00+09:00', '2026-10-15T17:15:00+09:00', 'done')`;
    const r = await call({ action: "init", idToken: "tok-old" });
    assertEquals((r.profile as { isReturning: boolean }).isReturning, true);
  });

  await t.step("取り消しもHIROさんに知らせる", async () => {
    sent.length = 0;
    const mine = (await call({ action: "init", idToken: "tok-old" })).bookings as { id: string; startsAt: string }[];
    const target = mine.find((x) => x.startsAt.startsWith("2026-10-31"))!;
    await call({ action: "cancel", idToken: "tok-old", bookingId: target.id });
    assertEquals(sent[0].text.startsWith("【予約の取り消し】\n10/31（土）09:00〜"), true);
  });

  await t.step("入力の整え", () => {
    assertEquals(normalizePhone("0565-27-2837"), "0565272837");
    assertEquals(normalizePhone("+81 90 1234 5678"), null);
    assertEquals(normalizeKana("やまだ たろう"), "ヤマダ タロウ");
  });

  await sql.end();
}});
