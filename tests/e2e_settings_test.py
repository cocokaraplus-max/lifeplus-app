# 設定画面（受付時間の種類・決まりごと）と、手入力だけの時間を本物のブラウザで押して確かめる  marker: lifeplus-settings-v1
#   使い方：tests/e2e_server.ts を動かしてから  python3 tests/e2e_settings_test.py <写真の置き場所>
#   ★終わったら、テスト用DBの受付時間・決まりごとを元（月・木 17〜20時、土 9〜12時、締め切り60分）に戻す
import json, urllib.request, subprocess, sys
from playwright.sync_api import sync_playwright
BASE="http://127.0.0.1:8765"; SH=sys.argv[1]
FAKE_LIFF="""window.liff={init:()=>Promise.resolve(),isLoggedIn:()=>true,isInClient:()=>false,getIDToken:()=>'tok-'+(localStorage.getItem('u')||'hiro'),login:()=>{},logout:()=>{},closeWindow:()=>{}};"""
CONFIG="window.LP_CONFIG={LIFF_ID:'test',API_URL:'/api'};"
DB=["psql","-h","127.0.0.1","-p","5544","-U","postgres","-q","-c"]
def api(u,a,**kw):
    r=urllib.request.Request(BASE+"/api",method="POST",data=json.dumps({"action":a,"idToken":"tok-"+u,**kw}).encode(),headers={"content-type":"application/json"})
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return json.load(e)
for q in ["delete from bookings","delete from customers","delete from closures","update app_settings set value='Uhiro' where key='admin_line_user_ids'",
          "delete from business_hours","insert into business_hours (weekday,kind,open_time,close_time) values (1,'public','17:00','20:00'),(4,'public','17:00','20:00'),(6,'public','09:00','12:00')"]:
    subprocess.run(DB+[q],check=True)
