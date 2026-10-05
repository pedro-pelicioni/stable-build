// stable-build landing page: runs in <head> before the first paint (not deferred).
// Picks the starting language: ?lang=, then the saved choice, then the browser's first language.
// For Portuguese it marks <html>, starts loading assets/pt.js right away and holds the translated
// parts of the page back (class i18n-pending, see style.css) until main.js has swapped the copy in,
// so English never paints first and then jumps. A 1-second failsafe shows the page regardless.
(function () {
  "use strict";
  var root = document.documentElement;

  function normalize(value) {
    if (!value) return null;
    var v = String(value).trim().toLowerCase();
    if (v === "pt" || v === "pt-br" || v === "pt_br") return "pt";
    if (v === "en") return "en";
    return null;
  }

  var lang = null;
  try { lang = normalize(new URLSearchParams(window.location.search).get("lang")); } catch (e) { /* old browser */ }
  if (!lang) {
    try { lang = normalize(window.localStorage.getItem("stable-build-lang")); } catch (e) { /* storage blocked */ }
  }
  if (!lang) {
    var prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || "en"];
    lang = /^pt\b/i.test(prefs[0] || "") ? "pt" : "en";
  }
  window.SB_START_LANG = lang;
  if (lang !== "pt") return;

  root.setAttribute("lang", "pt-BR");
  root.classList.add("i18n-pending");

  var s = document.createElement("script");
  s.id = "sb-pt";
  s.src = "assets/pt.js";
  s.onerror = function () { s.setAttribute("data-failed", "1"); };
  document.head.appendChild(s);

  window.setTimeout(function () {
    if (!root.classList.contains("i18n-pending")) return;
    root.classList.remove("i18n-pending");
    if (root.getAttribute("data-lang-applied") !== "pt") root.setAttribute("lang", "en");
  }, 1000);
})();
