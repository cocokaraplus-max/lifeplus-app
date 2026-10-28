# ホームページの変えられる所・求人（lifeplus-site-cms-v1）を本物のブラウザで押して確かめる（LINE だけ偽物）
#   deno run -A tests/e2e_server.ts &  →  python3 tests/e2e_cms_test.py <写真の置き場>
import json, os, sys, urllib.request, subprocess, base64
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8765"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else "."
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

subprocess.run(DB + ["delete from site_news; delete from site_jobs; delete from contact_messages; delete from staff_members;"
                     "update app_settings set value='Uhiro' where key='admin_line_user_ids';"
                     "update site_content set value='{}'::jsonb where key='photos';"
                     "insert into staff_members (label, perms, line_user_id) values ('受付さん', '{bookings}', 'Uuke');"], check=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    def new_ctx(w=390, h=844):
        c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, locale="ja-JP")
        c.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
        c.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
        c.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
        c.route("https://www.google.com/**", lambda r: r.fulfill(body="", content_type="text/html"))
        c.route("https://img.test/**", lambda r: r.fulfill(path="docs/img/ph/care.jpg", content_type="image/jpeg"))
        return c
    ctx = new_ctx()
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    # 1. 管理画面：HPのタブ（HIROさん）
    pg.goto(BASE + "/admin/")
    pg.locator('[data-tab="site"]').click()
    expect(pg.locator(".day h1")).to_contain_text("ホームページ")
    check("HPのタブが出る", True)
    # お知らせを書く
    pg.locator("#nnew").click()
    pg.fill("#nd", "2026-10-10"); pg.fill("#nt", "年末年始のお休みについて"); pg.fill("#nx", "12月29日〜1月3日はお休みです。")
    pg.locator("#ngo").click()
    expect(pg.locator(".site-item")).to_have_count(1)
    check("お知らせが一覧に出る（出ている）", "出ている" in pg.locator(".site-item").first.inner_text())
    pg.locator("#nnew").click()
    pg.fill("#nd", "2026-10-12"); pg.select_option("#nb", "day"); pg.fill("#nt", "デイの見学会"); pg.locator("#ngo").click()
    expect(pg.locator(".site-item")).to_have_count(2)
    # 求人を作る（デイ）→ 接骨院の求人も
    pg.locator('[data-ss="jobs"]').click()
    pg.locator("#jnew").click()
    pg.select_option("#jb", "day"); pg.fill("#jt", "介護職員"); pg.fill("#je", "パート"); pg.fill("#js", "週2日からOK"); pg.fill("#jy", "時給1,100円〜")
    pg.locator("#jgo").click()
    expect(pg.locator(".site-item")).to_have_count(1)
    pg.locator("#jnew").click()
    pg.select_option("#jb", "sekkotsu"); pg.fill("#jt", "柔道整復師"); pg.fill("#je", "正社員"); pg.locator("#jgo").click()
    expect(pg.locator(".site-item")).to_have_count(2)
    check("求人が2件（募集中）", pg.locator(".si-st.on").count() == 2)
    # どの事業の募集かを変える
    pg.locator(".site-item").nth(1).click()
    check("求人を開くと事業が入っている", pg.locator("#jb").input_value() == "sekkotsu")
    pg.select_option("#jb", "bodycare"); pg.locator("#jgo").click()
    expect(pg.locator(".site-item").nth(1)).to_contain_text("ボディケア")
    check("事業を変えられる", True)
    # デイの時間
    pg.locator('[data-ss="day"]').click()
    pg.fill("#dha", "9:15〜12:15"); pg.locator("#dhgo").click()
    expect(pg.locator("#toast")).to_contain_text("保存しました")
    # ボディケアの料金・おすすめ
    pg.locator('[data-ss="menus"]').click()
    names = [pg.locator(f'[data-mn="{i}"]').input_value() for i in range(pg.locator("[data-mn]").count())]
    check("ボディケアのメニューが並ぶ（おすすめが先頭）", names[0] == "慢性症状アプローチ" and len(names) == 4)
    i = names.index("ちょっとお試しコース")
    pg.fill(f'[data-mp="{i}"]', "4500"); pg.locator("#mgo").click()
    expect(pg.locator("#toast")).to_contain_text("保存しました")
    # 写真
    pg.locator('[data-ss="photos"]').click()
    check("写真の場所が12か所", pg.locator(".photo-slot").count() == 12)
    pg.locator('[data-pslot="top_hero"]').set_input_files("docs/img/ph/care.jpg")
    expect(pg.locator("[data-preset=top_hero]")).to_have_count(1)
    check("写真を入れ替えると「差し替え中」", "差し替え中" in pg.locator(".photo-slot").first.inner_text())
    pg.screenshot(path=f"{SHOTS}/cms_admin_photos.png", full_page=True)
    pg.locator('[data-ss="jobs"]').click(); pg.screenshot(path=f"{SHOTS}/cms_admin_jobs.png", full_page=True)

    # 2. 権限：受付さん（bookings だけ）には HP のタブが出ない
    ctx2 = new_ctx(); p2 = ctx2.new_page()
    p2.add_init_script("localStorage.setItem('u','uke')")
    p2.goto(BASE + "/admin/")
    expect(p2.locator('[data-tab="day"]')).to_have_count(1)
    check("site の権限がない人には HP のタブが出ない", p2.locator('[data-tab="site"]').count() == 0)
    ctx2.close()

    # 3. ホームページに出る
    pg.goto(BASE + "/")
    expect(pg.locator(".news-band")).to_be_visible()
    check("トップにお知らせ2件（新しい順）", pg.locator(".news-band li").count() == 2 and "デイの見学会" in pg.locator(".news-band li").first.inner_text())
    check("トップの写真が差し替わる", "img.test" in (pg.locator('img[data-photo="top_hero"]').get_attribute("src") or ""))
    check("採用の帯に件数", "2 件" in pg.locator("[data-job-count]").inner_text())
    pg.screenshot(path=f"{SHOTS}/cms_top_sp.png", full_page=False)
    pg.goto(BASE + "/dayservice/")
    expect(pg.locator(".news-band")).to_be_visible()
    check("デイのページ：お知らせ（すべて＋デイ）", pg.locator(".news-band li").count() == 2)
    check("デイの利用時間が変わる", pg.locator('[data-cms="day_am"]').inner_text() == "午前 9:15〜12:15")
    pg.goto(BASE + "/sekkotsu/")
    expect(pg.locator(".news-band")).to_be_visible()
    check("接骨院のページ：デイのお知らせは出ない", pg.locator(".news-band li").count() == 1)
    cells = pg.locator("[data-rsv-cell]")
    check("接骨院の受付時間は設定から（帯のマス）", cells.count() >= 1 and ":" in cells.first.inner_text())
    pg.goto(BASE + "/bodycare/")
    expect(pg.locator("[data-menus] .menu-item").first).to_contain_text("慢性症状アプローチ")
    txt = pg.locator("[data-menus]").inner_text()
    check("ボディケアの料金が変わる（4,500）", "¥4,500" in txt)
    check("ボディケアのおすすめが先頭（main）", "main" in (pg.locator("[data-menus] .menu-item").first.get_attribute("class") or ""))

    # 4. 採用ページ：絞り込み・応募
    pg.goto(BASE + "/recruit/")
    expect(pg.locator(".job")).to_have_count(2)
    check("採用ページに求人2件", True)
    check("求人がない時の文は隠れる", pg.locator("[data-jobs-none]").is_hidden())
    pg.locator('[data-jf="bodycare"]').click()
    check("事業で絞り込める", pg.locator(".job:visible").count() == 1)
    pg.locator('[data-jf=""]').click()
    pg.screenshot(path=f"{SHOTS}/cms_recruit_sp.png", full_page=True)
    pg.locator(".job").first.locator("[data-apply]").click()
    check("応募ボタンで求人が選ばれる", pg.locator("select[name=jobId]").input_value() != "")
    pg.wait_for_timeout(3300)
    pg.fill("#contact input[name=name]", "応募 花子"); pg.fill("#contact input[name=phone]", "090-1234-5678")
    pg.fill("#contact textarea[name=body]", "介護の経験3年です")
    pg.locator("#contact button[type=submit]").click()
    expect(pg.locator("#contact .msg")).to_contain_text("送りました")
    r = subprocess.run(DB[:-2] + ["-At", "-c", "select business||'|'||kind from contact_messages"], capture_output=True, text=True).stdout.strip()
    check("応募が表に残る（デイ／介護職員）", "recruit|デイサービス／介護職員（パート）" in r)

    # 5. アプリ開発のお問い合わせ（メールは画面で組み立て）
    pg.goto(BASE + "/apps/")
    check("会社概要のメールは画面で組み立てる", pg.locator("[data-mail]").first.inner_text() == "hiro@lifeplusllc.com")
    raw = urllib.request.urlopen(BASE + "/apps/").read().decode()
    check("アプリ開発のページ（元の文）にメールアドレスがそのまま書かれていない", "hiro@lifeplusllc.com" not in raw)
    pg.wait_for_timeout(3300)
    pg.select_option("#contact select[name=kind]", "導入の相談")
    pg.fill("#contact input[name=name]", "施設 太郎"); pg.fill("#contact input[name=email]", "a@example.jp")
    pg.locator("#contact button[type=submit]").click()
    expect(pg.locator("#contact .msg")).to_contain_text("送りました")
    check("アプリ開発のお問い合わせが送れる", True)

    # 6. パソコンの幅でメニューがはみ出さない
    ctx3 = new_ctx(1280, 900); p3 = ctx3.new_page()
    for path in ["/", "/recruit/", "/apps/", "/dayservice/", "/sekkotsu/", "/bodycare/", "/privacy/"]:
        p3.goto(BASE + path)
        ow = p3.evaluate("document.documentElement.scrollWidth > innerWidth")
        nav_ok = p3.evaluate("(() => { const n = document.querySelector('.site-top .wrap'); return n.scrollWidth <= n.clientWidth + 1; })()")
        check(f"パソコン {path}：横にはみ出さない", not ow and nav_ok)
    p3.goto(BASE + "/"); p3.screenshot(path=f"{SHOTS}/cms_top_pc.png", full_page=True)
    p3.goto(BASE + "/recruit/"); p3.screenshot(path=f"{SHOTS}/cms_recruit_pc.png", full_page=True)
    ctx3.close()
    for path in ["/", "/recruit/", "/apps/"]:
        pg.goto(BASE + path)
        check(f"スマホ {path}：横にはみ出さない", not pg.evaluate("document.documentElement.scrollWidth > innerWidth"))
    check("画面のエラーなし", not errors)
    if errors: print(errors)
    b.close()

ng = [r for r in results if r[0] == "NG"]
print(f"\n{len(results) - len(ng)}/{len(results)} 通りました")
sys.exit(1 if ng else 0)
