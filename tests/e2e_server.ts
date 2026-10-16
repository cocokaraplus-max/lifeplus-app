// 画面テスト用のサーバ：docs/ を配り、/api で本物の関所（handle）を動かす。LINEだけ偽物。
import postgres from "npm:postgres@3.4.5";
import { ApiError, handle } from "../supabase/functions/booking/index.ts";

const sql = postgres(Deno.env.get("TEST_DB_URL")!, { prepare: false, max: 2, onnotice: () => {} });
const verifyIdToken = (t: string) =>
  Promise.resolve(t.startsWith("tok-") ? { sub: "U" + t.slice(4), name: "LINE太郎" } : null);
const NOW = new Date("2026-10-16T12:00:00+09:00");
const root = new URL("../docs/", import.meta.url);

Deno.serve({ port: 8765 }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/api") {
    try {
      return Response.json(await handle(await req.json(), { sql, verifyIdToken, now: () => NOW }));
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.code }, { status: e.status });
      console.error(e);
      return Response.json({ error: "server_error" }, { status: 500 });
    }
  }
  if (u.pathname.startsWith("/__font/")) {
    const w = u.pathname.split("/").pop();
    const f = new URL(`../mock/node_modules/@fontsource/zen-maru-gothic/files/zen-maru-gothic-japanese-${w}-normal.woff2`, import.meta.url);
    try { return new Response(await Deno.readFile(f), { headers: { "content-type": "font/woff2", "access-control-allow-origin": "*" } }); }
    catch { return new Response("", { status: 404 }); }
  }
  const path = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  try {
    const body = await Deno.readFile(new URL(path, root));
    const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
    return new Response(body, { headers: { "content-type": type + "; charset=utf-8" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
