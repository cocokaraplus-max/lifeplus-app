// はたらく人の声（採用ページ）を本物の Postgres（テスト用）で確かめる  marker: lifeplus-site-voices-v1
//   ★先に sql/lifeplus_site_voices_v1.sql を流しておくこと
import postgres from "npm:postgres@3.4.5";
import { deepStrictEqual as eq } from "node:assert/strict";
import { ApiError, handle, youtubeId } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) => Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE" } : null);
const NOW = new Date("2026-11-05T10:00:00+09:00");
const puts: string[] = [];
const putImage = (path: string, _b: Uint8Array, _t: string) => { puts.push(path); return Promise.resolve("https://cdn.example/site/" + path); };
const deps = { sql, verifyIdToken, now: () => NOW, notify: () => Promise.resolve(), putImage, clientIp: "203.0.113.9" };
const as = (who: string, body: Record<string, unknown>) => handle({ idToken: "tok-" + who, ...body }, deps);
// deno-lint-ignore no-explicit-any
const pub = () => handle({ action: "site" }, deps) as Promise<any>;
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ApiError ? e.code : String(e); } };
const JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

Deno.test({ name: "はたらく人の声", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  await sql`delete from site_voices`;
  await sql`update app_settings set value = 'Uhiro' where key = 'admin_line_user_ids'`;
  await sql`delete from staff_members`;
  await sql`insert into staff_members (label, perms, line_user_id) values ('事務さん', '{site}', 'Ujimu'), ('受付さん', '{bookings}', 'Uuke')`;
  try {
    await t.step("YouTube の URL から動画の番号を読む", () => {
      const id = "dQw4w9WgXcQ";
      for (const u of [id, `https://www.youtube.com/watch?v=${id}&t=10s`, `https://youtu.be/${id}?si=abc`, `https://youtube.com/shorts/${id}`,
        `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}`]) eq(youtubeId(u), id, u);
      for (const u of ["", "https://example.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/short", "javascript:alert(1)", "<script>"]) eq(youtubeId(u), null, u);
    });

    await t.step("1件も出していないときは、ホームページに声は出ない", async () => {
      eq((await pub()).voices, []);
      const r = await as("hiro", { action: "admin_site_voice_save", business: "day", name: "Aさん", role: "介護職員・3年目", headline: "笑顔が毎日の力に", body: "利用者さんと\n一緒に", published: false });
      eq((await pub()).voices, []);   // 下書きは出ない
      const a = await as("hiro", { action: "admin_site" });
      eq((a.voices as any[]).map((v) => [v.name, v.published]), [["Aさん", false]]);
      eq(typeof r.id, "string");
    });

    await t.step("「出す」にすると、動画・写真つきで出る（メモの順に並ぶ）", async () => {
      const id = ((await as("hiro", { action: "admin_site" })).voices as any[])[0].id;
      await as("hiro", { action: "admin_site_voice_save", id, business: "day", name: "Aさん", role: "介護職員・3年目", headline: "笑顔が毎日の力に", body: "利用者さんと\n一緒に",
        video: "https://youtu.be/dQw4w9WgXcQ", published: true, sort: 2 });
      const p = await as("hiro", { action: "admin_site_voice_photo", id, type: "image/jpeg", data: "data:image/jpeg;base64," + JPG });
      eq(String(p.photo).startsWith("https://cdn.example/site/voices/" + id), true);
      await as("jimu", { action: "admin_site_voice_save", business: "sekkotsu", name: "Bさん", role: "柔道整復師", headline: "", body: "", published: true, sort: 1 });
      const v = (await pub()).voices;
      eq(v.map((x: any) => x.name), ["Bさん", "Aさん"]);
      eq([v[1].business, v[1].role, v[1].headline, v[1].body, v[1].videoId, v[1].photo === p.photo], ["day", "介護職員・3年目", "笑顔が毎日の力に", "利用者さんと\n一緒に", "dQw4w9WgXcQ", true]);
      eq(Object.keys(v[0]).includes("id") || Object.keys(v[0]).includes("published"), false);   // ホームページには中の番号・下書きの印を出さない
    });

    await t.step("おかしな動画の URL・名前なしは保存できない", async () => {
      eq(await code(as("hiro", { action: "admin_site_voice_save", name: "Cさん", video: "https://example.com/x" })), "site_video_invalid");
      eq(await code(as("hiro", { action: "admin_site_voice_save", name: "", headline: "x" })), "site_voice_name");
    });

    await t.step("写真を外す・声を消す", async () => {
      const a = ((await as("hiro", { action: "admin_site" })).voices as any[]).find((x) => x.name === "Aさん");
      await as("hiro", { action: "admin_site_voice_photo_del", id: a.id });
      eq((await pub()).voices.find((x: any) => x.name === "Aさん").photo, "");
      await as("hiro", { action: "admin_site_voice_del", id: a.id });
      eq((await pub()).voices.map((x: any) => x.name), ["Bさん"]);
    });

    await t.step("ホームページの権限がない人は使えない", async () => {
      eq(await code(as("uke", { action: "admin_site_voice_save", name: "Dさん", published: true })), "no_permission");
      eq(await code(as("pat", { action: "admin_site_voice_del", id: "00000000-0000-0000-0000-000000000000" })), "not_admin");
    });
  } finally {
    await sql`delete from site_voices`; await sql`delete from staff_members`;
    await sql.end();
  }
}});
