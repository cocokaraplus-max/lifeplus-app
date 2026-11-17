# 取り消しの締め切り（予約と別）とキャンセルの案内を、本物のブラウザで確かめる（LINE だけ偽物）  marker: lifeplus-cancel-rule-v1
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
subprocess.run(DB + ["delete from bookings; delete from closures; delete from extra_hours; delete from app_settings where key in ('cancel_minutes','cancel_notice'); update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
api("pat", "init")
api("pat", "profile", name="テスト 一郎", nameKana="てすと いちろう", phone="09011112222")
# 今は 10/16 12:00。13:00（1時間後）と 14:30（2時間30分後）の予約を入れておく
for hm in ["13:00", "14:30"]:
    subprocess.run(DB + [f"""insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until, status, price_yen)
      select c.id, m.id, m.business_id, '2026-10-16T{hm}:00+09:00', '2026-10-16T{hm}:00+09:00'::timestamptz + interval '20 minutes',
             '2026-10-16T{hm}:00+09:00'::timestamptz + interval '20 minutes', 'confirmed', 0
        from customers c, (select * from menus where is_active order by sort_order limit 1) m where c.line_user_id = 'Upat'"""], check=True)

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
    # 1. 管理画面の設定：予約と取り消しの締め切りを別に、案内を書く
    pg = new_ctx("hiro", 820).new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(BASE + "/admin/"); pg.click("[data-tab=set]"); pg.wait_for_selector("#sc")
    check("設定：取り消しの締め切りの欄（まだ決めていなければ予約と同じ）", pg.input_value("#sc") == pg.input_value("#sl"))
    check("設定：案内は元の文が入っている", "{取消}" in pg.input_value("#sx"))
    pg.fill("#sl", "120"); pg.fill("#sc", "90"); pg.fill("#sn", "2")
    pv = pg.locator("#sxpv").inner_text()
    check("設定：見え方に今の値が入る（取消 1時間30分・2回）", "開始の1時間30分前まで" in pv and "2回続いた方" in pv)
    pg.locator("#sxpv").scroll_into_view_if_needed()
    pg.screenshot(path=f"{SHOTS}/c01_settings.png", full_page=True)
    pg.fill("#sx", "")
    check("設定：空にすると「出しません」", "出しません" in pg.locator("#sxpv").inner_text())
    pg.click("#sxdef")
    check("設定：［元の文に戻す］", "{取消}" in pg.input_value("#sx"))
    pg.click("#sgo"); expect(pg.locator(".toast")).to_contain_text("保存しました")
    s = api("hiro", "admin_settings")
    check("設定：保存できた（予約120・取消90）", s["leadMinutes"] == 120 and s["cancelMinutes"] == 90)
    # 2. お客さまのご予約の状況
    cp = new_ctx("pat").new_page(); cp.on("pageerror", lambda e: errors.append(str(e)))
    cp.goto(BASE + "/yoyaku/"); expect(cp.locator(".bk").first).to_be_visible()
    bk = cp.locator(".bk")
    check("お客さま：締め切りを過ぎた予約（13:00）には取り消しのボタンが無い", bk.nth(0).locator("[data-cancel]").count() == 0 and "1時間30分前" in bk.nth(0).inner_text())
    check("お客さま：まだの予約（14:30）は取り消せる", bk.nth(1).locator("[data-cancel]").count() == 1)
    check("お客さま：下に「キャンセルについて」（たたんである）", cp.locator("details.policy").count() == 1 and not cp.locator(".policy-b").is_visible())
    cp.locator("details.policy summary").click()
    check("お客さま：開くと案内（今の値入り）", "開始の1時間30分前まで" in cp.locator(".policy-b").inner_text())
    cp.screenshot(path=f"{SHOTS}/c02_home.png", full_page=True)
    # 3. 予約の確認画面にも案内
    cp.get_by_role("button", name="新しく予約する").click()
    cp.locator("[data-biz=bodycare]").click()
    cp.locator("[data-menu]").first.click()
    cp.locator('[data-day="2026-10-19"]').click()
    cp.locator("#slots .time").first.click()
    go = cp.get_by_role("button", name="確認へ進む")
    if go.count(): go.click()
    expect(cp.get_by_role("heading", name="この内容で予約しますか？")).to_be_visible()
    pol = cp.locator(".card.policy")
    check("確認画面：「予約する」の前に案内（開いたまま）", pol.count() == 1 and pol.is_visible() and "キャンセルについて" in pol.inner_text())
    check("確認画面：案内は「予約する」より上", pol.bounding_box()["y"] < cp.get_by_role("button", name="予約する").bounding_box()["y"])
    cp.screenshot(path=f"{SHOTS}/c03_confirm.png", full_page=True)
    # 4. 案内を空にすると、どこにも出ない
    api("hiro", "admin_settings_save", hours=s["hours"], leadMinutes=120, horizonDays=s["horizonDays"], noshowLimit=2, cancelNotice="")
    cp.goto(BASE + "/yoyaku/"); expect(cp.locator(".bk").first).to_be_visible()
    check("案内を空にすると出さない", cp.locator(".policy").count() == 0)
    check("画面のエラーなし", not errors); print(errors[:3])
    b.close()
ng = [r for r in results if r[0] == "NG"]
print(f"OK {len(results) - len(ng)} NG {len(ng)}")
sys.exit(1 if ng else 0)
