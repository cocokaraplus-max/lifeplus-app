// ホームページのお問い合わせ（site-contact-v1）を本物の Postgres（テスト用）で確かめる
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = () => Promise.resolve(null);
const NOW = new Date("2026-10-23T10:00:00+09:00");
const sent: { to: string[]; text: string }[] = [];
const notify = (to: string[], text: string) => { sent.push({ to, text }); return Promise.resolve(); };
const call = (body: Record<string, unknown>, ip = "203.0.113.5") =>
  handle({ action: "contact", elapsed: 8000, ...body }, { sql, verifyIdToken, now: () => NOW, notify, clientIp: ip });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const base = { business: "day", kind: "見学したい", name: "テスト 太郎", phone: "090-1111-2222", body: "見学できますか" };

Deno.test({ name: "お問い合わせ", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from contact_messages`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  try {
    await t.step("LINE のログインなしで送れる。表に残り、HIROさんに知らせる", async () => {
      eq(await call(base), { ok: true });
      const r = await sql`select business, kind, name, phone, email, body, ip_hash from contact_messages`;
      eq([r.length, r[0].business, r[0].kind, r[0].phone, r[0].email], [1, "day", "見学したい", "09011112222", null]);
      eq(r[0].ip_hash !== "203.0.113.5" && String(r[0].ip_hash).length === 24, true);   // IP はそのまま残さない
      eq(sent.length, 1);
      eq(sent[0].to.includes("Uhiro"), true);
      eq(sent[0].text.includes("デイサービス ココカラプラス") && sent[0].text.includes("090-1111-2222"), true);
    });
    await t.step("連絡先が1つも無い・おかしい形は断る", async () => {
      eq(await code(call({ ...base, phone: "" })), "contact_reach");
      eq(await code(call({ ...base, phone: "123" })), "phone_invalid");
      eq(await code(call({ ...base, phone: "", email: "abc" })), "email_invalid");
      eq(await code(call({ ...base, phone: "", email: "cm@example.jp" }, "198.51.100.9")), "ok");
    });
    await t.step("名前・種類が無い／決まっていない種類は断る", async () => {
      eq(await code(call({ ...base, name: " " })), "contact_name");
      eq(await code(call({ ...base, kind: "営業のご案内" })), "contact_kind");
      eq(await code(call({ ...base, business: "shop" })), "contact_invalid");
    });
    await t.step("URL を書いたもの（営業）は受け付けない", async () => {
      eq(await code(call({ ...base, body: "弊社サービスのご案内 https://example.com" })), "contact_link");
      eq(await code(call({ ...base, body: "詳しくは www.example.jp へ" })), "contact_link");
      eq(await code(call({ ...base, org: "example.com/lp" })), "contact_link");
    });
    await t.step("機械（見えない欄が埋まっている・開いてすぐ）は、受け付けたふりをして捨てる", async () => {
      const before = (await sql`select count(*)::int as n from contact_messages`)[0].n;
      eq(await call({ ...base, website: "http://spam" }, "192.0.2.1"), { ok: true });
      eq(await call({ ...base, elapsed: 500 }, "192.0.2.2"), { ok: true });
      eq((await sql`select count(*)::int as n from contact_messages`)[0].n, before);
    });
    await t.step("同じ所から1時間に3件まで", async () => {
      eq(await code(call(base, "192.0.2.50")), "ok");
      eq(await code(call(base, "192.0.2.50")), "ok");
      eq(await code(call(base, "192.0.2.50")), "ok");
      eq(await code(call(base, "192.0.2.50")), "contact_too_many");
      eq(await code(call(base, "192.0.2.51")), "ok");   // 別の所からは送れる
    });
    await t.step("ほかの操作は、いままでどおり LINE のログインが要る", async () => {
      eq(await code(handle({ action: "init" }, { sql, verifyIdToken })), "no_token");
    });
  } finally {
    await sql`delete from contact_messages`;
    await sql.end();
  }
} });
