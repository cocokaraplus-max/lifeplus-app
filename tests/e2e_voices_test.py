# はたらく人の声（採用ページ）を本物のブラウザで押して確かめる（LINE だけ偽物）  marker: lifeplus-site-voices-v1
#   ★先に sql/lifeplus_site_voices_v1.sql をテスト用DBに流しておくこと
#   deno run -A tests/e2e_server.ts &  →  python3 tests/e2e_voices_test.py <写真の置き場> <試しに使う写真（JPEG）>
import os, sys, subprocess
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "."
PHOTO = sys.argv[2] if len(sys.argv) > 2 else "docs/img/ph/care.jpg"
DB = ["psql", "-h", os.environ.get("PGHOST_E2E", "127.0.0.1"), "-p", os.environ.get("PGPORT_E2E", "5544"), "-U", "postgres", "-d", os.environ.get("PGDB_E2E", "postgres"), "-q", "-c"]
FAKE_LIFF = """
window.liff = {
  init: () => Promise.resolve(), isLoggedIn: () => true, isInClient: () => false,
  getIDToken: () => 'tok-' + (localStorage.getItem('u') || 'hiro'),
  login: () => {}, logout: () => {}, closeWindow: () => {},
};
"""
CONFIG = "window.LP_CONFIG = { LIFF_ID: 'test', API_URL: '/api' };"
results = []
def check(name, cond):
    results.append(("OK" if cond else "NG", name)); print(("OK " if cond else "NG ") + name)

subprocess.run(DB + ["delete from site_voices; delete from staff_members; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    frames = []
    def new_ctx(w=390, h=844):
        c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, locale="ja-JP")
        c.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
        c.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        c.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
        c.route("https://img.test/**", lambda r: r.fulfill(path=PHOTO, content_type="image/jpeg"))
        c.route("https://i.ytimg.com/**", lambda r: r.fulfill(path=PHOTO, content_type="image/jpeg"))
        c.route("https://www.youtube-nocookie.com/**", lambda r: (frames.append(r.request.url), r.fulfill(body="<html><body style='background:#000'></body></html>", content_type="text/html")))
        return c
    errors = []
    site = new_ctx().new_page()
    site.on("pageerror", lambda e: errors.append(str(e)))

    # 1. まだ何もないとき：採用ページに欄もボタンも出ない
    site.goto(BASE + "/recruit/")
    site.wait_for_load_state("networkidle")
    check("声が1件もないと、欄が出ない", site.locator("#voices").is_hidden())
    check("声が1件もないと、上のボタンも出ない", site.locator("[data-voices-link]").is_hidden())

    # 2. 管理画面で声を足す（動画と写真つき）
    pg = new_ctx().new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/admin/")
    pg.locator('[data-tab="site"]').click()
    pg.get_by_role("button", name="はたらく人の声").click()
    expect(pg.get_by_text("まだありません")).to_be_visible()
    pg.locator("#vnew").click()
    pg.select_option("#vb", "day")
    pg.fill("#vn", "Aさん"); pg.fill("#vr", "介護職員・3年目")
    pg.fill("#vh", "利用者さんの「ありがとう」が毎日の力です")
    pg.fill("#vx", "前は別の仕事をしていました。\n未経験でも、先輩がていねいに教えてくれました。")
    pg.fill("#vv", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s")
    pg.set_input_files("#vpf", PHOTO)
    expect(pg.locator("#vpimg")).to_be_visible()
    pg.screenshot(path=f"{SHOTS}/v01_form.png", full_page=True)
    pg.locator("#vgo").click()
    expect(pg.locator(".voice-item")).to_have_count(1)
    it = pg.locator(".voice-item").first
    check("一覧に出る（出している・動画）", "出している" in it.inner_text() and "動画" in it.inner_text() and "Aさん" in it.inner_text())
    # 動画の URL がおかしいときは止める
    pg.locator("#vnew").click()
    pg.fill("#vn", "Bさん"); pg.fill("#vv", "https://example.com/movie")
    pg.locator("#vgo").click()
    expect(pg.locator(".toast")).to_contain_text("動画の URL が読めませんでした")
    check("おかしな動画の URL は保存されない", pg.locator(".voice-item").count() == 1)
    pg.fill("#vv", ""); pg.select_option("#vb", "sekkotsu"); pg.fill("#vr", "柔道整復師"); pg.fill("#vh", "患者さんの笑顔に会える仕事")
    pg.locator("#vgo").click()
    expect(pg.locator(".voice-item")).to_have_count(2)

    # 3. 採用ページに出る
    site.reload(); site.wait_for_load_state("networkidle")
    expect(site.locator("#voices")).to_be_visible()
    check("上に「はたらく人の声」のボタンが出る", site.locator("[data-voices-link]").is_visible())
    cards = site.locator(".voice")
    check("声が2件並ぶ", cards.count() == 2)
    a = cards.nth(0)
    check("名前・事業・職種・ひとこと・お話が出る", "Aさん" in a.inner_text() and "デイサービス・介護職員・3年目" in a.inner_text()
          and "ありがとう" in a.inner_text() and "先輩がていねいに" in a.inner_text())
    check("動画のある声は再生ボタン・小さな顔写真", a.locator(".voice-video").count() == 1 and a.locator("img.voice-face").count() == 1)
    check("写真も動画もない声は、頭文字の丸", cards.nth(1).locator(".voice-ini").inner_text() == "B")
    site.screenshot(path=f"{SHOTS}/v02_recruit_sp.png", full_page=True)
    a.locator(".voice-video").click()
    expect(a.locator("iframe.voice-frame")).to_have_count(1)
    check("押すと YouTube（クッキーなし）で再生", "youtube-nocookie.com/embed/dQw4w9WgXcQ" in a.locator("iframe").get_attribute("src"))
    check("横にはみ出さない（スマホ）", site.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    pc = new_ctx(1280, 900).new_page()
    pc.goto(BASE + "/recruit/#voices"); pc.wait_for_load_state("networkidle")
    pc.locator("#voices").screenshot(path=f"{SHOTS}/v03_recruit_pc.png")
    check("横にはみ出さない（パソコン）", pc.evaluate("document.documentElement.scrollWidth <= innerWidth"))

    # 4. 下書きにすると出なくなる・ぜんぶ下書きなら欄ごと消える
    for i in range(2):
        pg.locator(".voice-item").nth(i).click()
        pg.locator("#vp").uncheck()
        pg.locator("#vgo").click()
        expect(pg.locator(".voice-item").nth(i)).to_contain_text("下書き")
    site.reload(); site.wait_for_load_state("networkidle")
    check("ぜんぶ下書きにすると、欄もボタンも消える", site.locator("#voices").is_hidden() and site.locator("[data-voices-link]").is_hidden())

    # 5. 写真を外す・消す
    pg.locator(".voice-item").first.click()
    pg.locator("#vpdel").click()
    expect(pg.locator(".voice-item img")).to_have_count(1)   # 動画の小さな絵だけ残る
    pg.locator(".voice-item").nth(1).click()
    pg.locator("#vdel").click(); pg.locator("#cfy").click()
    expect(pg.locator(".voice-item")).to_have_count(1)
    check("消すと一覧から消える", True)
    check("画面のエラーなし", not errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(("ぜんぶOK " if not ng else "NGあり ") + f"{len(results) - len(ng)} / {len(results)}")
sys.exit(1 if ng else 0)
