// =============================================================
// LIFE PLUS 予約  関所（Supabase Edge Function: booking）
// marker: lifeplus-booking-fn-v1 / admin-notify-v1 / notify-contact-v1 / admin-api-v1 / staff-perms-v1 / site-contact-v1 / admin-device-v1 / lifeplus-site-cms-v1
//
// 予約ページ（LIFF）からの依頼は、すべてここを通る。
//   1. LINE の ID トークンを LINE 本体に問い合わせて、本人を確かめる
//   2. 確かめた LINE ID のお客さまとしてだけ、予約・取消・登録をする
// ページ側が「私は〇〇です」と言っても、ここで確かめるので成りすましはできない。
//
// データベースには SUPABASE_DB_URL（Supabase が自動で用意する）で直接つなぐ。
// 鍵をこのファイルに書くことはない。
// =============================================================

// ---------- 決めごと ----------
export const LINE_CHANNEL_ID = "2012042545"; // LINEログインチャネル（公開してよい番号）
export const MAX_ACTIVE_BOOKINGS = 3;        // 1人が同時に持てる予約の数（いたずら・営業よけ）
export const SYMPTOMS = [
  "首", "肩", "背中", "腰", "お尻・股関節", "膝", "足首・足",
  "肘・手首", "頭痛", "だるさ・疲れ", "ケガ（捻挫・打撲など）", "その他",
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JST_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// deno-lint-ignore no-explicit-any
type Sql = any;
export interface Deps {
  sql: Sql;
  verifyIdToken: (token: string) => Promise<{ sub: string; name?: string } | null>;
  now?: () => Date;
  // HIROさん・患者さんの LINE へ送る（失敗しても予約は止めない）
  notify?: (to: string[], text: string) => Promise<void>;
  // site-contact-v1: お問い合わせを送ってきた所（いたずら止めにだけ使う。そのままは残さない）
  clientIp?: string;
  // lifeplus-site-cms-v1: ホームページの写真を storage に置き、見られる URL を返す
  putImage?: (path: string, bytes: Uint8Array, type: string) => Promise<string>;
}

// ---------- 日付（日本時間） ----------
export function jstDate(d: Date): string {
  return new Date(d.getTime() + JST_MS).toISOString().slice(0, 10);
}
export function jstTime(d: Date): string {
  return new Date(d.getTime() + JST_MS).toISOString().slice(11, 16);
}
function addDays(ymd: string, n: number): string {
  const t = Date.parse(ymd + "T00:00:00Z") + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function isoWeekday(ymd: string): number {
  const w = new Date(ymd + "T00:00:00Z").getUTCDay(); // 0=日
  return w === 0 ? 7 : w;
}

// ---------- 入力の整え ----------
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.normalize("NFKC").replace(/[^0-9]/g, "");
  return /^0\d{9,10}$/.test(d) ? d : null;
}
export function normalizeKana(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // ひらがな → カタカナ、全角スペースも許す
  const s = v.normalize("NFKC").trim().replace(/[ぁ-ゖ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0x60)
  ).replace(/\s+/g, " ");
  return /^[ァ-ーー ]{1,40}$/.test(s) ? s : null;
}

// ---------- お客さま ----------
async function getOrCreateCustomer(sql: Sql, who: { sub: string; name?: string }) {
  const lineName = str(who.name ?? "", 60) || null;
  const rows = await sql`
    insert into customers (line_user_id, line_name)
    values (${who.sub}, ${lineName})
    on conflict (line_user_id) do update
      set line_name = coalesce(excluded.line_name, customers.line_name)
    returning id, name, name_kana, phone, line_name, is_returning, is_blocked`;
  return rows[0];
}

function profileOf(
  c: { name: string | null; name_kana: string | null; phone: string | null; is_returning: boolean },
  hold = false,
) {
  return {
    name: c.name ?? "",
    nameKana: c.name_kana ?? "",
    phone: c.phone ?? "",
    complete: !!(c.name && c.name_kana && c.phone),
    // 確定で入るかどうか（通院中で、ドタキャンが続いていない）
    isReturning: c.is_returning && !hold,
    // ドタキャンが続いたため仮予約になる
    noShowHold: hold,
  };
}

async function holdOf(sql: Sql, customerId: string): Promise<boolean> {
  const r = await sql`select lp_noshow_hold(${customerId}::uuid) as h`;
  return !!r[0].h;
}

// 知らせに添える連絡先（名前・LINE名・電話）
function contactLine(c: { name: string | null; line_name?: string | null; phone: string | null }) {
  const p = String(c.phone ?? "");
  const tel = p.length === 11 ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`
    : p.length === 10 ? `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6)}` : p;
  return `${c.name ?? ""} 様` + (c.line_name ? `（LINE名：${c.line_name}）` : "") + (tel ? `\n電話 ${tel}` : "");
}

async function adminIds(sql: Sql): Promise<string[]> {
  const r = await sql`select value from app_settings where key = 'admin_line_user_ids'`;
  return String(r[0]?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

// ---------- 休みのお知らせ（予約カレンダーに出す）  marker: lifeplus-closure-notice-v1 ----------
function dayLabel(ymd: string): string { return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${WEEKDAYS[isoWeekday(ymd) % 7]}）`; }
function closureView(c: Record<string, unknown>) {
  const s = c.starts_at as Date, e = c.ends_at as Date;
  const date = jstDate(s), endDate = jstDate(new Date(e.getTime() - 1));
  const from = jstTime(s), to = jstTime(e) === "00:00" ? "24:00" : jstTime(e);
  const whole = from === "00:00" && to === "24:00";
  return { date, endDate, from, to, whole, label: (date === endDate ? dayLabel(date) : `${dayLabel(date)}〜${dayLabel(endDate)}`) + (whole ? "" : ` ${from}〜${to}`) };
}

// ---------- 臨時の受付日（いつもは受付のない日に、その日だけ受付の時間を足す）  marker: lifeplus-extra-hours-v1 ----------
interface Extra { id: string; date: string; kind: string; open: string; close: string; note: string; notice: string }
async function extrasBetween(sql: Sql, from: string, to: string): Promise<Extra[]> {
  const r = await sql`select id, day::text as d, kind, to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c, note, notice
    from extra_hours where day >= ${from}::date and day <= ${to}::date order by day, open_time`;
  return r.map((x: Record<string, unknown>) => ({ id: x.id as string, date: x.d as string, kind: x.kind as string, open: x.o as string, close: x.c as string, note: (x.note ?? "") as string, notice: (x.notice ?? "") as string }));
}
// その日（JST）にかかっている休みから、その日の分だけを抜く（前後は残す・メモとお知らせはそのまま）
async function openDayOf(tx: Sql, d: string, onlyId?: string) {
  const { start, end } = dayRange(d);
  const rows = onlyId
    ? await tx`select * from closures where id = ${onlyId}::uuid and tstzrange(starts_at, ends_at, '[)') && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)') for update`
    : await tx`select * from closures where tstzrange(starts_at, ends_at, '[)') && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)') for update`;
  for (const c of rows) {
    await tx`delete from closures where id = ${c.id}::uuid`;
    if ((c.starts_at as Date).toISOString() < start)
      await tx`insert into closures (starts_at, ends_at, note, notice) values (${c.starts_at}, ${start}::timestamptz, ${c.note}, ${c.notice})`;
    if ((c.ends_at as Date).toISOString() > end)
      await tx`insert into closures (starts_at, ends_at, note, notice) values (${end}::timestamptz, ${c.ends_at}, ${c.note}, ${c.notice})`;
  }
  return rows.length;
}

// ---------- 管理画面を使える人  marker: staff-perms-v1 ----------
export const PERMS = ["closures", "bookings", "customers", "notify", "site"] as const;   // lifeplus-site-cms-v1: site＝ホームページの変更
// 操作ごとに要る権限（null は全員、owner はHIROさんだけ）
const PERM_OF: Record<string, string | null> = {
  admin_init: null, admin_day: null, admin_month: null, admin_pending: null,
  admin_closures: "closures", admin_closure_add: "closures", admin_closure_del: "closures", admin_closure_update: "closures",   // lifeplus-closure-notice-v1
  admin_extra_add: "closures", admin_extra_del: "closures", admin_closure_open_day: "closures",   // lifeplus-extra-hours-v1
  admin_decide: "bookings", admin_outcome: "bookings", admin_cancel: "bookings", admin_slots: "bookings", admin_book: "bookings",
  admin_customers: "customers", admin_customer: "customers", admin_customer_update: "customers", admin_message: "customers",
  admin_customer_delete: "customers",
  // device-perms-v2: スタッフ・端末の管理と、設定。★お店の端末だけが持てる（LINE のスタッフは持てない：staff_perms_ok）
  admin_staff: "staff", admin_staff_invite: "staff", admin_staff_update: "staff", admin_staff_del: "staff",
  admin_devices: "staff", admin_device_code: "staff", admin_device_update: "staff", admin_device_del: "staff",
  admin_settings: "settings", admin_settings_save: "settings",
  // lifeplus-site-cms-v1: ホームページ（お知らせ・求人・時間・料金・写真）
  admin_site: "site", admin_site_news_save: "site", admin_site_news_del: "site", admin_site_job_save: "site", admin_site_job_del: "site",
  admin_site_day_hours: "site", admin_site_menus: "site", admin_site_photo: "site", admin_site_photo_reset: "site",   // customer-delete-staff-v1: HIROさん以外は、LINEなし・これからの予約なしの人だけ（下の runAdmin で見る）
};
interface Me { owner: boolean; perms: string[]; label: string; staffId: string | null; deviceId?: string | null }
async function staffOf(sql: Sql, sub: string): Promise<Me | null> {
  if ((await adminIds(sql)).includes(sub)) return { owner: true, perms: [...PERMS], label: "HIRO", staffId: null };
  const r = await sql`update staff_members set last_seen_at = now() where line_user_id = ${sub} returning id, label, perms`;
  if (!r.length) return null;
  return { owner: false, perms: r[0].perms ?? [], label: r[0].label, staffId: r[0].id };
}
function cleanPerms(v: unknown): string[] {
  return Array.isArray(v) ? PERMS.filter((p) => v.includes(p)) : [];
}
function newInviteCode(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const INVITE_HOURS = 72;

async function notifyIds(sql: Sql): Promise<string[]> {
  const s = await sql`select line_user_id from staff_members where line_user_id is not null and 'notify' = any(perms)`;
  return [...new Set([...(await adminIds(sql)), ...s.map((r: Record<string, unknown>) => String(r.line_user_id))])];
}

async function tellAdmin(deps: Deps, text: string) {
  if (!deps.notify) return;
  try {
    const to = await notifyIds(deps.sql);
    if (to.length) await deps.notify(to, text);
  } catch (e) {
    console.error("notify failed", e);
  }
}

async function tellOwner(deps: Deps, text: string) {
  if (!deps.notify) return;
  try {
    const to = await adminIds(deps.sql);
    if (to.length) await deps.notify(to, text);
  } catch (e) {
    console.error("notify failed", e);
  }
}

// lifeplus-settings-v1: 設定画面へ返すもの
const HM15_RE = /^([01]\d|2[0-4]):(00|15|30|45)$/;
function hmMin(t: string) { const p = t.split(":"); return Number(p[0]) * 60 + Number(p[1]); }
async function settingsOut(sql: Sql) {
  const hours = await sql`select weekday, kind, to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c from business_hours order by weekday, open_time`;
  const rows = await sql`select key, value from app_settings where key in ('lead_minutes','horizon_days','noshow_limit')`;
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    hours: hours.map((h: Record<string, unknown>) => ({ weekday: Number(h.weekday), kind: h.kind, open: h.o, close: h.c === "00:00" ? "24:00" : h.c })),
    leadMinutes: Number(m.lead_minutes ?? 60),
    horizonDays: Number(m.horizon_days ?? 60),
    noshowLimit: Number(m.noshow_limit ?? 2),
  };
}

