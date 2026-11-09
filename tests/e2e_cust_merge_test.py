# 店頭で入れた方と、あとからLINEで予約した方を1人にまとめる を本物のブラウザで押して確かめる（LINE だけ偽物）  marker: lifeplus-cust-merge-v1
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
subprocess.run(DB + ["delete from bookings; delete from customers; delete from staff_members; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
mid = [m["id"] for m in api("pat", "init")["menus"] if m["name"] == "施術（保険）"][0]
subprocess.run(DB + ["insert into customers (name, name_kana, phone, chart_no, memo, is_returning) values ('山田 花子', 'ヤマダ ハナコ', '09011112222', '1234', '腰が弱い', true);"], check=True)
subprocess.run(DB + ["insert into bookings (customer_id, menu_id, business_id, starts_at, ends_at, block_until, status, source) select id, '" + mid + "', 'mominoki', '2026-10-12T17:00:00+09:00', '2026-10-12T17:15:00+09:00', '2026-10-12T17:15:00+09:00', 'done', 'admin' from customers where chart_no = '1234';"], check=True)
api("hana", "profile", name="やまだ はなこ", nameKana="やまだ はなこ", phone="090-1111-2222")
api("hana", "book", menuId=mid, startsAt="2026-10-22T17:00:00+09:00", symptoms=["腰"])
subprocess.run(DB + ["insert into customers (name, name_kana, phone) values ('佐藤 一郎', 'サトウ イチロウ', '09099998888');"], check=True)

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
    pg.locator('[data-tab="cust"]').click()
    expect(pg.locator(".cust")).to_have_count(3)
    check("はじめは名簿に3人（同じ方が2人に分かれている）", pg.locator(".cust", has_text="やまだ").count() == 1 and pg.locator(".cust", has_text="山田").count() == 1)
    # 1. LINEで予約した方を開くと、同じ方かもしれない登録が出る
    pg.locator(".cust", has_text="やまだ").click()
    expect(pg.locator(".dupe-note")).to_be_visible()
    dn = pg.locator(".dupe-note").inner_text()
    check("「同じ方かもしれない登録」に店頭の方が出る（電話・フリガナが同じ・LINEなし・カルテ1234）", "山田 花子" in dn and "電話が同じ" in dn and "フリガナが同じ" in dn and "カルテ 1234" in dn)
    pg.screenshot(path=f"{SHOTS}/g01_dupe.png", full_page=True)
    pg.locator("[data-dmg]").first.click()
    expect(pg.get_by_role("heading", name="1人にまとめますか？")).to_be_visible()
    f = pg.locator(".facts").inner_text()
    check("残すのはLINEのある方", "残す方" in f and "やまだ はなこ（LINEあり）" in f and "山田 花子（LINEなし）" in f)
    check("お名前が違うので選べる（店頭の漢字のお名前が先に選ばれている）", pg.locator('[data-nf].on').inner_text() == "山田 花子")
    pg.screenshot(path=f"{SHOTS}/g02_confirm.png", full_page=True)
    pg.locator("#mgok").click()
    expect(pg.locator(".toast")).to_contain_text("1人にまとめました")
    expect(pg.get_by_role("heading", name="山田 花子")).to_be_visible()
    sheet = pg.locator(".sheet").inner_text()
    check("まとめた方にカルテ番号・来院1回・2件の履歴", "1234" in sheet and "来院 1回" in sheet and pg.locator(".sheet .h").count() == 2)
    check("「同じ方かもしれない」はもう出ない", pg.locator(".dupe-note").count() == 0)
    pg.locator(".sheet-x").click()
    expect(pg.locator(".cust")).to_have_count(2)
    check("名簿は2人になる（お名前は漢字・LINEあり）", pg.locator(".cust", has_text="やまだ").count() == 0 and "LINEなし" not in pg.locator(".cust", has_text="山田").inner_text())
    # 2. 探してまとめる（候補に出ない人）：佐藤さんを開いて、探す → 両方LINEなし → 開いていた方が残る
    pg.locator(".cust", has_text="佐藤").click()
    pg.locator("#tmg").click()
    pg.fill("#mq", "1234")
    expect(pg.locator("[data-mp]")).to_have_count(1)
    pg.locator("[data-mp]").first.click()
    check("LINEのある方（山田 花子）を残す形になる", "山田 花子（LINEあり）" in pg.locator(".facts").inner_text().split("まとめて消える方")[0])
    pg.locator("#mgno").click()
    check("横にはみ出さない（スマホ）", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    check("画面のエラーなし", not errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(("ぜんぶOK " if not ng else "NGあり ") + f"{len(results) - len(ng)} / {len(results)}")
sys.exit(1 if ng else 0)
