/* LIFE PLUS ホームページ  marker: lifeplus-site-v1 / lifeplus-site-v2 / site-contact-v1 */
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
    mb.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      mb.setAttribute("aria-expanded", open ? "true" : "false");
      mb.textContent = open ? "閉じる" : "メニュー";
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
        kind: f.kind.value, name: f.name.value, org: f.org ? f.org.value : "",
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
