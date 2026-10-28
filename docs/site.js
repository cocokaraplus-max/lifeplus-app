/* LIFE PLUS ホームページ  marker: lifeplus-site-v1 / lifeplus-site-v2 / site-contact-v1 / lifeplus-site-cms-v1 */
(function () {
  "use strict";

  // ---------- 文字の大きさ（予約ページと同じ設定を使う） ----------
  function applySize(z) {
    document.documentElement.style.setProperty("--text-zoom", String(z));
    Array.prototype.forEach.call(document.querySelectorAll("[data-size]"), function (b) {
      b.setAttribute("aria-pressed", Number(b.getAttribute("data-size")) === z ? "true" : "false");
    });
  }
  var z = 1;
  try { z = Number(localStorage.getItem("lp_text_zoom")) || 1; } catch (_) { /* 何もしない */ }
  if ([1, 1.2, 1.4].indexOf(z) < 0) z = 1;
  applySize(z);
  Array.prototype.forEach.call(document.querySelectorAll("[data-size]"), function (b) {
    b.addEventListener("click", function () {
      var v = Number(b.getAttribute("data-size"));
      applySize(v);
      try { localStorage.setItem("lp_text_zoom", String(v)); } catch (_) { /* 何もしない */ }
    });
  });

  // ---------- 少し下へ動かしたら、上の帯に線を引く ----------
  var top = document.querySelector(".site-top");
  if (top) {
    var onScroll = function () { top.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }

  // ---------- スマホのメニュー ----------
  var mb = document.querySelector(".menu-btn"), nav = document.querySelector(".nav");
  if (mb && nav) {
    // lifeplus-nav-v1：丸いハンバーガー。行き先を押す・Esc で閉じる
    var setMenu = function (open) {
      nav.classList.toggle("open", open);
      mb.classList.toggle("on", open);
      mb.setAttribute("aria-expanded", open ? "true" : "false");
      mb.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
      var lb = mb.querySelector(".mb-lb");
      if (lb) lb.textContent = open ? "CLOSE" : "MENU";
    };
    mb.addEventListener("click", function () { setMenu(!nav.classList.contains("open")); });
    nav.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) setMenu(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) { setMenu(false); mb.focus(); }
    });
  }

  // ---------- お問い合わせ（site-contact-v1） ----------
  var ERR = {
    contact_name: "お名前を入れてください。",
    contact_kind: "ご用件を選んでください。",
    contact_reach: "折り返しのご連絡先として、お電話かメールのどちらかを入れてください。",
    phone_invalid: "電話番号の形が違うようです。市外局番から入れてください。",
    email_invalid: "メールアドレスの形が違うようです。",
    contact_link: "URL（http や www で始まるもの）は書けません。消してから送ってください。",
    contact_too_many: "送信が続いたため、いまは受け付けていません。少し時間をおくか、お電話でご連絡ください。",
    contact_invalid: "送れませんでした。お手数ですが、お電話でご連絡ください。"
  };
  var form = document.getElementById("contact");
  if (form) {
    var opened = Date.now();
    var msg = form.querySelector(".msg");
    var btn = form.querySelector("button[type=submit]");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var f = form.elements;
      var body = {
        action: "contact", business: form.getAttribute("data-business") || "other",
        kind: f.kind ? f.kind.value : "", jobId: f.jobId ? f.jobId.value : "", name: f.name.value, org: f.org ? f.org.value : "",
        phone: f.phone.value, email: f.email.value, body: f.body.value,
        website: f.website.value, elapsed: Date.now() - opened
      };
      function show(ok, text) { msg.hidden = false; msg.className = "msg " + (ok ? "ok" : "ng"); msg.textContent = text; }
      if (!body.name.trim()) { show(false, ERR.contact_name); f.name.focus(); return; }
      if (!body.phone.trim() && !body.email.trim()) { show(false, ERR.contact_reach); f.phone.focus(); return; }
      if (/https?:|www\./i.test(body.body + " " + body.org + " " + body.name)) { show(false, ERR.contact_link); f.body.focus(); return; }
      btn.disabled = true; btn.textContent = "送っています…";
      var cfg = window.LP_CONFIG || {};
      fetch(cfg.API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (x.ok && x.j && x.j.ok) {
            form.reset(); opened = Date.now();
            show(true, "送りました。内容を確かめて、担当からご連絡します。");
          } else {
            show(false, ERR[x.j && x.j.error] || ERR.contact_invalid);
          }
        }, function () { show(false, "送れませんでした。通信のよい所でもう一度送るか、お電話でご連絡ください。"); })
        .then(function () { btn.disabled = false; btn.textContent = "この内容で送る"; });
    });
  }
})();

