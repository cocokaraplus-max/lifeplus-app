# 管理画面を本物のブラウザで押して確かめる（LINE だけ偽物に差し替え）
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
        data=json.dumps({"action": action, "idToken": "tok-" + user, **kw}).encode(),
        headers={"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.load(e)

results = []
def check(name, cond):
    results.append(("OK" if cond else "NG", name)); print(("OK " if cond else "NG ") + name)

# 準備：まっさらにして、HIROさんを管理者に。患者さんが仮予約を1件入れる
subprocess.run(DB + ["delete from bookings; delete from customers; delete from closures; update app_settings set value='Uhiro' where key='admin_line_user_ids';"], check=True)
init = api("pat", "init")
mid = {m["name"]: m["id"] for m in init["menus"]}
api("pat", "profile", name="テスト 一郎", nameKana="てすと いちろう", phone="09011112222")
r = api("pat", "book", menuId=mid["施術（保険）"], startsAt="2026-10-19T18:30:00+09:00", symptoms=["腰"])
check("患者さんの予約は仮予約", r["booking"]["status"] == "pending")

with sync_playwright() as p:
    b = p.chromium.launch()
    def new_ctx():
        c = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="ja-JP")
        c.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
        c.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        c.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
        # 関所の「今」（2026-10-16 12:00）にブラウザの時計もそろえる（そろえないと、日が過ぎると予約が「過去」になる）
        c.clock.set_fixed_time("2026-10-16T12:00:00+09:00")
        return c
    ctx = new_ctx()
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    # 1. 予約表
    pg.goto(BASE + "/admin/?date=2026-10-19")
    expect(pg.locator(".day h1")).to_contain_text("10月19日")
    check("確認待ちの帯が出る", pg.locator("#gowait .n").inner_text() == "1")
    bk = pg.locator(".bk")
    check("予約が1件並ぶ", bk.count() == 1 and "テスト 一郎" in bk.first.inner_text())
    print("free", pg.locator(".free").count()); check("空き枠が並ぶ（12枠から予約の1枠を除く）", pg.locator(".free").count() == 11)
    pg.screenshot(path=f"{SHOTS}/a01_day.png", full_page=True)

    # 1b. 月のカレンダーで日を移動する
    pg.locator("#dm").click()
    expect(pg.locator(".sheet .cal-title")).to_have_text("2026年10月")
    check("予約のある日に件数が出る", "1件" in pg.locator('[data-md="2026-10-19"]').inner_text() and pg.locator('[data-md="2026-10-19"] .dot').count() == 1)
    pg.screenshot(path=f"{SHOTS}/a01b_month.png")
    pg.locator("#mn").click()
    expect(pg.locator(".sheet .cal-title")).to_have_text("2026年11月")
    pg.locator('[data-md="2026-11-05"]').click()
    expect(pg.locator(".day h1")).to_contain_text("11月5日")
    pg.locator("#dm").click()
    expect(pg.locator(".sheet .cal-title")).to_have_text("2026年11月")
    pg.locator("#mp").click()
    expect(pg.locator(".sheet .cal-title")).to_have_text("2026年10月")
    pg.locator('[data-md="2026-10-19"]').click()
    expect(pg.locator(".day h1")).to_contain_text("10月19日")
    check("×ボタンで閉じられる", True)

    # 2. 予約票 → 確定
    bk.first.click()
    expect(pg.locator(".sheet .status")).to_have_text("確認待ち")
    pg.screenshot(path=f"{SHOTS}/a02_slip.png")
    pg.locator(".sheet-x").click()
    expect(pg.locator("#sheet")).to_be_hidden()
    bk.first.click()
    pg.get_by_role("button", name="確定する").click()
    expect(pg.locator("#toast")).to_contain_text("確定しました")
    expect(pg.locator("#gowait")).to_have_count(0)
    check("確定すると確定の色になる", "confirmed" in pg.locator(".bk").first.get_attribute("class"))

    # 3. 空き枠を × にする → 患者さんから選べない → 外す
    pg.locator('[data-free="17:30"]').click()
    pg.screenshot(path=f"{SHOTS}/a03_free.png")
    pg.get_by_role("button", name="17:30〜17:45 を×にする").click()
    expect(pg.locator(".xblk")).to_have_count(1)
    slots = api("pat", "slots", menuId=mid["施術（保険）"], date="2026-10-19")
    times = [s["time"] for s in slots.get("slots", [])]
    check("×の時間は患者さんの予約ページで選べない", "17:30" not in times and "17:15" in times and "17:45" in times)
    pg.screenshot(path=f"{SHOTS}/a04_x.png", full_page=True)
    pg.locator(".xblk").click()
    pg.get_by_role("button", name="×を外す（予約を受けられるようにする）").click()
    expect(pg.locator(".xblk")).to_have_count(0)
    check("×を外すと戻る", "17:30" in [s["time"] for s in api("pat", "slots", menuId=mid["施術（保険）"], date="2026-10-19")["slots"]])

    # 4. 空き枠から手で予約（LINEのない方）
    pg.locator('[data-free="17:00"]').click()
    pg.get_by_role("button", name="ここに予約を入れる").click()
    pg.select_option("#bm", label="眠れるボディケアコース（60分）")
    expect(pg.locator(".time").first).to_be_visible()
    pg.locator('.time[data-t="17:00"]').click()
    pg.fill("#bn", "電話 花子"); pg.fill("#bk", "でんわ はなこ"); pg.fill("#bp", "0565-11-2222")
    pg.screenshot(path=f"{SHOTS}/a05_book.png")
    pg.get_by_role("button", name="この内容で入れる").click()
    expect(pg.locator("#toast")).to_contain_text("予約を入れました")
    expect(pg.locator(".bk")).to_have_count(2)
    check("手入れの予約はボディケアの色・すぐ確定", "bc confirmed" in pg.locator(".bk").first.get_attribute("class"))
    check("ボディケアの後に片付けの15分が出る", pg.locator(".clean").count() == 1)
    pg.screenshot(path=f"{SHOTS}/a06_day2.png", full_page=True)

    # 5. 確定済みの予約を取り消す（LINEで知らせる）
    pg.locator(".bk.mo").click()
    pg.get_by_role("button", name="取り消す").click()
    pg.fill("#cm", "急用のためお休みします")
    pg.screenshot(path=f"{SHOTS}/a07_cancel.png")
    pg.locator("#cy").click()
    expect(pg.locator(".bk")).to_have_count(1)
    check("取り消すと患者さんの予約からも消える", len(api("pat", "init")["bookings"]) == 0)

    # 6. 確認待ちタブ（もう一度仮予約を入れてもらう）
    api("pat", "book", menuId=mid["施術（保険）"], startsAt="2026-10-22T17:00:00+09:00")
    pg.get_by_role("button", name="確認待ち").click()
    expect(pg.locator(".pend")).to_have_count(1)
    pg.screenshot(path=f"{SHOTS}/a08_pending.png")
    pg.get_by_role("button", name="確定", exact=True).click()
    expect(pg.get_by_text("確認待ちの予約はありません。")).to_be_visible()

    # 7. 休み：10/26 を一日休み、10/29 は 18:00〜20:00
    pg.get_by_role("button", name="休み", exact=True).click()
    expect(pg.locator(".cal-title")).to_have_text("2026年10月")
    pg.locator('[data-off="2026-10-26"]').click()
    pg.fill("#on", "研修")
    pg.get_by_role("button", name="休みにする").click()
    expect(pg.locator(".offl .oi")).to_have_count(1)
    pg.locator('[data-off="2026-10-29"]').click()
    pg.get_by_role("radio", name="時間だけ休み").click()
    pg.select_option("#of", "18:00")
    pg.get_by_role("button", name="休みにする").click()
    expect(pg.locator(".offl .oi")).to_have_count(2)
    check("一日休みの日は「休」", "closed" in pg.locator('[data-off="2026-10-26"]').get_attribute("class"))
    check("時間休みの日は「一部」", "part" in pg.locator('[data-off="2026-10-29"]').get_attribute("class"))
    m = api("pat", "month", menuId=mid["施術（保険）"], month="2026-10")
    st = {d["date"]: d["state"] for d in m["days"]}
    check("患者さんのカレンダーでも休み", st.get("2026-10-26") == "off")
    pg.screenshot(path=f"{SHOTS}/a09_off.png", full_page=True)
    pg.locator(".offl .oi").first.get_by_role("button", name="外す").click()
    pg.locator("#cfy").click()
    expect(pg.locator(".offl .oi")).to_have_count(1)

    # 8. お客さま：通院中にする・メモ
    pg.get_by_role("button", name="お客さま").click()
    expect(pg.locator(".cust")).to_have_count(2)
    pg.screenshot(path=f"{SHOTS}/a10_cust.png")
    pg.locator(".cust", has_text="テスト 一郎").click()
    expect(pg.locator("#tr")).to_be_visible()
    pg.screenshot(path=f"{SHOTS}/a11_custsheet.png")
    pg.locator("#tr").check(); pg.fill("#tm", "腰が多い")
    pg.locator("#ts").click()
    expect(pg.locator("#toast")).to_have_text("保存しました")
    r = api("pat", "book", menuId=mid["施術（保険）"], startsAt="2026-11-02T17:00:00+09:00")
    check("通院中にすると予約がすぐ確定", r.get("booking", {}).get("status") == "confirmed")

    # 9. LINEで連絡
    pg.locator(".cust", has_text="テスト 一郎").click()
    pg.get_by_role("button", name="LINEで連絡").click()
    pg.get_by_role("button", name="お礼").click()
    check("ひな形が入る", "ありがとうございました" in pg.locator("#mt").input_value())
    pg.screenshot(path=f"{SHOTS}/a12_msg.png")
    pg.locator("#ms").click()
    expect(pg.locator("#toast")).to_contain_text("送")  # テストではLINEが偽物なので送信失敗の文でもよい

    # 10. 文字を大きく
    pg.locator("#mn").click() if pg.locator("#mn").count() else None
    pg.get_by_role("button", name="予約表").click()
    pg.get_by_role("button", name="特大").click()
    check("文字の大きさが変わる", pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text-zoom').trim()") == "1.4")
    pg.screenshot(path=f"{SHOTS}/a13_big.png")
    check("横にはみ出さない", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))

    # 10b. テストで入れた人を消す（予約の履歴ごと）
    pg.get_by_role("button", name="標準").click()
    pg.get_by_role("button", name="お客さま").click()
    expect(pg.locator(".cust")).to_have_count(2)
    pg.locator(".cust", has_text="電話 花子").click()
    pg.locator("#tdel").click()
    pg.screenshot(path=f"{SHOTS}/a14b_delete.png")
    pg.locator("#cfy").click()
    expect(pg.locator("#toast")).to_contain_text("消しました")
    expect(pg.locator(".cust")).to_have_count(1)
    check("人を消すと名簿から消える", pg.locator(".cust", has_text="電話 花子").count() == 0)
    d = api("hiro", "admin_day", date="2026-10-19")
    check("その人の予約も予約表から消える", all(x["customer"]["name"] != "電話 花子" for x in d["bookings"]))

    # 11. スタッフを招待する → 相手が開くと参加 → 選んだことだけできる
    subprocess.run(DB + ["delete from staff_members;"], check=True)
    pg.get_by_role("button", name="スタッフ").click()
    expect(pg.get_by_text("まだ誰もいません。")).to_be_visible()
    pg.get_by_role("button", name="＋ 人を追加する（招待リンクを作る）").click()
    pg.fill("#sl", "受付さん")
    pg.screenshot(path=f"{SHOTS}/a15_staffadd.png")
    pg.locator("#ss").click()
    url = pg.locator("#iu").input_value()
    check("招待リンクができる", "/admin/?join=" in url)
    pg.screenshot(path=f"{SHOTS}/a16_invite.png")
    code_ = url.split("join=")[1]
    pg.locator("#iok").click()
    expect(pg.locator(".cust .pill")).to_have_text("招待中")

    api("hiro", "admin_book", name="確認 用", menuId=mid["施術（保険）"], startsAt="2026-10-19T18:00:00+09:00")
    ps = new_ctx().new_page()  # 別の人の LINE（保存場所を分ける）
    ps.on("pageerror", lambda e: errors.append(str(e)))
    ps.add_init_script("localStorage.setItem('u','staff')")
    ps.goto(BASE + "/admin/?date=2026-10-19&join=" + code_)
    expect(ps.locator("#toast")).to_contain_text("参加しました")
    tabs = ps.locator(".tabs button").all_inner_texts()
    check("スタッフのタブは 予約表・確認待ち・休み だけ", [t.strip() for t in tabs] == ["予約表", "確認待ち", "休み"])
    check("スタッフには＋（手で予約）が出ない", ps.locator("#fab").count() == 0)
    check("上に呼び名が出る", "受付さん" in ps.locator(".bar-top").inner_text())
    ps.locator('[data-free="19:00"]').click()
    check("空き枠では×だけ選べる", ps.get_by_role("button", name="ここに予約を入れる").count() == 0)
    ps.get_by_role("button", name="19:00〜19:15 を×にする").click()
    expect(ps.locator(".xblk")).to_have_count(1)
    ps.locator(".bk").first.click()
    check("予約票に確定・取消のボタンが出ない", ps.get_by_role("button", name="取り消す").count() == 0 and ps.get_by_text("HIROさんにお願いしてください").count() == 1)
    ps.screenshot(path=f"{SHOTS}/a17_staffslip.png")

    pg.get_by_role("button", name="スタッフ").click()
    expect(pg.locator(".cust .pill")).to_have_text("参加済み")
    pg.locator(".cust").click()
    pg.locator('[data-perm="customers"]').check()
    pg.screenshot(path=f"{SHOTS}/a18_staffedit.png")
    pg.locator("#ss").click()
    expect(pg.locator("#toast")).to_have_text("保存しました")
    ps.reload()
    expect(ps.locator(".tabs button")).to_have_count(4)
    check("お客さまを許すとタブが増える", "お客さま" in ps.locator(".tabs").inner_text())
    pg.locator(".cust").click()
    pg.locator("#sdel").click(); pg.locator("#cfy").click()
    expect(pg.get_by_text("まだ誰もいません。")).to_be_visible()
    ps.reload()
    expect(ps.get_by_text("このLINEでは管理画面を開けません。").first).to_be_visible()
    check("外すと開けなくなる", True)

    # 12. HIROさん以外は開けない
    pg2 = new_ctx().new_page()
    pg2.add_init_script("localStorage.setItem('u','pat')")
    pg2.goto(BASE + "/admin/")
    expect(pg2.get_by_text("このLINEでは管理画面を開けません。").first).to_be_visible()
    pg2.screenshot(path=f"{SHOTS}/a14_notadmin.png")

    check("画面のエラーなし", not errors)
    if errors: print(errors)
    b.close()

subprocess.run(DB + ["update app_settings set value='' where key='admin_line_user_ids';"], check=True)
ng = [r for r in results if r[0] == "NG"]
print(f"\n{len(results) - len(ng)}/{len(results)} OK")
sys.exit(1 if ng else 0)