res=[]
def check(n,c): res.append(c); print(("OK " if c else "NG ")+n)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":430,"height":900})
    ctx.route("https://static.line-scdn.net/**", lambda r: r.fulfill(body=FAKE_LIFF, content_type="text/javascript"))
    ctx.route("**/config.js*", lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    pg=ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); 
    pg.goto(BASE+"/admin/?date=2026-10-19"); pg.wait_for_selector(".tl")
    check("設定タブが出る（HIROさん）", pg.locator("[data-tab=set]").count()==1)
    pg.click("[data-tab=set]"); pg.wait_for_selector(".wdrow")
    check("曜日が7つ並ぶ", pg.locator(".wdrow").count()==7)
    check("月曜は 17:00〜20:00（見せる）", pg.locator(".wdrow").nth(0).locator(".hrow.public").count()==1)
    # 月曜に手入力だけを足す（20:00〜21:00 が既定で入る）
    pg.locator(".wdrow").nth(0).locator("[data-hadd]").click()
    r=pg.locator(".wdrow").nth(0).locator(".hrow").nth(1)
    check("足した行は手入力だけ・20:00〜21:00", r.get_attribute("class")=="hrow staff" and r.locator("[data-ho]").input_value()=="20:00" and r.locator("[data-hc]").input_value()=="21:00")
    # 水曜に手入力だけ 10:00〜12:00
    pg.locator(".wdrow").nth(2).locator("[data-hadd]").click()
    w=pg.locator(".wdrow").nth(2).locator(".hrow").nth(0)
    w.locator("[data-hk]").select_option("staff")
    w=pg.locator(".wdrow").nth(2).locator(".hrow").nth(0)
    w.locator("[data-ho]").select_option("10:00"); w.locator("[data-hc]").select_option("12:00")
    pg.fill("#sl","30")
    pg.click("#sgo"); pg.wait_for_timeout(1200)
    s=api("hiro","admin_settings")
    pg.screenshot(path=SH+"/set_saved.png", full_page=True)
    check("保存できた（5つの時間・締め切り30分）", len(s["hours"])==5 and s["leadMinutes"]==30 and any(h["weekday"]==3 and h["kind"]=="staff" and h["open"]=="10:00" for h in s["hours"]))
    # 重なりは止まる
    pg.locator(".wdrow").nth(0).locator(".hrow").nth(1).locator("[data-ho]").select_option("19:45")
    pg.click("#sgo"); pg.wait_for_timeout(600)
    check("重なると保存しない（知らせが出る）", "重なっている" in pg.inner_text("#toast"))
    pg.click("#sre"); pg.wait_for_timeout(600)
    # 予約表：月曜に手入力だけの段がうっすら出る
    pg.click("[data-tab=day]"); pg.wait_for_selector(".tl")
    check("月曜の上の説明に「手入力だけ 20:00〜21:00」", "手入力だけ 20:00〜21:00" in pg.inner_text(".sub"))
    check("手入力だけの段が4つ（20:00〜20:45）", pg.locator(".row.staff").count()==4 and pg.locator(".free.staff").count()==4)
    pg.screenshot(path=SH+"/day_staff.png")
    pg.locator(".free.staff").first.click(); pg.wait_for_timeout(300)
    check("手入力だけの枠を押すと、予約だけ（×は出ない）", pg.locator("#fb").count()==1 and pg.locator("#fx").count()==0)
    pg.click("#fb"); pg.wait_for_selector(".time")
    check("候補に「手」の印つきで 20:00 が選ばれている", pg.locator(".time.staff.on").count()==1 and pg.locator(".time.staff.on").get_attribute("data-t")=="20:00")
    pg.check("#bany"); pg.wait_for_timeout(700)
    check("受付時間の外も出すと「外」の候補（06:00〜）が出る", pg.locator(".time.other").count()>0 and pg.locator(".time").first.get_attribute("data-t")=="06:00")
    pg.screenshot(path=SH+"/book_any.png")
    pg.locator('.time[data-t="20:00"]').click()
    pg.fill("#bn","知り合い 一"); pg.click("#bgo"); pg.wait_for_timeout(800)
    d=api("hiro","admin_day",date="2026-10-19")
    check("手入力だけの時間に予約が入った", any(x["time"]=="20:00" for x in d["bookings"]))
    # 水曜（手入力だけの日）
    pg.goto(BASE+"/admin/?date=2026-10-21"); pg.wait_for_selector(".tl")
    check("水曜（手入力だけの日）も予約表が出る", pg.locator(".row.staff").count()==8)
    # お客さまの予約ページには出ない
    pt=api("pat","init"); api("pat","profile",name="患者 一",nameKana="かんじゃ はじめ",phone="09011112222")
    mid=[m["id"] for m in pt["menus"] if m["name"]=="施術（保険）"][0]
    dd=api("pat","days",menuId=mid,**{"from":"2026-10-19"})
    mon=[x for x in dd["days"] if x["date"]=="2026-10-19"][0]
    check("お客さまの予約ページ：月曜は19:45まで・水曜は出ない", mon["slots"][-1]["time"]=="19:45" and not any(x["date"]=="2026-10-21" for x in dd["days"]))
    # 招待した人には設定タブが出ない
    subprocess.run(DB+["insert into staff_members (label,line_user_id,perms) values ('受付','Ustaff',array['bookings'])"],check=True)
    pg.evaluate("localStorage.setItem('u','staff')"); pg.goto(BASE+"/admin/?date=2026-10-19"); pg.wait_for_selector(".tl")
    check("招待した人には設定タブが出ない", pg.locator("[data-tab=set]").count()==0)
    check("画面のエラーなし", not errs)
    if errs: print(errs)
    b.close()
for q in ["delete from staff_members","delete from bookings","delete from customers","delete from business_hours",
          "insert into business_hours (weekday,kind,open_time,close_time) values (1,'public','17:00','20:00'),(4,'public','17:00','20:00'),(6,'public','09:00','12:00')",
          "update app_settings set value='60' where key in ('lead_minutes','horizon_days')","update app_settings set value='2' where key='noshow_limit'"]:
    subprocess.run(DB+[q])
print("NG あり" if not all(res) else "ぜんぶOK", sum(res), "/", len(res))
