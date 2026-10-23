// お店の端末（admin-device-v1）を本物の Postgres（テスト用）で確かめる
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" + t.slice(4) } : null);
let NOW = new Date("2026-10-23T10:00:00+09:00");
const sent: { to: string[]; text: string }[] = [];
const notify = (to: string[], text: string) => { sent.push({ to, text }); return Promise.resolve(); };
const deps = (ip = "203.0.113.7") => ({ sql, verifyIdToken, now: () => NOW, notify, clientIp: ip });
// deno-lint-ignore no-explicit-any
const hiro = (body: Record<string, unknown>): Promise<any> => handle({ ...body, idToken: "tok-hiro" }, deps());
// deno-lint-ignore no-explicit-any
const dev = (tok: string, body: Record<string, unknown>): Promise<any> => handle({ ...body, deviceToken: tok }, deps());
// deno-lint-ignore no-explicit-any
const pair = (c: string, ip?: string): Promise<any> => handle({ action: "device_pair", code: c, ua: "iPad Safari" }, deps(ip));
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const wrong = (c: string) => (c === "000000" ? "000001" : "000000");

Deno.test({ name: "お店の端末", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from admin_devices`; await sql`delete from device_pair_fails`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  let tok = "", id = "";
  try {
    await t.step("HIROさんが番号を出す（6桁・15分）。通知の権限は付けられない", async () => {
      const r = await hiro({ action: "admin_device_code", label: "受付PC", perms: ["bookings", "notify", "closures"] });
      eq(/^\d{6}$/.test(r.code), true);
      eq(Date.parse(r.expires) - NOW.getTime(), 15 * 60000);
      id = r.id;
      const row = (await sql`select perms, pair_code_hash, token_hash from admin_devices where id = ${id}`)[0];
      eq(row.perms, ["closures", "bookings"]);
      eq(row.pair_code_hash !== r.code && String(row.pair_code_hash).length === 64, true);   // 番号はそのまま残さない
      const l = await hiro({ action: "admin_devices" });
      eq([l.devices.length, l.devices[0].paired, l.devices[0].pairing], [1, false, true]);
      (globalThis as Record<string, unknown>).CODE = r.code;
    });
    await t.step("違う番号・形のおかしい番号は断る", async () => {
      const c = (globalThis as Record<string, unknown>).CODE as string;
      eq(await code(pair(wrong(c))), "pair_invalid");
      eq(await code(pair("12")), "pair_invalid");
    });
    await t.step("番号を入れると、LINE なしで管理画面が開ける。HIROさんに知らせる", async () => {
      sent.length = 0;
      const c = (globalThis as Record<string, unknown>).CODE as string;
      const r = await pair(c.slice(0, 3) + " " + c.slice(3));   // 間に空白があっても通る
      tok = r.deviceToken; eq([r.ok, r.label, tok.length >= 40], [true, "受付PC", true]);
      eq(sent.length === 1 && sent[0].to.includes("Uhiro") && sent[0].text.includes("受付PC"), true);
      const row = (await sql`select token_hash, pair_code_hash from admin_devices where id = ${id}`)[0];
      eq([row.token_hash !== tok, row.pair_code_hash], [true, null]);   // 合鍵もハッシュだけ
      const init = await dev(tok, { action: "admin_init" });
      eq(init.me, { owner: false, perms: ["closures", "bookings"], label: "受付PC", device: true });
      eq(await code(pair(c)), "pair_invalid");   // 同じ番号は2回使えない
    });
    await t.step("権限の外・HIROさんだけの操作はできない。予約ページの操作もできない", async () => {
      eq(await code(dev(tok, { action: "admin_day", date: "2026-10-26" })), "ok");
      eq(await code(dev(tok, { action: "admin_customers" })), "no_permission");
      eq(await code(dev(tok, { action: "admin_staff" })), "no_permission");
      eq(await code(dev(tok, { action: "admin_devices" })), "no_permission");
      eq(await code(dev(tok, { action: "admin_device_code", label: "x" })), "no_permission");
      eq(await code(dev(tok, { action: "admin_settings" })), "no_permission");
      eq(await code(dev(tok, { action: "init" })), "no_permission");
      eq(await code(dev("でたらめ", { action: "admin_init" })), "device_invalid");
    });
    await t.step("権限を変えるとすぐ効く", async () => {
      await hiro({ action: "admin_device_update", id, label: "受付PC", perms: ["customers"] });
      eq(await code(dev(tok, { action: "admin_customers" })), "ok");
    });
    await t.step("お客さまの権限がある端末は、手で入れた人（LINEなし・予約なし）を消せる", async () => {
      const cu = (await sql`insert into customers (name, phone) values ('端末で消す人', '09033334444') returning id`)[0].id;
      eq(await dev(tok, { action: "admin_customer_delete", customerId: cu }), { ok: true, bookings: 0 });
      const lc = (await sql`insert into customers (name, line_user_id) values ('LINEの人', 'Uline-del') returning id`)[0].id;
      eq(await code(dev(tok, { action: "admin_customer_delete", customerId: lc })), "customer_has_line");
      await sql`delete from customers where id = ${lc}`;
    });
    await t.step("番号を出し直すと、それまでの端末は使えなくなる", async () => {
      const r = await hiro({ action: "admin_device_code", id });
      eq(await code(dev(tok, { action: "admin_init" })), "device_invalid");
      tok = (await pair(r.code)).deviceToken;
      eq(await code(dev(tok, { action: "admin_init" })), "ok");
    });
    await t.step("15分を過ぎた番号は使えない", async () => {
      const r = await hiro({ action: "admin_device_code", label: "タブレット", perms: [] });
      NOW = new Date(NOW.getTime() + 16 * 60000);
      eq(await code(pair(r.code)), "pair_invalid");
      await sql`delete from admin_devices where id = ${r.id}`;
    });
    await t.step("端末が自分で登録を外せる", async () => {
      const r = await hiro({ action: "admin_device_code", label: "予備", perms: [] });
      const t2 = (await pair(r.code)).deviceToken;
      eq(await dev(t2, { action: "admin_device_forget" }), { ok: true });
      eq(await code(dev(t2, { action: "admin_init" })), "device_invalid");
      eq(await code(dev(tok, { action: "admin_init" })), "ok");   // ほかの端末はそのまま
      await sql`delete from admin_devices where id = ${r.id}`;
    });
    await t.step("180日開かなかった端末は使えない", async () => {
      NOW = new Date(NOW.getTime() + 181 * 86400000);
      eq(await code(dev(tok, { action: "admin_init" })), "device_invalid");
    });
    await t.step("HIROさんが外すと、すぐ使えなくなる", async () => {
      const r = await hiro({ action: "admin_device_code", id });
      tok = (await pair(r.code)).deviceToken;
      await hiro({ action: "admin_device_del", id });
      eq(await code(dev(tok, { action: "admin_init" })), "device_invalid");
    });
    await t.step("番号の入れ間違いは、同じ所から1時間に10回まで", async () => {
      await sql`delete from device_pair_fails`;
      const r = await hiro({ action: "admin_device_code", label: "総当たり", perms: [] });
      for (let i = 0; i < 10; i++) eq(await code(pair(wrong(r.code), "198.51.100.1")), "pair_invalid");
      eq(await code(pair(r.code, "198.51.100.1")), "pair_too_many");   // 正しい番号でも止める
      eq(await code(pair(r.code, "198.51.100.2")), "ok");              // 別の所からは入れる
    });
    await t.step("ほかの人の LINE では端末を作れない", async () => {
      eq(await code(handle({ action: "admin_device_code", label: "x", idToken: "tok-pat" }, deps())), "not_admin");
    });
  } finally {
    await sql`delete from admin_devices`; await sql`delete from device_pair_fails`;
    await sql.end();
  }
} });
