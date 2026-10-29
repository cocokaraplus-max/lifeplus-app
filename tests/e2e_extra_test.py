# 臨時の受付日・期間の休みの中の1日だけ受付に戻す を本物のブラウザで押して確かめる（LINE だけ偽物）  marker: lifeplus-extra-hours-v1
#   ★先に sql/lifeplus_closure_notice_v1.sql と sql/lifeplus_extra_hours_v1.sql をテスト用DBに流しておくこと
import json, sys, urllib.request, subprocess
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "."
DB = ["psql", "-h", "127.0.0.1", "-p", "5544", "-U", "postgres", "-q", "-c"]
FAKE_LIFF = """
window.liff = {
  init: () => Promise.resolve(), isLoggedIn: () => true, isInClient: () => false,
  getIDToken: () => 'tok-' + (localStorage.getItem('u') || 'hiro'),
  login: () => {}, logout: () => {}, closeWindow: () => {},
};
"""
CONFIG = "window.LP_CONFIG = { LIFF_ID: 'test', API_URL: '/api' };"

def api(user, action, **kw):
    req = urllib.request.Request(BASE + "/api", method="POST",
        data=json.dumps({"action": action, "idToken": "tok-" + user, **kw}).encode(), headers={"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.load(e)

results = []
def check(name, cond):
    results.append(("OK" if cond else "NG", name)); print(("OK " if cond else "NG ") + name)

subprocess.run(DB + ["delete from bookings; delete from customers; delete from closures; delete from extra_hours; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
init = api("pat", "init")
mid = {m["name"]: m["id"] for m in init["menus"]}
api("pat", "profile", name="テスト 一郎", nameKana="てすと いちろう", phone="09011112222")

with sync_playwright() as p:
    b = p.chromium.launch()
    def new_ctx(user):
        c = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="ja-JP")
        c.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
        c.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        c.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
        c.clock.set_fixed_time("2026-10-16T12:00:00+09:00")
        c.add_init_script(f"localStorage.setItem('u', '{user}')")
        return c
    errors = []
    pg = new_ctx("hiro").new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/admin/")
    pg.get_by_role("button", name="休み", exact=True).click()
    expect(pg.locator(".cal-title")).to_have_text("2026年10月")

    # 1. 受付のない火曜（10/20）を臨時で受付にする
    check("受付のない日も押せる", pg.locator('[data-none="2026-10-20"]').count() == 1)
    pg.locator('[data-none="2026-10-20"]').click()
    pg.get_by_role("button", name="臨時で受付にする").click()
    expect(pg.get_by_role("heading", name="10月20日（火） を臨時で受付にする")).to_be_visible()
    pg.select_option("#xf", "10:00"); pg.select_option("#xt", "12:00")
    pg.get_by_role("button", name="臨時で受付します").click()
    pg.fill("#xm", "振替")
    pg.screenshot(path=f"{SHOTS}/x01_extra_form.png", full_page=True)
    pg.get_by_role("button", name="受付にする").click()
    expect(pg.get_by_role("heading", name="臨時の受付日")).to_be_visible()
    row = pg.locator(".offl").first.locator(".oi").first
    check("臨時の受付日の一覧に出る", "10月20日（火）" in row.inner_text() and "10:00〜12:00" in row.inner_text() and "振替" in row.inner_text() and "臨時で受付します" in row.inner_text())
    d20 = pg.locator('[data-off="2026-10-20"]')
    check("カレンダーで10/20が「臨時」の受付日になる", d20.count() == 1 and "extra" in d20.get_attribute("class") and "臨時" in d20.inner_text())

    # 2. お客さまの予約カレンダー
    cp = new_ctx("pat").new_page()
    cp.on("pageerror", lambda e: errors.append(str(e)))
    cp.goto(BASE + "/yoyaku/")
    cp.get_by_role("button", name="新しく予約する").click()
    cp.locator("[data-biz=mominoki]").click()
    expect(cp.locator(".cal-title")).to_have_text("2026年10月")
    check("お客さまのカレンダーで10/20が選べる", cp.locator('button[data-day="2026-10-20"]').count() == 1)
    check("お知らせに臨時の受付が出る", "10/20（火） 10:00〜12:00" in cp.locator(".cal-notice").inner_text() and "振替" not in cp.content())
    cp.locator('[data-day="2026-10-20"]').click()
    expect(cp.locator("#slots .time").first).to_be_visible()
    check("10:00から選べる", cp.locator("#slots .time").first.inner_text() == "10:00")
    cp.screenshot(path=f"{SHOTS}/x02_customer.png", full_page=True)

    # 3. 受付のない水曜（10/21）から期間で休みを入れる → 10/27 まで
    pg.locator('[data-none="2026-10-21"]').click()
    pg.get_by_role("button", name="この日から期間で休みを入れる").click()
    expect(pg.locator(".pick-bar b")).to_have_text("終わりの日を押してください")
    check("始まりは受付のない10/21", "sel" in pg.locator('[data-pick="2026-10-21"]').get_attribute("class"))
    pg.locator('[data-pick="2026-10-27"]').click()
    check("期間は10/21〜10/27", pg.locator("#rs").input_value() == "2026-10-21" and pg.locator("#re").input_value() == "2026-10-27")
    pg.fill("#ntc", "研修のため休み")
    pg.get_by_role("button", name="休みにする").click()
    expect(pg.get_by_text("10/21〜10/27")).to_be_visible()
    check("期間の中の受付日（10/22 木）は休み", "closed" in pg.locator('[data-off="2026-10-22"]').get_attribute("class"))

    # 4. 期間の中の1日（10/22）だけ受付に戻す
    pg.locator('[data-off="2026-10-22"]').click()
    pg.screenshot(path=f"{SHOTS}/x03_open_day.png", full_page=True)
    pg.get_by_role("button", name="この日だけ休みをやめて受付にする").click()
    expect(pg.get_by_text("10/23〜10/27")).to_be_visible()
    check("10/22 は受付に戻る・前後の休みは残る", "open" in pg.locator('[data-off="2026-10-22"]').get_attribute("class")
          and pg.get_by_text("10月21日（水）", exact=False).count() >= 1 and "closed" in pg.locator('[data-off="2026-10-24"]').get_attribute("class"))
    r = api("pat", "month", menuId=mid["施術（保険）"], month="2026-10")
    st = {d["date"]: d["state"] for d in r["days"]}
    check("お客さまのカレンダーでも10/22は受付・10/24は休み", st["2026-10-22"] != "off" and st["2026-10-24"] == "off")
    pg.screenshot(path=f"{SHOTS}/x04_off.png", full_page=True)

    # 5. 臨時の受付を外す
    pg.locator("[data-xdel]").first.click()
    pg.locator("#cfy").click()
    expect(pg.get_by_role("heading", name="臨時の受付日")).to_have_count(0)
    check("外すと10/20は受付のない日に戻る", pg.locator('[data-none="2026-10-20"]').count() == 1)
    check("横にはみ出さない（スマホ）", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check("画面のエラーなし", not errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(("ぜんぶOK " if not ng else "NGあり ") + f"{len(results) - len(ng)} / {len(results)}")
sys.exit(1 if ng else 0)
