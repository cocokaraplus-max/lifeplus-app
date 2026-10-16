/* LIFE PLUS 予約管理（HIROさんだけ）  marker: lifeplus-admin-ui-v1
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
  function hoursOf(ymd) {
    var w = wdOf(ymd) === 0 ? 7 : wdOf(ymd);
    return (A.init.hours || []).filter(function (h) { return h.weekday === w; });
  }
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
  };
  function sizes() {
    return '<div class="sizes" role="group" aria-label="文字の大きさ">' +
      [[1, "標準"], [1.2, "大"], [1.4, "特大"]].map(function (s) {
        return '<button data-size="' + s[0] + '" aria-pressed="' + (zoom() === s[0]) + '">' + s[1] + "</button>";
      }).join("") + "</div>";
  }
  function frame(barInner, mainHtml, extra) {
    var pc = A.day ? A.day.pendingCount : A.init.pendingCount;
    var tabs = [["day", "予約表"], ["pending", "確認待ち"], ["off", "休み"], ["cust", "お客さま"]].map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (A.tab === t[0] ? "on" : "") + '"' + (A.tab === t[0] ? ' aria-current="page"' : "") + ">" +
        ICONS[t[0]] + t[1] + (t[0] === "pending" && pc ? '<span class="badge">' + pc + "</span>" : "") + "</button>";
    }).join("");
    $app.innerHTML =
      '<header class="bar"><div class="bar-top"><span><b>LIFE PLUS</b>　予約管理</span>' + sizes() + "</div>" + barInner + "</header>" +
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
    var hours = d.hours;
    var bar =
      '<div class="day"><button class="arrow" id="dp" aria-label="前の日">‹</button>' +
      "<h1>" + mdj(d.date) + "<small>（" + esc(d.weekday) + "）</small></h1>" +
      (d.date !== A.init.today ? '<button class="today-btn" id="dt">今日</button>' : "") +
      '<button class="arrow" id="dn" aria-label="次の日">›</button></div>' +
      '<div class="sub">' + (hours.length ? hours.map(function (h) { return h.open + "〜" + h.close; }).join("・") + "　予約 " + live.length + "件" : "受付のない曜日です") + "</div>";

    var h = "";
    if (d.pendingCount) {
      h += '<button class="wait" id="gowait"><span class="n">' + d.pendingCount + '</span><span class="t">確認待ちの予約があります<br>（初めての方・仮予約）</span><span class="go">見る</span></button>';
    }
    if (!hours.length) {
      h += '<div class="closed-day">この曜日は受付時間がありません。</div>';
      if (bs.length) h += bs.map(cardOf).join("");
    } else {
      h += '<div class="legend"><span><i class="sw mo"></i>接骨院</span><span><i class="sw bc"></i>ボディケア</span><span><i class="sw pd"></i>確認待ち</span><span><i class="sw x"></i>×（受けない）</span></div>';
      h += timeline(d);
      h += '<p class="note">空いている枠を押すと、予約を入れたり×にしたりできます。</p>';
    }
    frame(bar, h, '<button class="fab" id="fab" aria-label="予約を手で入れる">＋</button>');
    $("#dp").onclick = function () { loadDay(addDays(A.date, -1)); };
    $("#dn").onclick = function () { loadDay(addDays(A.date, 1)); };
    if ($("#dt")) $("#dt").onclick = function () { loadDay(A.init.today); };
    if ($("#gowait")) $("#gowait").onclick = function () { go("pending"); };
    $("#fab").onclick = function () { bookForm({ date: A.date }); };
    on("[data-bk]", function (el) { slip(el.getAttribute("data-bk")); });
    on("[data-free]", function (el) { freeSlot(el.getAttribute("data-free")); });
    on("[data-x]", function (el) { xSheet(el.getAttribute("data-x")); });
  }

  function timeline(d) {
    var open = Math.min.apply(null, d.hours.map(function (h) { return toMin(h.open); }));
    var close = Math.max.apply(null, d.hours.map(function (h) { return toMin(h.close); }));
    // 時間外の予約（手入力など）もはみ出さないように広げる
    d.bookings.forEach(function (b) { open = Math.min(open, toMin(b.time)); close = Math.max(close, toMin(b.blockUntil) || toMin(b.endTime)); });
    open = Math.floor(open / 15) * 15; close = Math.ceil(close / 15) * 15;
    var y = function (m) { return (m - open) / 15 * ROW; };
    var inHours = function (m) { return d.hours.some(function (h) { return m >= toMin(h.open) && m + 15 <= toMin(h.close); }); };
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
      h += '<div class="row' + (m % 60 === 0 ? " hour" : "") + '" style="position:absolute;left:0;right:0;top:' + y(m) + 'px"><span class="lb">' + hm(m) + "</span>" +
        (inHours(m) && !busyAt(m) ? '<button class="free" data-free="' + hm(m) + '" aria-label="' + hm(m) + ' 空き">空き</button>' : "") + "</div>";
    }
    h += '<div class="row hour end" style="position:absolute;left:0;right:0;top:' + y(close) + 'px"><span class="lb">' + hm(close) + "</span></div>";
    d.closures.forEach(function (c) {
      var s = Math.max(open, toMin(c.from)), e = Math.min(close, toMin(c.to));
      if (e <= s) return;
      h += '<button class="xblk" data-x="' + esc(c.id) + '" style="top:' + (y(s) + 3) + "px;height:" + (y(e) - y(s) - 6) + 'px">× ' +
        esc(c.from === "00:00" && c.to === "24:00" ? "終日お休み" : c.from + "〜" + c.to) + (c.note ? "　" + esc(c.note) : "") + "</button>";
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

  // 空き枠を押したとき
  function freeSlot(t) {
    var m = toMin(t), d = A.day;
    var close = Math.max.apply(null, d.hours.filter(function (h) { return toMin(h.open) <= m; }).map(function (h) { return toMin(h.close); }));
    openSheet(
      "<h3>" + dayText(d.date) + " " + esc(t) + "</h3>" +
      '<p class="note">この時間をどうしますか？</p>' +
      '<button class="btn mint wide" id="fb">ここに予約を入れる</button>' +
      '<button class="btn line wide" id="fx">' + esc(t + "〜" + hm(m + 15)) + " を×にする</button>" +
      (close > m + 15 ? '<button class="btn gray wide" id="fxe">' + esc(t + "〜" + hm(close)) + " をまとめて×にする</button>" : "") +
      '<p class="note">×にした時間は、患者さんの予約ページで選べなくなります。×を押すと外せます。</p>');
    $("#fb").onclick = function () { bookForm({ date: d.date, time: t }); };
    var add = function (btn, to) {
      busy(btn, api("admin_closure_add", { date: d.date, from: t, to: to, note: "" })).then(function (r) {
        closeSheet(); toast("×にしました"); afterClosure(r); loadDay(d.date);
      }, fail);
    };
    $("#fx").onclick = function () { add($("#fx"), hm(m + 15)); };
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

    if (b.status === "pending") {
      h += '<div class="acts"><button class="btn mint" data-do="confirm">確定する</button><button class="btn gray" data-do="reject">お断りする</button></div>' +
        '<p class="note">確定・お断りは、患者さんのLINEにすぐ届きます。</p>' +
        '<div class="danger-zone"><button class="link red" data-do="block">お断りしてブロック（営業など）</button></div>';
    } else if (b.status === "confirmed" && !past) {
      h += '<div class="acts">' + (c.hasLine ? '<button class="btn line" data-do="msg">LINEで連絡</button>' : "") +
        '<button class="btn red" data-do="cancel">取り消す</button></div>';
    } else if (b.status === "confirmed" && past) {
      h += '<p class="note">来院されましたか？</p><div class="acts">' +
        '<button class="btn mint" data-do="done">来院</button><button class="btn gray" data-do="late_cancel">直前キャンセル</button><button class="btn red" data-do="no_show">無断キャンセル</button></div>';
    } else if (b.status === "done" || b.status === "no_show" || b.status === "late_cancel") {
      h += '<div class="acts"><button class="btn gray" data-do="redo">記録を付け直す</button>' + (c.hasLine ? '<button class="btn line" data-do="msg">LINEで連絡</button>' : "") + "</div>";
    }
    h += '<button class="btn gray wide" data-do="cust">この方の情報・履歴を見る</button>';
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
          '<div class="acts"><button class="btn mint" data-ok="' + esc(b.id) + '">確定</button><button class="btn gray" data-bk="' + esc(b.id) + '">詳しく見る</button></div></div>';
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
    $("#nb").onclick = function () { bookForm({ date: A.date || A.init.today }); };
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
            (c.isBlocked ? "" : '<button class="btn mint" id="tk">予約を入れる</button>') + "</div>" +
          '<div class="hist"><h2 style="font-size:16px">履歴</h2>' +
          (hst.bookings.length ? hst.bookings.map(function (b) {
            return '<button class="h" data-bk="' + esc(b.id) + '" style="width:100%;background:none;border:0;border-bottom:1px solid var(--line);text-align:left"><span>' + mds(b.date) + "（" + WD[wdOf(b.date)] + "）" + esc(b.time) + "　" + esc(b.menuName) + "</span><b>" + esc(STATUS[b.status] || b.status) + "</b></button>";
          }).join("") : '<p class="note">まだ予約はありません。</p>') + "</div>");
        $("#ts").onclick = function () {
          busy($("#ts"), api("admin_customer_update", { customerId: c.id, isReturning: $("#tr").checked, isBlocked: $("#tb").checked, memo: $("#tm").value })).then(function () {
            c.isReturning = $("#tr").checked; c.isBlocked = $("#tb").checked; c.memo = $("#tm").value;
            closeSheet(); toast("保存しました"); if (A.tab === "cust") loadCust(); else refresh();
          }, fail);
        };
        if ($("#tl")) $("#tl").onclick = function () { msgSheet(c); };
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
      '<label class="check" id="tellw"><input type="checkbox" id="btell" checked>患者さんのLINEに知らせる</label>' +
      '<p class="note">手で入れた予約は、初めての方でもすぐ確定になります。休み・×の時間にも入れられます。</p>' +
      '<button class="btn mint wide" id="bgo" disabled>この内容で入れる</button><button class="btn gray wide" id="bno">やめる</button>');

    function drawWho() {
      if (cust) {
        $("#who").innerHTML = '<dl class="facts" style="margin-top:6px"><div><dt>お客さま</dt><dd>' + esc(cust.name) + (cust.phone ? "<br>" + esc(telText(cust.phone)) : "") +
          '</dd></div></dl><button class="link" id="wch">別の人にする</button>';
        $("#wch").onclick = function () { cust = null; drawWho(); };
      } else {
        $("#who").innerHTML = '<label class="f"><span>お名前（名簿にいる方は候補から選べます）</span><input id="bn" maxlength="30" autocomplete="off" placeholder="例：山田 花子"></label>' +
          '<div id="sug"></div>' +
          '<label class="f"><span>フリガナ</span><input id="bk" maxlength="40" placeholder="ヤマダ ハナコ"></label>' +
          '<label class="f"><span>電話番号</span><input id="bp" type="tel" inputmode="tel" maxlength="15" placeholder="090-1234-5678"></label>';
        var t;
        $("#bn").oninput = function () {
          var q = this.value.trim(); clearTimeout(t);
          if (!q) { $("#sug").innerHTML = ""; return; }
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
      api("admin_slots", { date: date, menuId: mid }).then(function (r) {
        var $t = $("#bt"); if (!$t) return;
        if (!r.slots.length) { $t.innerHTML = '<p class="note">この日は入れられる時間がありません（受付のない曜日か、埋まっています）。</p>'; return; }
        $t.innerHTML = '<div class="times">' + r.slots.map(function (s) {
          return '<button class="time" data-at="' + esc(s.startsAt) + '" data-t="' + esc(s.time) + '">' + esc(s.time) + "</button>";
        }).join("") + "</div>";
        var pick = function (el) {
          $$(".time", $t).forEach(function (x) { x.classList.toggle("on", x === el); });
          picked = el.getAttribute("data-at"); $("#bgo").disabled = false;
        };
        on(".time", pick, $t);
        if (want) { var w = $('[data-t="' + want + '"]', $t); if (w) pick(w); else toast(want + " からは、このメニューは入れられません。"); want = null; }
      }, fail);
    }
    // 選んだ時間の枠に合うメニュー（接骨院ならその事業）を先に選んでおく
    if (o.menuId) $("#bm").value = o.menuId;
    drawWho();
    $("#bm").onchange = loadTimes; $("#bd").onchange = loadTimes;
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
      return api("admin_init").then(function (d) {
        A.init = d; A.date = d.today;
        var q = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(location.search);
        if (q) A.date = q[1];
        return loadDay(A.date);
      }, function (e) {
        var code = fail(e);
        if (code !== "no_token" && code !== "token_invalid")
          $app.innerHTML = '<div class="boot"><p>' + esc(ERR[code] || ERR.server_error) + '</p><button class="btn" style="max-width:260px" onclick="location.reload()">もう一度読み込む</button></div>';
      });
    }, function () {
      $app.innerHTML = '<div class="boot">LINEとのつながりを準備できませんでした。LINEアプリから開き直してください。</div>';
    });
  }
  boot();
})();
