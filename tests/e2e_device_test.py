# お店の端末（admin-device-v1）を本物のブラウザで確かめる（LINE だけ偽物）
import json, sys, urllib.request, subprocess
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "."
DB = ["psql", "-h", "127.0.0.1", "-p", "5544", "-U", "postgres", "-q", "-c"]

# LINE にログインしていないブラウザ（お店の端末）。getIDToken が呼ばれたら印を残す
FAKE_LIFF_OUT = """
window.__lineUsed = 0;
window.liff = {
  init: () => Promise.resolve(), isLoggedIn: () => false, isInClient: () => false,
  getIDToken: () => { window.__lineUsed++; return null; },
  login: () => { window.__lineUsed++; }, logout: () => {}, closeWindow: () => {},
};
"""
FAKE_LIFF_HIRO = """
window.liff = {
  init: () => Promise.resolve(), isLoggedIn: () => true, isInClient: () => false,
  getIDToken: () => 'tok-hiro', login: () => {}, logout: () => {}, closeWindow: () => {},
};
"""
CONFIG = "window.LP_CONFIG = { LIFF_ID: 'test', API_URL: '/api' };"

def api(action, **kw):
    req = urllib.request.Request(BASE + "/api", method="POST",
        data=json.dumps({"action": action, "idToken": "tok-hiro", **kw}).encode(), headers={"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.load(e)

results = []
def check(name, cond):
    results.append(("OK" if cond else "NG", name)); print(("OK " if cond else "NG ") + name)

subprocess.run(DB + ["delete from admin_devices; delete from device_pair_fails; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    def new_ctx(liff):
        c = b.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=1, locale="ja-JP")
        c.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=liff, content_type="text/javascript"))
        c.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        c.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
        return c
    errors = []

    # 1. HIROさんの画面：スタッフ → お店の端末 → 番号を出す
    hc = new_ctx(FAKE_LIFF_HIRO); hp = hc.new_page(); hp.on("pageerror", lambda e: errors.append(str(e)))
    hp.goto(BASE + "/admin/?date=2026-10-19")
    expect(hp.locator(".day h1")).to_contain_text("10月19日")
    hp.click('[data-tab="staff"]')
    expect(hp.locator("#dadd")).to_be_visible()
    hp.click("#dadd")
    hp.fill("#dl", "受付PC")
    check("端末には「通知」の項目が無い", hp.locator('[data-dperm="notify"]').count() == 0)
    hp.check('[data-dperm="closures"]')
    hp.click("#ds")
    expect(hp.locator(".pair-code")).to_be_visible()
    pcode = hp.locator(".pair-code").inner_text().replace(" ", "").replace("\n", "")
    check("6桁の番号が出る", len(pcode) == 6 and pcode.isdigit())
    hp.screenshot(path=f"{SHOTS}/d01_code.png")
    hp.click("#pok")
    expect(hp.locator('[data-d]')).to_have_count(1)
    check("一覧に「番号を出しています」", "番号を出しています" in hp.locator('[data-d]').inner_text())

    # 2. お店の端末：LINE なしで開くと番号の画面
    dc = new_ctx(FAKE_LIFF_OUT); dp = dc.new_page(); dp.on("pageerror", lambda e: errors.append(str(e)))
    dp.goto(BASE + "/admin/")
    expect(dp.locator("#pc")).to_be_visible()
    check("LINE にログインしていなくても、勝手に LINE のログインへ飛ばない", dp.evaluate("window.__lineUsed") == 0)
    dp.screenshot(path=f"{SHOTS}/d02_pair.png")
    dp.fill("#pc", "000000" if pcode != "000000" else "111111"); dp.click("#pgo")
    expect(dp.locator("#toast")).to_contain_text("番号が違う")
    dp.fill("#pc", pcode[:3] + " " + pcode[3:]); dp.click("#pgo")
    expect(dp.locator(".day h1")).to_be_visible()
    check("登録すると予約表が開く（呼び名つき）", "受付PC" in dp.locator(".bar-top").inner_text())
    tabs = dp.locator("nav.tabs").inner_text()
    check("スタッフ・設定・お客さまのタブは出ない／休みは出る", "スタッフ" not in tabs and "設定" not in tabs and "お客さま" not in tabs and "休み" in tabs)
    check("LINE は一度も使っていない", dp.evaluate("window.__lineUsed") == 0)
    dp.screenshot(path=f"{SHOTS}/d03_device_day.png")

    # 3. 開き直しても、そのまま使える
    dp.reload()
    expect(dp.locator(".day h1")).to_be_visible()
    check("開き直しても番号は要らない", dp.locator("#pc").count() == 0 and dp.evaluate("window.__lineUsed") == 0)

    # 4. HIROさんの一覧で「使えます」。外すと端末は番号の画面に戻る
    hp.click('[data-tab="day"]'); hp.click('[data-tab="staff"]')
    expect(hp.locator('[data-d]')).to_contain_text("使えます")
    did = api("admin_devices")["devices"][0]["id"]
    hp.click('[data-d]'); hp.click("#ddel"); hp.locator(".sheet button", has_text="外す").last.click()
    expect(hp.locator('[data-d]')).to_have_count(0)
    dp.reload()
    expect(dp.locator(".pair-msg")).to_contain_text("登録が外れています")
    check("外された端末は番号の画面に戻る", dp.locator("#pc").is_visible())

    # 5. 端末が自分で外す
    r = api("admin_device_code", label="iPad", perms=[])
    dp.fill("#pc", r["code"]); dp.click("#pgo")
    expect(dp.locator("#devout")).to_be_visible()
    dp.click("#devout"); dp.locator(".sheet button", has_text="外す").last.click()
    expect(dp.locator(".pair-msg")).to_contain_text("登録を外しました")
    check("自分で外すと、合鍵も消える", dp.evaluate("localStorage.getItem('lp_admin_device')") is None)
    check("画面のエラーなし", not errors)
    if errors: print(errors)
    b.close()

subprocess.run(DB + ["delete from admin_devices; delete from device_pair_fails;"], check=True)
ng = [r for r in results if r[0] == "NG"]
print(f"\n{len(results) - len(ng)}/{len(results)} OK")
sys.exit(1 if ng else 0)
