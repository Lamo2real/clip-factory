// Injected by the Clip Factory desktop wrapper before the page's own scripts (docs/CONTRACTS.md §12.3).
// 1. Tells the web app it runs inside the wrapper, so it hides "Get the app".
// 2. Says which native see-through glass is behind the page (window.__CF_GLASS__: "vibrancy", "acrylic", "blur"
//    or "none"; set just above this script by main.rs, §22). The web app goes transparent only when it is not "none".
// 3. Links to other sites (and window.open) become a plain navigation, which the wrapper catches and opens
//    in the system browser. The page itself never leaves the app. Same-site links open in this window.
(function () {
  "use strict";
  window.__CF_DESKTOP__ = true;
  if (typeof window.__CF_GLASS__ !== "string") window.__CF_GLASS__ = "none";

  function parse(href) {
    try {
      return new URL(href, window.location.href);
    } catch (_) {
      return null;
    }
  }

  function isOutward(url) {
    return (
      url !== null &&
      url.origin !== window.location.origin &&
      (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:")
    );
  }

  document.addEventListener(
    "click",
    function (event) {
      if (event.button !== 0 && event.button !== 1) return;
      var target = event.target;
      var link = target && target.closest ? target.closest("a[href]") : null;
      if (!link || link.hasAttribute("download")) return;
      var url = parse(link.href);
      if (isOutward(url)) {
        event.preventDefault();
        window.location.assign(url.href);
      } else if (url !== null && link.target && link.target !== "_self") {
        // A web view cannot open a second window; show same-site pages here instead of doing nothing.
        event.preventDefault();
        window.location.assign(url.href);
      }
    },
    true
  );

  var nativeOpen = window.open;
  window.open = function (href, target, features) {
    var url = href === undefined || href === null ? null : parse(String(href));
    if (url !== null && (isOutward(url) || target === undefined || target === "_blank")) {
      window.location.assign(url.href);
      return null;
    }
    return nativeOpen.call(window, href, target, features);
  };
})();
