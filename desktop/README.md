# Clip Factory desktop app

A thin native window for Mac and Windows that opens the deployed Clip Factory web app
(docs/CONTRACTS.md §12.3). It is built with [Tauri v2](https://v2.tauri.app) and **bundles no web UI**: the
window shows the live website, so every web release reaches desktop users through the normal update banner
("What's new" and Reload). The installers only need a rebuild when this folder or the app icon changes.

## What it does

| Feature | How |
|---|---|
| Opens the app | Address baked in at build time from `CF_APP_URL` (Terraform output `app_url`) by `src-tauri/build.rs`. A release build without it stops with a clear error. Debug builds fall back to `http://localhost:5173/`. |
| Window | Title "Clip Factory", starts at 1200 × 820, never smaller than 380 × 600. |
| Remembers size and position | `tauri-plugin-window-state` (saved on close, restored on start). |
| Links to other sites | Open in the system browser (`tauri-plugin-opener`, called from Rust). Mail links open the mail app. Anything else (`file:`, custom schemes) is blocked. |
| Tells the web app it is installed | `window.__CF_DESKTOP__ = true` (injected by `src-tauri/src/init.js` before the page loads) and a user agent ending in `ClipFactoryDesktop/<version>`. The web app then hides "Get the app". |
| Icon | Generated from `web/public/icons/icon-512.png` by `scripts/make-icons.sh` (also run by every CI build). |
| Installers | Mac: universal `.dmg` (Apple silicon and Intel). Windows: NSIS `-setup.exe`, installs for the current user only and fetches the WebView2 runtime if missing. |

### Security

The page inside the window is a remote website, so it gets **no native access at all**: the only capability
(`src-tauri/capabilities/main.json`) grants nothing, `withGlobalTauri` is off, and there is no file system or
shell plugin. Opening links and saving the window state happen in Rust. Navigation away from the app's own
origin is cancelled in `src-tauri/src/main.rs` and handed to the system browser.

About the user agent: web views cannot append to their default user agent, so the wrapper sets a full one in
the usual shape for each platform's engine, with `ClipFactoryDesktop/<version>` at the end.

## Files

```
desktop/
  package.json                 the Tauri CLI (pinned), and npm scripts
  scripts/make-icons.sh        icons from the web app icon
  src-tauri/
    Cargo.toml, Cargo.lock     Rust crate (tauri 2, opener and window-state plugins)
    build.rs                   reads and checks CF_APP_URL
    tauri.conf.json            product name, identifier app.clipfactory.desktop, bundle settings
    capabilities/main.json     deliberately empty permission set
    icons/                     generated, committed
    src/main.rs                the window, link handling, user agent (+ unit tests)
    src/init.js                injected script (desktop flag, outward links)
```

## Build it yourself

Needs Node 20+ and Rust (`brew install rustup && rustup-init -y`, or https://rustup.rs). On Windows also
the "Desktop development with C++" build tools; on Linux the WebKitGTK libraries listed in `.github/workflows/ci.yml`.

```bash
cd desktop
npm ci
npm run icons                     # only after changing web/public/icons/icon-512.png

# Mac, universal .dmg
rustup target add aarch64-apple-darwin x86_64-apple-darwin
CF_APP_URL=https://dxxxx.cloudfront.net npm run build:mac
#   -> src-tauri/target/universal-apple-darwin/release/bundle/dmg/Clip Factory_<version>_universal.dmg

# Windows, NSIS installer
CF_APP_URL=https://dxxxx.cloudfront.net npm run build:windows
#   -> src-tauri/target/release/bundle/nsis/Clip Factory_<version>_x64-setup.exe

# Against the local web app (start it first: cd web && npm run dev:mock)
npm run dev
```

Checks (CI runs them on Linux whenever this folder changes):

```bash
cd desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## How it is released

`.github/workflows/deploy.yml`, after the web deploy:

1. **desktop-plan** compares a hash of this folder (docs excluded), the app icon and the app address with the
   `source-hash` stored on each installer in the web bucket. A missing installer or a different hash means a
   build; otherwise the target is skipped.
2. **desktop** builds the needed installers (`macos-latest` → `.dmg`, `windows-latest` → `.exe`) and uploads them
   to `s3://<web bucket>/downloads/Clip-Factory.dmg` and `downloads/Clip-Factory-Setup.exe` (no-cache, download as
   attachment).
3. **desktop-manifest** rewrites `downloads/manifest.json` with only the files that exist, then refreshes
   CloudFront for `/downloads/*`.

These jobs never fail a deploy. If a build breaks, the previous installer stays online and the next deploy tries
again.

The builds are **unsigned** for now (no Apple or Microsoft certificates). The first time, Mac users right-click
the app and choose Open; Windows users click "More info" and then "Run anyway". The "Get the app" card in the
web app says so. Signing is on the roadmap.

To change the version shown in the installer and manifest, bump `version` in `src-tauri/tauri.conf.json`
(and `Cargo.toml`, `package.json` to match).
