# 予約ページを本物のブラウザで押して確かめる（LINE だけ偽物に差し替え）
import json, sys, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "."

FAKE_LIFF = """
window.liff = {
  init: () => Promise.resolve(),
  isLoggedIn: () => true,
  isInClient: () => false,
  getIDToken: () => 'tok-' + (localStorage.getItem('u') || 'p1'),
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

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="ja-JP")
    ctx.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
    ctx.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
    FONT = "".join(f"@font-face{{font-family:'Zen Maru Gothic';font-weight:{w};src:url(http://127.0.0.1:8765/__font/{w})}}" for w in (500,700,900))
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body=FONT, content_type="text/css"))
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    # 1. 初めての人：ホーム → 登録 → ボディケア → メニュー → 日時 → 症状 → 確認 → 完了
    pg.goto(BASE + "/")
    expect(pg.get_by_text("いまお取りしているご予約はありません")).to_be_visible()
    pg.screenshot(path=f"{SHOTS}/01_home.png")
    pg.get_by_role("button", name="新しく予約する").click()
    expect(pg.get_by_role("heading", name="お名前とご連絡先")).to_be_visible()
    pg.fill("#pn", "テスト 花子"); pg.fill("#pk", "てすと はなこ"); pg.fill("#pp", "090-1111-2222")
    pg.screenshot(path=f"{SHOTS}/02_profile.png")
    pg.get_by_role("button", name="登録して進む").click()
    expect(pg.get_by_role("heading", name="どちらのご予約ですか？")).to_be_visible()
    pg.screenshot(path=f"{SHOTS}/03_business.png")
    pg.locator("[data-biz=bodycare]").click()
    expect(pg.get_by_role("heading", name="メニューをお選びください")).to_be_visible()
    check("ボディケアのメニューが4つ", pg.locator("[data-menu]").count() == 4)
    pg.screenshot(path=f"{SHOTS}/04_menu.png")
    pg.get_by_role("button", name="眠れるボディケアコース").click()
    expect(pg.get_by_role("heading", name="ご希望の日をお選びください")).to_be_visible()
    expect(pg.locator(".cal-title")).to_have_text("2026年10月")
    check("カレンダー：日曜は休、16日（今日）は受付外", pg.locator('.cal-d.off', has_text="18").count() == 1 and pg.locator('button[data-day="2026-10-16"]').count() == 0)
    pg.locator('[data-day="2026-10-19"]').click()
    mon = pg.locator("#slots")
    expect(mon.locator(".time").first).to_be_visible()
    times = mon.locator(".time").all_inner_texts()
    check("月曜の60分は17:00〜19:00の9つ", times[0] == "17:00" and times[-1] == "19:00" and len(times) == 9)
    pg.screenshot(path=f"{SHOTS}/05_time.png", full_page=True)
    mon.get_by_role("button", name="17:00").click()
    expect(pg.get_by_role("heading", name="気になるところはどこですか？")).to_be_visible()
    pg.get_by_role("button", name="腰", exact=True).click()
    pg.get_by_role("button", name="肩", exact=True).click()
    pg.screenshot(path=f"{SHOTS}/06_symptom.png")
    pg.get_by_role("button", name="確認へ進む").click()
    expect(pg.get_by_text("初めての方は「仮予約」になります")).to_be_visible()
    check("確認画面に料金8,000円", pg.get_by_text("8,000円").is_visible())
    check("ボディケアには保険のご案内を出さない", pg.locator(".notice").count() == 0)
    pg.screenshot(path=f"{SHOTS}/07_confirm.png")
    # 確認画面から名前を変えられる
    pg.get_by_role("button", name="変更する").click()
    expect(pg.get_by_role("button", name="保存する")).to_be_visible()
    pg.fill("#pn", "本番 花子")
    pg.get_by_role("button", name="保存する").click()
    expect(pg.get_by_role("heading", name="この内容で予約しますか？")).to_be_visible()
    check("確認画面で名前を変えられる", pg.get_by_text("本番 花子 様").is_visible())
    pg.get_by_role("button", name="予約する").click()
    expect(pg.get_by_role("heading", name="仮予約を受け付けました")).to_be_visible()
    pg.screenshot(path=f"{SHOTS}/08_done.png")
    pg.get_by_role("button", name="ご予約の状況へ").click()
    check("ホームに確認待ちの予約が1件", pg.locator(".bk").count() == 1 and pg.locator(".badge.pending").count() == 1)
    pg.screenshot(path=f"{SHOTS}/09_home_booked.png")

    # 2. 接骨院はメニューが1つなので日時へ直行。17:00〜18:15 は埋まっていて最初は18:15
    pg.get_by_role("button", name="新しく予約する").click()
    pg.locator("[data-biz=mominoki]").click()
    expect(pg.get_by_role("heading", name="ご希望の日をお選びください")).to_be_visible()
    pg.locator('[data-day="2026-10-19"]').click()
    expect(pg.locator("#slots .time").first).to_be_visible()
    first = pg.locator("#slots .time").first.inner_text()
    check("接骨院の月曜の最初の枠は18:15（ボディケア＋片付けの後）", first == "18:15")
    check("接骨院の日時の画面に保険のご案内", pg.locator(".notice", has_text="ケガ以外の症状は保険外となりますので").is_visible())

    # 3. 選んでいるあいだに別の人が同じ時間を取った → 案内して時間を選び直し
    api("p2", "profile", name="別の人", nameKana="ベツノヒト", phone="0565111111")
    slot = pg.locator("#slots").get_by_role("button", name="18:15")
    at = slot.get_attribute("data-at")
    slot.click()
    pg.get_by_role("button", name="確認へ進む").click()
    menu_id = api("p2", "init")["menus"][0]["id"]
    r = api("p2", "book", menuId=menu_id, startsAt=at)
    check("別の人が先に18:15を取った", r.get("booking", {}).get("time") == "18:15")
    pg.get_by_role("button", name="予約する").click()
    expect(pg.locator("#toast")).to_contain_text("たった今埋まってしまいました")
    expect(pg.get_by_role("heading", name="ご希望の日をお選びください")).to_be_visible()
    expect(pg.locator("#slots .time").first).to_be_visible()
    first2 = pg.locator("#slots .time").first.inner_text()
    check("選び直しの一覧から18:15が消えている", first2 == "18:30")

    # 4. 取り消し
    pg.get_by_role("button", name="← もどる").click()
    pg.get_by_role("button", name="← もどる").click()
    pg.once("dialog", lambda d: d.accept())
    pg.get_by_role("button", name="このご予約を取り消す").click()
    expect(pg.locator("#toast")).to_contain_text("取り消しました")
    check("取り消し後は予約0件", pg.locator(".bk").count() == 0)

    # 5. 月をめくれる（今月より前には戻れない）
    pg.get_by_role("button", name="新しく予約する").click()
    pg.locator("[data-biz=mominoki]").click()
    expect(pg.locator(".cal-title")).to_have_text("2026年10月")
    check("今月より前には戻れない", pg.locator("#pm").is_disabled())
    pg.locator("#nm").click()
    expect(pg.locator(".cal-title")).to_have_text("2026年11月")
    pg.screenshot(path=f"{SHOTS}/05b_month.png", full_page=True)
    check("11月は月・木・土に空き", pg.locator('button[data-day="2026-11-02"]').count() == 1 and pg.locator('button[data-day="2026-11-03"]').count() == 0)

    # 6. ブロックされた人
    api("vendor", "init")
    import subprocess
    subprocess.run(["psql", "-h", "/var/tmp/lp_pgtest", "-p", "5544", "-U", "postgres", "-q", "-c",
                    "update customers set is_blocked=true where line_user_id='Uvendor'"], check=True)
    pg.evaluate("localStorage.setItem('u','vendor')")
    pg.goto(BASE + "/")
    expect(pg.get_by_text("現在このアカウントではご予約を承れません").first).to_be_visible()
    check("ブロックした人には予約ボタンが出ない", pg.get_by_role("button", name="新しく予約する").count() == 0)

    check("ページのエラーなし", not errors)
    if errors: print(errors)
    b.close()

ng = [n for s, n in results if s == "NG"]
print(f"\n{len(results) - len(ng)}/{len(results)} OK")
sys.exit(1 if ng else 0)
