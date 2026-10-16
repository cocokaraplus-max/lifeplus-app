// =============================================================
// LIFE PLUS 予約  関所（Supabase Edge Function: booking）
// marker: lifeplus-booking-fn-v1 / admin-notify-v1
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
  // HIROさんの LINE へ知らせる（失敗しても予約は止めない）
  notify?: (to: string[], text: string) => Promise<void>;
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
    returning id, name, name_kana, phone, is_returning, is_blocked`;
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

async function adminIds(sql: Sql): Promise<string[]> {
  const r = await sql`select value from app_settings where key = 'admin_line_user_ids'`;
  return String(r[0]?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

async function tellAdmin(deps: Deps, text: string) {
  if (!deps.notify) return;
  try {
    const to = await adminIds(deps.sql);
    if (to.length) await deps.notify(to, text);
  } catch (e) {
    console.error("notify failed", e);
  }
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

// ---------- 本体 ----------
// deno-lint-ignore no-explicit-any
export async function handle(body: any, deps: Deps): Promise<Record<string, unknown>> {
  const { sql } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (!body || typeof body !== "object") throw new ApiError("bad_request");

  const token = str(body.idToken, 4000);
  if (!token) throw new ApiError("no_token", 401);
  const who = await deps.verifyIdToken(token);
  if (!who || !who.sub) throw new ApiError("token_invalid", 401);

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
      const hours = await sql`select distinct weekday from business_hours`;
      const openW = new Set(hours.map((h: Record<string, unknown>) => Number(h.weekday)));

      const dates: string[] = [];
      for (let i = 0; i < 14; i++) {
        const d = addDays(from, i);
        if (d > last) break;
        if (openW.has(isoWeekday(d))) dates.push(d);
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
          `${head}\n${bk.date.slice(5).replace("-", "/")}（${bk.weekday}）${bk.time}〜\n${bk.businessName}　${bk.menuName}\n${cust.name} 様${why}`);
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
          `【予約の取り消し】\n${d.slice(5).replace("-", "/")}（${WEEKDAYS[new Date(d + "T00:00:00Z").getUTCDay()]}）${jstTime(s)}〜\n${b[0].menu_name}\n${cust.name} 様`);
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
      const out = await handle(body, { sql, verifyIdToken, notify });
      return Response.json(out, { headers: cors });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.code }, { status: e.status, headers: cors });
      console.error("booking error", e);
      return Response.json({ error: "server_error" }, { status: 500, headers: cors });
    }
  });
}
