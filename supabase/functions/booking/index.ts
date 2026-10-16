// =============================================================
// LIFE PLUS 予約  関所（Supabase Edge Function: booking）
// marker: lifeplus-booking-fn-v1 / admin-notify-v1 / notify-contact-v1 / admin-api-v1
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

  // 管理画面（HIROさんだけ）
  if (typeof body.action === "string" && body.action.startsWith("admin_")) {
    const ids = await adminIds(sql);
    if (!ids.includes(who.sub)) throw new ApiError("not_admin", 403);
    return await handleAdmin(body, deps, now);
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
      const hours = await sql`select distinct weekday from business_hours`;
      const openW = new Set(hours.map((h: Record<string, unknown>) => Number(h.weekday)));
      const first = ym + "-01";
      const days = [];
      for (let d = first; d.slice(0, 7) === ym; d = addDays(d, 1)) {
        let state = "off"; let count = 0;
        if (d < today || d > last) state = "out";
        else if (openW.has(isoWeekday(d))) {
          const r = await sql`select count(*)::int as n from lp_available_slots(${d}::date, ${menuId}::uuid)`;
          count = r[0].n;
          const anyHours = await sql`select 1 from closures where tstzrange(starts_at, ends_at, '[)') @> tstzrange(${d + "T00:00:00+09:00"}::timestamptz, ${addDays(d, 1) + "T00:00:00+09:00"}::timestamptz, '[)') limit 1`;
          state = anyHours.length ? "off" : count === 0 ? "full" : count <= 2 ? "few" : "open";
        }
        days.push({ date: d, day: Number(d.slice(8)), weekday: WEEKDAYS[isoWeekday(d) % 7], state, count });
      }
      const prevM = addDays(first, -1).slice(0, 7);
      const nextM = addDays(addDays(first, 31).slice(0, 7) + "-01", 0).slice(0, 7);
      return {
        month: ym, label: `${Number(ym.slice(0, 4))}年${Number(ym.slice(5))}月`, lead: isoWeekday(first) % 7, days,
        prev: prevM >= today.slice(0, 7) ? prevM : null, next: nextM <= last.slice(0, 7) ? nextM : null,
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
      const hours = await sql`select weekday, to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c from business_hours order by weekday, open_time`;
      const pend = await sql`select count(*)::int as n from bookings where status = 'pending' and ends_at > ${now.toISOString()}::timestamptz`;
      return {
        today: jstDate(now),
        businesses: businesses.map((b: Record<string, unknown>) => ({ id: b.id, name: b.name })),
        menus: menus.map((m: Record<string, unknown>) => ({ id: m.id, businessId: m.business_id, name: m.name, durationMin: m.duration_min, bufferMin: m.buffer_after_min, priceYen: m.price_yen })),
        hours: hours.map((h: Record<string, unknown>) => ({ weekday: Number(h.weekday), open: h.o, close: h.c })),
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
      const hours = await sql`select to_char(open_time,'HH24:MI') as o, to_char(close_time,'HH24:MI') as c from business_hours where weekday = ${isoWeekday(d)} order by open_time`;
      const pend = await sql`select count(*)::int as n from bookings where status = 'pending' and ends_at > ${now.toISOString()}::timestamptz`;
      return {
        date: d, weekday: WEEKDAYS[isoWeekday(d) % 7], bookings: list,
        closures: closures.map((c: Record<string, unknown>) => ({ id: c.id, from: jstTime(c.starts_at as Date), to: jstDate(c.ends_at as Date) > d ? "24:00" : jstTime(c.ends_at as Date), note: c.note ?? "" })),
        hours: hours.map((h: Record<string, unknown>) => ({ open: h.o, close: h.c })),
        pendingCount: pend[0].n,
      };
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
      const rows = await sql`select id, starts_at, ends_at, note from closures where ends_at > ${now.toISOString()}::timestamptz order by starts_at limit 100`;
      return {
        closures: rows.map((c: Record<string, unknown>) => {
          const s = c.starts_at as Date, e = c.ends_at as Date;
          return { id: c.id, date: jstDate(s), endDate: jstDate(new Date(e.getTime() - 1)), from: jstTime(s), to: jstTime(e) === "00:00" ? "24:00" : jstTime(e), note: c.note ?? "" };
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
      await sql`insert into closures (starts_at, ends_at, note) values (${start}::timestamptz, ${end}::timestamptz, ${str(body.note, 100) || null})`;
      const conflicts = await bookingsWhere(sql, sql`b.status in ('pending','confirmed') and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')`);
      return { ok: true, conflicts };
    }
    case "admin_closure_del": {
      const id = str(body.id, 40);
      if (!UUID_RE.test(id)) throw new ApiError("bad_request");
      await sql`delete from closures where id = ${id}::uuid`;
      return { ok: true };
    }

    // 手で予約を入れる（電話・来院で受けたもの）
    case "admin_slots": {
      const d = str(body.date, 10), menuId = str(body.menuId, 40);
      if (!DATE_RE.test(d) || !UUID_RE.test(menuId)) throw new ApiError("bad_request");
      const rows = await sql`
        with m as (select duration_min, buffer_after_min from menus where id = ${menuId}::uuid),
        h as (select ((${d}::date + open_time) at time zone 'Asia/Tokyo') as op, ((${d}::date + close_time) at time zone 'Asia/Tokyo') as cl from business_hours where weekday = ${isoWeekday(d)}),
        c as (select gs as s, gs + make_interval(mins => m.duration_min + m.buffer_after_min) as b
              from h, m, generate_series(h.op, h.cl - make_interval(mins => m.duration_min), interval '15 minutes') gs)
        select c.s from c where not exists (
          select 1 from bookings bk where bk.status in ('pending','confirmed')
            and tstzrange(bk.starts_at, bk.block_until, '[)') && tstzrange(c.s, c.b, '[)'))
        order by c.s`;
      return { slots: rows.map((r: Record<string, unknown>) => ({ startsAt: (r.s as Date).toISOString(), time: jstTime(r.s as Date) })) };
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