async function settings(sql: Sql) {
  const rows = await sql`select key, value from app_settings`;
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    leadMinutes: Number(m.lead_minutes ?? 60),
    horizonDays: Number(m.horizon_days ?? 60),
  };
}

async function myBookings(sql: Sql, customerId: string, now: Date) {
  const rows = await sql`
    select b.id, b.starts_at, b.ends_at, b.status, b.price_yen,
           m.name as menu_name, m.duration_min, bz.name as business_name, bz.id as business_id
    from bookings b
    join menus m on m.id = b.menu_id
    join businesses bz on bz.id = b.business_id
    where b.customer_id = ${customerId}
      and b.status in ('pending','confirmed')
      and b.ends_at > ${now.toISOString()}::timestamptz
    order by b.starts_at`;
  return rows.map((r: Record<string, unknown>) => {
    const s = r.starts_at as Date;
    return {
      id: r.id,
      startsAt: s.toISOString(),
      date: jstDate(s),
      weekday: WEEKDAYS[new Date(jstDate(s) + "T00:00:00Z").getUTCDay()],
      time: jstTime(s),
      endTime: jstTime(r.ends_at as Date),
      status: r.status,
      priceYen: r.price_yen,
      menuName: r.menu_name,
      businessId: r.business_id,
      businessName: r.business_name,
    };
  });
}