/* ---------- ホームページの変えられる所（lifeplus-site-cms-v1） ----------
   管理画面で変えた「お知らせ・求人・デイの利用時間・受付時間・ボディケアの料金・写真」を、関所から読んで差し替える。
   読めなかったときは、ページに書いてある元の中身のまま。 */
(function () {
  "use strict";
  var cfg = window.LP_CONFIG || {};
  var WD = ["", "月", "火", "水", "木", "金", "土", "日"];
  var BIZ = { all: "", day: "デイサービス", sekkotsu: "接骨院", bodycare: "ボディケア", company: "会社" };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function br(s) { return esc(s).replace(/\n/g, "<br>"); }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  function md(ymd) { var p = ymd.split("-"); return Number(p[0]) + "." + Number(p[1]) + "." + Number(p[2]); }
  function yen(n) { return "¥" + Number(n).toLocaleString("ja-JP"); }

  // メールアドレスは、機械に読み取られにくいよう画面でだけ組み立てる
  each("[data-mail]", function (a) {
    var m = a.getAttribute("data-mail") + "@" + a.getAttribute("data-dom");
    a.href = "mailto:" + m; a.textContent = m;
  });

  // 受付時間：同じ時間の曜日をまとめる（例：月曜・木曜 17:00〜20:00）
  function groupHours(list) {
    var by = {};
    list.forEach(function (h) { (by[h.weekday] = by[h.weekday] || []).push(h.open + "〜" + h.close); });
    var groups = [];
    Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).forEach(function (w) {
      var t = by[w].join("・");
      var g = groups.filter(function (x) { return x.t === t; })[0];
      if (g) g.w.push(w); else groups.push({ t: t, w: [w] });
    });
    return groups;
  }

  function render(d) {
    // 写真
    var ph = d.photos || {};
    each("img[data-photo]", function (img) {
      var u = ph[img.getAttribute("data-photo")];
      if (u && /^https:\/\//.test(u)) { img.src = u; img.removeAttribute("srcset"); }
    });
    // デイの利用時間
    if (d.dayHours) {
      each("[data-cms]", function (el) {
        var k = el.getAttribute("data-cms"), v = { day_am: d.dayHours.am, day_pm: d.dayHours.pm, day_sun: d.dayHours.sun, day_days: d.dayHours.days }[k];
        if (v == null) return;
        if (!v) { el.hidden = true; return; }
        el.textContent = (el.getAttribute("data-prefix") || "") + v;
      });
    }
    // 接骨院・ボディケアの受付時間（予約の設定と同じもの）
    if (d.rsvHours && d.rsvHours.length) {
      var g = groupHours(d.rsvHours);
      // 帯の中の「曜日と時間」のマスを、今の受付時間で作り直す
      var cells = document.querySelectorAll("[data-rsv-cell]");
      if (cells.length) {
        var parent = cells[0].parentNode, first = cells[0];
        g.forEach(function (x) {
          var dv = document.createElement("div");
          dv.setAttribute("data-rsv-cell", "");
          dv.innerHTML = "<b>" + x.w.map(function (w) { return WD[w] + "曜"; }).join("・") + "</b><span>" + esc(x.t) + "</span>";
          parent.insertBefore(dv, first);
        });
        Array.prototype.forEach.call(cells, function (c) { c.parentNode.removeChild(c); });
      }
      each("[data-rsv-hours=text]", function (el) {
        el.textContent = g.map(function (x) { return x.w.map(function (w) { return WD[w]; }).join("・") + " " + x.t; }).join("／");
      });
    }
    // ボディケアのメニュー
    if (d.menus && d.menus.length) {
      each("[data-menus]", function (box) {
        box.innerHTML = d.menus.map(function (m) {
          return '<div class="menu-item' + (m.featured ? " main" : "") + '"><h3>' + esc(m.name) + "<small>" + esc(m.durationMin) + " min</small></h3>" +
            '<span class="price">' + (m.priceYen == null ? "" : yen(m.priceYen)) + "</span>" + (m.description ? "<p>" + esc(m.description) + "</p>" : "") + "</div>";
        }).join("");
      });
    }
    // お知らせ
    each("[data-news]", function (sec) {
      var want = sec.getAttribute("data-news"), max = Number(sec.getAttribute("data-max") || 5);
      var list = (d.news || []).filter(function (n) { return want === "all" || n.business === "all" || n.business === want; }).slice(0, max);
      var box = sec.querySelector(".news-list");
      if (!list.length || !box) { sec.hidden = true; return; }
      box.innerHTML = list.map(function (n) {
        return '<li><time datetime="' + esc(n.date) + '">' + esc(md(n.date)) + "</time>" +
          (n.business !== "all" && want === "all" ? '<span class="nb nb-' + esc(n.business) + '">' + esc(BIZ[n.business]) + "</span>" : "") +
          (n.body ? "<details><summary>" + esc(n.title) + "</summary><p>" + br(n.body) + "</p></details>" : "<span class=\"nt\">" + esc(n.title) + "</span>") + "</li>";
      }).join("");
      sec.hidden = false;
    });
    // 求人（採用ページ）
    each("[data-jobs]", function (box) {
      var jobs = d.jobs || [];
      var none = document.querySelector("[data-jobs-none]");
      if (none) none.hidden = jobs.length > 0;
      var bizs = []; jobs.forEach(function (j) { if (bizs.indexOf(j.business) < 0) bizs.push(j.business); });
      var chips = document.querySelector("[data-job-chips]");
      if (chips) {
        chips.hidden = bizs.length < 2;
        chips.innerHTML = ['<button type="button" data-jf="" aria-pressed="true">すべて</button>'].concat(bizs.map(function (b) {
          return '<button type="button" data-jf="' + esc(b) + '" aria-pressed="false">' + esc(BIZ[b]) + "</button>";
        })).join("");
        Array.prototype.forEach.call(chips.querySelectorAll("[data-jf]"), function (c) {
          c.onclick = function () {
            var f = c.getAttribute("data-jf");
            Array.prototype.forEach.call(chips.querySelectorAll("[data-jf]"), function (x) { x.setAttribute("aria-pressed", String(x === c)); });
            Array.prototype.forEach.call(box.querySelectorAll(".job"), function (el) { el.hidden = !!f && el.getAttribute("data-biz") !== f; });
          };
        });
      }
      var rows = [["仕事の内容", "duties"], ["応募の条件", "requirements"], ["給与", "salary"], ["勤務時間", "hours"], ["休日", "holidays"], ["待遇・手当", "benefits"]];
      box.innerHTML = jobs.map(function (j) {
        return '<article class="job c-' + esc(j.business === "sekkotsu" ? "kotsu" : j.business === "bodycare" ? "body" : j.business === "company" ? "app" : "day") + '" data-biz="' + esc(j.business) + '">' +
          '<div class="job-head"><span class="job-biz">' + esc(BIZ[j.business]) + '</span><span class="job-emp">' + esc(j.employment) + "</span></div>" +
          "<h3>" + esc(j.title) + "</h3>" + (j.summary ? '<p class="job-sum">' + br(j.summary) + "</p>" : "") +
          '<dl class="facts">' + rows.filter(function (r) { return j[r[1]]; }).map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + br(j[r[1]]) + "</dd>"; }).join("") + "</dl>" +
          '<a class="btn solid" href="#apply" data-apply="' + esc(j.id) + '">この求人に応募する</a></article>';
      }).join("");
      var sel = document.querySelector("#contact select[name=jobId]");
      if (sel) {
        sel.innerHTML = jobs.map(function (j) { return '<option value="' + esc(j.id) + '">' + esc(BIZ[j.business] + "／" + j.title + "（" + j.employment + "）") + "</option>"; }).join("") +
          '<option value="">求人全般・そのほかの相談</option>';
        Array.prototype.forEach.call(box.querySelectorAll("[data-apply]"), function (a) {
          a.addEventListener("click", function () { sel.value = a.getAttribute("data-apply"); });
        });
      }
    });
    each("[data-job-count]", function (el) {
      var n = (d.jobs || []).length;
      el.textContent = n ? "いま " + n + " 件の募集があります" : "";
      el.hidden = !n;
    });
  }

  if (!cfg.API_URL) return;
  fetch(cfg.API_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "site" }) })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) render(d); }, function () { /* 読めなければ元のまま */ });
})();
