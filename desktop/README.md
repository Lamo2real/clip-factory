# Clip Factory desktop app

A thin native window for Mac and Windows that opens the deployed Clip Factory web app
(docs/CONTRACTS.md §12.3). It is built with [Tauri v2](https://v2.tauri.app) and **bundles no web UI**: the
window shows the live website, so every web release reaches desktop users through the normal update banner
("What's new" and Reload). The installers only need a rebuild when this folder or the app icon changes, and then
the installed apps **update themselves** (see "How installed apps update" below).

## What it does

| Feature | How |
|---|---|
| Opens the app | Address baked in at build time from `CF_APP_URL` (Terraform output `app_url`) by `src-tauri/build.rs`. A release build without it stops with a clear error. Debug builds fall back to `http://localhost:5173/`. |
| Window | Title "Clip Factory", starts at 1200 × 820, never smaller than 380 × 600. |
| Remembers size and position | `tauri-plugin-window-state` (saved on close, restored on start). |
| Links to other sites | Open in the system browser (`tauri-plugin-opener`, called from Rust). Mail links open the mail app. Anything else (`file:`, custom schemes) is blocked. |
| See-through glass | The window is transparent with a native material behind the page, so the desktop shows through, blurred (docs/CONTRACTS.md §22): macOS Liquid Glass on macOS 26+, the under-window vibrancy material on 11–15; Windows 11 22H2+ acrylic; Windows 10 1809 to 11 21H2 blur. Linux and older Windows get an ordinary window. The light theme is forced and an off-white tint is laid in. Liquid Glass uses the tint while the window is in use and drops it while another app is in use (measured on macOS 27.2); the Windows blur uses it; Windows 11 acrylic and the older macOS material draw their own. The page learns which glass it has through `window.__CF_GLASS__` (`liquid`, `vibrancy`, `acrylic`, `blur` or `none`) and tints its panels just enough for dark text to stay readable over the darkest that glass can be. |
| Tells the web app it is installed | `window.__CF_DESKTOP__ = true` (injected by `src-tauri/src/init.js` before the page loads) and a user agent ending in `ClipFactoryDesktop/<version>`. The web app then hides "Get the app". |
| Updates itself | `tauri-plugin-updater`, from Rust (`src-tauri/src/update.rs`): 5 s after start and every 6 hours it reads `downloads/latest.json` on the app's CloudFront, downloads a newer signed version in the background and asks once, "Clip Factory updated / Restart to use the newest version.", **Restart now** or **Later** (`tauri-plugin-dialog`). Later = the next start. Errors are silent. |
| Tells the web app its version | `window.__CF_DESKTOP_VERSION__` (`1.<n>.0`), so the page can tell copies apart. A copy with no `window.__CF_GLASS__` is from before 2026-11-16 and gets an "Update the app" button in the page. |
| Icon | Generated from `web/public/icons/icon-512.png` by `scripts/make-icons.sh` (also run by every CI build). |
| Installers | Mac: universal `.dmg` (Apple silicon and Intel). Windows: NSIS `-setup.exe`, installs for the current user only and fetches the WebView2 runtime if missing. |

### Security

The page inside the window is a remote website, so it gets **no native access at all**: the only capability
(`src-tauri/capabilities/main.json`) grants nothing, `withGlobalTauri` is off, and there is no file system or
shell plugin. Opening links, saving the window state, checking for updates and the restart question happen in Rust. The window glass is chosen and applied in
Rust too; the page only reads `window.__CF_GLASS__`.

**Which glass a Mac has.** Every Mac asks Tauri for the same two effects (Liquid Glass first, the vibrancy material
as the fallback), and Tauri picks by AppKit's version number. `main.rs` reads the same number
(`NSAppKitVersionNumber`, a constant AppKit exports) and compares it with the same threshold, **2685** (macOS 26.0,
window-vibrancy's `MIN_APPKIT_VERSION_LIQUID_GLASS`), so the name it sends is the glass Tauri chose: `liquid` from
macOS 26, `vibrancy` before. The mapping is a pure function of the number (`Glass::for_appkit`) with its own
unit tests, and a test pins window-vibrancy to 0.8.x in `Cargo.lock`, so an update asks for a fresh look at the
threshold. Reading that constant is the only `unsafe` in the crate: `unsafe_code` is denied in `Cargo.toml` and
allowed on that one extern block. A web bundle that does not know a name yet treats it as `none`, so a newer app
with an older page still gives an ordinary, readable window.

`app.macOSPrivateApi` is on (tauri.conf.json, with tauri's `macos-private-api` feature): macOS needs it for a
transparent web view. It keeps the app out of the Mac App Store, which it does not use. Navigation away from the app's own
origin is cancelled in `src-tauri/src/main.rs` and handed to the system browser.

About the user agent: web views cannot append to their default user agent, so the wrapper sets a full one in
the usual shape for each platform's engine, with `ClipFactoryDesktop/<version>` at the end.

## Files

```
desktop/
  package.json                 the Tauri CLI (pinned), and npm scripts
  scripts/make-icons.sh        icons from the web app icon
  src-tauri/
    Cargo.toml, Cargo.lock     Rust crate (tauri 2 with macos-private-api, opener, window-state, updater and
                               dialog plugins, windows-version on Windows)
    build.rs                   reads and checks CF_APP_URL
    tauri.conf.json            product name, identifier app.clipfactory.desktop, bundle settings, the updater's
                               public key and address
    capabilities/main.json     deliberately empty permission set
    icons/                     generated, committed
    src/main.rs                the window, its glass (and which one this computer draws), link handling,
                               user agent (+ unit tests)
    src/update.rs              the update checks, download, and the one Restart now / Later question (+ tests)
    src/init.js                injected script (desktop flag, glass name, outward links)
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

Checks (CI runs them on Linux whenever this folder changes; the macOS glass code only compiles on a Mac, so run
them there too after touching it):

```bash
cd desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

What the glass really looks like can only be seen in a built app. docs/TESTING.md ("Hand check: the real window")
says how to check it with known pictures behind the window, in use and not in use.

## How it is released

`.github/workflows/deploy.yml`, after the web deploy:

1. **desktop-plan** compares a hash of this folder (docs excluded), the app icon and the app address with the
   `source-hash` stored on each installer in the web bucket. A missing installer, a different hash or (with the
   signing key set) a missing update bundle means a build of **every** target, as version `1.<run number>.0`;
   otherwise nothing is built.
2. **desktop** builds the installers (`macos-latest` → `.dmg` and the update bundle `.app.tar.gz`,
   `windows-latest` → `-setup.exe`, which is its own update bundle), signed for the updater with the
   `TAURI_SIGNING_PRIVATE_KEY` secret. This job has no AWS access.
3. **desktop-upload** puts the signed bundle at `downloads/updates/<version>/` (never overwritten), then the
   target's pointer `downloads/updates/<mac|windows>.json`, then the installer at `downloads/Clip-Factory.dmg` or
   `downloads/Clip-Factory-Setup.exe` (no-cache, download as attachment).
4. **desktop-manifest** rewrites `downloads/manifest.json` (Get the app) and `downloads/latest.json` (what installed
   apps update from: the newest version, with only the platforms built at that version), then refreshes CloudFront
   for `/downloads/*`.

These jobs never fail a deploy. If a build breaks, the previous installer stays online and the next deploy tries
again.

The builds are **unsigned** by Apple and Microsoft for now (no certificates). The first time, Mac users right-click
the app and choose Open; Windows users click "More info" and then "Run anyway". The "Get the app" card in the
web app says so. Signing is on the roadmap. Updates replace the app in place, so that warning is a first-install
thing only.

The version is set by CI. `tauri.conf.json`, `Cargo.toml` and `package.json` keep `1.0.0`, which is older than any
release, so a copy built by hand is updated too.

## How installed apps update

* Every copy from this release on checks `https://dglrbjmf28m6c.cloudfront.net/downloads/latest.json` 5 seconds
  after it starts and every 6 hours. A newer version is downloaded quietly and checked against the public key in
  `tauri.conf.json` (`plugins.updater.pubkey`) and the version it was signed for. Then it asks once:
  **Restart now** starts the new version; **Later** leaves it for the next start (on Windows it installs quietly when
  the app is closed). It never asks twice in one run and never shows an error.
* Only https on that host is accepted, for the list and for the download, and never an older version.
* Copies built before this release (before 2026-11-18) cannot update themselves. The web page spots them (they never
  set `window.__CF_GLASS__`) and shows **Update the app**: one button that downloads the new installer in the
  normal browser. Install it once, over the old one; from then on it updates itself.
* To check what is live: `downloads/latest.json` and the "Desktop downloads" summary of the deploy run.

### The signing key

* Made with `npx tauri signer generate` (minisign) on 2026-11-18. The **public** key is committed in
  `tauri.conf.json`. The **private** key and its password belong only in the GitHub Actions secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (set with `gh secret set ... < file`, never
  pasted), read only by the build step of the `desktop` job. Until both are set, every deploy's `desktop-plan` shows
  an error annotation saying so.
* Keep a **backup copy** (the key file, its password file and the public key) outside the repository, somewhere
  private and durable, such as a password manager. It must never be committed, pasted into an issue or pull
  request, or printed in a log.
* Without the secrets, deploys still build the installers but no update bundle, so installed apps stay where they
  are until the secrets are back.

**If the key is lost** (or leaked): installed apps only accept bundles signed by the old key, so they can no longer
be updated automatically.

1. Make a new pair: `npx tauri signer generate -w <a file outside the repository>` with a strong password.
2. Put the new public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), and replace both secrets
   (`gh secret set TAURI_SIGNING_PRIVATE_KEY < key-file`, `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD <
   password-file`). Merge; the deploy builds a release signed with the new key.
3. Install that release **by hand once** on every computer (Get the app, or the `.dmg` / `.exe` under
   `downloads/`), over the old app. From then on it updates itself again with the new key.
4. Keep a backup of the new key, as above.

A leaked key also means: replace it this way at once, since anyone with it could sign a bundle the apps accept (they
would still need to serve it from our CloudFront).