// ---------- ホームページのお問い合わせ  marker: site-contact-v1 ----------
//   ★LINE でログインしなくても送れる（ご家族・ケアマネさん向け）。そのぶん、いたずら・営業を止める：
//     ・URL（http・www）を書いたものは受け付けない（営業の文はたいてい URL を貼ってくる）
//     ・人には見えない欄（website）が埋まっていたら機械とみなし、受け付けたふりをして捨てる
//     ・開いてすぐ（3秒未満）に送られたものも機械とみなす
//     ・同じ所から1時間に3件まで、ぜんぶで1日50件まで
export const CONTACT_KINDS: Record<string, string[]> = {
  day: ["見学したい", "利用について相談したい", "ケアマネジャーからの相談", "その他"],
  sekkotsu: ["交通事故のこと", "その他"],
  bodycare: ["メニューのこと", "その他"],
  apps: ["TASUKARUについて", "導入の相談", "その他"],   // lifeplus-site-cms-v1
  other: ["その他"],
};
const BIZ_LABEL: Record<string, string> = {
  day: "デイサービス ココカラプラス", sekkotsu: "もみの木接骨院", bodycare: "HIROボディケアスタジオ", other: "LIFE PLUS",
  apps: "アプリ開発（TASUKARU）", recruit: "採用",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function ipHash(ip: string): Promise<string | null> {
  if (!ip) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("lp-contact:" + ip));
  return Array.from(new Uint8Array(d)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// ---------- お店の端末（LINE を使わずに管理画面を開く）  marker: admin-device-v1 ----------
//  HIROさんが管理画面で6桁の番号を出す → お店の端末でその番号を入れる → 端末に長い合鍵（deviceToken）を渡す。
//  ★番号も合鍵も、表にはハッシュだけ残す ★通知は受け取れない（LINE が無いので）
//  ★180日開かなかった端末は使えなくなる ★番号を出し直すと、それまでの端末は使えなくなる
const DEVICE_PERMS = ["closures", "bookings", "customers", "staff", "settings", "site"];   // device-perms-v2 / lifeplus-site-cms-v1
const PAIR_MINUTES = 15;
const DEVICE_IDLE_DAYS = 180;
const PAIR_FAILS_PER_IP_HOUR = 10;
const PAIR_FAILS_ALL_HOUR = 50;
async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newPairCode(): string {
  const b = new Uint32Array(1);
  // 偏りが出ないように、100万の倍数より上は引き直す
  do crypto.getRandomValues(b); while (b[0] >= 4294000000);
  return String(b[0] % 1000000).padStart(6, "0");
}
function newDeviceToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cleanDevicePerms(v: unknown): string[] {
  return Array.isArray(v) ? DEVICE_PERMS.filter((p) => v.includes(p)) : [];
}
async function deviceOf(sql: Sql, token: string, now: Date): Promise<Me | null> {
  const h = await sha256hex("lp-device:" + token);
  const idle = new Date(now.getTime() - DEVICE_IDLE_DAYS * 86400000).toISOString();
  const r = await sql`update admin_devices set last_seen_at = ${now.toISOString()}::timestamptz
    where token_hash = ${h} and coalesce(last_seen_at, paired_at) > ${idle}::timestamptz returning id, label, perms`;
  if (!r.length) return null;
  return { owner: false, perms: cleanDevicePerms(r[0].perms), label: r[0].label, staffId: null, deviceId: r[0].id };
}
// deno-lint-ignore no-explicit-any
async function handleDevicePair(body: any, deps: Deps, now: Date): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const ih = await ipHash("pair:" + (deps.clientIp ?? ""));
  const hourAgo = new Date(now.getTime() - 3600000).toISOString();
  const f = await sql`select count(*) filter (where ip_hash = ${ih})::int as mine, count(*)::int as all
    from device_pair_fails where created_at > ${hourAgo}::timestamptz`;
  if (f[0].mine >= PAIR_FAILS_PER_IP_HOUR || f[0].all >= PAIR_FAILS_ALL_HOUR) throw new ApiError("pair_too_many", 429);
  const code = String(body.code ?? "").replace(/[^0-9]/g, "");
  const row = code.length === 6
    ? await sql`select id, label from admin_devices where pair_code_hash = ${await sha256hex("lp-pair:" + code)}
        and pair_expires_at > ${now.toISOString()}::timestamptz`
    : [];
  if (!row.length) {
    await sql`insert into device_pair_fails (ip_hash, created_at) values (${ih}, ${now.toISOString()}::timestamptz)`;
    throw new ApiError("pair_invalid", 404);
  }
  const token = newDeviceToken();
  await sql`update admin_devices set token_hash = ${await sha256hex("lp-device:" + token)}, pair_code_hash = null, pair_expires_at = null,
    paired_at = ${now.toISOString()}::timestamptz, last_seen_at = ${now.toISOString()}::timestamptz, user_agent = ${str(body.ua, 200) || null}
    where id = ${row[0].id}`;
  await tellOwner(deps, `【管理画面】お店の端末「${row[0].label}」を登録しました。心当たりが無いときは、管理画面のスタッフ→お店の端末から外してください。`);
  return { ok: true, deviceToken: token, label: row[0].label };
}

// deno-lint-ignore no-explicit-any
async function handleContact(body: any, deps: Deps, now: Date): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const biz = str(body.business, 20);
  let kind = str(body.kind, 40);
  if (biz === "recruit") {
    // lifeplus-site-cms-v1: 求人への応募。種類は「募集中の求人の名前」か「求人全般」
    const jid = str(body.jobId, 40);
    if (jid) {
      if (!UUID_RE.test(jid)) throw new ApiError("contact_kind");
      const j = await sql`select title, employment, business from site_jobs where id = ${jid}::uuid and is_open`;
      if (!j.length) throw new ApiError("contact_kind");
      const bz: Record<string, string> = { day: "デイサービス", sekkotsu: "接骨院", bodycare: "ボディケア", company: "会社" };
      kind = `${bz[j[0].business] ?? ""}／${j[0].title}（${j[0].employment}）`.slice(0, 80);
    } else kind = "求人全般";
  } else {
    if (!(biz in CONTACT_KINDS)) throw new ApiError("contact_invalid");
    if (!CONTACT_KINDS[biz].includes(kind)) throw new ApiError("contact_kind");
  }
  // 機械よけ（見えない欄が埋まっている・開いてすぐ送った）：受け付けたふりをして捨てる
  if (str(body.website, 200) || Number(body.elapsed ?? 0) < 3000) return { ok: true };
  const name = str(body.name, 40).normalize("NFKC");
  if (!name) throw new ApiError("contact_name");
  const org = str(body.org, 60).normalize("NFKC") || null;
  const phone = normalizePhone(body.phone);
  if (str(body.phone, 30) && !phone) throw new ApiError("phone_invalid");
  const emailRaw = str(body.email, 120).normalize("NFKC");
  const email = emailRaw ? (EMAIL_RE.test(emailRaw) ? emailRaw : null) : null;
  if (emailRaw && !email) throw new ApiError("email_invalid");
  if (!phone && !email) throw new ApiError("contact_reach");   // 折り返しの連絡先が1つは要る
  const text = str(body.body, 800);
  if (/https?:|www\.|\.(com|net|jp|io)\//i.test(text + " " + (org ?? "") + " " + name)) throw new ApiError("contact_link");
  const ih = await ipHash(deps.clientIp ?? "");
  if (ih) {
    const r = await sql`select count(*)::int as n from contact_messages
      where ip_hash = ${ih} and created_at > ${now.toISOString()}::timestamptz - interval '1 hour'`;
    if (r[0].n >= 3) throw new ApiError("contact_too_many", 429);
  }
  const all = await sql`select count(*)::int as n from contact_messages
    where created_at > ${now.toISOString()}::timestamptz - interval '1 day'`;
  if (all[0].n >= 50) throw new ApiError("contact_too_many", 429);
  await sql`insert into contact_messages (created_at, business, kind, name, org, phone, email, body, ip_hash)
    values (${now.toISOString()}::timestamptz, ${biz}, ${kind}, ${name}, ${org}, ${phone}, ${email}, ${text || null}, ${ih})`;
  const tel = phone ? (phone.length === 11 ? `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`
    : `${phone.slice(0, 4)}-${phone.slice(4, 6)}-${phone.slice(6)}`) : "";
  await tellAdmin(deps, (biz === "recruit" ? `【ホームページから採用への応募】\n${kind}\n` : `【ホームページからお問い合わせ】${BIZ_LABEL[biz]}\n${kind}\n`) +
    `${name} 様` + (org ? `（${org}）` : "") + (tel ? `\n電話 ${tel}` : "") + (email ? `\nメール ${email}` : "") +
    (text ? `\n\n${text}` : ""));
  return { ok: true };
}

// ---------- ホームページの変えられる所・求人  marker: lifeplus-site-cms-v1 ----------
//  ・だれでも読める（action "site"）：お知らせ・募集中の求人・デイの利用時間・接骨院/ボディケアの受付時間・ボディケアの料金・差し替えた写真
//  ・書けるのは管理画面の「site」の権限がある人（HIROさん・権限を渡したスタッフ・お店の端末）
//  ★ボディケアの名前と料金は、予約ページと同じもの（menus）。ここで変えると予約ページも変わる
//  ★写真は storage の site に置き、表にはその URL だけ残す
export const SITE_BIZ = ["all", "day", "sekkotsu", "bodycare"];
export const JOB_BIZ = ["day", "sekkotsu", "bodycare", "company"];
export const PHOTO_SLOTS: Record<string, string> = {
  top_hero: "トップの最初の写真",
  top_day: "トップ：デイサービスの写真", top_kotsu: "トップ：接骨院の写真", top_body: "トップ：ボディケアの写真",
  day_1: "デイ：写真の列（左）", day_2: "デイ：写真の列（右）",
  kotsu_1: "接骨院：写真の列（左）", kotsu_2: "接骨院：写真の列（右）",
  body_1: "ボディケア：写真の列（左）", body_2: "ボディケア：写真の列（中）", body_3: "ボディケア：写真の列（右）",
  profile: "ボディケア：施術する人",
};
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function txt(v: unknown, max: number): string | null {
  const s = str(v, max).normalize("NFKC").replace(/\r\n?/g, "\n");
  return s ? s : null;
}
async function contentOf(sql: Sql): Promise<Record<string, any>> {
  const rows = await sql`select key, value from site_content`;
  const m: Record<string, any> = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}
// 日付は表の側で文字にしてから受け取る（nd・ud）。時差でずれないように
function newsRow(n: Record<string, any>) {
  return { id: n.id, date: String(n.nd), title: n.title, body: n.body ?? "", business: n.business, published: n.published, until: n.ud ? String(n.ud) : "" };
}
function jobRow(j: Record<string, any>) {
  return { id: j.id, business: j.business, title: j.title, employment: j.employment, summary: j.summary ?? "", duties: j.duties ?? "",
    requirements: j.requirements ?? "", salary: j.salary ?? "", hours: j.hours ?? "", holidays: j.holidays ?? "", benefits: j.benefits ?? "",
    open: j.is_open, sort: j.sort_order };
}
async function bodyMenus(sql: Sql, content: Record<string, any>) {
  const rows = await sql`select id, name, duration_min, price_yen, sort_order from menus where business_id = 'bodycare' and is_active order by sort_order`;
  const desc = (content.menu_desc ?? {}) as Record<string, string>;
  const feat = String(content.menu_featured ?? "");
  const list = rows.map((m: Record<string, any>) => ({ id: m.id, name: m.name, durationMin: m.duration_min, priceYen: m.price_yen,
    description: desc[m.id] ?? "", featured: m.id === feat }));
  // おすすめを先頭に
  return list.filter((m: any) => m.featured).concat(list.filter((m: any) => !m.featured));
}
async function publicHours(sql: Sql) {
  const r = await sql`select weekday, to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c
    from business_hours where kind = 'public' order by weekday, open_time`;
  return r.map((h: Record<string, any>) => ({ weekday: Number(h.weekday), open: h.o, close: h.c === "00:00" ? "24:00" : h.c }));
}
// だれでも読める
async function siteOut(sql: Sql, now: Date) {
  const today = jstDate(now);
  const c = await contentOf(sql);
  const news = await sql`select *, news_date::text as nd, until_date::text as ud from site_news where published and news_date <= ${today}::date
    and (until_date is null or until_date >= ${today}::date) order by news_date desc, created_at desc limit 20`;
  const jobs = await sql`select * from site_jobs where is_open order by sort_order, created_at`;
  return {
    news: news.map(newsRow).map((n: any) => ({ date: n.date, title: n.title, body: n.body, business: n.business })),
    jobs: jobs.map(jobRow).map((j: any) => { const { open: _o, sort: _s, ...rest } = j; return rest; }),
    dayHours: c.day_hours ?? null,
    rsvHours: await publicHours(sql),
    menus: (await bodyMenus(sql, c)).map((m: any) => ({ name: m.name, durationMin: m.durationMin, priceYen: m.priceYen, description: m.description, featured: m.featured })),
    photos: c.photos ?? {},
  };
}
// deno-lint-ignore no-explicit-any
async function handleSiteAdmin(body: any, deps: Deps, me: Me, now: Date): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const by = me.owner ? "HIRO" : me.label;
  const putContent = async (key: string, value: unknown) => {
    await sql`insert into site_content (key, value, updated_at, updated_by) values (${key}, ${sql.json(value)}, ${now.toISOString()}::timestamptz, ${by})
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
  };
  switch (body.action) {
    case "admin_site": {
      const c = await contentOf(sql);
      const news = await sql`select *, news_date::text as nd, until_date::text as ud from site_news order by news_date desc, created_at desc limit 100`;
      const jobs = await sql`select * from site_jobs order by sort_order, created_at`;
      return { news: news.map(newsRow), jobs: jobs.map(jobRow), dayHours: c.day_hours ?? {}, menus: await bodyMenus(sql, c),
        photos: c.photos ?? {}, slots: PHOTO_SLOTS, today: jstDate(now) };
    }
    case "admin_site_news_save": {
      const id = str(body.id, 40);
      const date = str(body.date, 10), until = str(body.until, 10);
      if (!YMD_RE.test(date) || (until && !YMD_RE.test(until))) throw new ApiError("site_date_invalid");
      const title = txt(body.title, 60);
      if (!title) throw new ApiError("site_title_required");
      const biz = SITE_BIZ.includes(String(body.business)) ? String(body.business) : "all";
      const b = txt(body.body, 600), pub = body.published !== false;
      if (id) {
        if (!UUID_RE.test(id)) throw new ApiError("bad_request");
        const r = await sql`update site_news set news_date = ${date}::date, title = ${title}, body = ${b}, business = ${biz}, published = ${pub},
          until_date = ${until || null}::date, updated_at = ${now.toISOString()}::timestamptz where id = ${id}::uuid returning id`;
        if (!r.length) throw new ApiError("site_not_found", 404);
        return { ok: true, id };
      }
      const r = await sql`insert into site_news (news_date, title, body, business, published, until_date)
        values (${date}::date, ${title}, ${b}, ${biz}, ${pub}, ${until || null}::date) returning id`;
      return { ok: true, id: r[0].id };
    }
    case "admin_site_news_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      await sql`delete from site_news where id = ${id}::uuid`;
      return { ok: true };
    }
    case "admin_site_job_save": {
      const id = str(body.id, 40);
      const biz = String(body.business);
      if (!JOB_BIZ.includes(biz)) throw new ApiError("site_job_business");
      const title = txt(body.title, 40), emp = txt(body.employment, 30);
      if (!title || !emp) throw new ApiError("site_title_required");
      const f = {
        summary: txt(body.summary, 200), duties: txt(body.duties, 1000), requirements: txt(body.requirements, 600),
        salary: txt(body.salary, 300), hours: txt(body.hours, 300), holidays: txt(body.holidays, 300), benefits: txt(body.benefits, 600),
      };
      const open = body.open !== false;
      const sort = Number.isInteger(Number(body.sort)) ? Math.max(0, Math.min(999, Number(body.sort))) : 0;
      if (id) {
        if (!UUID_RE.test(id)) throw new ApiError("bad_request");
        const r = await sql`update site_jobs set business = ${biz}, title = ${title}, employment = ${emp}, summary = ${f.summary}, duties = ${f.duties},
          requirements = ${f.requirements}, salary = ${f.salary}, hours = ${f.hours}, holidays = ${f.holidays}, benefits = ${f.benefits},
          is_open = ${open}, sort_order = ${sort}, updated_at = ${now.toISOString()}::timestamptz where id = ${id}::uuid returning id`;
        if (!r.length) throw new ApiError("site_not_found", 404);
        return { ok: true, id };
      }
      const r = await sql`insert into site_jobs (business, title, employment, summary, duties, requirements, salary, hours, holidays, benefits, is_open, sort_order)
        values (${biz}, ${title}, ${emp}, ${f.summary}, ${f.duties}, ${f.requirements}, ${f.salary}, ${f.hours}, ${f.holidays}, ${f.benefits}, ${open}, ${sort}) returning id`;
      return { ok: true, id: r[0].id };
    }
    case "admin_site_job_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      await sql`delete from site_jobs where id = ${id}::uuid`;
      return { ok: true };
    }
    case "admin_site_day_hours": {
      const h = body.dayHours ?? {};
      const v = { am: txt(h.am, 40) ?? "", pm: txt(h.pm, 40) ?? "", sun: txt(h.sun, 40) ?? "", days: txt(h.days, 80) ?? "" };
      if (!v.am && !v.pm && !v.sun) throw new ApiError("site_hours_required");
      await putContent("day_hours", v);
      return { ok: true, dayHours: v };
    }
    case "admin_site_menus": {
      const list = Array.isArray(body.menus) ? body.menus : null;
      if (!list || list.length > 20) throw new ApiError("bad_request");
      const c = await contentOf(sql);
      const desc: Record<string, string> = { ...(c.menu_desc ?? {}) };
      const cur = await sql`select id from menus where business_id = 'bodycare'`;
      const ids = new Set(cur.map((r: any) => String(r.id)));
      let featured = String(c.menu_featured ?? "");
      await sql.begin(async (tx: Sql) => {
        for (const m of list) {
          const id = String(m && m.id);
          if (!ids.has(id)) throw new ApiError("site_not_found", 404);
          const name = txt(m.name, 30);
          const price = Number(m.priceYen);
          if (!name) throw new ApiError("site_title_required");
          if (!Number.isInteger(price) || price < 0 || price > 1000000) throw new ApiError("site_price_invalid");
          await tx`update menus set name = ${name}, price_yen = ${price} where id = ${id}::uuid and business_id = 'bodycare'`;
          const d = txt(m.description, 200);
          if (d) desc[id] = d; else delete desc[id];
          if (m.featured) featured = id;
        }
      }).catch((e: unknown) => {
        if (e instanceof ApiError) throw e;
        if (String((e as Error).message).includes("menus_business_id_name_key") || String((e as Error).message).includes("unique")) throw new ApiError("site_menu_dup", 409);
        throw e;
      });
      await putContent("menu_desc", desc);
      await putContent("menu_featured", featured);
      return { ok: true, menus: await bodyMenus(sql, await contentOf(sql)) };
    }
    case "admin_site_photo": {
      const slot = str(body.slot, 20);
      if (!(slot in PHOTO_SLOTS)) throw new ApiError("site_photo_slot");
      const type = str(body.type, 20);
      const ext = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : type === "image/webp" ? "webp" : "";
      if (!ext) throw new ApiError("site_photo_type");
      let bytes: Uint8Array;
      try {
        const b64 = str(body.data, 6000000).replace(/^data:[^,]*,/, "");
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch { throw new ApiError("site_photo_type"); }
      if (!bytes.length || bytes.length > PHOTO_MAX_BYTES) throw new ApiError("site_photo_size");
      // 中身が本当に写真か（先頭の印で確かめる）
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8, isPng = bytes[0] === 0x89 && bytes[1] === 0x50,
        isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!(ext === "jpg" ? isJpg : ext === "png" ? isPng : isWebp)) throw new ApiError("site_photo_type");
      if (!deps.putImage) throw new ApiError("server_error", 500);
      const url = await deps.putImage(`photos/${slot}-${now.getTime()}.${ext}`, bytes, type);
      const c = await contentOf(sql);
      const photos = { ...(c.photos ?? {}), [slot]: url };
      await putContent("photos", photos);
      return { ok: true, photos };
    }
    case "admin_site_photo_reset": {
      const slot = str(body.slot, 20);
      if (!(slot in PHOTO_SLOTS)) throw new ApiError("site_photo_slot");
      const c = await contentOf(sql);
      const photos = { ...(c.photos ?? {}) };
      delete photos[slot];
      await putContent("photos", photos);
      return { ok: true, photos };
    }
  }
  throw new ApiError("bad_request");
}

// 管理画面の操作（LINE の人も、お店の端末も、ここを通る）
// deno-lint-ignore no-explicit-any
async function runAdmin(me: Me, body: any, deps: Deps, now: Date): Promise<Record<string, unknown>> {
  // お店の端末が自分の登録を外す（端末の「登録を外す」ボタン）
  if (body.action === "admin_device_forget") {
    if (me.deviceId) await deps.sql`update admin_devices set token_hash = null where id = ${me.deviceId}::uuid`;
    return { ok: true };
  }
  const need = body.action in PERM_OF ? PERM_OF[body.action] : "owner";
  // ★HIROさん（owner）は何でもできる。perms の中身では見ない（device-perms-v2 で「staff」「settings」を足したため）
  if (!me.owner && (need === "owner" || (need !== null && !me.perms.includes(need)))) throw new ApiError("no_permission", 403);
  // customer-delete-staff-v1: お店の端末・スタッフが消せるのは、手で入れた人（LINEなし）で、これからの予約が無い人だけ
  //   ★LINE でつながっている人は、消してもまた予約ページを開けば作り直される。HIROさんだけにしておく
  //   ★これからの予約が入っている人を消すと、患者さんに知らせずに予約が消える。先に取り消してもらう
  if (body.action === "admin_customer_delete" && !me.owner) {
    const id = str(body.customerId, 40);
    if (!UUID_RE.test(id)) throw new ApiError("customer_not_found");
    const c = await deps.sql`select line_user_id from customers where id = ${id}::uuid`;
    if (!c.length) throw new ApiError("customer_not_found", 404);
    if (c[0].line_user_id) throw new ApiError("customer_has_line", 403);
    const live = await deps.sql`select 1 from bookings where customer_id = ${id}::uuid and status in ('pending', 'confirmed')
      and starts_at > ${now.toISOString()}::timestamptz limit 1`;
    if (live.length) throw new ApiError("customer_has_booking", 409);
  }
  if (String(body.action).startsWith("admin_site")) return await handleSiteAdmin(body, deps, me, now);   // lifeplus-site-cms-v1
  const out = await handleAdmin(body, deps, now);
  if (body.action === "admin_init") out.me = { owner: me.owner, perms: me.perms, label: me.label, device: !!me.deviceId };
  return out;
}

// ---------- 本体 ----------
// deno-lint-ignore no-explicit-any
export async function handle(body: any, deps: Deps): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (!body || typeof body !== "object") throw new ApiError("bad_request");

  // site-contact-v1: ホームページのお問い合わせ（LINE のログインは要らない）
  if (body.action === "contact") return await handleContact(body, deps, now);
  // lifeplus-site-cms-v1: ホームページの変えられる所（だれでも読める）
  if (body.action === "site") return await siteOut(sql, now);

  // admin-device-v1: お店の端末（LINE のログインは要らない）
  if (body.action === "device_pair") return await handleDevicePair(body, deps, now);
  const dtok = str(body.deviceToken, 200);
  if (dtok) {
    if (typeof body.action !== "string" || !body.action.startsWith("admin_")) throw new ApiError("no_permission", 403);
    const me = await deviceOf(sql, dtok, now);
    if (!me) throw new ApiError("device_invalid", 401);
    return await runAdmin(me, body, deps, now);
  }

  const token = str(body.idToken, 4000);
  if (!token) throw new ApiError("no_token", 401);
  const who = await deps.verifyIdToken(token);
  if (!who || !who.sub) throw new ApiError("token_invalid", 401);

  // 招待リンクを開いた人が、管理画面の仲間に入る
  if (body.action === "staff_join") {
    const code = str(body.code, 40);
    if (!code) throw new ApiError("invite_invalid");
    if ((await adminIds(sql)).includes(who.sub)) throw new ApiError("invite_self", 409);
    const mine = await sql`select id from staff_members where line_user_id = ${who.sub}`;
    const inv = await sql`select id, invite_expires_at from staff_members where invite_code = ${code} and line_user_id is null`;
    if (!inv.length) {
      if (mine.length) return { ok: true, already: true };
      throw new ApiError("invite_invalid", 404);
    }
    if ((inv[0].invite_expires_at as Date).getTime() < now.getTime()) throw new ApiError("invite_expired", 410);
    if (mine.length) throw new ApiError("invite_already_staff", 409);
    await sql`update staff_members set line_user_id = ${who.sub}, line_name = ${str(who.name ?? "", 60) || null},
      joined_at = ${now.toISOString()}::timestamptz, invite_code = null, invite_expires_at = null where id = ${inv[0].id}`;
    const r = await sql`select label from staff_members where id = ${inv[0].id}`;
    await tellOwner(deps, `【管理画面】「${r[0].label}」が参加しました（LINE名：${who.name ?? "—"}）`);
    return { ok: true };
  }

  // 管理画面（HIROさんと、HIROさんが招待した人）
  if (typeof body.action === "string" && body.action.startsWith("admin_")) {
    const me = await staffOf(sql, who.sub);
    if (!me) throw new ApiError("not_admin", 403);
    return await runAdmin(me, body, deps, now);
  }

  const cust = await getOrCreateCustomer(sql, who);
  if (cust.is_blocked) throw new ApiError("customer_blocked", 403);

  switch (body.action) {
    // 最初に開いたとき：登録内容・メニュー・自分の予約
    case "init": {
      const businesses = await sql`
        select id, name, color from businesses where accepts_booking order by sort_order`;
      const menus = await sql`
        select m.id, m.business_id, m.name, m.description, m.duration_min, m.price_yen
        from menus m join businesses b on b.id = m.business_id
        where m.is_active and b.accepts_booking
        order by b.sort_order, m.sort_order`;
      return {
        profile: profileOf(cust, await holdOf(sql, cust.id)),
        businesses: businesses.map((b: Record<string, unknown>) => ({ id: b.id, name: b.name, color: b.color })),
        menus: menus.map((m: Record<string, unknown>) => ({
          id: m.id, businessId: m.business_id, name: m.name, description: m.description,
          durationMin: m.duration_min, priceYen: m.price_yen,
        })),
        symptoms: SYMPTOMS,
        bookings: await myBookings(sql, cust.id, now),
        settings: await settings(sql),
      };
    }

    // 名前・フリガナ・電話番号の登録
    case "profile": {
      const name = str(body.name, 30);
      const kana = normalizeKana(body.nameKana);
      const phone = normalizePhone(body.phone);
      if (!name) throw new ApiError("name_required");
      if (!kana) throw new ApiError("kana_invalid");
      if (!phone) throw new ApiError("phone_invalid");
      const rows = await sql`
        update customers set name = ${name}, name_kana = ${kana}, phone = ${phone}
        where id = ${cust.id}
        returning id, name, name_kana, phone, is_returning, is_blocked`;
      return { profile: profileOf(rows[0], await holdOf(sql, cust.id)) };
    }

    // 空き枠：from から14日ぶん（受付のある曜日だけ）
    case "days": {
      const menuId = str(body.menuId, 40);
      if (!UUID_RE.test(menuId)) throw new ApiError("menu_not_found");
      const today = jstDate(now);
      let from = str(body.from, 10);
      if (!DATE_RE.test(from) || from < today) from = today;
      const st = await settings(sql);
      const last = addDays(today, st.horizonDays);
      // lifeplus-hours-kind-v1: お客さまに見せる受付時間（public）だけ
      const hours = await sql`select distinct weekday from business_hours where kind = 'public'`;
      const openW = new Set(hours.map((h: Record<string, unknown>) => Number(h.weekday)));
      const extraD = new Set((await extrasBetween(sql, from, addDays(from, 13))).filter((x) => x.kind === "public").map((x) => x.date));   // lifeplus-extra-hours-v1

      const dates: string[] = [];
      for (let i = 0; i < 14; i++) {
        const d = addDays(from, i);
        if (d > last) break;
        if (openW.has(isoWeekday(d)) || extraD.has(d)) dates.push(d);
      }
      const days = [];
      for (const d of dates) {
        const slots = await sql`select starts_at from lp_available_slots(${d}::date, ${menuId}::uuid)`;
        days.push({
          date: d,
          weekday: WEEKDAYS[isoWeekday(d) % 7],
          slots: slots.map((s: Record<string, unknown>) => ({
            startsAt: (s.starts_at as Date).toISOString(),
            time: jstTime(s.starts_at as Date),
          })),
        });
      }
      const next = addDays(from, 14);
      let prev: string | null = null;
      if (from > today) {
        const p = addDays(from, -14);
        prev = p < today ? today : p;
      }
      return { from, days, next: next <= last ? next : null, prev };
    }

    // ひと月のカレンダー（日ごとの空き数）  marker: month-calendar-v1
    case "month": {
      const menuId = str(body.menuId, 40);
      if (!UUID_RE.test(menuId)) throw new ApiError("menu_not_found");
      const today = jstDate(now);
      let ym = str(body.month, 7);
      if (!/^\d{4}-\d{2}$/.test(ym) || ym < today.slice(0, 7)) ym = today.slice(0, 7);
      const st = await settings(sql);
      const last = addDays(today, st.horizonDays);
      if (ym > last.slice(0, 7)) ym = last.slice(0, 7);
      const hours = await sql`select distinct weekday from business_hours where kind = 'public'`;   // lifeplus-closure-notice-v1: お客さまには見せる受付時間の曜日だけ
      const openW = new Set(hours.map((h: Record<string, unknown>) => Number(h.weekday)));
      const first = ym + "-01";
      const extraD = new Set((await extrasBetween(sql, first, addDays(first, 31))).filter((x) => x.kind === "public").map((x) => x.date));   // lifeplus-extra-hours-v1
      const days = [];
      for (let d = first; d.slice(0, 7) === ym; d = addDays(d, 1)) {
        let state = "off"; let count = 0;
        if (d < today || d > last) state = "out";
        else if (openW.has(isoWeekday(d)) || extraD.has(d)) {
          const r = await sql`select count(*)::int as n from lp_available_slots(${d}::date, ${menuId}::uuid)`;
          count = r[0].n;
          const anyHours = await sql`select 1 from closures where tstzrange(starts_at, ends_at, '[)') @> tstzrange(${d + "T00:00:00+09:00"}::timestamptz, ${addDays(d, 1) + "T00:00:00+09:00"}::timestamptz, '[)') limit 1`;
          state = anyHours.length ? "off" : count === 0 ? "full" : count <= 2 ? "few" : "open";
        }
        days.push({ date: d, day: Number(d.slice(8)), weekday: WEEKDAYS[isoWeekday(d) % 7], state, count });
      }
      const prevM = addDays(first, -1).slice(0, 7);
      const nextM = addDays(addDays(first, 31).slice(0, 7) + "-01", 0).slice(0, 7);
      // lifeplus-closure-notice-v1: お知らせの付いた休み（これから・予約できる日までに始まるもの）
      const nrows = await sql`select starts_at, ends_at, notice from closures
        where notice is not null and notice <> '' and ends_at > ${now.toISOString()}::timestamptz
          and starts_at < ${addDays(last, 1) + "T00:00:00+09:00"}::timestamptz
        order by starts_at limit 5`;
      const notices = nrows.map((c: Record<string, unknown>) => { const v = closureView(c); return { date: v.date, endDate: v.endDate, label: v.label, text: c.notice as string }; });
      // lifeplus-extra-hours-v1: お知らせの付いた臨時の受付日も並べる（日付の順）
      for (const x of await extrasBetween(sql, today, last)) {
        if (x.kind === "public" && x.notice) notices.push({ date: x.date, endDate: x.date, label: `${dayLabel(x.date)} ${x.open}〜${x.close}`, text: x.notice });
      }
      notices.sort((a: { date: string }, b: { date: string }) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      notices.splice(5);
      return {
        month: ym, label: `${Number(ym.slice(0, 4))}年${Number(ym.slice(5))}月`, lead: isoWeekday(first) % 7, days,
        prev: prevM >= today.slice(0, 7) ? prevM : null, next: nextM <= last.slice(0, 7) ? nextM : null, notices,
      };
    }

    // その日の時間
    case "slots": {
      const menuId = str(body.menuId, 40), d = str(body.date, 10);
      if (!UUID_RE.test(menuId)) throw new ApiError("menu_not_found");
      if (!DATE_RE.test(d)) throw new ApiError("bad_request");
      const rows = await sql`select starts_at from lp_available_slots(${d}::date, ${menuId}::uuid)`;
      return {
        date: d, weekday: WEEKDAYS[isoWeekday(d) % 7],
        slots: rows.map((r: Record<string, unknown>) => ({ startsAt: (r.starts_at as Date).toISOString(), time: jstTime(r.starts_at as Date) })),
      };
    }

    // 予約する
    case "book": {
      if (!profileOf(cust).complete) throw new ApiError("profile_required");
      const menuId = str(body.menuId, 40);
      if (!UUID_RE.test(menuId)) throw new ApiError("menu_not_found");
      const startsAt = str(body.startsAt, 40);
      const t = Date.parse(startsAt);
      if (!startsAt || Number.isNaN(t)) throw new ApiError("slot_not_available");
      const symptoms: string[] = Array.isArray(body.symptoms)
        ? [...new Set(body.symptoms.filter((x: unknown) => typeof x === "string" && SYMPTOMS.includes(x as string)))] as string[]
        : [];

      const active = await sql`
        select count(*)::int as n from bookings
        where customer_id = ${cust.id} and status in ('pending','confirmed')
          and ends_at > ${now.toISOString()}::timestamptz`;
      if (active[0].n >= MAX_ACTIVE_BOOKINGS) throw new ApiError("too_many_bookings");

      let id: string;
      try {
        const r = await sql`
          select lp_create_booking(${cust.id}::uuid, ${menuId}::uuid,
                                   ${new Date(t).toISOString()}::timestamptz,
                                   ${symptoms.length ? symptoms : null}::text[], 'line') as id`;
        id = r[0].id;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        for (const code of ["slot_not_available", "menu_not_found", "customer_blocked", "customer_not_found"]) {
          if (msg.includes(code)) throw new ApiError(code, code === "customer_blocked" ? 403 : 409);
        }
        throw e;
      }
      const mine = await myBookings(sql, cust.id, now);
      const bk = mine.find((b: { id: unknown }) => b.id === id) ?? null;
      if (bk) {
        const hold = await holdOf(sql, cust.id);
        const head = bk.status === "confirmed" ? "【予約が入りました】" : "【確認待ちの仮予約】";
        const why = bk.status === "confirmed" ? "" : hold ? "\n※ドタキャンが続いている方です" : "\n※はじめての方です";
        await tellAdmin(deps,
          `${head}\n${bk.date.slice(5).replace("-", "/")}（${bk.weekday}）${bk.time}〜\n${bk.businessName}　${bk.menuName}\n${contactLine(cust)}${why}`);
      }
      return { booking: bk, bookings: mine };
    }

    // 取り消す（締め切りまで）
    case "cancel": {
      const id = str(body.bookingId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("booking_not_found");
      const st = await settings(sql);
      const limit = new Date(now.getTime() + st.leadMinutes * 60000).toISOString();
      const rows = await sql`
        update bookings set status = 'cancelled', cancelled_at = now()
        where id = ${id}::uuid and customer_id = ${cust.id}
          and status in ('pending','confirmed')
          and starts_at >= ${limit}::timestamptz
        returning id`;
      if (rows.length) {
        const b = await sql`
          select b.starts_at, m.name as menu_name from bookings b join menus m on m.id = b.menu_id
          where b.id = ${id}::uuid`;
        const s = b[0].starts_at as Date;
        const d = jstDate(s);
        await tellAdmin(deps,
          `【予約の取り消し】\n${d.slice(5).replace("-", "/")}（${WEEKDAYS[new Date(d + "T00:00:00Z").getUTCDay()]}）${jstTime(s)}〜\n${b[0].menu_name}\n${contactLine(cust)}`);
      }
      if (!rows.length) {
        const exists = await sql`
          select 1 from bookings where id = ${id}::uuid and customer_id = ${cust.id}
            and status in ('pending','confirmed')`;
        throw new ApiError(exists.length ? "cancel_too_late" : "booking_not_found");
      }
      return { bookings: await myBookings(sql, cust.id, now) };
    }

    default:
      throw new ApiError("bad_request");
  }
}


// =============================================================
// 管理画面（HIROさんだけ）  marker: admin-api-v1
// =============================================================
function md(d: string) { return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`; }
function whenText(s: Date) {
  const d = jstDate(s);
  return `${md(d)}（${WEEKDAYS[new Date(d + "T00:00:00Z").getUTCDay()]}）${jstTime(s)}〜`;
}
async function tellPatient(deps: Deps, lineUserId: string | null, text: string): Promise<boolean> {
  if (!deps.notify || !lineUserId) return false;
  try { await deps.notify([lineUserId], text); return true; } catch (e) { console.error("patient push", e); return false; }
}
const TAIL = "\nご質問はこのトークにご返信ください。";

// deno-lint-ignore no-explicit-any
function bookingRow(r: any) {
  const s = r.starts_at as Date;
  return {
    id: r.id, startsAt: s.toISOString(), date: jstDate(s), time: jstTime(s),
    endTime: jstTime(r.ends_at as Date), blockUntil: jstTime(r.block_until as Date),
    status: r.status, businessId: r.business_id, menuName: r.menu_name, durationMin: r.duration_min,
    priceYen: r.price_yen, symptoms: r.symptoms ?? [], source: r.source, outcomeNote: r.outcome_note,
    createdAt: (r.created_at as Date)?.toISOString?.() ?? null,
    customer: {
      id: r.customer_id, name: r.c_name ?? "", kana: r.c_kana ?? "", phone: r.c_phone ?? "", lineName: r.c_line_name ?? "",
      hasLine: !!r.c_line, isReturning: !!r.c_returning, isBlocked: !!r.c_blocked,
      visits: Number(r.visits ?? 0), noShows: Number(r.no_shows ?? 0), lateCancels: Number(r.late_cancels ?? 0),
    },
  };
}
// deno-lint-ignore no-explicit-any
async function bookingsWhere(sql: Sql, where: any) {
  const rows = await sql`
    select b.*, m.name as menu_name, m.duration_min,
           c.name as c_name, c.name_kana as c_kana, c.phone as c_phone, c.line_name as c_line_name,
           c.line_user_id as c_line, c.is_returning as c_returning, c.is_blocked as c_blocked,
           st.visits, st.no_shows, st.late_cancels
    from bookings b
    join menus m on m.id = b.menu_id
    join customers c on c.id = b.customer_id
    left join customer_stats st on st.customer_id = c.id
    where ${where}
    order by b.starts_at`;
  return rows.map(bookingRow);
}
async function bookingFull(sql: Sql, id: string) {
  const r = await sql`
    select b.*, m.name as menu_name, bz.name as business_name, c.line_user_id, c.name as c_name
    from bookings b join menus m on m.id = b.menu_id join businesses bz on bz.id = b.business_id
    join customers c on c.id = b.customer_id where b.id = ${id}::uuid`;
  if (!r.length) throw new ApiError("booking_not_found", 404);
  return r[0];
}
function dayRange(d: string) {
  const start = new Date(Date.parse(d + "T00:00:00+09:00")).toISOString();
  const end = new Date(Date.parse(d + "T00:00:00+09:00") + 86400000).toISOString();
  return { start, end };
}

// deno-lint-ignore no-explicit-any
async function handleAdmin(body: any, deps: Deps, now: Date): Promise<Record<string, unknown>> {
  const { sql } = deps;
  switch (body.action) {
    case "admin_init": {
      const businesses = await sql`select id, name, color from businesses where accepts_booking order by sort_order`;
      const menus = await sql`
        select m.id, m.business_id, m.name, m.duration_min, m.buffer_after_min, m.price_yen
        from menus m join businesses b on b.id = m.business_id where m.is_active and b.accepts_booking
        order by b.sort_order, m.sort_order`;
      const hours = await sql`select weekday, kind, to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c from business_hours order by weekday, open_time`;  // lifeplus-hours-kind-v1
      const pend = await sql`select count(*)::int as n from bookings where status = 'pending' and ends_at > ${now.toISOString()}::timestamptz`;
      return {
        today: jstDate(now),
        businesses: businesses.map((b: Record<string, unknown>) => ({ id: b.id, name: b.name })),
        menus: menus.map((m: Record<string, unknown>) => ({ id: m.id, businessId: m.business_id, name: m.name, durationMin: m.duration_min, bufferMin: m.buffer_after_min, priceYen: m.price_yen })),
        hours: hours.map((h: Record<string, unknown>) => ({ weekday: Number(h.weekday), kind: h.kind, open: h.o, close: h.c })),
        extras: await extrasBetween(sql, addDays(jstDate(now), -1), addDays(jstDate(now), 400)),   // lifeplus-extra-hours-v1
        pendingCount: pend[0].n,
        symptoms: SYMPTOMS,
      };
    }

    case "admin_day": {
      const d = str(body.date, 10);
      if (!DATE_RE.test(d)) throw new ApiError("bad_request");
      const { start, end } = dayRange(d);
      const list = await bookingsWhere(sql, sql`b.starts_at >= ${start}::timestamptz and b.starts_at < ${end}::timestamptz and b.status not in ('cancelled','rejected')`);
      const closures = await sql`
        select id, starts_at, ends_at, note from closures
        where tstzrange(starts_at, ends_at, '[)') && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)') order by starts_at`;
      // lifeplus-hours-kind-v1: hours＝お客さまに見せる受付時間、staffHours＝手入力だけの時間（予約表にうっすら出す）
      const hours = await sql`select kind, o, c from (
          select kind, open_time, to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c from business_hours where weekday = ${isoWeekday(d)}
          union all
          select kind, open_time, to_char(open_time,'HH24:MI'), to_char(close_time,'HH24:MI') from extra_hours where day = ${d}::date) t order by open_time`;   // lifeplus-extra-hours-v1: 臨時の受付時間も入れる
      const extras = await extrasBetween(sql, d, d);
      const pend = await sql`select count(*)::int as n from bookings where status = 'pending' and ends_at > ${now.toISOString()}::timestamptz`;
      return {
        date: d, weekday: WEEKDAYS[isoWeekday(d) % 7], bookings: list,
        // 前の日から続く休みは 00:00 から、次の日へ続く休みは 24:00 まで（marker: admin-day-closure-clip-v1）
        closures: closures.map((c: Record<string, unknown>) => {
          const s = c.starts_at as Date, e = c.ends_at as Date;
          return {
            id: c.id, from: jstDate(s) < d ? "00:00" : jstTime(s), to: jstDate(e) > d ? "24:00" : jstTime(e), note: c.note ?? "",
            startDate: jstDate(s), endDate: jstDate(new Date(e.getTime() - 1)),
          };
        }),
        hours: hours.filter((h: Record<string, unknown>) => h.kind === "public").map((h: Record<string, unknown>) => ({ open: h.o, close: h.c })),
        staffHours: hours.filter((h: Record<string, unknown>) => h.kind === "staff").map((h: Record<string, unknown>) => ({ open: h.o, close: h.c })),
        extras,   // lifeplus-extra-hours-v1
        pendingCount: pend[0].n,
      };
    }

    // ひと月の予約の数（予約表のカレンダー）  marker: admin-month-v1
    case "admin_month": {
      const ym = str(body.month, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) throw new ApiError("bad_request");
      const first = ym + "-01";
      const next = addDays(addDays(first, 31).slice(0, 7) + "-01", 0);
      const s = dayRange(first).start, e = dayRange(next).start;
      const bk = await sql`
        select to_char(starts_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as d,
               count(*) filter (where status in ('pending','confirmed','done','no_show','late_cancel'))::int as n,
               count(*) filter (where status = 'pending')::int as p
        from bookings where starts_at >= ${s}::timestamptz and starts_at < ${e}::timestamptz group by 1`;
      const cl = await sql`select starts_at, ends_at from closures where tstzrange(starts_at, ends_at, '[)') && tstzrange(${s}::timestamptz, ${e}::timestamptz, '[)')`;
      const hours = await sql`select distinct weekday, kind from business_hours`;  // lifeplus-hours-kind-v1
      const openW = new Set(hours.filter((h: Record<string, unknown>) => h.kind === "public").map((h: Record<string, unknown>) => Number(h.weekday)));
      const staffW = new Set(hours.filter((h: Record<string, unknown>) => h.kind === "staff").map((h: Record<string, unknown>) => Number(h.weekday)));
      const ex = await extrasBetween(sql, first, addDays(next, -1));   // lifeplus-extra-hours-v1
      const exP = new Set(ex.filter((x) => x.kind === "public").map((x) => x.date)), exS = new Set(ex.filter((x) => x.kind === "staff").map((x) => x.date));
      const days = [];
      for (let d = first; d < next; d = addDays(d, 1)) {
        const r = dayRange(d);
        const b = bk.find((x: Record<string, unknown>) => x.d === d);
        const whole = cl.some((c: Record<string, unknown>) => (c.starts_at as Date).toISOString() <= r.start && (c.ends_at as Date).toISOString() >= r.end);
        const part = !whole && cl.some((c: Record<string, unknown>) => (c.starts_at as Date).toISOString() < r.end && (c.ends_at as Date).toISOString() > r.start);
        days.push({ date: d, open: openW.has(isoWeekday(d)) || exP.has(d), staff: staffW.has(isoWeekday(d)) || exS.has(d), extra: exP.has(d) || exS.has(d), count: b ? b.n : 0, pending: b ? b.p : 0, off: whole ? "all" : part ? "part" : "" });
      }
      return { month: ym, lead: isoWeekday(first) % 7, days };
    }

    case "admin_pending": {
      return { bookings: await bookingsWhere(sql, sql`b.status = 'pending' and b.ends_at > ${now.toISOString()}::timestamptz`) };
    }

    // 確定・お断り（患者さんの LINE に知らせる）
    case "admin_decide": {
      const id = str(body.bookingId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("booking_not_found");
      const ok = body.decision === "confirm";
      if (!ok && body.decision !== "reject") throw new ApiError("bad_request");
      const rows = await sql`
        update bookings set status = ${ok ? "confirmed" : "rejected"}, confirmed_at = ${ok ? now.toISOString() : null}::timestamptz
        where id = ${id}::uuid and status = 'pending' returning id`;
      if (!rows.length) throw new ApiError("booking_not_pending", 409);
      const b = await bookingFull(sql, id);
      const when = whenText(b.starts_at);
      const text = ok
        ? `【ご予約が確定しました】\n${when}\n${b.business_name}　${b.menu_name}\n当日お待ちしております。${TAIL}`
        : `【ご予約について】\n申し訳ありません。${when}のご予約はお受けできませんでした。\nお手数ですが、別の日時でご予約ください。${TAIL}`;
      const sent = await tellPatient(deps, b.line_user_id, text);
      return { ok: true, sent };
    }

    // 来院・直前キャンセル・ドタキャン（付け直しは confirmed）
    case "admin_outcome": {
      const id = str(body.bookingId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("booking_not_found");
      const o = str(body.outcome, 20);
      if (!["done", "no_show", "late_cancel", "confirmed"].includes(o)) throw new ApiError("bad_request");
      try {
        await sql`select lp_set_outcome(${id}::uuid, ${o}, ${str(body.note, 200) || null})`;
      } catch (e) {
        if (String((e as Error).message).includes("booking_not_found")) throw new ApiError("booking_not_found", 404);
        throw e;
      }
      return { ok: true };
    }

    // HIROさんが取り消す（患者さんに知らせるかは選べる）
    case "admin_cancel": {
      const id = str(body.bookingId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("booking_not_found");
      const rows = await sql`update bookings set status = 'cancelled', cancelled_at = now()
        where id = ${id}::uuid and status in ('pending','confirmed') returning id`;
      if (!rows.length) throw new ApiError("booking_not_found", 404);
      let sent = false;
      if (body.tellPatient) {
        const b = await bookingFull(sql, id);
        sent = await tellPatient(deps, b.line_user_id,
          `【ご予約の取り消し】\n${whenText(b.starts_at)}のご予約を取り消しました。\n${str(body.message, 300) || "またのご予約をお待ちしております。"}${TAIL}`);
      }
      return { ok: true, sent };
    }

    // お客さま
    case "admin_customers": {
      const q = str(body.q, 40).normalize("NFKC");
      const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
      const digits = q.replace(/[^0-9]/g, "");
      const filter = str(body.filter, 20);
      const rows = await sql`
        select c.id, c.name, c.name_kana, c.phone, c.line_name, c.line_user_id, c.is_returning, c.is_blocked, c.memo,
               st.visits, st.no_shows, st.late_cancels,
               (select min(starts_at) from bookings b where b.customer_id = c.id and b.status in ('pending','confirmed') and b.starts_at > ${now.toISOString()}::timestamptz) as next_at,
               (select max(starts_at) from bookings b where b.customer_id = c.id and b.status = 'done') as last_at
        from customers c left join customer_stats st on st.customer_id = c.id
        where c.name is not null
          and (${q} = '' or c.name ilike ${like} or c.name_kana ilike ${like} or c.line_name ilike ${like} or (${digits} <> '' and c.phone like ${"%" + digits + "%"}))
          and (${filter} = '' or (${filter} = 'returning' and c.is_returning and not c.is_blocked)
               or (${filter} = 'new' and not c.is_returning and not c.is_blocked)
               or (${filter} = 'blocked' and c.is_blocked)
               or (${filter} = 'noshow' and coalesce(st.no_shows,0) > 0))
        order by c.name_kana nulls last, c.name
        limit 300`;
      return {
        customers: rows.map((c: Record<string, unknown>) => ({
          id: c.id, name: c.name, kana: c.name_kana ?? "", phone: c.phone ?? "", lineName: c.line_name ?? "", hasLine: !!c.line_user_id,
          isReturning: !!c.is_returning, isBlocked: !!c.is_blocked, memo: c.memo ?? "",
          visits: Number(c.visits ?? 0), noShows: Number(c.no_shows ?? 0), lateCancels: Number(c.late_cancels ?? 0),
          next: c.next_at ? whenText(c.next_at as Date) : "", last: c.last_at ? md(jstDate(c.last_at as Date)) : "",
        })),
      };
    }

    case "admin_customer_update": {
      const id = str(body.customerId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("customer_not_found");
      const cur = await sql`select * from customers where id = ${id}::uuid`;
      if (!cur.length) throw new ApiError("customer_not_found", 404);
      const c = cur[0];
      const isReturning = typeof body.isReturning === "boolean" ? body.isReturning : c.is_returning;
      const isBlocked = typeof body.isBlocked === "boolean" ? body.isBlocked : c.is_blocked;
      const memo = typeof body.memo === "string" ? str(body.memo, 500) : c.memo;
      await sql`update customers set is_returning = ${isReturning}, is_blocked = ${isBlocked}, memo = ${memo} where id = ${id}::uuid`;
      return { ok: true };
    }

    case "admin_customer": {
      const id = str(body.customerId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("customer_not_found");
      const list = await bookingsWhere(sql, sql`b.customer_id = ${id}::uuid and b.status not in ('rejected')`);
      return { bookings: list.reverse().slice(0, 50) };
    }

    // LINE で連絡する
    case "admin_message": {
      const id = str(body.customerId, 40);
      const text = str(body.text, 1000);
      if (!UUID_RE.test(id)) throw new ApiError("customer_not_found");
      if (!text) throw new ApiError("message_required");
      const c = await sql`select line_user_id from customers where id = ${id}::uuid`;
      if (!c.length) throw new ApiError("customer_not_found", 404);
      if (!c[0].line_user_id) throw new ApiError("no_line", 409);
      const sent = await tellPatient(deps, c[0].line_user_id, text);
      if (!sent) throw new ApiError("send_failed", 502);
      return { ok: true };
    }

    // 休み
    case "admin_closures": {
      const rows = await sql`select id, starts_at, ends_at, note, notice from closures where ends_at > ${now.toISOString()}::timestamptz order by starts_at limit 100`;
      return {
        closures: rows.map((c: Record<string, unknown>) => {
          const v = closureView(c);   // lifeplus-closure-notice-v1
          return { id: c.id, date: v.date, endDate: v.endDate, from: v.from, to: v.to, note: c.note ?? "", notice: c.notice ?? "" };
        }),
      };
    }
    case "admin_closure_add": {
      const d1 = str(body.date, 10), d2 = str(body.endDate, 10) || d1;
      const f = str(body.from, 5) || "00:00", t = str(body.to, 5) || "24:00";
      if (!DATE_RE.test(d1) || !DATE_RE.test(d2) || d2 < d1 || !/^\d{2}:\d{2}$/.test(f) || !/^\d{2}:\d{2}$/.test(t)) throw new ApiError("bad_request");
      const start = new Date(Date.parse(`${d1}T${f}:00+09:00`)).toISOString();
      const end = t === "24:00" ? new Date(Date.parse(`${d2}T00:00:00+09:00`) + 86400000).toISOString() : new Date(Date.parse(`${d2}T${t}:00+09:00`)).toISOString();
      if (end <= start) throw new ApiError("bad_request");
      // lifeplus-closure-notice-v1: notice＝お客さまの予約カレンダーに出すお知らせ（60字まで・なくてもよい）
      await sql`insert into closures (starts_at, ends_at, note, notice) values (${start}::timestamptz, ${end}::timestamptz, ${str(body.note, 100) || null}, ${str(body.notice, 60) || null})`;
      const conflicts = await bookingsWhere(sql, sql`b.status in ('pending','confirmed') and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')`);
      return { ok: true, conflicts };
    }
    case "admin_closure_update": {   // lifeplus-closure-notice-v1: お知らせだけを変える
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      const r = await sql`update closures set notice = ${str(body.notice, 60) || null} where id = ${id}::uuid returning id`;
      if (!r.length) throw new ApiError("closure_not_found", 404);
      return { ok: true };
    }
    // lifeplus-extra-hours-v1: 臨時の受付日を足す。その日にかかっている休みがあれば、その日の分だけ休みをやめる
    case "admin_extra_add": {
      const d = str(body.date, 10), f = str(body.from, 5), t = str(body.to, 5);
      const kind = body.kind === "staff" ? "staff" : "public";
      if (!DATE_RE.test(d) || !HM15_RE.test(f) || !HM15_RE.test(t) || hmMin(t) <= hmMin(f) || f === "24:00") throw new ApiError("bad_request");
      if (d < jstDate(now)) throw new ApiError("bad_request");
      const clash = await sql`select 1 from extra_hours where day = ${d}::date and open_time < ${t}::time and close_time > ${f}::time limit 1`;
      if (clash.length) throw new ApiError("extra_overlap", 409);
      const reopened = await sql.begin(async (tx: Sql) => {
        await tx`insert into extra_hours (day, open_time, close_time, kind, note, notice)
          values (${d}::date, ${f}::time, ${t}::time, ${kind}, ${str(body.note, 100) || null}, ${str(body.notice, 60) || null})`;
        return body.reopen === false ? 0 : await openDayOf(tx, d);
      });
      return { ok: true, reopened };
    }
    case "admin_extra_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      const r = await sql`delete from extra_hours where id = ${id}::uuid returning day::text as d, open_time, close_time`;
      if (!r.length) throw new ApiError("extra_not_found", 404);
      const { start } = dayRange(r[0].d);
      const conflicts = await bookingsWhere(sql, sql`b.status in ('pending','confirmed') and b.starts_at >= ${start}::timestamptz
        and b.starts_at < ${dayRange(r[0].d).end}::timestamptz
        and (b.starts_at at time zone 'Asia/Tokyo')::time >= ${r[0].open_time}::time and (b.starts_at at time zone 'Asia/Tokyo')::time < ${r[0].close_time}::time`);
      return { ok: true, conflicts };
    }
    // lifeplus-extra-hours-v1: 期間の休みの中の1日だけ、休みをやめて受付に戻す（前後の休みは残す）
    case "admin_closure_open_day": {
      const id = str(body.id, 40), d = str(body.date, 10);
      if (!UUID_RE.test(id) || !DATE_RE.test(d)) throw new ApiError("bad_request");
      const n = await sql.begin(async (tx: Sql) => await openDayOf(tx, d, id));
      if (!n) throw new ApiError("closure_not_found", 404);
      return { ok: true };
    }
    case "admin_closure_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      await sql`delete from closures where id = ${id}::uuid`;
      return { ok: true };
    }

    // 手で予約を入れる（電話・来院で受けたもの）
    case "admin_slots": {
      // lifeplus-hours-kind-v1: 手で入れるときの候補。
      //   public＝お客さまに見せる受付時間／staff＝手入力だけの時間／other＝それ以外（any のときだけ・6時〜23時）
      //   ★同じ時刻が重なったら public → staff → other の順で1つにする
      const d = str(body.date, 10), menuId = str(body.menuId, 40);
      if (!DATE_RE.test(d) || !UUID_RE.test(menuId)) throw new ApiError("bad_request");
      const any = body.any === true;
      const rows = await sql`
        with m as (select duration_min, buffer_after_min from menus where id = ${menuId}::uuid),
        h as (select kind, ((${d}::date + open_time) at time zone 'Asia/Tokyo') as op, ((${d}::date + close_time) at time zone 'Asia/Tokyo') as cl
                from business_hours where weekday = ${isoWeekday(d)}
              union all
              select kind, ((${d}::date + open_time) at time zone 'Asia/Tokyo'), ((${d}::date + close_time) at time zone 'Asia/Tokyo')
                from extra_hours where day = ${d}::date   -- lifeplus-extra-hours-v1
              union all
              select 'other', ((${d}::date + time '06:00') at time zone 'Asia/Tokyo'), ((${d}::date + time '23:00') at time zone 'Asia/Tokyo') where ${any}),
        c as (select h.kind, gs as s, gs + make_interval(mins => m.duration_min + m.buffer_after_min) as b
              from h, m, generate_series(h.op, h.cl - make_interval(mins => m.duration_min), interval '15 minutes') gs),
        c2 as (select distinct on (c.s) c.s, c.b, c.kind from c
               order by c.s, case c.kind when 'public' then 0 when 'staff' then 1 else 2 end)
        select c2.s, c2.kind from c2 where not exists (
          select 1 from bookings bk where bk.status in ('pending','confirmed')
            and tstzrange(bk.starts_at, bk.block_until, '[)') && tstzrange(c2.s, c2.b, '[)'))
        order by c2.s`;
      return { slots: rows.map((r: Record<string, unknown>) => ({ startsAt: (r.s as Date).toISOString(), time: jstTime(r.s as Date), kind: r.kind })) };
    }
    case "admin_book": {
      const menuId = str(body.menuId, 40);
      const t = Date.parse(str(body.startsAt, 40));
      if (!UUID_RE.test(menuId) || Number.isNaN(t)) throw new ApiError("bad_request");
      let custId = str(body.customerId, 40);
      if (!UUID_RE.test(custId)) {
        const name = str(body.name, 30);
        if (!name) throw new ApiError("name_required");
        const phone = body.phone ? normalizePhone(body.phone) : null;
        if (body.phone && !phone) throw new ApiError("phone_invalid");
        const kana = body.nameKana ? normalizeKana(body.nameKana) : null;
        const r = await sql`insert into customers (name, name_kana, phone) values (${name}, ${kana}, ${phone}) returning id`;
        custId = r[0].id;
      }
      let id: string;
      try {
        const r = await sql`select lp_create_booking(${custId}::uuid, ${menuId}::uuid, ${new Date(t).toISOString()}::timestamptz, null::text[], 'admin') as id`;
        id = r[0].id;
      } catch (e) {
        const msg = String((e as Error).message);
        for (const code of ["slot_not_available", "menu_not_found", "customer_blocked", "customer_not_found"]) if (msg.includes(code)) throw new ApiError(code, 409);
        throw e;
      }
      let sent = false;
      if (body.tellPatient) {
        const b = await bookingFull(sql, id);
        sent = await tellPatient(deps, b.line_user_id, `【ご予約を承りました】\n${whenText(b.starts_at)}\n${b.business_name}　${b.menu_name}\n当日お待ちしております。${TAIL}`);
      }
      return { ok: true, id, sent };
    }

    // 設定（HIROさんだけ）  marker: lifeplus-settings-v1
    //   受付時間（曜日ごと・種類つき）と、予約の決まりごと（締め切り・何日先まで・ドタキャンの回数）
    case "admin_settings": {
      return await settingsOut(sql);
    }
    case "admin_settings_save": {
      const list = Array.isArray(body.hours) ? body.hours : null;
      if (!list || list.length > 40) throw new ApiError("bad_request");
      const hours: { weekday: number; kind: string; open: string; close: string }[] = [];
      for (const x of list) {
        const w = Number(x && x.weekday), kind = String(x && x.kind), o = str(x && x.open, 5), c = str(x && x.close, 5);
        if (!(w >= 1 && w <= 7) || (kind !== "public" && kind !== "staff") || !HM15_RE.test(o) || !HM15_RE.test(c)) throw new ApiError("hours_invalid");
        if (hmMin(o) >= hmMin(c) || hmMin(c) > 24 * 60) throw new ApiError("hours_invalid");
        hours.push({ weekday: w, kind, open: o, close: c });
      }
      // 同じ曜日の時間どうしは、種類が違っても重ねない（どちらの時間か分からなくなるため）
      for (const a of hours) for (const b of hours) {
        if (a !== b && a.weekday === b.weekday && hmMin(a.open) < hmMin(b.close) && hmMin(b.open) < hmMin(a.close)) throw new ApiError("hours_overlap");
      }
      const lead = Number(body.leadMinutes), horizon = Number(body.horizonDays), noshow = Number(body.noshowLimit);
      if (!Number.isInteger(lead) || lead < 0 || lead > 2880) throw new ApiError("settings_invalid");
      if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) throw new ApiError("settings_invalid");
      if (!Number.isInteger(noshow) || noshow < 1 || noshow > 10) throw new ApiError("settings_invalid");
      await sql.begin(async (tx: Sql) => {
        await tx`delete from business_hours`;
        for (const h of hours) {
          await tx`insert into business_hours (weekday, kind, open_time, close_time)
                   values (${h.weekday}, ${h.kind}, ${h.open}::time, ${h.close === "24:00" ? "24:00:00" : h.close}::time)`;
        }
        for (const [k, v] of [["lead_minutes", lead], ["horizon_days", horizon], ["noshow_limit", noshow]] as [string, number][]) {
          await tx`insert into app_settings (key, value) values (${k}, ${String(v)}) on conflict (key) do update set value = excluded.value`;
        }
      });
      return await settingsOut(sql);
    }

    // 消す（HIROさんだけ。テストで入れた人など）  marker: admin-delete-v1
    // お客さまを消すと、その人の予約の履歴もすべて消える。元に戻せない。
    case "admin_customer_delete": {
      const id = str(body.customerId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("customer_not_found");
      const n = await sql.begin(async (tx: Sql) => {
        const b = await tx`delete from bookings where customer_id = ${id}::uuid returning id`;
        const c = await tx`delete from customers where id = ${id}::uuid returning id`;
        if (!c.length) throw new ApiError("customer_not_found", 404);
        return b.length;
      });
      return { ok: true, bookings: n };
    }
    // 予約を1件だけ消す（取り消し済み・来院済みなど、終わったものだけ）
    case "admin_booking_delete": {
      const id = str(body.bookingId, 40);
      if (!UUID_RE.test(id)) throw new ApiError("booking_not_found");
      const cur = await sql`select status from bookings where id = ${id}::uuid`;
      if (!cur.length) throw new ApiError("booking_not_found", 404);
      if (cur[0].status === "pending" || cur[0].status === "confirmed") throw new ApiError("booking_active", 409);
      await sql`delete from bookings where id = ${id}::uuid`;
      return { ok: true };
    }

    // 管理画面を使える人（HIROさんだけが触れる）
    case "admin_staff": {
      const rows = await sql`select * from staff_members order by created_at`;
      return {
        staff: rows.map((s: Record<string, unknown>) => ({
          id: s.id, label: s.label, lineName: s.line_name ?? "", perms: s.perms ?? [], joined: !!s.line_user_id,
          inviteCode: s.line_user_id ? null : s.invite_code,
          inviteExpires: s.invite_expires_at ? (s.invite_expires_at as Date).toISOString() : null,
          inviteExpired: !s.line_user_id && (!s.invite_expires_at || (s.invite_expires_at as Date).getTime() < now.getTime()),
          lastSeen: s.last_seen_at ? jstDate(s.last_seen_at as Date) : null,
        })),
      };
    }
    // 招待リンクを作る（id があれば、まだ参加していない人のリンクを出し直す）
    case "admin_staff_invite": {
      const code = newInviteCode();
      const exp = new Date(now.getTime() + INVITE_HOURS * 3600000).toISOString();
      const id = str(body.id, 40);
      if (id) {
        if (!UUID_RE.test(id)) throw new ApiError("bad_request");
        const r = await sql`update staff_members set invite_code = ${code}, invite_expires_at = ${exp}::timestamptz
          where id = ${id}::uuid and line_user_id is null returning id`;
        if (!r.length) throw new ApiError("staff_not_found", 404);
        return { ok: true, id, code, expires: exp };
      }
      const label = str(body.label, 30);
      if (!label) throw new ApiError("label_required");
      const r = await sql`insert into staff_members (label, perms, invite_code, invite_expires_at)
        values (${label}, ${cleanPerms(body.perms)}::text[], ${code}, ${exp}::timestamptz) returning id`;
      return { ok: true, id: r[0].id, code, expires: exp };
    }
    case "admin_staff_update": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      const label = str(body.label, 30);
      if (!label) throw new ApiError("label_required");
      const r = await sql`update staff_members set label = ${label}, perms = ${cleanPerms(body.perms)}::text[] where id = ${id}::uuid returning id`;
      if (!r.length) throw new ApiError("staff_not_found", 404);
      return { ok: true };
    }
    case "admin_staff_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      await sql`delete from staff_members where id = ${id}::uuid`;
      return { ok: true };
    }

    // ---------- お店の端末（HIROさんだけ）  marker: admin-device-v1 ----------
    case "admin_devices": {
      const rows = await sql`select * from admin_devices order by created_at`;
      return {
        devices: rows.map((d: Record<string, unknown>) => ({
          id: d.id, label: d.label, perms: cleanDevicePerms(d.perms),
          paired: !!d.token_hash,
          pairing: !!d.pair_expires_at && (d.pair_expires_at as Date).getTime() > now.getTime(),
          pairExpires: d.pair_expires_at ? (d.pair_expires_at as Date).toISOString() : null,
          pairedAt: d.paired_at ? (d.paired_at as Date).toISOString() : null,
          lastSeen: d.last_seen_at && d.token_hash ? (d.last_seen_at as Date).toISOString() : null,
          ua: d.token_hash ? d.user_agent ?? "" : "",
        })),
      };
    }
    case "admin_device_code": {
      // 新しい端末なら作る。すでにある端末なら番号を出し直す（それまでの端末は使えなくなる）
      const id = str(body.id, 40);
      const exp = new Date(now.getTime() + PAIR_MINUTES * 60000).toISOString();
      for (let i = 0; i < 5; i++) {
        const code = newPairCode();
        const ch = await sha256hex("lp-pair:" + code);
        try {
          if (id) {
            if (!UUID_RE.test(id)) throw new ApiError("bad_request");
            const r = await sql`update admin_devices set pair_code_hash = ${ch}, pair_expires_at = ${exp}::timestamptz, token_hash = null
              where id = ${id}::uuid returning id`;
            if (!r.length) throw new ApiError("device_not_found", 404);
            return { ok: true, id, code, expires: exp };
          }
          const label = str(body.label, 30);
          if (!label) throw new ApiError("label_required");
          const r = await sql`insert into admin_devices (label, perms, pair_code_hash, pair_expires_at)
            values (${label}, ${cleanDevicePerms(body.perms)}::text[], ${ch}, ${exp}::timestamptz) returning id`;
          return { ok: true, id: r[0].id, code, expires: exp };
        } catch (e) {
          // 番号がたまたま重なったときだけ引き直す
          if (e instanceof ApiError || !String((e as Error).message).includes("pair_code_hash")) throw e;
        }
      }
      throw new ApiError("server_error", 500);
    }
    case "admin_device_update": {
      const id = str(body.id, 40), label = str(body.label, 30);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      if (!label) throw new ApiError("label_required");
      const r = await sql`update admin_devices set label = ${label}, perms = ${cleanDevicePerms(body.perms)}::text[] where id = ${id}::uuid returning id`;
      if (!r.length) throw new ApiError("device_not_found", 404);
      return { ok: true };
    }
    case "admin_device_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      await sql`delete from admin_devices where id = ${id}::uuid`;
      return { ok: true };
    }

    default:
      throw new ApiError("bad_request");
  }
}

// ---------- ここから下は Supabase 上でだけ動く ----------
// deno-lint-ignore no-explicit-any
const DenoRT = (globalThis as any).Deno;
if (DenoRT && DenoRT.env?.get("SUPABASE_DB_URL")) {
  const { default: postgres } = await import("npm:postgres@3.4.5");
  const sql = postgres(DenoRT.env.get("SUPABASE_DB_URL"), { prepare: false, max: 3 });

  const verifyIdToken = async (token: string) => {
    const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: token, client_id: LINE_CHANNEL_ID }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.aud !== LINE_CHANNEL_ID || !j.sub) return null;
    return { sub: String(j.sub), name: typeof j.name === "string" ? j.name : undefined };
  };

  const LINE_TOKEN = DenoRT.env.get("LINE_MESSAGING_TOKEN") ?? "";
  const notify = async (to: string[], text: string) => {
    if (!LINE_TOKEN) return;
    for (const id of to) {
      const r = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LINE_TOKEN}` },
        body: JSON.stringify({ to: id, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
      });
      if (!r.ok) console.error("line push", r.status, await r.text());
    }
  };

  // lifeplus-site-cms-v1: ホームページの写真を storage（site）に置く。鍵は Supabase が用意する環境変数から
  const SB_URL = DenoRT.env.get("SUPABASE_URL") ?? "";
  const SB_KEY = DenoRT.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const putImage = async (path: string, bytes: Uint8Array, type: string) => {
    const r = await fetch(`${SB_URL}/storage/v1/object/site/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, "content-type": type, "cache-control": "31536000", "x-upsert": "true" },
      body: bytes,
    });
    if (!r.ok) { console.error("storage", r.status, await r.text()); throw new ApiError("site_photo_upload", 502); }
    return `${SB_URL}/storage/v1/object/public/site/${path}`;
  };

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
  };

  DenoRT.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400, headers: cors });
    }
    try {
      const clientIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || (req.headers.get("x-real-ip") ?? "");
      const out = await handle(body, { sql, verifyIdToken, notify, clientIp, putImage });   // site-contact-v1 / lifeplus-site-cms-v1
      return Response.json(out, { headers: cors });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.code }, { status: e.status, headers: cors });
      console.error("booking error", e);
      return Response.json({ error: "server_error" }, { status: 500, headers: cors });
    }
  });
}
