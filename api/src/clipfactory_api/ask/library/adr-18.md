## ADR-18 A thin Tauri desktop wrapper, not Electron

- **Context.** After the first build the owner asked for a real download: "if it's a Mac, then it should be a DMG
  file ... if it's on Windows operating system, then it should be an exe file". A PWA installs from the browser but
  produces no file to download. The web app must stay the single source of the screens and update the moment it deploys.
- **Decision.** A Tauri v2 app in `desktop/` that opens `app_url` in the operating system's own web view (WebKit on
  macOS, WebView2 on Windows). It bundles no screens; it adds the window title, icon, minimum size, remembered
  position, outside links in the normal browser, and the markers (`ClipFactoryDesktop` in the user agent,
  `window.__CF_DESKTOP__`) that hide Get the app inside it. GitHub's macOS and Windows runners build a universal `.dmg`
  and an NSIS `.exe` in `deploy.yml`.
- **Alternatives.** Electron (ships a whole Chromium: about 100 MB per download against about 10 MB, more memory, and
  a Chromium to keep patched; nothing in this app needs Node in the desktop); a native Swift/WinUI app (two codebases);
  only the PWA (no `.dmg`/`.exe`, which the owner explicitly asked for).
- **Consequences.** Small downloads, nothing extra to keep in step with the web app. The web view differs per system
  (Safari's engine on Mac, Edge's on Windows), so the web app must keep working in both, which it already must for
  browsers. Rust and the Tauri CLI are needed only on the CI runners.
