# ホームページ（トップ・デイ・接骨院・ボディケア）を本物のブラウザで確かめる  marker: lifeplus-site-v1
import json, sys, urllib.request, subprocess, os
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "."
CONFIG = "window.LP_CONFIG = { LIFF_ID: 'test', API_URL: '/api' };"
FD = os.environ.get("FONTS_DIR", "")
def fonts(ctx):
    # 見た目を確かめるときは、手元に置いた同じ書体を使う（FONTS_DIR が無ければ書体なし）
    if not FD:
        ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css")); return
    css = []
    for fam, pkg, ws in (("Zen Kaku Gothic New", "zen-kaku-gothic-new", (500, 700, 900)), ("Outfit", "outfit", (300, 400, 500)), ("BIZ UDPGothic", "biz-udpgothic", (400, 700))):
        for w in ws:
            for sub in (("japanese", "latin") if pkg != "outfit" else ("latin",)):
                css.append(f"@font-face{{font-family:'{fam}';font-weight:{w};src:url(https://fontfile.local/{pkg}/{pkg}-{sub}-{w}-normal.woff2)}}")
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="".join(css), content_type="text/css"))
    def ff(r):
        name = r.request.url.split("fontfile.local/")[1]
        pkg, fn = name.split("/")
        path = os.path.join(FD, "node_modules/@fontsource", pkg, "files", fn)
        if os.path.exists(path): r.fulfill(body=open(path, "rb").read(), content_type="font/woff2", headers={"access-control-allow-origin": "*"})
        else: r.fulfill(status=404, body="")
    ctx.route("https://fontfile.local/**", ff)
results = []
def check(name, cond):
    results.append(("OK" if cond else "NG", name)); print(("OK " if cond else "NG ") + name)

with sync_playwright() as p:
    b = p.chromium.launch()
    for vw, vh, tag in ((390, 844, "sp"), (1280, 860, "pc")):
        ctx = b.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=1, locale="ja-JP")
        ctx.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        fonts(ctx)
        ctx.route("https://www.google.com/maps**", lambda r: r.fulfill(body="<html><body style='background:#dde'>地図</body></html>", content_type="text/html"))
        pg = ctx.new_page(); errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
        pg.screenshot(path=f"{SHOTS}/site_top_{tag}.png", full_page=True)
        check(f"[{tag}] トップ：見出し", pg.inner_text("h1").replace("\n", "") == "からだと、くらしに、プラスを。")
        check(f"[{tag}] トップ：3つの事業が各ページへ", [pg.get_attribute(f".svc:nth-of-type({i})", "href") for i in (1, 2, 3)] == ["dayservice/", "sekkotsu/", "bodycare/"])
        check(f"[{tag}] 横にはみ出さない", pg.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
        if tag == "sp":
            check("[sp] メニューは閉じている", not pg.locator(".nav").is_visible())
            pg.click(".menu-btn"); check("[sp] メニューを開ける", pg.locator(".nav").is_visible())
            pg.click(".menu-btn")
        pg.click(".svc.c-kotsu"); pg.wait_for_load_state()
        check(f"[{tag}] 押すと接骨院へ", pg.url.endswith("/sekkotsu/"))
        for path in ("dayservice", "sekkotsu", "bodycare"):
            pg.goto(f"{BASE}/{path}/"); pg.wait_for_timeout(400)
            pg.screenshot(path=f"{SHOTS}/site_{path}_{tag}.png", full_page=True)
            check(f"[{tag}] {path}：はみ出さない", pg.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
            check(f"[{tag}] {path}：今のページに印", pg.locator('.nav a[aria-current="page"]').count() == 1)
        # 予約ボタンは LIFF の予約ページへ
        pg.goto(BASE + "/sekkotsu/")
        check(f"[{tag}] 接骨院の予約ボタン", pg.get_attribute(".act-bar .btn.line", "href") == "https://liff.line.me/2012042545-nlHLpIre/yoyaku/")
        # 文字の大きさ
        pg.click('[data-size="1.4"]'); check(f"[{tag}] 文字を特大に", pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text-zoom').trim()") == "1.4")
        pg.click('[data-size="1"]')
        # 問い合わせ
        pg.goto(BASE + "/dayservice/#form"); pg.wait_for_timeout(3200)
        pg.click("#contact button[type=submit]")
        check(f"[{tag}] 名前なしは止める", "お名前" in pg.inner_text("#contact .msg"))
        pg.fill("#contact [name=name]", "テスト 家族"); pg.select_option("#contact [name=kind]", "見学したい")
        pg.click("#contact button[type=submit]")
        check(f"[{tag}] 連絡先なしは止める", "どちらか" in pg.inner_text("#contact .msg"))
        pg.fill("#contact [name=phone]", "0565-00-0000"); pg.fill("#contact [name=body]", "見学できますか")
        pg.click("#contact button[type=submit]"); pg.wait_for_timeout(800)
        check(f"[{tag}] 送れる", "送りました" in pg.inner_text("#contact .msg"))
        pg.wait_for_timeout(3200); pg.fill("#contact [name=name]", "営業"); pg.fill("#contact [name=phone]", "0565-00-0000"); pg.fill("#contact [name=body]", "ご案内 https://x.example")
        pg.click("#contact button[type=submit]"); pg.wait_for_timeout(800)
        check(f"[{tag}] URL入りは断る", "URL" in pg.inner_text("#contact .msg"))
        pg.screenshot(path=f"{SHOTS}/site_form_{tag}.png")
        check(f"[{tag}] 画面のエラーなし", errors == [])
        ctx.close()
    # LINE の予約（LIFF）からトップが開かれたら、予約ページへ
    ctx = b.new_context(user_agent="Mozilla/5.0 (iPhone) Line/14.0.0 LIFF")
    ctx.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
    ctx.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body="window.liff={init:()=>new Promise(()=>{})}", content_type="text/javascript"))
    pg = ctx.new_page(); pg.goto(BASE + "/"); pg.wait_for_timeout(800)
    check("LIFF から開くと予約ページへ", pg.url.endswith("/yoyaku/"))
    ctx.close()
    ctx = b.new_context(user_agent="Mozilla/5.0 (iPhone) Line/14.0.0")
    fonts(ctx)
    pg = ctx.new_page(); pg.goto(BASE + "/"); pg.wait_for_timeout(500)
    check("LINE のトークで開いたホームページはそのまま", pg.url == BASE + "/")
    b.close()
ng = [n for s, n in results if s == "NG"]
print(f"{len(results) - len(ng)}/{len(results)} OK"); sys.exit(1 if ng else 0)
