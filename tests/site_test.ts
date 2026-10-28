// ホームページの変えられる所・求人（lifeplus-site-cms-v1）を本物の Postgres（テスト用）で確かめる
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" } : null);
const NOW = new Date("2026-10-28T10:00:00+09:00");
const sent: { to: string[]; text: string }[] = [];
const notify = (to: string[], text: string) => { sent.push({ to, text }); return Promise.resolve(); };
const puts: string[] = [];
const putImage = (path: string, _b: Uint8Array, _t: string) => { puts.push(path); return Promise.resolve("https://cdn.example/site/" + path); };
const deps = { sql, verifyIdToken, now: () => NOW, notify, putImage, clientIp: "203.0.113.9" };
const as = (who: string, body: Record<string, unknown>) => handle({ idToken: "tok-" + who, ...body }, deps);
const pub = () => handle({ action: "site" }, deps) as Promise<any>;
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
// 小さな本物の JPEG（1x1）
const JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

Deno.test({ name: "ホームページの変えられる所・求人", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from site_news`; await sql`delete from site_jobs`; await sql`delete from contact_messages`;
  await sql`update site_content set value = '{}'::jsonb where key = 'photos'`;
  await sql`update site_content set value = '{"am":"9:00〜12:00","pm":"13:30〜16:30","sun":"9:30〜16:30","days":"月曜〜金曜・日曜・祝日（土曜はお休み）"}'::jsonb where key = 'day_hours'`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  await sql`delete from staff_members`;
  await sql`insert into staff_members (label, perms, line_user_id) values ('事務さん', '{site}', 'Ujimu'), ('受付さん', '{bookings}', 'Uuke')`;
  try {
    await t.step("だれでも読める：はじめはデイの時間・受付時間・ボディケアの料金（おすすめが先頭）", async () => {
      const s = await pub();
      eq([s.news.length, s.jobs.length], [0, 0]);
      eq(s.dayHours.am, "9:00〜12:00");
      eq(s.rsvHours.length > 0, true);
      eq(s.menus[0].name, "慢性症状アプローチ");
      eq(s.menus[0].featured, true);
      eq(s.menus[0].description.includes("トリガーポイント"), true);
      eq(s.menus.map((m: any) => m.name).includes("施術（保険）"), false);   // 接骨院のメニューは出さない
    });
    await t.step("書けるのは site の権限がある人だけ（受付さん・お客さま・ログインなしはだめ）", async () => {
      eq(await code(as("uke", { action: "admin_site" })), "no_permission");
      eq(await code(as("guest", { action: "admin_site" })), "not_admin");
      eq(await code(handle({ action: "admin_site" }, deps)), "no_token");
      eq(await code(as("jimu", { action: "admin_site" })), "ok");
      eq(await code(as("hiro", { action: "admin_site" })), "ok");
    });
    await t.step("お知らせ：載せる日・期限・下書きで出し分ける", async () => {
      await as("jimu", { action: "admin_site_news_save", date: "2026-10-25", title: "年末年始のお休み", body: "12/29〜1/3", business: "all" });
      await as("jimu", { action: "admin_site_news_save", date: "2026-11-01", title: "先の日付", business: "day" });          // まだ出さない
      await as("jimu", { action: "admin_site_news_save", date: "2026-10-01", title: "期限切れ", until: "2026-10-20", business: "all" });
      await as("jimu", { action: "admin_site_news_save", date: "2026-10-27", title: "下書き", published: false, business: "sekkotsu" });
      const s = await pub();
      eq(s.news.map((n: any) => n.title), ["年末年始のお休み"]);
      eq(s.news[0], { date: "2026-10-25", title: "年末年始のお休み", body: "12/29〜1/3", business: "all" });
      const a = await as("jimu", { action: "admin_site" }) as any;
      eq(a.news.length, 4);
      eq(await code(as("jimu", { action: "admin_site_news_save", date: "10/25", title: "x" })), "site_date_invalid");
      eq(await code(as("jimu", { action: "admin_site_news_save", date: "2026-10-25", title: " " })), "site_title_required");
      await as("jimu", { action: "admin_site_news_del", id: a.news.find((n: any) => n.title === "下書き").id });
      eq(((await as("jimu", { action: "admin_site" })) as any).news.length, 3);
    });
    await t.step("求人：どの事業の募集かを選べる。募集中だけ出る", async () => {
      const r1 = await as("hiro", { action: "admin_site_job_save", business: "day", title: "介護職員", employment: "パート", salary: "時給1,100円〜", open: true }) as any;
      await as("hiro", { action: "admin_site_job_save", business: "sekkotsu", title: "柔道整復師", employment: "正社員", open: false });
      eq((await pub()).jobs.map((j: any) => [j.business, j.title]), [["day", "介護職員"]]);
      // 接骨院の募集に変える
      await as("jimu", { action: "admin_site_job_save", id: r1.id, business: "sekkotsu", title: "受付", employment: "パート", open: true });
      eq((await pub()).jobs.map((j: any) => [j.business, j.title]), [["sekkotsu", "受付"]]);
      eq(await code(as("jimu", { action: "admin_site_job_save", business: "shop", title: "x", employment: "y" })), "site_job_business");
    });
    await t.step("求人への応募：募集中の求人か「求人全般」。HIROさんに知らせる", async () => {
      const job = (await pub()).jobs[0];
      sent.length = 0;
      eq(await handle({ action: "contact", business: "recruit", jobId: job.id, name: "応募 花子", phone: "090-3333-4444", body: "経験3年", elapsed: 9000 }, deps), { ok: true });
      eq(await handle({ action: "contact", business: "recruit", name: "応募 次郎", email: "a@example.jp", elapsed: 9000 }, { ...deps, clientIp: "203.0.113.10" }), { ok: true });
      const r = await sql`select business, kind from contact_messages order by created_at, kind`;
      eq(r.map((x: any) => x.business), ["recruit", "recruit"]);
      eq(r.some((x: any) => x.kind === "接骨院／受付（パート）") && r.some((x: any) => x.kind === "求人全般"), true);
      eq(sent[0].text.startsWith("【ホームページから採用への応募】"), true);
      // 募集していない求人・おかしな番号は断る
      const closed = (await sql`select id from site_jobs where not is_open`)[0].id;
      eq(await code(handle({ action: "contact", business: "recruit", jobId: closed, name: "x", phone: "09011112222", elapsed: 9000 }, deps)), "contact_kind");
      eq(await code(handle({ action: "contact", business: "recruit", jobId: "abc", name: "x", phone: "09011112222", elapsed: 9000 }, deps)), "contact_kind");
      // URL 入りの営業は、応募でも断る
      eq(await code(handle({ action: "contact", business: "recruit", name: "x", phone: "09011112222", body: "https://spam", elapsed: 9000 }, { ...deps, clientIp: "203.0.113.11" })), "contact_link");
    });
    await t.step("アプリ開発のお問い合わせ", async () => {
      eq(await handle({ action: "contact", business: "apps", kind: "導入の相談", name: "施設 太郎", email: "b@example.jp", elapsed: 9000 }, { ...deps, clientIp: "203.0.113.12" }), { ok: true });
      eq(await code(handle({ action: "contact", business: "apps", kind: "営業", name: "x", email: "b@example.jp", elapsed: 9000 }, deps)), "contact_kind");
    });
    await t.step("デイの利用時間を変える", async () => {
      await as("jimu", { action: "admin_site_day_hours", dayHours: { am: "9:15〜12:15", pm: "13:30〜16:30", sun: "", days: "月〜金・日" } });
      eq((await pub()).dayHours, { am: "9:15〜12:15", pm: "13:30〜16:30", sun: "", days: "月〜金・日" });
      eq(await code(as("jimu", { action: "admin_site_day_hours", dayHours: { am: "", pm: "", sun: "" } })), "site_hours_required");
    });
    await t.step("ボディケアの名前・料金・説明・おすすめ。料金は予約ページ（menus）と同じ", async () => {
      const a = await as("hiro", { action: "admin_site" }) as any;
      const trial = a.menus.find((m: any) => m.name === "ちょっとお試しコース");
      const list = a.menus.map((m: any) => m.id === trial.id ? { ...m, priceYen: 4500, description: "初回の方に", featured: true } : { ...m, featured: false });
      await as("jimu", { action: "admin_site_menus", menus: list });
      const s = await pub();
      eq([s.menus[0].name, s.menus[0].priceYen, s.menus[0].description, s.menus[0].featured], ["ちょっとお試しコース", 4500, "初回の方に", true]);
      eq((await sql`select price_yen from menus where id = ${trial.id}::uuid`)[0].price_yen, 4500);
      eq(await code(as("jimu", { action: "admin_site_menus", menus: [{ ...trial, priceYen: -1 }] })), "site_price_invalid");
      eq(await code(as("jimu", { action: "admin_site_menus", menus: [{ ...trial, id: "00000000-0000-0000-0000-000000000000" }] })), "site_not_found");
      // 元に戻す
      await as("hiro", { action: "admin_site_menus", menus: a.menus });
    });
    await t.step("写真：決まった場所だけ。写真でないもの・大きすぎるものは断る。元に戻せる", async () => {
      const r = await as("jimu", { action: "admin_site_photo", slot: "top_hero", type: "image/jpeg", data: "data:image/jpeg;base64," + JPG }) as any;
      eq(r.photos.top_hero.startsWith("https://cdn.example/site/photos/top_hero-"), true);
      eq((await pub()).photos.top_hero, r.photos.top_hero);
      eq(await code(as("jimu", { action: "admin_site_photo", slot: "evil", type: "image/jpeg", data: JPG })), "site_photo_slot");
      eq(await code(as("jimu", { action: "admin_site_photo", slot: "day_1", type: "image/jpeg", data: btoa("<html>not a photo</html>") })), "site_photo_type");
      eq(await code(as("jimu", { action: "admin_site_photo", slot: "day_1", type: "text/html", data: JPG })), "site_photo_type");
      await as("jimu", { action: "admin_site_photo_reset", slot: "top_hero" });
      eq((await pub()).photos, {});
    });
    await t.step("お店の端末にも site の権限を付けられる", async () => {
      const c = await as("hiro", { action: "admin_device_code", label: "受付のiPad", perms: ["site", "bookings"] }) as any;
      const p = await handle({ action: "device_pair", code: c.code }, deps) as any;
      eq(await code(handle({ action: "admin_site", deviceToken: p.deviceToken }, deps)), "ok");
      await sql`delete from admin_devices`;
    });
  } finally {
    await sql`delete from site_news`; await sql`delete from site_jobs`; await sql`delete from contact_messages`; await sql`delete from staff_members`;
    await sql.end();
  }
} });
