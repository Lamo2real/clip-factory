// Injected by the Clip Factory desktop wrapper before the page's own scripts (docs/CONTRACTS.md §12.3).
// 1. Tells the web app it runs inside the wrapper, so it hides "Get the app".
// 2. Says which native see-through glass is behind the page (window.__CF_GLASS__: "liquid", "vibrancy", "acrylic",
//    "blur" or "none"; set just above this script by main.rs, §22). The web app goes transparent only when it is
//    not "none", and tints its panels for the glass it is told. Wrappers built before 2026-11-16 16:54 never set it,
//    which is how the page tells an old copy from a computer that truly cannot show glass.
// 3. Says which version of the app this is (window.__CF_DESKTOP_VERSION__, set just above by main.rs, §12.6).
// 4. Says how tall the title bar band laid over the page is (window.__CF_TITLEBAR__, in CSS px; set just above this
//    script by main.rs: 28 on macOS, where the title bar is transparent and the traffic lights float over the page,
//    0 elsewhere). The web app keeps that band clear and starts every column below it (docs/CONTRACTS.md §11.1).
// 5. Mac fetches it (docs/CONTRACTS.md §35): window.__CF_MAC_FETCH__ lets the page ask this app to get a YouTube
//    video on this computer's own connection and send it to the job. Four commands only (start, status, upload,
//    cancel), which main.rs grants to the app's own address in this window and nowhere else.
// 6. Connect Content Rewards (docs/CONTRACTS.md §38.15): window.__CF_CR_CONNECT__ (version 1) lets the page open a
//    one-time sign-in door on this computer (127.0.0.1, ports 47811-47815, 5 minutes), open Content Rewards' own
//    sign-in page in the system browser, and read the answer once. Four commands only (listen, open, result,
//    cancel), granted like Mac fetches it. Errors are {code: "no_port" | "bad_url" | "unsupported" | "busy"}; off
//    macOS listen answers unsupported.
// 7. Links to other sites (and window.open) become a plain navigation, which the wrapper catches and opens
//    in the system browser. The page itself never leaves the app. Same-site links open in this window.
(function () {
  "use strict";
  window.__CF_DESKTOP__ = true;
  if (typeof window.__CF_GLASS__ !== "string") window.__CF_GLASS__ = "none";
  if (typeof window.__CF_TITLEBAR__ !== "number") window.__CF_TITLEBAR__ = 0;

  // Tauri's own bridge is read at call time, so the order of the injected scripts does not matter.
  var call = function (cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return Promise.reject(new Error("no_bridge"));
    return internals.invoke(cmd, args);
  };
  window.__CF_MAC_FETCH__ = Object.freeze({
    version: 1,
    start: function (jobId, url) {
      return call("mac_fetch_start", { jobId: String(jobId), url: String(url) });
    },
    status: function (jobId) {
      return call("mac_fetch_status", { jobId: String(jobId) });
    },
    upload: function (jobId, partSize, parts) {
      return call("mac_fetch_upload", { jobId: String(jobId), partSize: Number(partSize), parts: parts });
    },
    cancel: function (jobId) {
      return call("mac_fetch_cancel", { jobId: String(jobId) });
    },
  });

  // Errors always reach the page as {code}, even before Tauri's bridge is there.
  var crCall = function (cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return Promise.reject({ code: "unsupported" });
    return internals.invoke(cmd, args);
  };
  window.__CF_CR_CONNECT__ = Object.freeze({
    version: 1,
    listen: function () {
      return crCall("cr_connect_listen", {});
    },
    open: function (url) {
      return crCall("cr_connect_open", { url: String(url) });
    },
    result: function () {
      return crCall("cr_connect_result", {});
    },
    cancel: function () {
      return crCall("cr_connect_cancel", {});
    },
  });

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
