// 管理画面の関所（admin_*）を本物の Postgres（テスト用）で確かめる
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const sent: { to: string[]; text: string }[] = [];
const notify = (to: string[], text: string) => { sent.push({ to, text }); return Promise.resolve(); };
const call = (tok: string, body: Record<string, unknown>) => handle({ ...body, idToken: "tok-" + tok }, { sql, verifyIdToken, now: () => NOW, notify });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };

Deno.test({ name: "管理画面", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from bookings`; await sql`delete from customers`; await sql`delete from closures`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  const init = await call("pat", { action: "init" });
  // deno-lint-ignore no-explicit-any
  const menus = init.menus as any[];
  const mid = (n: string) => menus.find((m) => m.name === n).id;
  await call("pat", { action: "profile", name: "患者 一", nameKana: "かんじゃ はじめ", phone: "09011112222" });
  const b1 = (await call("pat", { action: "book", menuId: mid("施術（保険）"), startsAt: "2026-10-19T18:30:00+09:00", symptoms: ["腰"] })).booking as { id: string };

  await t.step("HIROさん以外は管理の操作ができない", async () => {
    eq(await code(call("pat", { action: "admin_init" })), "not_admin");
    eq(await code(call("x", { action: "admin_day", date: "2026-10-19" })), "not_admin");
  });

  await t.step("その日の予約・確認待ちの数が見える", async () => {
    const d = await call("hiro", { action: "admin_day", date: "2026-10-19" });
    // deno-lint-ignore no-explicit-any
    const bs = d.bookings as any[];
    eq([bs.length, bs[0].time, bs[0].status, bs[0].customer.name, bs[0].customer.phone, d.pendingCount, d.weekday], [1, "18:30", "pending", "患者 一", "09011112222", 1, "月"]);
    eq((d.hours as { open: string }[])[0].open, "17:00");
  });

  await t.step("確定すると患者さんのLINEに届く", async () => {
    sent.length = 0;
    const r = await call("hiro", { action: "admin_decide", bookingId: b1.id, decision: "confirm" });
    eq(r.sent, true);
    eq(sent[0].to, ["Upat"]);
    eq(sent[0].text.startsWith("【ご予約が確定しました】\n10/19（月）18:30〜"), true);
    eq(await code(call("hiro", { action: "admin_decide", bookingId: b1.id, decision: "confirm" })), "booking_not_pending");
  });

  await t.step("お断りすると枠が空き、患者さんに届く", async () => {
    const b2 = (await call("pat", { action: "book", menuId: mid("施術（保険）"), startsAt: "2026-10-22T17:00:00+09:00" })).booking as { id: string; status: string };
    eq(b2.status, "pending");
    sent.length = 0;
    await call("hiro", { action: "admin_decide", bookingId: b2.id, decision: "reject" });
    eq(sent[0].text.includes("お受けできませんでした"), true);
    const d = await call("hiro", { action: "admin_day", date: "2026-10-22" });
    eq((d.bookings as unknown[]).length, 0);
  });

  await t.step("来院・ドタキャンを付けると名簿の回数に出る", async () => {
    await call("hiro", { action: "admin_outcome", bookingId: b1.id, outcome: "no_show" });
    let c = await call("hiro", { action: "admin_customers", q: "カンジャ" });
    // deno-lint-ignore no-explicit-any
    let row = (c.customers as any[])[0];
    eq([row.noShows, row.visits], [1, 0]);
    await call("hiro", { action: "admin_outcome", bookingId: b1.id, outcome: "done" });
    c = await call("hiro", { action: "admin_customers", q: "0901111" });
    // deno-lint-ignore no-explicit-any
    row = (c.customers as any[])[0];
    eq([row.noShows, row.visits, row.isReturning], [0, 1, true]);
    eq(await code(call("hiro", { action: "admin_outcome", bookingId: b1.id, outcome: "hack" })), "bad_request");
  });

  await t.step("名簿の絞り込み・ブロック", async () => {
    // deno-lint-ignore no-explicit-any
    const cid = ((await call("hiro", { action: "admin_customers", q: "" })).customers as any[])[0].id;
    await call("hiro", { action: "admin_customer_update", customerId: cid, isBlocked: true, memo: "テスト" });
    // deno-lint-ignore no-explicit-any
    eq(((await call("hiro", { action: "admin_customers", filter: "blocked" })).customers as any[]).length, 1);
    eq(await code(call("pat", { action: "init" })), "customer_blocked");
    await call("hiro", { action: "admin_customer_update", customerId: cid, isBlocked: false });
    eq(await code(call("pat", { action: "init" })), "ok");
  });

  await t.step("休みを入れると、重なる予約を教えてくれる。はがすと戻る", async () => {
    const b3 = (await call("pat", { action: "book", menuId: mid("施術（保険）"), startsAt: "2026-10-26T18:00:00+09:00" })).booking as { id: string };
    const r = await call("hiro", { action: "admin_closure_add", date: "2026-10-26", from: "17:30", note: "用事" });
    eq((r.conflicts as { id: string }[]).map((x) => x.id), [b3.id]);
    // deno-lint-ignore no-explicit-any
    const cl = (await call("hiro", { action: "admin_closures" })).closures as any[];
    eq([cl[0].date, cl[0].from, cl[0].to, cl[0].note], ["2026-10-26", "17:30", "24:00", "用事"]);
    const slots = await call("pat", { action: "days", menuId: mid("施術（保険）"), from: "2026-10-26" });
    // deno-lint-ignore no-explicit-any
    eq(((slots.days as any[]).find((d) => d.date === "2026-10-26")).slots.map((s: any) => s.time), ["17:00", "17:15"]);
    await call("hiro", { action: "admin_closure_del", id: cl[0].id });
    eq(((await call("hiro", { action: "admin_closures" })).closures as unknown[]).length, 0);
  });

  await t.step("電話の予約を手で入れる（LINEなしの人も）", async () => {
    const s = await call("hiro", { action: "admin_slots", date: "2026-10-29", menuId: mid("眠れるボディケアコース") });
    eq((s.slots as { time: string }[])[0].time, "17:00");
    const r = await call("hiro", { action: "admin_book", name: "電話 太郎", phone: "0565-11-2222", menuId: mid("眠れるボディケアコース"), startsAt: "2026-10-29T17:00:00+09:00", tellPatient: true });
    eq([r.ok, r.sent], [true, false]);
    const d = await call("hiro", { action: "admin_day", date: "2026-10-29" });
    // deno-lint-ignore no-explicit-any
    const b = (d.bookings as any[])[0];
    eq([b.status, b.source, b.customer.name, b.customer.hasLine, b.blockUntil], ["confirmed", "admin", "電話 太郎", false, "18:15"]);
    eq(await code(call("hiro", { action: "admin_book", name: "重ね", menuId: mid("施術（保険）"), startsAt: "2026-10-29T17:30:00+09:00" })), "slot_not_available");
  });

  await t.step("LINEで連絡する（LINEのない人には送れない）", async () => {
    // deno-lint-ignore no-explicit-any
    const cs = (await call("hiro", { action: "admin_customers", q: "" })).customers as any[];
    const pat = cs.find((c) => c.name === "患者 一"), tel = cs.find((c) => c.name === "電話 太郎");
    sent.length = 0;
    await call("hiro", { action: "admin_message", customerId: pat.id, text: "明日はよろしくお願いします" });
    eq(sent[0], { to: ["Upat"], text: "明日はよろしくお願いします" });
    eq(await code(call("hiro", { action: "admin_message", customerId: tel.id, text: "x" })), "no_line");
    eq(await code(call("hiro", { action: "admin_message", customerId: pat.id, text: "" })), "message_required");
  });

  await t.step("HIROさんが取り消す", async () => {
    // deno-lint-ignore no-explicit-any
    const d = (await call("hiro", { action: "admin_day", date: "2026-10-26" })).bookings as any[];
    sent.length = 0;
    const r = await call("hiro", { action: "admin_cancel", bookingId: d[0].id, tellPatient: true, message: "体調不良のためお休みします" });
    eq([r.sent, sent[0].text.includes("体調不良のためお休みします")], [true, true]);
    eq(((await call("hiro", { action: "admin_day", date: "2026-10-26" })).bookings as unknown[]).length, 0);
  });

  await sql`update app_settings set value = '' where key = 'admin_line_user_ids'`;
  await sql.end();
}});
