# 期間の休み・お知らせを本物のブラウザで押して確かめる（LINE だけ偽物）  marker: lifeplus-closure-notice-v1
#   ★先に sql/lifeplus_closure_notice_v1.sql をテスト用DBに流しておくこと
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

subprocess.run(DB + ["delete from bookings; delete from customers; delete from closures; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
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

    # 1. 期間を選ぶ：10/29 → 11/3（月をまたぐ）
    pg.goto(BASE + "/admin/")
    pg.get_by_role("button", name="休み", exact=True).click()
    expect(pg.locator(".cal-title")).to_have_text("2026年10月")
    pg.get_by_role("button", name="期間で休みを入れる（お盆・年末年始など）").click()
    expect(pg.locator(".pick-bar b")).to_have_text("始まりの日を押してください")
    check("期間を選ぶときは、受付のない日（10/30 金）も押せる", pg.locator('[data-pick="2026-10-30"]').count() == 1)
    pg.locator('[data-pick="2026-10-29"]').click()
    expect(pg.locator(".pick-bar b")).to_have_text("終わりの日を押してください")
    check("始まりの日に印が付く", "sel" in pg.locator('[data-pick="2026-10-29"]').get_attribute("class"))
    pg.screenshot(path=f"{SHOTS}/c01_pick.png", full_page=True)
    pg.locator("#nm").click()
    expect(pg.locator(".cal-title")).to_have_text("2026年11月")
    check("月を替えても選んでいる途中のまま", pg.locator(".pick-bar b").inner_text() == "終わりの日を押してください")
    pg.locator('[data-pick="2026-11-03"]').click()
    expect(pg.get_by_role("heading", name="期間で休みを入れる")).to_be_visible()
    check("日付が入っている", pg.locator("#rs").input_value() == "2026-10-29" and pg.locator("#re").input_value() == "2026-11-03")
    check("何日間・受付日が何日かが出る", pg.locator("#rsum").inner_text() == "6日間（そのうち受付日 3日）を休みにします。")
    pg.get_by_role("button", name="年末年始のお休み").click()
    check("例を押すとお知らせに入る", pg.locator("#ntc").input_value() == "年末年始のお休み")
    pg.fill("#ntc", "秋の臨時休業")
    pg.fill("#rm", "家族旅行")
    pg.screenshot(path=f"{SHOTS}/c02_range_form.png", full_page=True)
    pg.get_by_role("button", name="休みにする").click()
    expect(pg.locator(".offl .oi")).to_have_count(1)
    row = pg.locator(".offl .oi").first
    check("一覧に期間・メモ・お知らせが出る", "10/29〜11/3" in row.inner_text() and "家族旅行" in row.inner_text() and "お知らせ：秋の臨時休業" in row.inner_text())
    check("休みにした月（10月）に戻る", pg.locator(".cal-title").inner_text() == "2026年10月")
    check("10/29 は休み・お知らせの印", "closed" in pg.locator('[data-off="2026-10-29"]').get_attribute("class") and "ntc" in pg.locator('[data-off="2026-10-29"]').get_attribute("class"))
    pg.screenshot(path=f"{SHOTS}/c03_off_list.png", full_page=True)

    # 2. 逆の順に押しても入れ替わる・やめるで戻る
    pg.get_by_role("button", name="期間で休みを入れる（お盆・年末年始など）").click()
    pg.get_by_role("button", name="やめる").click()
    check("やめると元の画面", pg.locator("#prange").count() == 1 and pg.locator("[data-pick]").count() == 0)

    # 3. お客さまの予約カレンダー
    cp = new_ctx("pat").new_page()
    cp.on("pageerror", lambda e: errors.append(str(e)))
    cp.goto(BASE + "/yoyaku/")
    cp.get_by_role("button", name="新しく予約する").click()
    cp.locator("[data-biz=mominoki]").click()
    expect(cp.locator(".cal-title")).to_have_text("2026年10月")
    nt = cp.locator(".cal-notice")
    check("カレンダーの上にお休みのお知らせ", nt.count() == 1 and "お休みのお知らせ" in nt.inner_text() and "10/29（木）〜11/3（火）" in nt.inner_text() and "秋の臨時休業" in nt.inner_text())
    check("自分用のメモはお客さまに出ない", "家族旅行" not in cp.content())
    check("10/29 は「休」で押せない", cp.locator('button[data-day="2026-10-29"]').count() == 0)
    cp.screenshot(path=f"{SHOTS}/c04_customer.png", full_page=True)

    # 4. お知らせを変える → 空にすると消える
    pg.locator(".offl .oi").first.get_by_role("button", name="お知らせ").click()
    check("今のお知らせが入っている", pg.locator("#ntc").input_value() == "秋の臨時休業")
    pg.fill("#ntc", "")
    pg.get_by_role("button", name="保存する").click()
    expect(pg.locator(".oi-ntc")).to_have_count(0)
    cp.reload()
    cp.get_by_role("button", name="新しく予約する").click()
    cp.locator("[data-biz=mominoki]").click()
    expect(cp.locator(".cal-title")).to_have_text("2026年10月")
    check("お知らせを空にすると、お客さまのカレンダーから消える（休みはそのまま）", cp.locator(".cal-notice").count() == 0 and cp.locator('button[data-day="2026-10-29"]').count() == 0)

    # 5. 1日の休みにもお知らせを付けられる
    pg.locator('[data-off="2026-10-26"]').click()
    pg.fill("#ntc", "研修のため休み")
    pg.get_by_role("button", name="休みにする").click()
    expect(pg.locator(".offl .oi")).to_have_count(2)
    r = api("pat", "month", menuId=mid["施術（保険）"], month="2026-10")
    check("1日の休みのお知らせも出る", [x["text"] for x in r["notices"]] == ["研修のため休み"])

    # 6. パソコンの幅
    pg.set_viewport_size({"width": 1280, "height": 900})
    pg.get_by_role("button", name="期間で休みを入れる（お盆・年末年始など）").click()
    pg.screenshot(path=f"{SHOTS}/c05_pc_pick.png", full_page=True)
    check("横にはみ出さない（パソコン）", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check("画面のエラーなし", not errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(("ぜんぶOK " if not ng else "NGあり ") + f"{len(results) - len(ng)} / {len(results)}")
sys.exit(1 if ng else 0)
