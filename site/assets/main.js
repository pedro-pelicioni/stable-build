// stable-build landing page: EN/PT toggle, copy buttons, code-panel focus, the hero terminal, the
// scroll reveal and the card spotlight. No dependencies.
// assets/boot.js runs first (in <head>) and sets window.SB_START_LANG; for Portuguese it has already
// started loading assets/pt.js. English visitors never download pt.js unless they press PT.
(function () {
  "use strict";

  var STORE_KEY = "stable-build-lang";
  var PT_SRC = "assets/pt.js";
  var EN_UI = {
    "ui.copy": "Copy",
    "ui.copied": "Copied",
    "ui.copiedLive": "Command copied.",
    "ui.selected": "Selected",
    "ui.selectedLive": "Could not copy; the command is selected instead."
  };
  var root = document.documentElement;
  var current = "en";
  var enHtml = new Map();   // element -> English innerHTML, captured before the first swap
  var enAttrs = new Map();  // element -> { attribute: English value }
  var enTitle = document.title;
  var live = document.getElementById("live");

  function dict() { return window.SB_PT || {}; }

  function t(key) {
    var PT = dict();
    if (current === "pt" && PT[key] != null) return PT[key];
    return EN_UI[key];
  }

  function readStored() {
    try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function store(value) {
    try { window.localStorage.setItem(STORE_KEY, value); } catch (e) { /* private mode or blocked storage */ }
  }
  function normalize(value) {
    if (!value) return null;
    var v = String(value).trim().toLowerCase();
    if (v === "pt" || v === "pt-br" || v === "pt_br") return "pt";
    if (v === "en") return "en";
    return null;
  }
  function initialLang() {
    var fromBoot = normalize(window.SB_START_LANG);
    if (fromBoot) return fromBoot;
    var fromUrl = null;
    try { fromUrl = normalize(new URLSearchParams(window.location.search).get("lang")); } catch (e) { /* old browser */ }
    if (fromUrl) return fromUrl;
    var saved = normalize(readStored());
    if (saved) return saved;
    return "en";
  }

  // Loads the Portuguese dictionary once; done(ok) runs when window.SB_PT is ready or loading failed.
  var ptWaiters = null;
  function loadPt(done) {
    if (window.SB_PT) { done(true); return; }
    if (ptWaiters) { ptWaiters.push(done); return; }
    ptWaiters = [done];
    function finish(ok) {
      var waiting = ptWaiters || [];
      ptWaiters = null;
      for (var i = 0; i < waiting.length; i++) waiting[i](ok && !!window.SB_PT);
    }
    var s = document.getElementById("sb-pt");
    if (s && s.getAttribute("data-failed")) { s.parentNode.removeChild(s); s = null; }
    if (!s) {
      s = document.createElement("script");
      s.id = "sb-pt";
      s.src = PT_SRC;
      document.head.appendChild(s);
    }
    s.addEventListener("load", function () { finish(true); });
    s.addEventListener("error", function () { s.setAttribute("data-failed", "1"); finish(false); });
  }

  function apply(lang) {
    current = lang === "pt" ? "pt" : "en";
    var PT = dict();
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!enHtml.has(el)) enHtml.set(el, el.innerHTML);
      var key = el.getAttribute("data-i18n");
      el.innerHTML = (current === "pt" && PT[key] != null) ? PT[key] : enHtml.get(el);
    }
    var attrNodes = document.querySelectorAll("[data-i18n-attr]");
    for (var j = 0; j < attrNodes.length; j++) {
      var node = attrNodes[j];
      var pairs = node.getAttribute("data-i18n-attr").split(";");
      if (!enAttrs.has(node)) enAttrs.set(node, {});
      var saved = enAttrs.get(node);
      for (var k = 0; k < pairs.length; k++) {
        var parts = pairs[k].split(":");
        var attr = parts[0].trim();
        var akey = (parts[1] || "").trim();
        if (!attr || !akey) continue;
        if (!(attr in saved)) saved[attr] = node.getAttribute(attr);
        node.setAttribute(attr, (current === "pt" && PT[akey] != null) ? PT[akey] : saved[attr]);
      }
    }
    root.setAttribute("lang", current === "pt" ? "pt-BR" : "en");
    root.setAttribute("data-lang-applied", current);
    document.title = (current === "pt" && PT["meta.title"]) ? PT["meta.title"] : enTitle;

    var toggles = document.querySelectorAll(".lang button[data-lang]");
    for (var m = 0; m < toggles.length; m++) {
      toggles[m].setAttribute("aria-pressed", String(toggles[m].getAttribute("data-lang") === current));
    }
    var copies = document.querySelectorAll(".copy");
    for (var n = 0; n < copies.length; n++) resetCopy(copies[n]);
    if (typeof onLangApplied === "function") onLangApplied();
  }

  function reveal() { root.classList.remove("i18n-pending"); }

  function switchTo(lang, save) {
    if (lang !== "pt") {
      apply("en");
      if (save) store("en");
      reveal();
      return;
    }
    loadPt(function (ok) {
      apply(ok ? "pt" : "en");
      if (ok && save) store("pt");
      reveal();
    });
  }

  // ---- Copy buttons ----

  function commandText(code) {
    var lines = code.querySelectorAll(".l");
    if (!lines.length) return code.textContent.trim();
    var out = [];
    for (var i = 0; i < lines.length; i++) out.push(lines[i].textContent);
    return out.join("\n");
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function selectNode(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* nothing else to do */ }
  }

  // Only the visible text changes; aria-describedby (which command) stays on the button.
  function resetCopy(btn) {
    btn.classList.remove("is-done");
    btn.textContent = t("ui.copy");
  }

  function announce(message) {
    if (!live) return;
    live.textContent = "";
    window.setTimeout(function () { live.textContent = message; }, 30);
  }

  function onCopy(event) {
    var btn = event.currentTarget;
    var code = document.getElementById(btn.getAttribute("data-copy"));
    if (!code) return;
    copyText(commandText(code)).then(function (ok) {
      if (ok) {
        btn.classList.add("is-done");
        btn.textContent = t("ui.copied");
        announce(t("ui.copiedLive"));
      } else {
        selectNode(code);
        btn.textContent = t("ui.selected");
        announce(t("ui.selectedLive"));
      }
      window.clearTimeout(btn._sbTimer);
      btn._sbTimer = window.setTimeout(function () { resetCopy(btn); }, 2000);
    });
  }

  // ---- Code panels: a tab stop only when they scroll sideways ----

  var panels = document.querySelectorAll("pre.code");
  function syncPanels() {
    for (var i = 0; i < panels.length; i++) {
      var el = panels[i];
      if (el.scrollWidth > el.clientWidth + 1) el.setAttribute("tabindex", "0");
      else if (el !== document.activeElement) el.removeAttribute("tabindex");
    }
  }
  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(syncPanels, 150);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncPanels);

  // ---- Motion: hero terminal, scroll reveal, card spotlight ----
  // boot.js adds .motion to <html> unless the visitor prefers reduced motion; without it every line
  // and card is simply shown. "motion-ready" tells boot.js's failsafe that this script is running.

  var motion = root.classList.contains("motion");
  root.classList.add("motion-ready");

  var term = document.getElementById("term");
  var termLines = term ? term.querySelectorAll(".t-line") : [];
  var termTimers = [];
  var termStarted = false;
  var TYPE_MS = 34;

  function clearTerm() {
    for (var i = 0; i < termTimers.length; i++) window.clearTimeout(termTimers[i]);
    termTimers = [];
    for (var j = 0; j < termLines.length; j++) termLines[j].classList.remove("on", "is-current");
  }

  function at(ms, fn) { termTimers.push(window.setTimeout(fn, ms)); }

  function showLine(i) {
    return function () {
      if (i > 0) termLines[i - 1].classList.remove("is-current");
      termLines[i].classList.add("on", "is-current");
    };
  }

  function runTerm() {
    clearTerm();
    var t = 300;
    for (var i = 0; i < termLines.length; i++) {
      var line = termLines[i];
      var typed = line.querySelector(".t-type");
      if (typed) {
        var n = Math.max(1, typed.textContent.length);
        typed.style.setProperty("--n", String(n));
        at(t, showLine(i));
        t += n * TYPE_MS + 520;
      } else {
        at(t, showLine(i));
        t += line.classList.contains("t-warn") ? 1300 : 650;
      }
    }
    at(t + 6500, runTerm);
  }

  function startTerm() {
    if (termStarted || !motion || !termLines.length) return;
    termStarted = true;
    runTerm();
  }

  function onLangApplied() { if (termStarted) runTerm(); }

  if (motion && "IntersectionObserver" in window) {
    var revealer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        revealer.unobserve(e.target);
        if (e.target === term) startTerm();
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    var items = document.querySelectorAll("[data-reveal]");
    for (var r = 0; r < items.length; r++) {
      var el = items[r];
      var sibs = el.parentNode ? el.parentNode.querySelectorAll(":scope > [data-reveal]") : [];
      var idx = Array.prototype.indexOf.call(sibs, el);
      if (idx > 0) el.style.transitionDelay = Math.min(idx, 6) * 70 + "ms";
      revealer.observe(el);
    }
  } else if (motion) {
    root.classList.remove("motion");
    motion = false;
  }

  var spots = document.querySelectorAll(".spot");
  for (var sp = 0; sp < spots.length; sp++) {
    spots[sp].addEventListener("pointermove", function (event) {
      var box = event.currentTarget.getBoundingClientRect();
      event.currentTarget.style.setProperty("--mx", (event.clientX - box.left) + "px");
      event.currentTarget.style.setProperty("--my", (event.clientY - box.top) + "px");
    });
  }

  // ---- Init ----

  var buttons = document.querySelectorAll(".copy[data-copy]");
  for (var b = 0; b < buttons.length; b++) {
    buttons[b].hidden = false;
    buttons[b].addEventListener("click", onCopy);
  }

  var group = document.querySelector(".lang");
  if (group) {
    group.hidden = false;
    group.addEventListener("click", function (event) {
      var target = event.target.closest ? event.target.closest("button[data-lang]") : null;
      if (!target) return;
      var lang = target.getAttribute("data-lang");
      if (lang === current) return;
      switchTo(lang, true);
    });
  }

  syncPanels();
  if (initialLang() === "pt") switchTo("pt", false);
  else {
    var copies = document.querySelectorAll(".copy");
    for (var c = 0; c < copies.length; c++) resetCopy(copies[c]);
    reveal();
  }
})();
