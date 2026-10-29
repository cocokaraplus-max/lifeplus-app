/* LIFE PLUS 予約ページ（LIFF）  marker: lifeplus-liff-v1 / techo-v1 / onelines-v1
   流れ：ホーム（自分の予約）→ 事業 → メニュー → 日時 → 症状 → 確認 → 完了
   予約・取消・登録はすべて関所（API_URL）を通す。ページ側は何も決めない。 */
(function () {
  "use strict";
  var CFG = window.LP_CONFIG || {};
  var $app = document.getElementById("app");
  var $toast = document.getElementById("toast");

  var S = {
    data: null,          // init の結果
    business: null,      // 選んだ事業
    menu: null,          // 選んだメニュー
    slot: null,          // { startsAt, time, date, weekday }
    symptoms: [],
    from: null,          // カレンダーの月（YYYY-MM）
    day: null,           // 選んだ日
    afterProfile: null,  // 登録が済んだら戻る先
  };

  // 接骨院の保険についてのお知らせ（marker: mominoki-insurance-note-v1）
  var MOMINOKI_NOTE =
    '<div class="notice" role="note"><b>保険についてのご案内</b>' +
    "ケガ以外の症状は保険外となりますので<br>ご了承ください。" +
    '<span class="ex">（保険が適応されない例：肩こり、腰痛、慢性痛、疲労、繰り返しの動作で発生した痛み）</span></div>';
  function mominokiNote() { return S.business && S.business.id === "mominoki" ? MOMINOKI_NOTE : ""; }

  var ERR = {
    no_token: "LINEのログインが切れました。もう一度開き直してください。",
    token_invalid: "LINEのログインが切れました。もう一度開き直してください。",
    customer_blocked: "申し訳ありません。現在このアカウントではご予約を承れません。",
    profile_required: "先にお名前とお電話番号のご登録をお願いします。",
    name_required: "お名前を入力してください。",
    kana_invalid: "フリガナはカタカナ（またはひらがな）で入力してください。",
    phone_invalid: "電話番号は数字10〜11桁で入力してください（例：090-1234-5678）。",
    menu_not_found: "このメニューは現在ご予約できません。",
    slot_not_available: "申し訳ありません。その時間はたった今埋まってしまいました。別の時間をお選びください。",
    too_many_bookings: "ご予約は3件までお取りいただけます。先に来院されてから、次のご予約をお願いします。",
    booking_not_found: "このご予約は見つかりませんでした。",
    cancel_too_late: "直前のため、ページからは取り消せません。LINEのトークでお知らせください。",
    bad_request: "うまく送れませんでした。もう一度お試しください。",
    server_error: "うまく送れませんでした。少し時間をおいてお試しください。",
    network: "通信がうまくいきませんでした。電波の良いところでもう一度お試しください。",
  };

  // ---------- 小道具 ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function yen(n) { return n == null ? "保険診療" : n.toLocaleString("ja-JP") + "円"; }
  function md(ymd) { var p = ymd.split("-"); return Number(p[1]) + "月" + Number(p[2]) + "日"; }
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { $toast.hidden = true; }, 5000);
  }
  function loading(msg) {
    $app.innerHTML = '<div class="loading"><div class="spinner" aria-hidden="true"></div><p>' + esc(msg || "読み込んでいます…") + "</p></div>";
  }
  function view(html) { $app.innerHTML = html; window.scrollTo(0, 0); }
  function steps(n) {
    var h = '<div class="steps" aria-hidden="true">';
    for (var i = 1; i <= 5; i++) h += '<span class="' + (i <= n ? "on" : "") + '"></span>';
    return h + "</div>";
  }
  function bizOf(id) { return (S.data.businesses || []).filter(function (b) { return b.id === id; })[0]; }
  function setAccent() { /* 手帳の色は1つ（事業の色は印だけで出す） */ }

  // ---------- 関所への問い合わせ ----------
  function api(action, payload) {
    var body = Object.assign({ action: action, idToken: liff.getIDToken() }, payload || {});
    return fetch(CFG.API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return { error: "server_error" }; }).then(function (j) {
        if (r.ok) return j;
        var e = new Error(j.error || "server_error");
        e.code = j.error || "server_error";
        throw e;
      });
    }, function () {
      var e = new Error("network"); e.code = "network"; throw e;
    });
  }
  function fail(e) {
    var code = (e && e.code) || "server_error";
    if (code === "no_token" || code === "token_invalid") return relogin();
    toast(ERR[code] || ERR.server_error);
    return code;
  }
  function relogin() {
    loading("ログインし直しています…");
    if (liff.isInClient()) { location.reload(); return; }
    try { liff.logout(); } catch (_) { /* 何もしない */ }
    liff.login({ redirectUri: location.href });
  }

  // ---------- ホーム ----------
  function home() {
    setAccent();
    var bs = S.data.bookings || [];
    var h = "<h2>ご予約の状況</h2>";
    if (!bs.length) {
      h += '<div class="card empty">いまお取りしているご予約はありません。</div>';
    } else {
      bs.forEach(function (b) {
        h += '<div class="card bk">' +
          '<div class="when">' + md(b.date) + "（" + esc(b.weekday) + "）" + esc(b.time) + "〜</div>" +
          '<span class="badge ' + esc(b.status) + '">' + (b.status === "confirmed" ? "確定" : "確認<br>待ち") + "</span>" +
          '<div class="what">' + esc(b.businessName) + "　" + esc(b.menuName) + "</div>" +
          (b.status === "pending" ? '<div class="what">確定したらLINEでお知らせします。</div>' : "") +
          '<div class="actions"><button class="btn danger" data-cancel="' + esc(b.id) + '">このご予約を取り消す</button></div>' +
          "</div>";
      });
    }
    h += '<button class="btn" id="new">新しく予約する</button>';
    if (S.data.profile.complete) h += '<button class="btn ghost" id="prof">お名前・お電話番号の変更</button>';
    view(h);
    document.getElementById("new").onclick = function () { startBooking(); };
    var pf = document.getElementById("prof");
    if (pf) pf.onclick = function () { S.afterProfile = home; profile(); };
    Array.prototype.forEach.call($app.querySelectorAll("[data-cancel]"), function (btn) {
      btn.onclick = function () { cancel(btn.getAttribute("data-cancel")); };
    });
  }

  function cancel(id) {
    var b = (S.data.bookings || []).filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    if (!confirm(md(b.date) + "（" + b.weekday + "）" + b.time + "〜 の " + b.menuName + " を取り消します。よろしいですか？")) return;
    loading("取り消しています…");
    api("cancel", { bookingId: id }).then(function (r) {
      S.data.bookings = r.bookings;
      toast("ご予約を取り消しました。");
      home();
    }, function (e) { fail(e); home(); });
  }

  // ---------- 登録 ----------
  function profile() {
    var p = S.data.profile;
    view(
      '<button class="back" id="back">← もどる</button>' +
      "<h2>お名前とご連絡先</h2>" +
      '<p class="lead">ご予約の確認にだけ使います。</p>' +
      '<div class="card">' +
      '<p class="err" id="perr" hidden></p>' +
      '<label class="f"><span>お名前</span><input id="pn" autocomplete="name" maxlength="30" value="' + esc(p.name) + '" placeholder="山田 花子"></label>' +
      '<label class="f"><span>フリガナ</span><input id="pk" maxlength="40" value="' + esc(p.nameKana) + '" placeholder="ヤマダ ハナコ"></label>' +
      '<label class="f"><span>お電話番号</span><input id="pp" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" value="' + esc(p.phone) + '" placeholder="090-1234-5678"></label>' +
      '<p class="note">お電話は急ぎのときだけおかけします。</p>' +
      '<button class="btn" id="save">' + (p.complete ? "保存する" : "登録して進む") + '</button>' +
      "</div>"
    );
    document.getElementById("back").onclick = function () {
      var back = (p.complete && S.afterProfile) || home; S.afterProfile = null; back();
    };
    document.getElementById("save").onclick = function () {
      var btn = this; btn.disabled = true;
      api("profile", {
        name: document.getElementById("pn").value,
        nameKana: document.getElementById("pk").value,
        phone: document.getElementById("pp").value,
      }).then(function (r) {
        var changed = p.complete;
        S.data.profile = r.profile;
        var next = S.afterProfile || home; S.afterProfile = null; next();
        if (changed) toast("お名前・お電話番号を変更しました。");
      }, function (e) {
        btn.disabled = false;
        var code = fail(e);
        var el = document.getElementById("perr");
        if (el && ERR[code]) { el.textContent = ERR[code]; el.hidden = false; }
      });
    };
  }

  // ---------- 予約の流れ ----------
  function startBooking() {
    S.business = S.menu = S.slot = null; S.symptoms = []; S.from = null;
    if (!S.data.profile.complete) { S.afterProfile = chooseBusiness; profile(); return; }
    chooseBusiness();
  }

  function chooseBusiness() {
    setAccent();
    var h = '<button class="back" id="back">← もどる</button>' + steps(1) + "<h2>どちらのご予約ですか？</h2>";
    S.data.businesses.forEach(function (b) {
      var sub = b.id === "mominoki" ? "ケガ・痛みの施術（保険）" : "筋膜ケア・慢性症状（自費）";
      h += '<button class="choice" data-biz="' + esc(b.id) + '"><span class="dot" style="background:' + esc(b.color) + '"></span>' +
        '<span class="body"><span class="name">' + esc(b.name) + '</span><br><span class="meta">' + sub + "</span></span>" +
        '<span class="chev" aria-hidden="true">›</span></button>';
    });
    view(h);
    document.getElementById("back").onclick = function () { home(); };
    Array.prototype.forEach.call($app.querySelectorAll("[data-biz]"), function (btn) {
      btn.onclick = function () {
        S.business = bizOf(btn.getAttribute("data-biz"));
        setAccent(S.business.color);
        var ms = S.data.menus.filter(function (m) { return m.businessId === S.business.id; });
        if (ms.length === 1) { S.menu = ms[0]; chooseTime(); } else chooseMenu();
      };
    });
  }

  function chooseMenu() {
    var ms = S.data.menus.filter(function (m) { return m.businessId === S.business.id; });
    var h = '<button class="back" id="back">← もどる</button>' + steps(2) + "<h2>メニューをお選びください</h2>";
    ms.forEach(function (m) {
      h += '<button class="choice" data-menu="' + esc(m.id) + '"><span class="body"><span class="name">' + esc(m.name) + "</span><br>" +
        '<span class="meta">' + m.durationMin + "分" + (m.description ? "　" + esc(m.description) : "") + "</span></span>" +
        '<span class="price">' + yen(m.priceYen) + "</span></button>";
    });
    view(h);
    document.getElementById("back").onclick = function () { chooseBusiness(); };
    Array.prototype.forEach.call($app.querySelectorAll("[data-menu]"), function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute("data-menu");
        S.menu = ms.filter(function (m) { return m.id === id; })[0];
        chooseTime();
      };
    });
  }

  // ---------- 日時：ひと月のカレンダー → その日の時間（同じ画面の中で切り替える） marker: month-calendar-v1 ----------
  var MARK = { open: "○", few: "△", full: "×", off: "休", out: "" };
  function chooseTime() {
    var single = S.data.menus.filter(function (m) { return m.businessId === S.business.id; }).length === 1;
    view('<button class="back" id="back">← もどる</button>' + steps(3) +
      "<h2>ご希望の日をお選びください</h2>" +
      '<p class="lead">' + esc(S.menu.name) + "（" + S.menu.durationMin + "分）</p>" + mominokiNote() +
      '<div class="card cal-card" id="cal"><div class="loading small-loading"><div class="spinner" aria-hidden="true"></div></div></div>' +
      '<div class="cal-key"><span>○ 空きあり</span><span>△ 残りわずか</span><span>× 満席</span><span>休 お休み</span></div>' +
      '<div id="slots"></div>');
    document.getElementById("back").onclick = function () { S.from = null; S.day = null; if (single) chooseBusiness(); else chooseMenu(); };
    loadMonth(S.from);
  }

  function loadMonth(month) {
    var $cal = document.getElementById("cal");
    if (!$cal) return;
    $cal.classList.add("busy");
    api("month", { menuId: S.menu.id, month: month }).then(function (r) {
      S.from = r.month;
      // lifeplus-closure-notice-v1: お盆・年末年始などのお休みのお知らせ（カレンダーの上）
      var nt = (r.notices || []).length ? '<div class="cal-notice" role="note"><b class="cal-notice-h">お休みのお知らせ</b><ul>' +
        r.notices.map(function (x) { return '<li><span class="cal-notice-d">' + esc(x.label) + "</span>" + esc(x.text) + "</li>"; }).join("") + "</ul></div>" : "";
      var h = nt + '<div class="cal-head">' +
        '<button class="cal-nav" id="pm"' + (r.prev ? "" : " disabled") + ' aria-label="前の月">‹</button>' +
        '<span class="cal-title">' + esc(r.label) + "</span>" +
        '<button class="cal-nav" id="nm"' + (r.next ? "" : " disabled") + ' aria-label="次の月">›</button></div>' +
        '<div class="cal-grid">';
      ["日", "月", "火", "水", "木", "金", "土"].forEach(function (w, i) {
        h += '<span class="cal-wd' + (i === 0 ? " sun" : i === 6 ? " sat" : "") + '">' + w + "</span>";
      });
      for (var k = 0; k < r.lead; k++) h += "<span></span>";
      var anyOpen = false;
      r.days.forEach(function (d) {
        var can = d.state === "open" || d.state === "few";
        if (can) anyOpen = true;
        h += (can ? '<button class="cal-d ' + d.state + (S.day === d.date ? " on" : "") + '" data-day="' + esc(d.date) + '">'
                  : '<span class="cal-d ' + d.state + '">') +
          '<b>' + d.day + "</b><i>" + MARK[d.state] + "</i>" + (can ? "</button>" : "</span>");
      });
      h += "</div>";
      if (!anyOpen) h += '<p class="empty">この月はご予約いただける日がありません。</p>';
      $cal.innerHTML = h;
      $cal.classList.remove("busy");
      var pm = document.getElementById("pm"), nm = document.getElementById("nm");
      if (r.prev) pm.onclick = function () { S.day = null; document.getElementById("slots").innerHTML = ""; loadMonth(r.prev); };
      if (r.next) nm.onclick = function () { S.day = null; document.getElementById("slots").innerHTML = ""; loadMonth(r.next); };
      Array.prototype.forEach.call($cal.querySelectorAll("[data-day]"), function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call($cal.querySelectorAll(".cal-d.on"), function (x) { x.classList.remove("on"); });
          b.classList.add("on");
          S.day = b.getAttribute("data-day");
          loadSlots(S.day);
        };
      });
      if (S.day && $cal.querySelector('[data-day="' + S.day + '"]')) loadSlots(S.day, true);
    }, function (e) { fail(e); home(); });
  }

  function loadSlots(date, quiet) {
    var $s = document.getElementById("slots");
    $s.innerHTML = '<div class="loading small-loading"><div class="spinner" aria-hidden="true"></div></div>';
    api("slots", { menuId: S.menu.id, date: date }).then(function (r) {
      var h = '<div class="day" id="dayslots"><div class="day-head"><span class="day-date">' + md(r.date) + "</span>" +
        '<span class="day-wd' + (r.weekday === "土" ? " sat" : r.weekday === "日" ? " sun" : "") + '">（' + esc(r.weekday) + "）</span>" +
        '<span class="day-full">時間をお選びください</span></div>';
      if (!r.slots.length) h += '<p class="empty">この日は満席になりました。別の日をお選びください。</p>';
      else {
        h += '<div class="times">';
        r.slots.forEach(function (sl) {
          h += '<button class="time" data-at="' + esc(sl.startsAt) + '" data-time="' + esc(sl.time) + '">' + esc(sl.time) + "</button>";
        });
        h += "</div>";
      }
      $s.innerHTML = h + "</div>";
      Array.prototype.forEach.call($s.querySelectorAll("[data-at]"), function (btn) {
        btn.onclick = function () {
          S.slot = { startsAt: btn.getAttribute("data-at"), time: btn.getAttribute("data-time"), date: r.date, weekday: r.weekday };
          chooseSymptoms();
        };
      });
      if (!quiet) {
        var el = document.getElementById("dayslots");
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, function (e) { fail(e); });
  }

  function chooseSymptoms() {
    var h = '<button class="back" id="back">← もどる</button>' + steps(4) +
      "<h2>気になるところはどこですか？</h2>" +
      '<p class="lead">いくつでも選べます。<br>選ばなくても大丈夫です。</p>' +
      '<div class="card"><div class="chips">';
    S.data.symptoms.forEach(function (s) {
      h += '<button class="chip' + (S.symptoms.indexOf(s) >= 0 ? " on" : "") + '" data-sym="' + esc(s) + '" aria-pressed="' + (S.symptoms.indexOf(s) >= 0) + '">' + esc(s) + "</button>";
    });
    h += "</div></div>" + '<button class="btn" id="go">確認へ進む</button>';
    view(h);
    document.getElementById("back").onclick = function () { chooseTime(); };
    Array.prototype.forEach.call($app.querySelectorAll("[data-sym]"), function (btn) {
      btn.onclick = function () {
        var s = btn.getAttribute("data-sym"), i = S.symptoms.indexOf(s);
        if (i >= 0) S.symptoms.splice(i, 1); else S.symptoms.push(s);
        btn.classList.toggle("on", i < 0);
        btn.setAttribute("aria-pressed", String(i < 0));
      };
    });
    document.getElementById("go").onclick = function () { confirmView(); };
  }

  function confirmView() {
    var p = S.data.profile;
    var h = '<button class="back" id="back">← もどる</button>' + steps(5) + "<h2>この内容で予約しますか？</h2>" +
      mominokiNote() +
      '<div class="card summary"><dl>' +
      "<dt>ご予約先</dt><dd>" + esc(S.business.name) + "</dd>" +
      "<dt>メニュー</dt><dd>" + esc(S.menu.name) + "（" + S.menu.durationMin + "分）</dd>" +
      "<dt>日時</dt><dd>" + md(S.slot.date) + "（" + esc(S.slot.weekday) + "）" + esc(S.slot.time) + "〜</dd>" +
      "<dt>料金</dt><dd>" + yen(S.menu.priceYen) + "</dd>" +
      (S.symptoms.length ? "<dt>気になる所</dt><dd>" + esc(S.symptoms.join("・")) + "</dd>" : "") +
      '<dt>お名前</dt><dd class="namerow"><span>' + esc(p.name) + ' 様</span><button class="link" id="chg">変更する</button></dd>' +
      "</dl></div>" +
      (p.isReturning ? "" : p.noShowHold
        ? '<div class="info">ご来院のない予約が続いたため、<br>今回は「仮予約」でお預かりします。<br>確定したらLINEでお知らせします。</div>'
        : '<div class="info">初めての方は「仮予約」になります。<br>確定したらLINEでお知らせします。</div>') +
      '<button class="btn" id="book">予約する</button>';
    view(h);
    document.getElementById("back").onclick = function () { chooseSymptoms(); };
    document.getElementById("chg").onclick = function () { S.afterProfile = confirmView; profile(); };
    document.getElementById("book").onclick = function () {
      var btn = this; btn.disabled = true; btn.textContent = "送っています…";
      api("book", { menuId: S.menu.id, startsAt: S.slot.startsAt, symptoms: S.symptoms }).then(function (r) {
        S.data.bookings = r.bookings;
        done(r.booking);
      }, function (e) {
        var code = fail(e);
        if (code === "slot_not_available") { chooseTime(); return; }
        btn.disabled = false; btn.textContent = "予約する";
      });
    };
  }

  function done(b) {
    var ok = b && b.status === "confirmed";
    var h = '<div class="card center">' +
      '<div class="ok-mark' + (ok ? " confirmed" : "") + '" aria-hidden="true"></div>' +
      "<h2>" + (ok ? "ご予約が確定しました" : "仮予約を受け付けました") + "</h2>" +
      (b ? "<p><b>" + md(b.date) + "（" + esc(b.weekday) + "）" + esc(b.time) + "〜</b><br>" + esc(b.businessName) + "　" + esc(b.menuName) + "</p>" : "") +
      (ok ? "<p>当日お待ちしております。</p>" : "<p>確定したらLINEでお知らせします。<br>もうしばらくお待ちください。</p>") +
      "</div>" +
      '<button class="btn" id="close">' + (liff.isInClient() ? "閉じる" : "ご予約の状況へ") + "</button>";
    view(h);
    document.getElementById("close").onclick = function () {
      if (liff.isInClient()) liff.closeWindow(); else home();
    };
  }

  // ---------- 文字の大きさ（この端末に覚えておく） ----------
  function applySize(z) {
    var root = document.documentElement.style;
    root.setProperty("--text-zoom", String(z));
    root.setProperty("--time-cols", z >= 1.4 ? "2" : z >= 1.2 ? "3" : "4");
    Array.prototype.forEach.call(document.querySelectorAll("[data-size]"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-size") === String(z)));
    });
  }
  (function () {
    var z = 1;
    try { z = Number(localStorage.getItem("lp_text_zoom")) || 1; } catch (_) { /* 何もしない */ }
    if ([1, 1.2, 1.4].indexOf(z) < 0) z = 1;
    applySize(z);
    Array.prototype.forEach.call(document.querySelectorAll("[data-size]"), function (b) {
      b.onclick = function () {
        var v = Number(b.getAttribute("data-size"));
        applySize(v);
        try { localStorage.setItem("lp_text_zoom", String(v)); } catch (_) { /* 何もしない */ }
      };
    });
  })();

  // ---------- 起動 ----------
  function boot() {
    if (!window.liff || !CFG.LIFF_ID) { view('<div class="card">ページの準備ができていません。</div>'); return; }
    liff.init({ liffId: CFG.LIFF_ID }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      return api("init").then(function (d) { S.data = d; home(); }, function (e) {
        if (fail(e) === "customer_blocked") view('<div class="card">' + esc(ERR.customer_blocked) + "</div>");
        else if (e.code !== "no_token" && e.code !== "token_invalid")
          view('<div class="card">' + esc(ERR[e.code] || ERR.server_error) + '</div><button class="btn" onclick="location.reload()">もう一度読み込む</button>');
      });
    }, function () {
      view('<div class="card">LINEとのつながりを準備できませんでした。LINEアプリから開き直してください。</div>');
    });
  }
  boot();
})();
