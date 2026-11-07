# 予約メニューを管理画面から作る・直す（設定タブ）を本物のブラウザで押して確かめる（LINE だけ偽物）  marker: lifeplus-menu-edit-v1
#   ★先に sql/lifeplus_menu_edit_v1.sql をテスト用DBに流しておくこと
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
NAME = "保険が使えるか分からない方"
subprocess.run(DB + ["delete from bookings; delete from customers; delete from staff_members; delete from menus where name = '" + NAME + "' or name like 'テスト%'; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
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
    pg = new_ctx("hiro").new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/admin/")
    pg.locator('[data-tab="set"]').click()
    expect(pg.get_by_role("heading", name="予約のメニュー")).to_be_visible()
    check("設定に予約のメニューが出る（接骨院・ボディケア）", pg.locator(".menus-card .mh").all_inner_texts() == ["もみの木接骨院", "HIROボディケアスタジオ"])
    check("保険のメニューは「保険診療」と出る", "保険診療" in pg.locator(".mi", has_text="施術（保険）").first.inner_text())

    # 1. 接骨院に「保険が使えるか分からない方」を足す
    pg.locator('[data-madd="mominoki"]').click()
    pg.fill("#mn", NAME)
    pg.fill("#md", "来院時にお話を伺って、保険か保険外かをご説明します")
    pg.select_option("#mdu", "30")
    pg.locator('[data-pm="label"]').click()
    pg.fill("#mpl", "来院時にご案内")
    pg.fill("#mso", "5")
    pg.screenshot(path=f"{SHOTS}/m01_form.png", full_page=True)
    pg.locator("#mgo").click()
    expect(pg.locator(".mi", has_text=NAME)).to_have_count(1)
    it = pg.locator(".mi", has_text=NAME)
    check("一覧に出る（30分・来院時にご案内・説明）", "30分" in it.inner_text() and "来院時にご案内" in it.inner_text() and "保険か保険外か" in it.inner_text())
    pg.screenshot(path=f"{SHOTS}/m02_list.png", full_page=True)

    # 2. お客さまの予約ページ
    cp = new_ctx("pat").new_page()
    cp.on("pageerror", lambda e: errors.append(str(e)))
    cp.goto(BASE + "/yoyaku/")
    cp.get_by_role("button", name="新しく予約する").click()
    cp.locator("[data-biz=mominoki]").click()
    ch = cp.locator(".choice", has_text=NAME)
    expect(ch).to_have_count(1)
    check("予約ページに出る（30分・説明・料金の所に言葉）", "30分" in ch.inner_text() and "保険か保険外か" in ch.inner_text() and "来院時にご案内" in ch.inner_text() and "保険診療" not in ch.inner_text())
    cp.screenshot(path=f"{SHOTS}/m03_customer.png", full_page=True)
    ch.click()
    expect(cp.locator(".cal-title")).to_have_text("2026年10月")
    check("選ぶと日にちのカレンダーへ進む", cp.locator(".lead").inner_text().startswith(NAME + "（30分）"))

    # 3. 止める → 予約ページから消える
    pg.locator(".mi", has_text=NAME).click()
    pg.locator("#mac").uncheck(); pg.locator("#mgo").click()
    expect(pg.locator(".mi.off", has_text=NAME)).to_have_count(1)
    check("止めると一覧で「止めている」", "止めている" in pg.locator(".mi.off", has_text=NAME).inner_text())
    cp.goto(BASE + "/yoyaku/"); cp.get_by_role("button", name="新しく予約する").click(); cp.locator("[data-biz=mominoki]").click()
    expect(cp.locator(".choice").first).to_be_visible()
    check("止めたメニューは予約ページに出ない", cp.locator(".choice", has_text=NAME).count() == 0)

    # 4. 消す（予約に使っていないので消せる）
    pg.locator(".mi", has_text=NAME).click()
    pg.locator("#mdel").click(); pg.locator("#cfy").click()
    expect(pg.locator(".mi", has_text=NAME)).to_have_count(0)
    check("消すと一覧から消える", True)
    check("横にはみ出さない（スマホ）", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check("画面のエラーなし", not errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(("ぜんぶOK " if not ng else "NGあり ") + f"{len(results) - len(ng)} / {len(results)}")
sys.exit(1 if ng else 0)
