# 休みの日に「年末年始」「臨時休業」などの言葉が出る を本物のブラウザで確かめる（LINE だけ偽物）  marker: lifeplus-off-label-v1
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
subprocess.run(DB + ["delete from bookings; delete from closures; delete from extra_hours; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
api("hiro", "admin_closure_add", date="2026-10-26", endDate="2026-10-29", notice="年末年始のお休み", note="家族旅行")
api("hiro", "admin_closure_add", date="2026-10-22", notice="臨時休業")
api("hiro", "admin_closure_add", date="2026-10-31", note="研修")
api("hiro", "admin_closure_add", date="2026-10-24", notice="<b>点検</b>")   # 記号が入っても崩れない
api("pat", "profile", name="テスト 一郎", nameKana="てすと いちろう", phone="09011112222")

with sync_playwright() as p:
    b = p.chromium.launch()
    def new_ctx(user, w=390):
        c = b.new_context(viewport={"width": w, "height": 844}, device_scale_factor=2, locale="ja-JP")
        c.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
        c.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        c.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
        c.clock.set_fixed_time("2026-10-16T12:00:00+09:00")
        c.add_init_script(f"localStorage.setItem('u', '{user}')")
        return c
    errors = []
    # 1. お客さまの予約カレンダー
    cp = new_ctx("pat").new_page(); cp.on("pageerror", lambda e: errors.append(str(e)))
    cp.goto(BASE + "/yoyaku/")
    cp.get_by_role("button", name="新しく予約する").click()
    cp.locator("[data-biz=mominoki]").click()
    cp.locator(".choice").first.click()
    expect(cp.locator(".cal-title")).to_have_text("2026年10月")
    cell = lambda d: cp.locator(".cal-grid > *").nth(7 + 4 + d - 1)   # 曜日の見出し7つ＋10/1 は木曜（前に空きが4つ）
    check("お客さま：年末年始の休みの日に「年末年始」", cell(26).inner_text().replace("\n", "") == "26年末年始")
    check("お客さま：臨時休業の日に「臨時休業」", cell(22).inner_text().replace("\n", "") == "22臨時休業")
    check("お客さま：メモだけの休みは「休」のまま（メモは出ない）", cell(31).inner_text().replace("\n", "") == "31休" and "研修" not in cp.content() and "家族旅行" not in cp.content())
    check("お客さま：26〜29日は線でつながり、名前は1回だけ", cp.locator(".cal-grid .band").count() == 4 and cp.locator(".cal-grid .band-l").count() == 1
          and cp.locator(".cal-grid .band.bs").count() == 1 and cp.locator(".cal-grid .band.be").count() == 1)
    cp.locator(".cal-card").screenshot(path=f"{SHOTS}/o01_customer.png")
    # 2. 管理画面の休みのカレンダー
    pg = new_ctx("hiro").new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/admin/")
    pg.get_by_role("button", name="休み", exact=True).click()
    expect(pg.locator(".cal-title")).to_have_text("2026年10月")
    T = lambda sel: pg.locator(sel).inner_text().replace("\n", "")
    check("休みのカレンダー：「年末年始」「臨時休業」「研修」（4文字は2行）", T('[data-off="2026-10-26"]') == "26年末年始"
          and T('[data-off="2026-10-22"]') == "22臨時休業" and T('[data-off="2026-10-31"]') == "31研修"
          and pg.locator('[data-off="2026-10-26"] i br').count() == 1)
    check("休みのカレンダー：期間は線1本、名前は1回だけ", pg.locator(".card").first.locator(".band").count() == 4 and pg.locator(".card").first.locator(".band-l").count() == 1)
    pg.locator(".card").first.screenshot(path=f"{SHOTS}/o02_offcal.png")
    # 3. 予約表：その日を開くと上に大きく
    pg.locator('[data-tab="day"]').click()
    pg.locator("#dm").click()
    expect(pg.locator('[data-md="2026-10-26"]')).to_be_visible()
    check("予約表の月のカレンダー：「年末年始」「研修」", T('[data-md="2026-10-26"]') == "26年末年始" and T('[data-md="2026-10-31"]') == "31研修")
    check("記号の入った言葉も、そのまま文字で出る（画面が崩れない）", "<b>" in T('[data-md="2026-10-24"]') and pg.locator('[data-md="2026-10-24"] i b').count() == 0)
    check("予約表の月のカレンダー：期間は線1本、名前は1回だけ", pg.locator(".sheet .band").count() == 4 and pg.locator(".sheet .band-l").count() == 1)
    pg.locator(".sheet").screenshot(path=f"{SHOTS}/o03_month.png")
    pg.locator('[data-md="2026-10-26"]').click()
    expect(pg.locator(".off-banner")).to_be_visible()
    check("その日の予約表：上に「終日お休み　年末年始のお休み（家族旅行）」", pg.locator(".off-banner").inner_text().replace("\n", "") == "終日お休み年末年始のお休み（家族旅行）")
    check("時間の帯にもお知らせとメモ", "年末年始のお休み" in pg.locator(".xblk").first.inner_text() and "家族旅行" in pg.locator(".xblk").first.inner_text())
    pg.screenshot(path=f"{SHOTS}/o04_day.png")
    check("横にはみ出さない（スマホ）", pg.evaluate("document.documentElement.scrollWidth <= innerWidth") and cp.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check("画面のエラーなし", not errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(("ぜんぶOK " if not ng else "NGあり ") + f"{len(results) - len(ng)} / {len(results)}")
sys.exit(1 if ng else 0)
