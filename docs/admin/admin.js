/* LIFE PLUS 予約管理（HIROさんと、招待した人）  marker: lifeplus-admin-ui-v1 / staff-ui-v1
   タブ：今日（15分刻みの予約表・×で止める）／確認待ち／休み／お客さま
   操作はすべて関所（API_URL の admin_*）を通す。HIROさん以外の LINE では関所が断る。 */
(function () {
  "use strict";
  var CFG = window.LP_CONFIG || {};
  var $app = document.getElementById("app");
  var $toast = document.getElementById("toast");
  var $sheet = document.getElementById("sheet");
  var $sb = document.getElementById("sheet-body");

  var A = {
    init: null,        // admin_init の結果
    tab: "day",
    date: null,        // 予約表の日（YYYY-MM-DD）
    day: null,         // admin_day の結果
    offMonth: null,    // 休みカレンダーの月（YYYY-MM）
    closures: [],      // これからの休み
    q: "", filter: "", // お客さまの検索
  };
  var ROW = 46;        // 15分の高さ（admin.css の --row と同じ）

  var ERR = {
    not_admin: "このLINEでは管理画面を開けません。",
    no_permission: "この操作はできない設定になっています。HIROさんに頼んでください。",
    invite_invalid: "この招待リンクは使えません。HIROさんに新しいリンクをもらってください。",
    invite_expired: "この招待リンクは期限が切れています。HIROさんに新しいリンクをもらってください。",
    invite_self: "HIROさんのLINEでは招待リンクは使えません（もう全部できます）。",
    invite_already_staff: "このLINEはすでに参加しています。",
    label_required: "呼び名を入れてください。",
    staff_not_found: "この人は見つかりませんでした。",
    booking_active: "まだ有効な予約です。先に「取り消す」をしてから消してください。",
    no_token: "LINEのログインが切れました。開き直してください。",
    token_invalid: "LINEのログインが切れました。開き直してください。",
    booking_not_pending: "この予約はもう確認済みです。",
    booking_not_found: "この予約は見つかりませんでした。",
    customer_not_found: "このお客さまは見つかりませんでした。",
    slot_not_available: "その時間はもう埋まっています。別の時間を選んでください。",
    customer_blocked: "ブロック中のお客さまです。先にブロックを外してください。",
    name_required: "お名前を入れてください。",
    phone_invalid: "電話番号は数字10〜11桁で入れてください。",
    menu_not_found: "このメニューは使えません。",
    message_required: "送る文を入れてください。",
    no_line: "このお客さまはLINEでつながっていないため送れません。",
    send_failed: "LINEへの送信に失敗しました。少しおいてもう一度お試しください。",
    bad_request: "うまく送れませんでした。入力を確かめてください。",
    server_error: "うまく送れませんでした。少しおいてお試しください。",
    network: "通信がうまくいきませんでした。電波の良いところでもう一度お試しください。",
    // lifeplus-settings-v1
    hours_invalid: "時間の入れ方がおかしいところがあります（15分きざみ・終わりは始まりより後）。",
    hours_overlap: "同じ曜日で重なっている時間があります。重ならないようにしてください。",
    settings_invalid: "決まりごとの数字がおかしいところがあります。",
  };
  var WD = ["日", "月", "火", "水", "木", "金", "土"];
  var STATUS = { pending: "確認待ち", confirmed: "確定", done: "来院済み", no_show: "無断キャンセル", late_cancel: "直前キャンセル", cancelled: "取消", rejected: "お断り" };
  var TEMPLATES = [
    ["確認", "ご予約ありがとうございます。当日お待ちしております。"],
    ["遅れ", "申し訳ありません。本日少し遅れております。もうしばらくお待ちください。"],
    ["日時変更", "申し訳ありませんが、ご予約の日時を変更していただけますでしょうか。ご都合のよい日時をこのトークでお知らせください。"],
    ["お礼", "本日はご来院ありがとうございました。またのお越しをお待ちしております。"],
  ];

  // ---------- 小道具 ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function on(sel, fn, root) { $$(sel, root).forEach(function (el) { el.onclick = function (ev) { fn(el, ev); }; }); }
  function toMin(t) { var p = String(t).split(":"); return Number(p[0]) * 60 + Number(p[1]); }
  function hm(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
  function ymdUTC(d) { return d.toISOString().slice(0, 10); }
  function addDays(ymd, n) { var d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymdUTC(d); }
  function wdOf(ymd) { return new Date(ymd + "T00:00:00Z").getUTCDay(); }
  function mdj(ymd) { var p = ymd.split("-"); return Number(p[1]) + "月" + Number(p[2]) + "日"; }
  function mds(ymd) { var p = ymd.split("-"); return Number(p[1]) + "/" + Number(p[2]); }
  function dayText(ymd) { return mdj(ymd) + "（" + WD[wdOf(ymd)] + "）"; }
  function yen(n) { return n == null ? "保険診療" : Number(n).toLocaleString("ja-JP") + "円"; }
  function telHref(p) { return "tel:" + String(p || "").replace(/[^0-9+]/g, ""); }
  function telText(p) {
    var d = String(p || "").replace(/[^0-9]/g, "");
    if (d.length === 11) return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7);
    if (d.length === 10) return d.slice(0, 2) === "03" || d.slice(0, 2) === "06" ? d.slice(0, 2) + "-" + d.slice(2, 6) + "-" + d.slice(6) : d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6);
    return p || "";
  }
  // lifeplus-hours-kind-v1: hoursOf＝お客さまに見せる受付時間、staffHoursOf＝手入力だけの時間
  function hoursOf(ymd) {
    var w = wdOf(ymd) === 0 ? 7 : wdOf(ymd);
    return (A.init.hours || []).filter(function (h) { return h.weekday === w && (h.kind || "public") === "public"; });
  }
  function staffHoursOf(ymd) {
    var w = wdOf(ymd) === 0 ? 7 : wdOf(ymd);
    return (A.init.hours || []).filter(function (h) { return h.weekday === w && h.kind === "staff"; });
  }
  // できること（HIROさんは全部）
  function can(p) { var me = A.init && A.init.me; return !!me && (me.owner || me.perms.indexOf(p) >= 0); }
  function owner() { return !!(A.init && A.init.me && A.init.me.owner); }
  var PERM_LABELS = [
    ["closures", "休み・×の設定", "休み"],
    ["bookings", "予約の確定・取消・来院の記録・手で予約", "予約"],
    ["customers", "お客さまの名簿・メモ・LINE連絡", "お客さま"],
    ["notify", "予約・キャンセルのLINE通知を受け取る", "通知"],
  ];
  function bizClass(id) { return id === "mominoki" ? "mo" : "bc"; }
  function bizName(id) { var b = (A.init.businesses || []).filter(function (x) { return x.id === id; })[0]; return b ? b.name : ""; }
  function isPast(b) { return Date.parse(b.startsAt) <= Date.now(); }
  function toast(msg) {
    $toast.textContent = msg; $toast.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { $toast.hidden = true; }, 4500);
  }

  // ---------- 関所 ----------
  function api(action, payload) {
    var body = Object.assign({ action: action, idToken: liff.getIDToken() }, payload || {});
    return fetch(CFG.API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return { error: "server_error" }; }).then(function (j) {
          if (r.ok) return j;
          var e = new Error(j.error || "server_error"); e.code = j.error || "server_error"; throw e;
        });
      }, function () { var e = new Error("network"); e.code = "network"; throw e; });
  }
  function fail(e) {
    var code = (e && e.code) || "server_error";
    if (code === "no_token" || code === "token_invalid") { relogin(); return code; }
    toast(ERR[code] || ERR.server_error);
    return code;
  }
  function relogin() {
    if (liff.isInClient()) { location.reload(); return; }
    try { liff.logout(); } catch (_) { /* 何もしない */ }
    liff.login({ redirectUri: location.href });
  }
  // ボタンを押している間は二度押しできないようにする
  function busy(btn, p) {
    if (btn) btn.disabled = true;
    return p.then(function (r) { if (btn) btn.disabled = false; return r; }, function (e) { if (btn) btn.disabled = false; throw e; });
  }

  // ---------- 下から出る画面 ----------
  function openSheet(html) {
    $sb.innerHTML = html; $sheet.hidden = false;
    $(".sheet", $sheet).scrollTop = 0;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() { $sheet.hidden = true; $sb.innerHTML = ""; document.body.style.overflow = ""; }
  $$("[data-close]", $sheet).forEach(function (el) { el.onclick = closeSheet; });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$sheet.hidden) closeSheet(); });

  // ---------- 枠（上の帯・下のタブ） ----------
  var ICONS = {
    day: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
    pending: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    off: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/></svg>',
    cust: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.9 2.6 2.6 3 5.2"/></svg>',
    staff: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/><path d="M19 3v5M16.5 5.5h5"/></svg>',
    set: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  };
  function sizes() {
    return '<div class="sizes" role="group" aria-label="文字の大きさ">' +
      [[1, "標準"], [1.2, "大"], [1.4, "特大"]].map(function (s) {
        return '<button data-size="' + s[0] + '" aria-pressed="' + (zoom() === s[0]) + '">' + s[1] + "</button>";
      }).join("") + "</div>";
  }
  function frame(barInner, mainHtml, extra) {
    var pc = A.day ? A.day.pendingCount : A.init.pendingCount;
    var tabs = [["day", "予約表"], ["pending", "確認待ち"], ["off", "休み"], ["cust", "お客さま"], ["staff", "スタッフ"], ["set", "設定"]].filter(function (t) {
      return t[0] === "off" ? can("closures") : t[0] === "cust" ? can("customers") : t[0] === "staff" || t[0] === "set" ? owner() : true;
    }).map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (A.tab === t[0] ? "on" : "") + '"' + (A.tab === t[0] ? ' aria-current="page"' : "") + ">" +
        ICONS[t[0]] + t[1] + (t[0] === "pending" && pc ? '<span class="badge">' + pc + "</span>" : "") + "</button>";
    }).join("");
    $app.innerHTML =
      '<header class="bar"><div class="bar-top"><span><b>LIFE PLUS</b>　予約管理' + (owner() ? "" : "（" + esc(A.init.me.label) + "）") + "</span>" + sizes() + "</div>" + barInner + "</header>" +
      "<main>" + mainHtml + "</main>" + (extra || "") +
      '<nav class="tabs" aria-label="切り替え">' + tabs + "</nav>";
    on("[data-tab]", function (b) { go(b.getAttribute("data-tab")); });
    on("[data-size]", function (b) { setZoom(Number(b.getAttribute("data-size"))); });
  }
  function go(tab) {
    A.tab = tab; window.scrollTo(0, 0);
    if (tab === "day") return loadDay(A.date);
    if (tab === "pending") return showPending();
    if (tab === "off") return showOff();
    if (tab === "staff") return showStaff();
    if (tab === "set") return showSettings();   // lifeplus-settings-v1
    return showCustomers();
  }
  function loadingMain(title) {
    frame('<div class="day"><h1 class="title">' + esc(title) + "</h1></div>", '<div class="boot"><div class="spinner" aria-hidden="true"></div></div>');
  }

  // =============================================================
  // 予約表（その日の15分刻み）
  // =============================================================
  function loadDay(date) {
    A.date = date;
    return api("admin_day", { date: date }).then(function (d) { A.day = d; if (A.tab === "day") renderDay(); }, fail);
  }
  function refresh() { return A.tab === "day" ? loadDay(A.date) : go(A.tab); }

  function renderDay() {
    var d = A.day, bs = d.bookings, live = bs.filter(function (b) { return b.status === "pending" || b.status === "confirmed"; });
    var hours = d.hours, sh = d.staffHours || [];   // lifeplus-hours-kind-v1
    var bar =
      '<div class="day"><button class="arrow" id="dp" aria-label="前の日">‹</button>' +
      "<h1>" + mdj(d.date) + "<small>（" + esc(d.weekday) + "）</small></h1>" +
      (d.date !== A.init.today ? '<button class="today-btn" id="dt">今日</button>' : "") +
      '<button class="today-btn" id="dm" aria-label="カレンダーで日を選ぶ">月</button>' +
      '<button class="arrow" id="dn" aria-label="次の日">›</button></div>' +
      '<div class="sub">' + (hours.length || sh.length ?
        (hours.length ? hours.map(function (h) { return h.open + "〜" + h.close; }).join("・") : "受付なし") +
        (sh.length ? '<span class="sub-staff">　手入力だけ ' + sh.map(function (h) { return h.open + "〜" + h.close; }).join("・") + "</span>" : "") +
        "　予約 " + live.length + "件" : "受付のない曜日です") + "</div>";

    var h = "";
    if (d.pendingCount) {
      h += '<button class="wait" id="gowait"><span class="n">' + d.pendingCount + '</span><span class="t">確認待ちの予約があります<br>（初めての方・仮予約）</span><span class="go">見る</span></button>';
    }
    if (!hours.length && !sh.length) {
      h += '<div class="closed-day">この曜日は受付時間がありません。</div>';
      if (bs.length) h += bs.map(cardOf).join("");
    } else {
      h += '<div class="legend"><span><i class="sw mo"></i>接骨院</span><span><i class="sw bc"></i>ボディケア</span><span><i class="sw pd"></i>確認待ち</span><span><i class="sw x"></i>×（受けない）</span>' +
        (sh.length ? '<span><i class="sw st"></i>手入力だけ（お客さまには見えない）</span>' : "") + "</div>";
      h += timeline(d);
      if (can("bookings") || can("closures")) h += '<p class="note">空いている枠を押すと、' + (can("bookings") && can("closures") ? "予約を入れたり×にしたり" : can("bookings") ? "予約を入れることが" : "×にすることが") + "できます。</p>";
    }
    frame(bar, h, can("bookings") ? '<button class="fab" id="fab" aria-label="予約を手で入れる">＋</button>' : "");
    $("#dp").onclick = function () { loadDay(addDays(A.date, -1)); };
    $("#dn").onclick = function () { loadDay(addDays(A.date, 1)); };
    if ($("#dt")) $("#dt").onclick = function () { loadDay(A.init.today); };
    $("#dm").onclick = function () { monthSheet(A.date.slice(0, 7)); };
    if ($("#gowait")) $("#gowait").onclick = function () { go("pending"); };
    if ($("#fab")) $("#fab").onclick = function () { bookForm({ date: A.date }); };
    on("[data-bk]", function (el) { slip(el.getAttribute("data-bk")); });
    on("[data-free]", function (el) { freeSlot(el.getAttribute("data-free"), el.getAttribute("data-staff") === "1"); });
    on("button[data-x]", function (el) { xSheet(el.getAttribute("data-x")); });
  }

  function timeline(d) {
    var allH = d.hours.concat(d.staffHours || []);   // lifeplus-hours-kind-v1: 手入力だけの時間も表に入れる
    var open = Math.min.apply(null, allH.map(function (h) { return toMin(h.open); }));
    var close = Math.max.apply(null, allH.map(function (h) { return toMin(h.close); }));
    // 時間外の予約（手入力など）もはみ出さないように広げる
    d.bookings.forEach(function (b) { open = Math.min(open, toMin(b.time)); close = Math.max(close, toMin(b.blockUntil) || toMin(b.endTime)); });
    open = Math.floor(open / 15) * 15; close = Math.ceil(close / 15) * 15;
    var y = function (m) { return (m - open) / 15 * ROW; };
    var inHours = function (m) { return d.hours.some(function (h) { return m >= toMin(h.open) && m + 15 <= toMin(h.close); }); };
    var inStaff = function (m) { return (d.staffHours || []).some(function (h) { return m >= toMin(h.open) && m + 15 <= toMin(h.close); }); };
    var busyAt = function (m) {
      return d.bookings.some(function (b) {
        if (b.status === "cancelled" || b.status === "rejected") return false;
        var s = toMin(b.time), e = toMin(b.blockUntil) || toMin(b.endTime);
        if (e <= s) e = 24 * 60;
        return s < m + 15 && m < e;
      }) || d.closures.some(function (c) { return toMin(c.from) < m + 15 && m < toMin(c.to); });
    };
    var h = '<div class="tl" style="height:' + (y(close) + 10) + 'px">';
    for (var m = open; m < close; m += 15) {
      var st = !inHours(m) && inStaff(m);
      h += '<div class="row' + (m % 60 === 0 ? " hour" : "") + (st ? " staff" : !inHours(m) ? " outside" : "") + '" style="position:absolute;left:0;right:0;top:' + y(m) + 'px"><span class="lb">' + hm(m) + "</span>" +
        (inHours(m) && !busyAt(m) && (can("bookings") || can("closures")) ? '<button class="free" data-free="' + hm(m) + '" aria-label="' + hm(m) + ' 空き">空き</button>' : "") +
        (st && !busyAt(m) && can("bookings") ? '<button class="free staff" data-free="' + hm(m) + '" data-staff="1" aria-label="' + hm(m) + ' 手入力だけ">手入力だけ</button>' : "") + "</div>";
    }
    h += '<div class="row hour end" style="position:absolute;left:0;right:0;top:' + y(close) + 'px"><span class="lb">' + hm(close) + "</span></div>";
    d.closures.forEach(function (c) {
      var s = Math.max(open, toMin(c.from)), e = Math.min(close, toMin(c.to));
      if (e <= s) return;
      var tag = can("closures") ? "button" : "div";
      h += "<" + tag + ' class="xblk" data-x="' + esc(c.id) + '" style="display:flex;align-items:center;top:' + (y(s) + 3) + "px;height:" + (y(e) - y(s) - 6) + 'px">× ' +
        esc(c.from === "00:00" && c.to === "24:00" ? "終日お休み" : c.from + "〜" + c.to) + (c.note ? "　" + esc(c.note) : "") + "</" + tag + ">";
    });
    d.bookings.forEach(function (b) {
      var s = toMin(b.time), e = toMin(b.endTime), bu = toMin(b.blockUntil);
      if (e <= s) e = s + (b.durationMin || 15);
      var one = e - s <= 15;
      if (bu > e && (b.status === "pending" || b.status === "confirmed")) {
        h += '<div class="clean" style="top:' + y(e) + "px;height:" + (y(bu) - y(e) - 3) + 'px" aria-hidden="true">片付け・準備</div>';
      }
      var tags = "";
      if (b.status === "pending") tags += '<span class="tag">確認待ち</span>';
      if (b.status === "done") tags += '<span class="tag">来院</span>';
      if (b.status === "no_show") tags += '<span class="tag red">無断</span>';
      if (b.status === "late_cancel") tags += '<span class="tag red">直前取消</span>';
      if (b.status !== "pending" && !b.customer.isReturning) tags += '<span class="tag">初めて</span>';
      if (b.customer.noShows) tags += '<span class="tag red">無断' + b.customer.noShows + "回</span>";
      h += '<button class="bk ' + bizClass(b.businessId) + " " + esc(b.status) + (one ? " one" : "") + '" data-bk="' + esc(b.id) + '" style="top:' + (y(s) + 2) + "px;height:" + (y(e) - y(s) - 4) + 'px">' +
        '<span class="who">' + esc(b.customer.name || "（名前なし）") + tags + "</span>" +
        '<span class="what">' + esc(b.time + "〜" + b.endTime + "　" + b.menuName) + "</span></button>";
    });
    if (d.date === A.init.today) {
      var now = new Date(Date.now() + 9 * 3600000), nm = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (nm >= open && nm <= close) h += '<div class="now" style="top:' + y(nm) + 'px" aria-hidden="true"></div>';
    }
    return h + "</div>";
  }

  // 月のカレンダーで日を選ぶ  marker: admin-month-ui-v1
  function monthSheet(ym) {
    openSheet('<div class="boot" style="padding:30px 0"><div class="spinner" aria-hidden="true"></div></div>');
    api("admin_month", { month: ym }).then(function (r) {
      if ($sheet.hidden) return;
      var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
      var prev = ymdUTC(new Date(Date.UTC(y, mo - 2, 1))).slice(0, 7), next = ymdUTC(new Date(Date.UTC(y, mo, 1))).slice(0, 7);
      var h = '<div class="cal-head"><button class="cal-nav" id="mp" aria-label="前の月">‹</button>' +
        '<span class="cal-title">' + y + "年" + mo + '月</span><button class="cal-nav" id="mn" aria-label="次の月">›</button></div><div class="cal-grid">';
      WD.forEach(function (w, i) { h += '<span class="cal-wd' + (i === 0 ? " sun" : i === 6 ? " sat" : "") + '">' + w + "</span>"; });
      for (var i = 0; i < r.lead; i++) h += "<span></span>";
      r.days.forEach(function (d) {
        var cls = d.off === "all" ? "closed" : !d.open && !d.staff && !d.count ? "none" : !d.open && !d.count ? "staffday" : d.off === "part" ? "part" : "open";   // lifeplus-hours-kind-v1
        var mark = d.off === "all" ? "休" : d.count ? d.count + "件" : "";
        h += '<button class="cal-d ' + cls + (d.date === A.init.today ? " today" : "") + (d.date === A.date ? " sel" : "") + '" data-md="' + d.date + '" aria-label="' + dayText(d.date) + (mark ? " " + mark : "") + '">' +
          Number(d.date.slice(8)) + "<i>" + mark + "</i>" + (d.pending ? '<b class="dot" aria-hidden="true"></b>' : "") + "</button>";
      });
      h += '</div><div class="legend" style="margin-top:8px"><span>数字＝予約の件数</span><span><b class="dot" style="position:static;display:inline-block"></b>確認待ちあり</span><span><i class="sw x"></i>休み</span></div>' +
        '<button class="btn gray wide" id="mt">今日を開く</button>';
      $sb.innerHTML = h;
      $("#mp").onclick = function () { monthSheet(prev); };
      $("#mn").onclick = function () { monthSheet(next); };
      $("#mt").onclick = function () { closeSheet(); loadDay(A.init.today); };
      on("[data-md]", function (el) { closeSheet(); loadDay(el.getAttribute("data-md")); }, $sb);
    }, function (e) { closeSheet(); fail(e); });
  }

  // 空き枠を押したとき
  function freeSlot(t, staff) {
    var m = toMin(t), d = A.day;
    if (staff) {   // lifeplus-hours-kind-v1: 手入力だけの時間は、予約を入れるだけ（お客さまには見えないので×は要らない）
      openSheet("<h3>" + dayText(d.date) + " " + esc(t) + "</h3>" +
        '<p class="note">手入力だけの時間です。お客さまの予約ページには出ません。知り合いなどを入れるときに使います。</p>' +
        '<button class="btn mint wide" id="fb">ここに予約を入れる</button>');
      $("#fb").onclick = function () { bookForm({ date: d.date, time: t, any: false }); };
      return;
    }
    var close = Math.max.apply(null, d.hours.filter(function (h) { return toMin(h.open) <= m; }).map(function (h) { return toMin(h.close); }));
    openSheet(
      "<h3>" + dayText(d.date) + " " + esc(t) + "</h3>" +
      '<p class="note">この時間をどうしますか？</p>' +
      (can("bookings") ? '<button class="btn mint wide" id="fb">ここに予約を入れる</button>' : "") +
      (can("closures") ? '<button class="btn line wide" id="fx">' + esc(t + "〜" + hm(m + 15)) + " を×にする</button>" +
        (close > m + 15 ? '<button class="btn gray wide" id="fxe">' + esc(t + "〜" + hm(close)) + " をまとめて×にする</button>" : "") +
        '<p class="note">×にした時間は、患者さんの予約ページで選べなくなります。×を押すと外せます。</p>' : ""));
    if ($("#fb")) $("#fb").onclick = function () { bookForm({ date: d.date, time: t }); };
    var add = function (btn, to) {
      busy(btn, api("admin_closure_add", { date: d.date, from: t, to: to, note: "" })).then(function (r) {
        closeSheet(); toast("×にしました"); afterClosure(r); loadDay(d.date);
      }, fail);
    };
    if ($("#fx")) $("#fx").onclick = function () { add($("#fx"), hm(m + 15)); };
    if ($("#fxe")) $("#fxe").onclick = function () { add($("#fxe"), hm(close)); };
  }
  // × を押したとき
  function xSheet(id) {
    var c = A.day.closures.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var many = c.startDate && c.endDate && c.startDate !== c.endDate;
    openSheet(
      "<h3>× " + esc(c.from === "00:00" && c.to === "24:00" ? "終日お休み" : c.from + "〜" + c.to) + "</h3>" +
      (c.note ? '<p class="note">' + esc(c.note) + "</p>" : "") +
      (many ? '<p class="note">この休みは ' + mds(c.startDate) + "〜" + mds(c.endDate) + " の続きの休みです。外すと全部の日が外れます。</p>" : "") +
      '<button class="btn wide" id="xdel">×を外す（予約を受けられるようにする）</button>' +
      '<button class="btn gray wide" data-close2>そのままにする</button>');
    on("[data-close2]", closeSheet);
    $("#xdel").onclick = function () {
      busy($("#xdel"), api("admin_closure_del", { id: id })).then(function () { closeSheet(); toast("×を外しました"); loadDay(A.date); }, fail);
    };
  }
  // 休みと重なった予約があれば知らせる
  function afterClosure(r) {
    var cs = (r && r.conflicts) || [];
    if (!cs.length) return;
    setTimeout(function () {
      openSheet("<h3>重なる予約があります</h3>" +
        '<p class="note">休みにした時間に、次の予約が入っています。予約は自動では取り消されません。予約票から連絡・取り消しをしてください。</p>' +
        cs.map(cardOf).join(""));
      on("[data-bk]", function (el) { slip(el.getAttribute("data-bk"), cs); }, $sb);
    }, 50);
  }

  // =============================================================
  // 予約票
  // =============================================================
  function findBooking(id, list) {
    var pools = [list || [], (A.day && A.day.bookings) || [], A.pending || [], A.hist || []];
    for (var i = 0; i < pools.length; i++) { var b = pools[i].filter(function (x) { return x.id === id; })[0]; if (b) return b; }
    return null;
  }
  function slip(id, list) {
    var b = findBooking(id, list);
    if (!b) return;
    var c = b.customer, past = isPast(b);
    var h = '<span class="status ' + esc(b.status) + '">' + esc(STATUS[b.status] || b.status) + "</span>" +
      "<h3>" + esc(c.name || "（名前なし）") + "</h3>" + (c.kana ? '<div class="kana">' + esc(c.kana) + "</div>" : "") +
      '<div class="counts">' +
        (c.isBlocked ? '<span class="pill blk">ブロック中</span>' : c.isReturning ? '<span class="pill reg">通院中</span>' : '<span class="pill new">初めて</span>') +
        '<span class="pill reg">来院 ' + c.visits + "回</span>" +
        (c.noShows ? '<span class="pill ns">無断 ' + c.noShows + "回</span>" : "") +
        (c.lateCancels ? '<span class="pill ns">直前取消 ' + c.lateCancels + "回</span>" : "") +
      "</div>" +
      '<dl class="facts">' +
        "<div><dt>日時</dt><dd>" + dayText(b.date) + " " + esc(b.time + "〜" + b.endTime) + "</dd></div>" +
        "<div><dt>メニュー</dt><dd>" + esc(bizName(b.businessId)) + "<br>" + esc(b.menuName) + "</dd></div>" +
        "<div><dt>料金</dt><dd>" + yen(b.priceYen) + "</dd></div>" +
        (b.symptoms.length ? "<div><dt>気になる所</dt><dd>" + esc(b.symptoms.join("・")) + "</dd></div>" : "") +
        "<div><dt>電話</dt><dd>" + (c.phone ? '<a href="' + esc(telHref(c.phone)) + '">' + esc(telText(c.phone)) + "</a>" : "なし") + "</dd></div>" +
        "<div><dt>LINE名</dt><dd>" + (c.hasLine ? esc(c.lineName || "（あり）") : "LINEなし") + "</dd></div>" +
        (b.source === "admin" ? "<div><dt>受付</dt><dd>手で入れた予約</dd></div>" : "") +
        (b.outcomeNote ? "<div><dt>メモ</dt><dd>" + esc(b.outcomeNote) + "</dd></div>" : "") +
      "</dl>";

    if (!can("bookings")) {
      h += '<p class="note">確定・取り消しなどは、HIROさんにお願いしてください。</p>';
    } else if (b.status === "pending") {
      h += '<div class="acts"><button class="btn mint" data-do="confirm">確定する</button><button class="btn gray" data-do="reject">お断りする</button></div>' +
        '<p class="note">確定・お断りは、患者さんのLINEにすぐ届きます。</p>' +
        (can("customers") ? '<div class="danger-zone"><button class="link red" data-do="block">お断りしてブロック（営業など）</button></div>' : "");
    } else if (b.status === "confirmed" && !past) {
      h += '<div class="acts">' + (c.hasLine && can("customers") ? '<button class="btn line" data-do="msg">LINEで連絡</button>' : "") +
        '<button class="btn red" data-do="cancel">取り消す</button></div>';
    } else if (b.status === "confirmed" && past) {
      h += '<p class="note">来院されましたか？</p><div class="acts">' +
        '<button class="btn mint" data-do="done">来院</button><button class="btn gray" data-do="late_cancel">直前キャンセル</button><button class="btn red" data-do="no_show">無断キャンセル</button></div>';
    } else if (b.status === "done" || b.status === "no_show" || b.status === "late_cancel") {
      h += '<div class="acts"><button class="btn gray" data-do="redo">記録を付け直す</button>' + (c.hasLine && can("customers") ? '<button class="btn line" data-do="msg">LINEで連絡</button>' : "") + "</div>";
    }
    if (can("customers")) h += '<button class="btn gray wide" data-do="cust">この方の情報・履歴を見る</button>';
    if (owner() && b.status !== "pending" && b.status !== "confirmed")
      h += '<div class="danger-zone" style="text-align:center"><button class="link red" data-do="delbk">この予約を履歴から消す</button></div>';
    openSheet(h);

    var done = function (msg) { return function () { closeSheet(); toast(msg); refresh(); }; };
    on("[data-do]", function (el) {
      var k = el.getAttribute("data-do");
      if (k === "confirm") busy(el, api("admin_decide", { bookingId: b.id, decision: "confirm" })).then(function (r) { done(r.sent ? "確定しました（LINEでお知らせ済み）" : "確定しました")(); }, fail);
      if (k === "reject") confirmSheet("この予約をお断りしますか？", "患者さんのLINEに「お受けできませんでした」と届きます。", "お断りする", function (btn) {
        return api("admin_decide", { bookingId: b.id, decision: "reject" }).then(done("お断りしました"));
      });
      if (k === "block") confirmSheet("お断りしてブロックしますか？", "この方はこの後、予約ページを使えなくなります。お客さまの画面からいつでも外せます。", "お断りしてブロック", function () {
        return api("admin_decide", { bookingId: b.id, decision: "reject" })
          .then(function () { return api("admin_customer_update", { customerId: c.id, isBlocked: true }); })
          .then(done("お断りして、ブロックしました"));
      });
      if (k === "cancel") cancelSheet(b);
      if (k === "msg") msgSheet(c);
      if (k === "done" || k === "no_show" || k === "late_cancel" || k === "redo") {
        busy(el, api("admin_outcome", { bookingId: b.id, outcome: k === "redo" ? "confirmed" : k })).then(function () {
          done({ done: "来院を記録しました", no_show: "無断キャンセルを記録しました", late_cancel: "直前キャンセルを記録しました", redo: "記録を消しました。付け直してください" }[k])();
        }, fail);
      }
      if (k === "cust") custSheet(c.id);
      if (k === "delbk") confirmSheet("この予約を履歴から消しますか？", dayText(b.date) + " " + b.time + "〜 " + b.menuName + " の記録を消します。来院回数などの数え方からも消えます。元に戻せません。", "消す", function () {
        return api("admin_booking_delete", { bookingId: b.id }).then(function () { closeSheet(); toast("消しました"); refresh(); });
      });
    }, $sb);
  }
  function cardOf(b) {
    return '<button class="card pend" data-bk="' + esc(b.id) + '" style="display:block;width:100%;text-align:left;border:0">' +
      '<div class="when">' + dayText(b.date) + " " + esc(b.time) + "〜</div>" +
      '<div class="who">' + esc(b.customer.name || "（名前なし）") + "</div>" +
      '<div class="meta">' + esc(bizName(b.businessId) + "　" + b.menuName) + "</div></button>";
  }
  function confirmSheet(title, text, label, run) {
    openSheet("<h3>" + esc(title) + "</h3>" + '<p class="note">' + esc(text) + "</p>" +
      '<button class="btn red wide" id="cfy">' + esc(label) + '</button><button class="btn gray wide" id="cfn">やめる</button>');
    $("#cfn").onclick = closeSheet;
    $("#cfy").onclick = function () { busy($("#cfy"), run()).catch(fail); };
  }
  function cancelSheet(b) {
    var c = b.customer;
    openSheet("<h3>予約を取り消す</h3>" +
      '<p class="note">' + dayText(b.date) + " " + esc(b.time) + "〜　" + esc(b.menuName) + "</p>" +
      (c.hasLine
        ? '<label class="check"><input type="checkbox" id="ct" checked>患者さんのLINEに知らせる</label>' +
          '<label class="f"><span>ひとこと（なくても大丈夫です）</span><textarea id="cm" maxlength="300" placeholder="例：急用のためお休みをいただきます。申し訳ありません。"></textarea></label>'
        : '<p class="note">この方はLINEでつながっていません。お電話などでお知らせください。</p>') +
      '<button class="btn red wide" id="cy">取り消す</button><button class="btn gray wide" id="cn">やめる</button>');
    $("#cn").onclick = closeSheet;
    $("#cy").onclick = function () {
      var tell = !!($("#ct") && $("#ct").checked);
      busy($("#cy"), api("admin_cancel", { bookingId: b.id, tellPatient: tell, message: $("#cm") ? $("#cm").value.trim() : "" })).then(function (r) {
        closeSheet(); toast(r.sent ? "取り消して、LINEでお知らせしました" : "取り消しました"); refresh();
      }, fail);
    };
  }
  function msgSheet(c) {
    openSheet("<h3>LINEで連絡</h3>" + '<p class="note">送り先：' + esc(c.name) + "さん（LINE名：" + esc(c.lineName || "—") + "）</p>" +
      '<div class="tpl">' + TEMPLATES.map(function (t, i) { return '<button class="chip" data-tpl="' + i + '">' + esc(t[0]) + "</button>"; }).join("") + "</div>" +
      '<label class="f"><span>送る文</span><textarea id="mt" maxlength="1000"></textarea></label>' +
      '<p class="note">返事は、LINE公式アカウントのチャットに届きます。</p>' +
      '<button class="btn wide" id="ms">送る</button><button class="btn gray wide" id="mn">やめる</button>');
    var $t = $("#mt");
    $t.value = (c.name ? c.name.split(/[\s　]/)[0] + "様\n" : "");
    on("[data-tpl]", function (el) { $t.value = (c.name ? c.name.split(/[\s　]/)[0] + "様\n" : "") + TEMPLATES[Number(el.getAttribute("data-tpl"))][1]; $t.focus(); }, $sb);
    $("#mn").onclick = closeSheet;
    $("#ms").onclick = function () {
      busy($("#ms"), api("admin_message", { customerId: c.id, text: $t.value.trim() })).then(function () { closeSheet(); toast("LINEで送りました"); }, fail);
    };
  }

  // =============================================================
  // 確認待ち
  // =============================================================
  function showPending() {
    loadingMain("確認待ち");
    api("admin_pending").then(function (r) {
      A.pending = r.bookings;
      if (A.day) A.day.pendingCount = r.bookings.length;
      A.init.pendingCount = r.bookings.length;
      if (A.tab !== "pending") return;
      var h = r.bookings.length ? r.bookings.map(function (b) {
        var c = b.customer;
        return '<div class="card pend"><div class="when">' + dayText(b.date) + " " + esc(b.time) + "〜</div>" +
          '<div class="who">' + esc(c.name) + (c.noShows ? ' <span class="pill ns">無断 ' + c.noShows + "回</span>" : c.visits ? ' <span class="pill reg">来院 ' + c.visits + "回</span>" : ' <span class="pill new">初めて</span>') + "</div>" +
          '<div class="meta">' + esc(bizName(b.businessId) + "　" + b.menuName) + "</div>" +
          '<div class="meta">' + (c.phone ? '<a href="' + esc(telHref(c.phone)) + '">' + esc(telText(c.phone)) + "</a>" : "") + (c.lineName ? "　LINE：" + esc(c.lineName) : "") + "</div>" +
          '<div class="acts">' + (can("bookings") ? '<button class="btn mint" data-ok="' + esc(b.id) + '">確定</button>' : "") + '<button class="btn gray" data-bk="' + esc(b.id) + '">詳しく見る</button></div></div>';
      }).join("") : '<div class="card empty">確認待ちの予約はありません。</div>';
      frame('<div class="day"><h1 class="title">確認待ち</h1></div><div class="sub">初めての方・無断キャンセルが続いた方の仮予約です</div>', h);
      on("[data-bk]", function (el) { slip(el.getAttribute("data-bk"), r.bookings); });
      on("[data-ok]", function (el) {
        busy(el, api("admin_decide", { bookingId: el.getAttribute("data-ok"), decision: "confirm" })).then(function (x) {
          toast(x.sent ? "確定しました（LINEでお知らせ済み）" : "確定しました"); showPending();
        }, fail);
      });
    }, fail);
  }

  // =============================================================
  // 休み
  // =============================================================
  function showOff() {
    if (!A.offMonth) A.offMonth = A.init.today.slice(0, 7);
    loadingMain("休みの設定");
    api("admin_closures").then(function (r) { A.closures = r.closures; if (A.tab === "off") renderOff(); }, fail);
  }
  function closuresOn(ymd) {
    return A.closures.filter(function (c) { return c.date <= ymd && ymd <= c.endDate; });
  }
  function wholeDay(c, ymd) {
    return (c.date < ymd || c.from === "00:00") && (c.endDate > ymd || c.to === "24:00");
  }
  function renderOff() {
    var ym = A.offMonth, y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
    var first = ym + "-01", days = new Date(Date.UTC(y, mo, 0)).getUTCDate(), lead = wdOf(first);
    var thisMonth = A.init.today.slice(0, 7);
    var prev = ymdUTC(new Date(Date.UTC(y, mo - 2, 1))).slice(0, 7), next = ymdUTC(new Date(Date.UTC(y, mo, 1))).slice(0, 7);
    var h = '<div class="card"><div class="cal-head">' +
      '<button class="cal-nav" id="pm" aria-label="前の月"' + (ym <= thisMonth ? " disabled" : "") + ">‹</button>" +
      '<span class="cal-title">' + y + "年" + mo + "月</span>" +
      '<button class="cal-nav" id="nm" aria-label="次の月">›</button></div><div class="cal-grid">';
    WD.forEach(function (w, i) { h += '<span class="cal-wd' + (i === 0 ? " sun" : i === 6 ? " sat" : "") + '">' + w + "</span>"; });
    for (var i = 0; i < lead; i++) h += "<span></span>";
    for (var dd = 1; dd <= days; dd++) {
      var ymd = ym + "-" + String(dd).padStart(2, "0");
      var hasH = hoursOf(ymd).length > 0, cs = closuresOn(ymd), past = ymd < A.init.today;
      var whole = cs.some(function (c) { return wholeDay(c, ymd); });
      var cls = !hasH ? "none" : whole ? "closed" : cs.length ? "part" : "open";
      var mark = !hasH ? "" : whole ? "休" : cs.length ? "一部" : "";
      if (past || !hasH) h += '<span class="cal-d ' + (past ? "none" : cls) + '">' + dd + "</span>";
      else h += '<button class="cal-d ' + cls + (ymd === A.init.today ? " today" : "") + '" data-off="' + ymd + '" aria-label="' + dayText(ymd) + (mark ? " " + mark : "") + '">' + dd + "<i>" + mark + "</i></button>";
    }
    h += '</div><div class="legend" style="margin-top:8px"><span><i class="sw" style="background:var(--blue-soft)"></i>受付日</span><span><i class="sw x"></i>休み</span><span><i class="sw" style="background:var(--amber-soft)"></i>一部休み</span></div>' +
      '<p class="note">受付日を押すと、その日を休みにできます。時間だけ休むこともできます。</p></div>';

    h += "<h2>これからの休み</h2>";
    h += A.closures.length ? '<div class="card offl">' + A.closures.map(function (c) {
      var range = c.date === c.endDate ? dayText(c.date) : mds(c.date) + "〜" + mds(c.endDate);
      var t = c.from === "00:00" && c.to === "24:00" ? "終日" : c.from + "〜" + c.to;
      return '<div class="oi"><b>' + esc(range) + "</b><span>" + esc(t) + (c.note ? "　" + esc(c.note) : "") + '</span><button class="link red" data-del="' + esc(c.id) + '">外す</button></div>';
    }).join("") + "</div>" : '<div class="card empty">これからの休みは入っていません。</div>';

    frame('<div class="day"><h1 class="title">休みの設定</h1></div><div class="sub">祝日も受付します。休む日・時間だけここで止めます</div>', h);
    $("#pm").onclick = function () { A.offMonth = prev; renderOff(); };
    $("#nm").onclick = function () { A.offMonth = next; renderOff(); };
    on("[data-off]", function (el) { offForm(el.getAttribute("data-off")); });
    on("[data-del]", function (el) {
      var c = A.closures.filter(function (x) { return x.id === el.getAttribute("data-del"); })[0];
      confirmSheet("この休みを外しますか？", (c.date === c.endDate ? dayText(c.date) : mds(c.date) + "〜" + mds(c.endDate)) + " は、また予約を受けられるようになります。", "外す", function () {
        return api("admin_closure_del", { id: c.id }).then(function () { closeSheet(); toast("休みを外しました"); showOff(); });
      });
    });
  }
  function timeOptions(from, to, sel) {
    var h = "";
    for (var m = from; m <= to; m += 15) h += '<option value="' + hm(m) + '"' + (hm(m) === sel ? " selected" : "") + ">" + hm(m) + "</option>";
    return h;
  }
  function offForm(ymd) {
    var hs = hoursOf(ymd), o = toMin(hs[0].open), c = toMin(hs[hs.length - 1].close);
    var already = closuresOn(ymd);
    openSheet("<h3>" + dayText(ymd) + " を休みにする</h3>" +
      (already.length ? '<p class="note">この日はすでに休みが入っています：' + already.map(function (x) { return x.from === "00:00" && x.to === "24:00" || x.date < ymd ? "終日" : x.from + "〜" + x.to; }).join("・") + "</p>" : "") +
      '<div class="chips" role="radiogroup"><button class="chip on" data-kind="all" role="radio" aria-checked="true">一日休み</button><button class="chip" data-kind="time" role="radio" aria-checked="false">時間だけ休み</button></div>' +
      '<div id="tset" hidden><div class="two"><label class="f"><span>何時から</span><select id="of">' + timeOptions(o, c - 15, hm(o)) + "</select></label>" +
      '<label class="f"><span>何時まで</span><select id="ot">' + timeOptions(o + 15, c, hm(c)) + "</select></label></div></div>" +
      '<div id="dset"><label class="f"><span>何日まで（連休のとき）</span><input type="date" id="oe" value="' + ymd + '" min="' + ymd + '"></label></div>' +
      '<label class="f"><span>メモ（自分用・患者さんには見えません）</span><input id="on" maxlength="100" placeholder="例：研修、家の用事"></label>' +
      '<button class="btn wide" id="oy">休みにする</button><button class="btn gray wide" id="onn">やめる</button>');
    var kind = "all";
    on("[data-kind]", function (el) {
      kind = el.getAttribute("data-kind");
      $$("[data-kind]", $sb).forEach(function (x) { var y = x === el; x.classList.toggle("on", y); x.setAttribute("aria-checked", String(y)); });
      $("#tset").hidden = kind !== "time"; $("#dset").hidden = kind === "time";
    }, $sb);
    $("#onn").onclick = closeSheet;
    $("#oy").onclick = function () {
      var p = { date: ymd, note: $("#on").value.trim() };
      if (kind === "time") {
        p.from = $("#of").value; p.to = $("#ot").value;
        if (toMin(p.to) <= toMin(p.from)) { toast("「何時まで」は「何時から」より後にしてください。"); return; }
      } else {
        p.endDate = $("#oe").value || ymd;
        if (p.endDate < ymd) { toast("終わりの日は、始まりの日より後にしてください。"); return; }
      }
      busy($("#oy"), api("admin_closure_add", p)).then(function (r) {
        closeSheet(); toast("休みにしました"); afterClosure(r); showOff();
      }, fail);
    };
  }

  // =============================================================
  // お客さま
  // =============================================================
  function showCustomers() {
    var chips = [["", "全員"], ["returning", "通院中"], ["new", "初めて"], ["noshow", "無断あり"], ["blocked", "ブロック"]];
    frame('<div class="day"><h1 class="title">お客さま</h1></div>',
      '<input class="search" id="q" type="search" placeholder="名前・フリガナ・電話番号で探す" value="' + esc(A.q) + '" aria-label="お客さまを探す">' +
      '<div class="chips">' + chips.map(function (c) { return '<button class="chip' + (A.filter === c[0] ? " on" : "") + '" data-f="' + c[0] + '">' + c[1] + "</button>"; }).join("") + "</div>" +
      '<div class="card" id="cl" style="padding:4px 12px"><div class="boot" style="padding:20px 0"><div class="spinner" aria-hidden="true"></div></div></div>' +
      '<button class="btn mint wide" id="nb">LINEのない方の予約を入れる（電話・来院）</button>');
    var t;
    $("#q").oninput = function () { A.q = this.value; clearTimeout(t); t = setTimeout(loadCust, 300); };
    on("[data-f]", function (el) { A.filter = el.getAttribute("data-f"); showCustomers(); });
    if (can("bookings")) $("#nb").onclick = function () { bookForm({ date: A.date || A.init.today }); };
    else $("#nb").remove();
    loadCust();
  }
  function loadCust() {
    api("admin_customers", { q: A.q, filter: A.filter }).then(function (r) {
      A.custs = r.customers;
      var $cl = $("#cl"); if (!$cl) return;
      $cl.innerHTML = r.customers.length ? r.customers.map(function (c) {
        var pill = c.isBlocked ? '<span class="pill blk">ブロック</span>' : c.noShows ? '<span class="pill ns">無断' + c.noShows + "</span>" : c.isReturning ? '<span class="pill reg">通院中</span>' : '<span class="pill new">初めて</span>';
        return '<button class="cust" data-c="' + esc(c.id) + '"><span class="av' + (c.isBlocked ? " blk" : "") + '">' + esc((c.name || "？").slice(0, 1)) + "</span>" +
          '<span class="g"><span class="nm">' + esc(c.name) + "</span><br>" +
          '<span class="sb">' + esc([c.kana, c.next ? "次回 " + c.next : c.last ? "前回 " + c.last : "", c.hasLine ? "" : "LINEなし"].filter(Boolean).join("　")) + "</span></span>" + pill + "</button>";
      }).join("") : '<div class="empty">見つかりませんでした。</div>';
      on("[data-c]", function (el) { custSheet(el.getAttribute("data-c")); }, $cl);
    }, fail);
  }
  function custSheet(id) {
    var get = A.custs && A.custs.filter(function (x) { return x.id === id; })[0];
    var p = get ? Promise.resolve({ customers: [get] }) : api("admin_customers", { q: "" }).then(function (r) {
      return { customers: r.customers.filter(function (x) { return x.id === id; }) };
    });
    p.then(function (r) {
      var c = r.customers[0];
      if (!c) { toast(ERR.customer_not_found); return; }
      return api("admin_customer", { customerId: id }).then(function (hst) {
        A.hist = hst.bookings;
        openSheet("<h3>" + esc(c.name) + "</h3>" + (c.kana ? '<div class="kana">' + esc(c.kana) + "</div>" : "") +
          '<div class="counts"><span class="pill reg">来院 ' + c.visits + "回</span>" +
            (c.noShows ? '<span class="pill ns">無断 ' + c.noShows + "回</span>" : "") +
            (c.lateCancels ? '<span class="pill ns">直前取消 ' + c.lateCancels + "回</span>" : "") + "</div>" +
          '<dl class="facts"><div><dt>電話</dt><dd>' + (c.phone ? '<a href="' + esc(telHref(c.phone)) + '">' + esc(telText(c.phone)) + "</a>" : "なし") + "</dd></div>" +
          "<div><dt>LINE名</dt><dd>" + (c.hasLine ? esc(c.lineName || "（あり）") : "LINEなし") + "</dd></div>" +
          (c.next ? "<div><dt>次回</dt><dd>" + esc(c.next) + "</dd></div>" : "") + "</dl>" +
          '<label class="toggle"><span><b>通院中</b><br><span class="note" style="margin:0">オンにすると、予約がすぐ確定になります</span></span><input type="checkbox" id="tr"' + (c.isReturning ? " checked" : "") + ' style="width:26px;height:26px"></label>' +
          '<label class="toggle"><span><b>ブロック</b><br><span class="note" style="margin:0">オンにすると、予約ページを使えません</span></span><input type="checkbox" id="tb"' + (c.isBlocked ? " checked" : "") + ' style="width:26px;height:26px"></label>' +
          '<label class="f"><span>メモ（自分用）</span><textarea id="tm" maxlength="500">' + esc(c.memo) + "</textarea></label>" +
          '<button class="btn wide" id="ts">保存する</button>' +
          '<div class="acts">' + (c.hasLine ? '<button class="btn line" id="tl">LINEで連絡</button>' : "") +
            (c.isBlocked || !can("bookings") ? "" : '<button class="btn mint" id="tk">予約を入れる</button>') + "</div>" +
          '<div class="hist"><h2 style="font-size:16px">履歴</h2>' +
          (hst.bookings.length ? hst.bookings.map(function (b) {
            return '<button class="h" data-bk="' + esc(b.id) + '" style="width:100%;background:none;border:0;border-bottom:1px solid var(--line);text-align:left"><span>' + mds(b.date) + "（" + WD[wdOf(b.date)] + "）" + esc(b.time) + "　" + esc(b.menuName) + "</span><b>" + esc(STATUS[b.status] || b.status) + "</b></button>";
          }).join("") : '<p class="note">まだ予約はありません。</p>') + "</div>" +
          (owner() ? '<div class="danger-zone" style="text-align:center;margin-top:16px"><button class="link red" id="tdel">この方を消す（テストで入れた人など）</button></div>' : ""));
        $("#ts").onclick = function () {
          busy($("#ts"), api("admin_customer_update", { customerId: c.id, isReturning: $("#tr").checked, isBlocked: $("#tb").checked, memo: $("#tm").value })).then(function () {
            c.isReturning = $("#tr").checked; c.isBlocked = $("#tb").checked; c.memo = $("#tm").value;
            closeSheet(); toast("保存しました"); if (A.tab === "cust") loadCust(); else refresh();
          }, fail);
        };
        if ($("#tl")) $("#tl").onclick = function () { msgSheet(c); };
        if ($("#tdel")) $("#tdel").onclick = function () {
          var n = hst.bookings.length;
          confirmSheet("「" + c.name + "」を消しますか？", "名簿から消え、予約の履歴" + (n ? " " + n + "件" : "") + "もすべて消えます。元に戻せません。" +
            (hst.bookings.some(function (b) { return (b.status === "pending" || b.status === "confirmed") && !isPast(b); }) ? "これからの予約も消えます（患者さんには知らせません）。" : ""), "消す", function () {
            return api("admin_customer_delete", { customerId: c.id }).then(function (r) {
              closeSheet(); toast("消しました（予約の履歴 " + r.bookings + "件）");
              if (A.tab === "cust") loadCust(); else refresh();
            });
          });
        };
        if ($("#tk")) $("#tk").onclick = function () { bookForm({ date: A.date || A.init.today, customer: c }); };
        on("[data-bk]", function (el) { slip(el.getAttribute("data-bk"), hst.bookings); }, $sb);
      });
    }).catch(fail);
  }

  // =============================================================
  // 予約を手で入れる
  // =============================================================
  function bookForm(o) {
    var menus = A.init.menus, cust = o.customer || null, picked = null, date = o.date, want = o.time || null;
    var menuOpts = A.init.businesses.map(function (bz) {
      return '<optgroup label="' + esc(bz.name) + '">' + menus.filter(function (m) { return m.businessId === bz.id; }).map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.name) + "（" + m.durationMin + "分）</option>";
      }).join("") + "</optgroup>";
    }).join("");
    openSheet("<h3>予約を入れる</h3>" +
      '<div id="who"></div>' +
      '<label class="f"><span>メニュー</span><select id="bm">' + menuOpts + "</select></label>" +
      '<label class="f"><span>日にち</span><input type="date" id="bd" value="' + esc(date) + '" min="' + esc(A.init.today) + '"></label>' +
      '<div class="f"><span>時間</span><div id="bt"></div></div>' +
      '<label class="check"><input type="checkbox" id="bany"' + (o.any ? " checked" : "") + '>受付時間の外も出す（知り合いなど）</label>' +   // lifeplus-hours-kind-v1
      '<label class="check" id="tellw"><input type="checkbox" id="btell" checked>患者さんのLINEに知らせる</label>' +
      '<p class="note">手で入れた予約は、初めての方でもすぐ確定になります。休み・×の時間にも入れられます。<b class="tk staff">手</b>は手入力だけの時間、<b class="tk other">外</b>は受付時間の外です（どちらもお客さまには見えません）。</p>' +
      '<button class="btn mint wide" id="bgo" disabled>この内容で入れる</button><button class="btn gray wide" id="bno">やめる</button>');

    function drawWho() {
      if (cust) {
        $("#who").innerHTML = '<dl class="facts" style="margin-top:6px"><div><dt>お客さま</dt><dd>' + esc(cust.name) + (cust.phone ? "<br>" + esc(telText(cust.phone)) : "") +
          '</dd></div></dl><button class="link" id="wch">別の人にする</button>';
        $("#wch").onclick = function () { cust = null; drawWho(); };
      } else {
        $("#who").innerHTML = '<label class="f"><span>お名前' + (can("customers") ? "（名簿にいる方は候補から選べます）" : "") + '</span><input id="bn" maxlength="30" autocomplete="off" placeholder="例：山田 花子"></label>' +
          '<div id="sug"></div>' +
          '<label class="f"><span>フリガナ</span><input id="bk" maxlength="40" placeholder="ヤマダ ハナコ"></label>' +
          '<label class="f"><span>電話番号</span><input id="bp" type="tel" inputmode="tel" maxlength="15" placeholder="090-1234-5678"></label>';
        var t;
        $("#bn").oninput = function () {
          var q = this.value.trim(); clearTimeout(t);
          if (!q || !can("customers")) { $("#sug").innerHTML = ""; return; }
          t = setTimeout(function () {
            api("admin_customers", { q: q }).then(function (r) {
              var $s = $("#sug"); if (!$s) return;
              $s.innerHTML = r.customers.slice(0, 5).map(function (c) {
                return '<button class="chip" data-pick="' + esc(c.id) + '" style="margin:0 6px 6px 0">' + esc(c.name) + (c.phone ? "　" + esc(telText(c.phone).slice(-4)) : "") + "</button>";
              }).join("");
              on("[data-pick]", function (el) { cust = r.customers.filter(function (c) { return c.id === el.getAttribute("data-pick"); })[0]; drawWho(); }, $s);
            }, function () { /* 候補は出なくてもよい */ });
          }, 300);
        };
      }
      $("#tellw").hidden = !(cust && cust.hasLine);
    }
    function loadTimes() {
      picked = null; $("#bgo").disabled = true;
      var mid = $("#bm").value; date = $("#bd").value;
      if (!date) { $("#bt").innerHTML = ""; return; }
      $("#bt").innerHTML = '<div class="spinner" aria-hidden="true" style="margin:8px auto"></div>';
      api("admin_slots", { date: date, menuId: mid, any: !!($("#bany") && $("#bany").checked) }).then(function (r) {
        var $t = $("#bt"); if (!$t) return;
        if (!r.slots.length) { $t.innerHTML = '<p class="note">この日は入れられる時間がありません（受付のない曜日か、埋まっています）。「受付時間の外も出す」で、ほかの時間も選べます。</p>'; return; }
        $t.innerHTML = '<div class="times">' + r.slots.map(function (s) {
          var k = s.kind || "public";
          return '<button class="time ' + esc(k === "public" ? "" : k) + '" data-at="' + esc(s.startsAt) + '" data-t="' + esc(s.time) + '">' + esc(s.time) +
            (k === "staff" ? '<b class="tk staff">手</b>' : k === "other" ? '<b class="tk other">外</b>' : "") + "</button>";
        }).join("") + "</div>";
        var pick = function (el) {
          $$(".time", $t).forEach(function (x) { x.classList.toggle("on", x === el); });
          picked = el.getAttribute("data-at"); $("#bgo").disabled = false;
        };
        on(".time", pick, $t);
        if (want) { var w = $('[data-t="' + want + '"]', $t); if (w) { pick(w); w.scrollIntoView({ block: "nearest" }); } else toast(want + " からは、このメニューは入れられません。"); want = null; }
      }, fail);
    }
    // 選んだ時間の枠に合うメニュー（接骨院ならその事業）を先に選んでおく
    if (o.menuId) $("#bm").value = o.menuId;
    drawWho();
    $("#bm").onchange = loadTimes; $("#bd").onchange = loadTimes; $("#bany").onchange = loadTimes;
    $("#bno").onclick = closeSheet;
    $("#bgo").onclick = function () {
      if (!picked) return;
      var p = { menuId: $("#bm").value, startsAt: picked, tellPatient: !!(cust && cust.hasLine && $("#btell").checked) };
      if (cust) p.customerId = cust.id;
      else {
        p.name = $("#bn").value.trim(); p.nameKana = $("#bk").value.trim(); p.phone = $("#bp").value.trim();
        if (!p.name) { toast(ERR.name_required); return; }
      }
      busy($("#bgo"), api("admin_book", p)).then(function (r) {
        closeSheet(); toast(r.sent ? "予約を入れて、LINEでお知らせしました" : "予約を入れました");
        A.tab = "day"; loadDay(date);
      }, fail);
    };
    loadTimes();
  }

  // =============================================================
  // スタッフ（HIROさんだけ）  marker: staff-ui-v1
  // =============================================================
  function inviteUrl(code) { return "https://liff.line.me/" + CFG.LIFF_ID + "/admin/?join=" + encodeURIComponent(code); }
  function untilText(iso) {
    var d = new Date(Date.parse(iso) + 9 * 3600000);
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + hm(d.getUTCHours() * 60 + d.getUTCMinutes());
  }
  function permText(ps) {
    var t = PERM_LABELS.filter(function (p) { return ps.indexOf(p[0]) >= 0; }).map(function (p) { return p[2]; });
    return t.length ? t.join("・") : "予約表を見るだけ";
  }
  function showStaff() {
    loadingMain("スタッフ");
    api("admin_staff").then(function (r) {
      A.staff = r.staff;
      if (A.tab !== "staff") return;
      var h = '<div class="card" style="padding:4px 12px">' + (r.staff.length ? r.staff.map(function (s) {
        var st = s.joined ? '<span class="pill reg">参加済み</span>' : s.inviteExpired ? '<span class="pill ns">招待の期限切れ</span>' : '<span class="pill new">招待中</span>';
        return '<button class="cust" data-s="' + esc(s.id) + '"><span class="av">' + esc(s.label.slice(0, 1)) + "</span>" +
          '<span class="g"><span class="nm">' + esc(s.label) + "</span><br>" +
          '<span class="sb">' + esc(permText(s.perms)) + "</span></span>" + st + "</button>";
      }).join("") : '<div class="empty">まだ誰もいません。</div>') + "</div>" +
        '<button class="btn mint wide" id="sadd">＋ 人を追加する（招待リンクを作る）</button>' +
        '<p class="note">招待リンクをLINEで送り、相手がLINEで開くと参加になります。リンクは1回だけ・' + "3日間使えます。" +
        "予約表を見るのは全員できます。それ以外は人ごとに選べます。</p>";
      frame('<div class="day"><h1 class="title">スタッフ</h1></div><div class="sub">管理画面を使える人</div>', h);
      $("#sadd").onclick = function () { staffForm(null); };
      on("[data-s]", function (el) { staffForm(r.staff.filter(function (x) { return x.id === el.getAttribute("data-s"); })[0]); });
    }, fail);
  }
  function staffForm(s) {
    var ps = s ? s.perms : ["closures"];
    openSheet("<h3>" + (s ? esc(s.label) : "人を追加する") + "</h3>" +
      (s && s.joined ? '<p class="note">LINE名：' + esc(s.lineName || "—") + (s.lastSeen ? "　最後に開いた日：" + mds(s.lastSeen) : "") + "</p>" : "") +
      '<label class="f"><span>呼び名（自分用。例：受付さん、朋子）</span><input id="sl" maxlength="30" value="' + esc(s ? s.label : "") + '"></label>' +
      '<div class="f"><span>できること</span>' +
      '<label class="check" style="color:var(--mute)"><input type="checkbox" checked disabled>予約表を見る（全員）</label>' +
      PERM_LABELS.map(function (p) {
        return '<label class="check"><input type="checkbox" data-perm="' + p[0] + '"' + (ps.indexOf(p[0]) >= 0 ? " checked" : "") + ">" + esc(p[1]) + "</label>";
      }).join("") + "</div>" +
      (s ? '<button class="btn wide" id="ss">保存する</button>' : '<button class="btn mint wide" id="ss">招待リンクを作る</button>') +
      (s && !s.joined ? '<button class="btn line wide" id="sre">招待リンクを出し直す</button>' : "") +
      (s ? '<div class="danger-zone" style="text-align:center"><button class="link red" id="sdel">この人を外す（管理画面を使えなくする）</button></div>' : "") +
      '<button class="btn gray wide" id="sn">やめる</button>');
    var perms = function () { return $$("[data-perm]", $sb).filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute("data-perm"); }); };
    $("#sn").onclick = closeSheet;
    $("#ss").onclick = function () {
      var label = $("#sl").value.trim();
      if (!label) { toast(ERR.label_required); return; }
      if (s) {
        busy($("#ss"), api("admin_staff_update", { id: s.id, label: label, perms: perms() })).then(function () { closeSheet(); toast("保存しました"); showStaff(); }, fail);
      } else {
        busy($("#ss"), api("admin_staff_invite", { label: label, perms: perms() })).then(function (r) { showInvite(label, r); showStaff(); }, fail);
      }
    };
    if ($("#sre")) $("#sre").onclick = function () {
      busy($("#sre"), api("admin_staff_invite", { id: s.id })).then(function (r) { showInvite(s.label, r); showStaff(); }, fail);
    };
    if ($("#sdel")) $("#sdel").onclick = function () {
      confirmSheet("「" + s.label + "」を外しますか？", "外すと、すぐに管理画面を使えなくなります。また使ってもらうときは、もう一度招待します。", "外す", function () {
        return api("admin_staff_del", { id: s.id }).then(function () { closeSheet(); toast("外しました"); showStaff(); });
      });
    };
  }
  function showInvite(label, r) {
    var url = inviteUrl(r.code);
    var msg = "LIFE PLUS 予約管理への招待です。\nLINEで開いてください（" + untilText(r.expires) + "まで・1回だけ使えます）\n" + url;
    openSheet("<h3>招待リンクができました</h3>" +
      '<p class="note">' + "「" + esc(label) + "」に、LINEで送ってください。" + untilText(r.expires) + "まで使えます。</p>" +
      '<label class="f"><span>招待リンク</span><input id="iu" readonly value="' + esc(url) + '"></label>' +
      '<button class="btn mint wide" id="iline">LINEで送る</button>' +
      '<button class="btn line wide" id="icopy">リンクをコピー</button>' +
      '<button class="btn gray wide" id="iok">閉じる</button>' +
      '<p class="note">このリンクを開いた人が参加します。ほかの人に見せないでください。</p>');
    $("#iok").onclick = closeSheet;
    $("#icopy").onclick = function () {
      var done = function () { toast("コピーしました"); };
      var old = function () { var i = $("#iu"); i.focus(); i.select(); try { document.execCommand("copy"); done(); } catch (_) { toast("長押しでコピーしてください"); } };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, old); else old();
    };
    $("#iline").onclick = function () {
      var share = "https://line.me/R/share?text=" + encodeURIComponent(msg);
      if (liff.isInClient()) liff.openWindow({ url: share, external: false }); else window.open(share, "_blank");
    };
  }

  // 招待リンクから開いた人を参加させる
  function joinIfInvited() {
    var m = /[?&]join=([A-Za-z0-9_-]{8,40})/.exec(location.search);
    if (!m) return Promise.resolve();
    return api("staff_join", { code: m[1] }).then(function (r) {
      // リンクの join= だけ消す（もう一度読み込んでも参加し直さない）
      var rest = location.search.replace(/^\?/, "").split("&").filter(function (x) { return x && x.indexOf("join=") !== 0; }).join("&");
      try { history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "")); } catch (_) { /* 何もしない */ }
      if (!r.already) setTimeout(function () { toast("参加しました。これから管理画面を使えます"); }, 600);
    }, function (e) {
      if (e.code === "no_token" || e.code === "token_invalid") throw e;
      var x = new Error(e.code); x.code = e.code; x.join = true; throw x;
    });
  }


  // =============================================================
  // 設定（HIROさんだけ）  marker: lifeplus-settings-v1
  //   受付時間（曜日ごと・種類つき）と、予約の決まりごと
  //   種類：お客さまに見せる（予約ページで選べる）／手入力だけ（予約表にうっすら出て、手で入れるときだけ選べる）
  // =============================================================
  var WD_ISO = [[1, "月"], [2, "火"], [3, "水"], [4, "木"], [5, "金"], [6, "土"], [7, "日"]];
  function showSettings() {
    loadingMain("設定");
    api("admin_settings").then(function (r) { A.set = JSON.parse(JSON.stringify(r)); renderSettings(); }, fail);
  }
  function renderSettings() {
    var S = A.set, h = "";
    h += '<div class="card"><h2 style="margin-top:0">受付時間</h2>' +
      '<p class="note"><b class="kind public">見せる</b> お客さまの予約ページで選べる時間です。<br>' +
      '<b class="kind staff">手入力だけ</b> お客さまには見えません。予約表にうっすら出て、手で予約を入れるときだけ選べます（知り合いなど）。</p>';
    WD_ISO.forEach(function (w) {
      var rows = S.hours.map(function (x, i) { return { x: x, i: i }; }).filter(function (o) { return o.x.weekday === w[0]; })
        .sort(function (a, b) { return toMin(a.x.open) - toMin(b.x.open); });
      h += '<div class="wdrow"><div class="wdname' + (w[0] === 7 ? " sun" : w[0] === 6 ? " sat" : "") + '">' + w[1] + '</div><div class="wdlist">' +
        (rows.length ? rows.map(function (o) {
          var x = o.x;
          return '<div class="hrow ' + esc(x.kind) + '">' +
            '<select data-hk="' + o.i + '" aria-label="種類"><option value="public"' + (x.kind === "public" ? " selected" : "") + '>見せる</option><option value="staff"' + (x.kind === "staff" ? " selected" : "") + ">手入力だけ</option></select>" +
            '<select data-ho="' + o.i + '" aria-label="何時から">' + timeOptions(5 * 60, 23 * 60 + 45, x.open) + "</select><span>〜</span>" +
            '<select data-hc="' + o.i + '" aria-label="何時まで">' + timeOptions(5 * 60 + 15, 24 * 60, x.close) + "</select>" +
            '<button class="link red" data-hdel="' + o.i + '" aria-label="この時間を消す">×</button></div>';
        }).join("") : '<div class="note" style="margin:6px 0">受付なし</div>') +
        '<button class="link" data-hadd="' + w[0] + '">＋ 時間を足す</button></div></div>';
    });
    h += "</div>";
    h += '<div class="card"><h2 style="margin-top:0">予約の決まりごと</h2>' +
      '<label class="f"><span>予約・取消の締め切り（開始の何分前まで）</span><input type="number" id="sl" min="0" max="2880" step="15" value="' + esc(S.leadMinutes) + '"></label>' +
      '<label class="f"><span>何日先まで予約できるか</span><input type="number" id="sh" min="1" max="365" value="' + esc(S.horizonDays) + '"></label>' +
      '<label class="f"><span>ドタキャンが何回続いたら、通院中でも仮予約に戻すか</span><input type="number" id="sn" min="1" max="10" value="' + esc(S.noshowLimit) + '"></label>' +
      '<p class="note">締め切りと何日先までは、お客さまの予約ページに使われます。手で入れる予約には効きません。</p></div>';
    h += '<button class="btn mint wide" id="sgo">保存する</button><button class="btn gray wide" id="sre">元に戻す（保存しない）</button>';
    frame('<div class="day"><h1 class="title">設定</h1></div><div class="sub">受付時間と予約の決まりごと（HIROさんだけ）</div>', h);
    var num = function (el) { return Number(el.value); };
    on("[data-hadd]", function (el) {
      var w = Number(el.getAttribute("data-hadd")), same = S.hours.filter(function (x) { return x.weekday === w; });
      var last = same.reduce(function (m, x) { return Math.max(m, toMin(x.close)); }, 0);
      var o = last ? Math.min(last, 23 * 60) : 17 * 60, c = Math.min(o + 60, 24 * 60);
      S.hours.push({ weekday: w, kind: last ? "staff" : "public", open: hm(o), close: hm(c) });
      renderSettings();
    });
    on("[data-hdel]", function (el) { S.hours.splice(Number(el.getAttribute("data-hdel")), 1); renderSettings(); });
    $$("[data-hk]").forEach(function (el) { el.onchange = function () { S.hours[Number(el.getAttribute("data-hk"))].kind = el.value; renderSettings(); }; });
    $$("[data-ho]").forEach(function (el) { el.onchange = function () { S.hours[Number(el.getAttribute("data-ho"))].open = el.value; }; });
    $$("[data-hc]").forEach(function (el) { el.onchange = function () { S.hours[Number(el.getAttribute("data-hc"))].close = el.value; }; });
    $("#sre").onclick = function () { showSettings(); };
    $("#sgo").onclick = function () {
      S.leadMinutes = num($("#sl")); S.horizonDays = num($("#sh")); S.noshowLimit = num($("#sn"));
      for (var i = 0; i < S.hours.length; i++) {
        if (toMin(S.hours[i].close) <= toMin(S.hours[i].open)) { toast("「何時まで」は「何時から」より後にしてください。"); return; }
      }
      busy($("#sgo"), api("admin_settings_save", { hours: S.hours, leadMinutes: S.leadMinutes, horizonDays: S.horizonDays, noshowLimit: S.noshowLimit }))
        .then(function (r) {
          A.set = JSON.parse(JSON.stringify(r));
          return api("admin_init").then(function (d) { d.me = A.init.me; A.init = d; renderSettings(); toast("保存しました"); });
        }, fail);
    };
  }

  // ---------- 文字の大きさ（この端末に覚えておく） ----------
  function zoom() { var z = 1; try { z = Number(localStorage.getItem("lp_admin_zoom")) || 1; } catch (_) { /* 何もしない */ } return [1, 1.2, 1.4].indexOf(z) < 0 ? 1 : z; }
  function applyZoom(z) { document.documentElement.style.setProperty("--text-zoom", String(z)); }
  function setZoom(z) {
    try { localStorage.setItem("lp_admin_zoom", String(z)); } catch (_) { /* 何もしない */ }
    applyZoom(z);
    $$("[data-size]").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-size")) === z)); });
  }
  applyZoom(zoom());

  // 画面に戻ってきたら最新にする
  document.addEventListener("visibilitychange", function () { if (!document.hidden && A.init && $sheet.hidden) refresh(); });

  // ---------- 起動 ----------
  function boot() {
    if (!window.liff || !CFG.LIFF_ID) { $app.innerHTML = '<div class="boot">ページの準備ができていません。</div>'; return; }
    liff.init({ liffId: CFG.LIFF_ID }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      return joinIfInvited().then(function () { return api("admin_init"); }).then(function (d) {
        A.init = d; A.date = d.today;
        var q = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(location.search);
        if (q) A.date = q[1];
        return loadDay(A.date);
      }, function (e) {
        var code = e.join ? e.code : fail(e);
        if (code !== "no_token" && code !== "token_invalid")
          $app.innerHTML = '<div class="boot"><p>' + esc(ERR[code] || ERR.server_error) + '</p><button class="btn" style="max-width:260px" onclick="location.reload()">もう一度読み込む</button></div>';
      });
    }, function () {
      $app.innerHTML = '<div class="boot">LINEとのつながりを準備できませんでした。LINEアプリから開き直してください。</div>';
    });
  }
  boot();
})();
