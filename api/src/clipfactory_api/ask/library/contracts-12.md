## 12. Get the app, updates, and kid-proof UX (added by the owner after the first build)

### 12.1 "Get the app" (sidebar item; on phones a card in Settings plus a one-time banner on Home)
* Detect the device from `navigator.userAgentData` / user agent: `mac`, `windows`, `linux`, `ios`, `android`, `chromeos`.
* Offer what fits that device, one big button, plain words:
  * **Mac:** "Download for Mac" → `/downloads/Clip-Factory.dmg` (desktop wrapper, see 12.3). Secondary link:
    "or install from this browser" (PWA prompt where `beforeinstallprompt` exists).
  * **Windows:** "Download for Windows" → `/downloads/Clip-Factory-Setup.exe`. Secondary: browser install.
  * **Linux / ChromeOS:** browser install (PWA); Linux also `/downloads/Clip-Factory.AppImage` if listed.
  * **Android:** "Install app" via `beforeinstallprompt`; fallback picture steps (menu ⋮ → Install app).
  * **iPhone / iPad:** Apple allows no direct download: show 3 picture steps (Share icon → "Add to Home Screen" → Add),
    with the real Share icon drawn inline. In non-Safari iOS browsers, say "Open this page in Safari first".
* Which desktop files exist comes from `/downloads/manifest.json`
  `{version, files:{mac?:{path,size}, windows?:{path,size}, linux?:{path,size}}}` (no-cache). Missing file → fall back to
  browser install for that OS, never a dead link.
* **Never show "Get the app" when already installed:** hide when `matchMedia('(display-mode: standalone)')` or
  `(display-mode: window-controls-overlay)` matches, `navigator.standalone === true` (iOS), the desktop wrapper is
  detected (`window.__CF_DESKTOP__ === true` or user agent contains `ClipFactoryDesktop`), or after the `appinstalled`
  event (remembered in localStorage `cf.installed=1`). A "Not now" closes the Home banner for 30 days.

### 12.2 Update banner ("What's new" + Reload)
* Each deploy writes `/version.json` (no-cache): `{"version":"<git sha short>","builtAt":"<ISO>","areas":["Settings","Profile picture"]}`.
  The web build embeds its own version as `import.meta.env.VITE_APP_VERSION`.
* `areas` = at most 3 labels of 1–3 words, no sentences. A longer label is cut to its first 3 words, and a cut never
  ends on a joining word or punctuation (`Fixes: Home and Jobs` shows as `Fixes: Home`). Source, in order: commit trailers `Area: <label>` in the commits
  since the last deployed version; else changed files mapped through `web/areas.json` (`{"web/src/routes/settings": "Settings", ...}`,
  longest prefix wins); else `["Improvements"]`. Built by `scripts/release-areas.sh <prev-sha> <new-sha>` in deploy.yml
  (prev-sha read from the live `/version.json` in the web bucket; first deploy → `["First release"]`).
* The app checks `/version.json` on load, every 5 minutes, on `visibilitychange` to visible, and when the service
  worker finds a waiting worker. If `version` differs from its own: a glass bar slides up at the bottom (above the phone
  tab bar), showing a sparkle icon, the area labels as small pills (e.g. `Settings · Profile picture`), and a vermilion
  **Reload** button. Visible in the browser and in installed apps. Dismissable ("Later") until the next check.
* Reload: a progress bar inside the bar animates with an ease-in-out curve: quick to ~75 % in ~0.8 s (slow start,
  fast middle, slow end), holds/creeps while the new service worker installs and activates (`skipWaiting` via
  postMessage) and fresh assets are fetched, then eases to 100 %, a small sparkle/confetti, then `location.reload()`.
  Cap at 10 s, then reload anyway. Reduced motion → simple fill.

### 12.3 Desktop wrapper (`desktop/`, Tauri v2)
* A thin native window that loads `app_url` (no bundled UI), window title "Clip Factory", the app icon, minimum size
  380×600, remembers size/position, external links open in the system browser, user agent suffix `ClipFactoryDesktop`,
  injects `window.__CF_DESKTOP__ = true`, `window.__CF_GLASS__` (the native see-through glass, §22.2) and
  `window.__CF_DESKTOP_VERSION__` (this app's version, `1.<n>.0`). The pages update from the website itself (the
  update banner); the wrapper updates itself from `downloads/latest.json` (§12.6). `window.__CF_TITLEBAR__` (below) says how tall the overlay title bar is.
* **macOS title bar (owner request, 2026-11-19):** `TitleBarStyle::Overlay` with `hidden_title(true)`: the title bar is
  transparent and lies over the page, so there is no white strip and the traffic lights float on the app's own glass.
  The title "Clip Factory" still names the window in the Dock, Mission Control and the Window menu. The traffic lights
  keep the system's own place (no `traffic_light_position`). `__CF_TITLEBAR__` is `MAC_TITLEBAR_HEIGHT` (28) on macOS
  and 0 on Windows and Linux, which keep their normal frame; `init.js` defaults it to 0. The page keeps that band
  clear (§11.1). If a macOS release draws a taller title bar, only that number changes. In full screen the traffic
  lights hide and the 28 px band stays empty (a possible follow-up: `--titlebar-h: 0` in full screen).
* **The one native permission:** dragging the window by that band. `main.rs` adds the capability `title-bar-drag` at
  start-up (the app's address is only known at build time): `remote` = the app's own origin + `/*`, `local: false`,
  window `main`, permissions `core:window:allow-start-dragging` and `core:window:allow-internal-toggle-maximize`
  (used by Tauri's own drag script on `[data-tauri-drag-region]`). Nothing else is granted (`capabilities/main.json`
  stays empty); a Rust test holds the exact grant.
* Built in deploy.yml after the web deploy (job `desktop`, matrix `macos-latest` → universal `.dmg`,
  `windows-latest` → NSIS `.exe`), app URL from terraform output, uploaded to the web bucket as
  `downloads/Clip-Factory.dmg` and `downloads/Clip-Factory-Setup.exe`, then `downloads/manifest.json` rewritten.
  Builds are unsigned (no Apple/Microsoft certificates yet): the Get-the-app card shows a one-line hint for the first
  open (Mac: System Settings → Privacy & Security → Open Anyway; Windows: More info → Run anyway). Signing is a roadmap item.
* Only rebuilt when `desktop/**` or the app icon changes, or when no file exists yet in the bucket (or, with the
  signing key set, no update bundle yet). Then every target is rebuilt, all as version `1.<run number>.0` (§12.6).

### 12.6 The desktop app updates itself (owner request, 2026-11-18, ADR-46)

Why: the owner's Mac app was a copy from before the see-through window. The pages had updated, the native window had
not, so the page said "This computer can't show see-through" on macOS 27 with Liquid Glass.

* **Version.** deploy.yml builds every desktop app as `1.<run number>.0` (`github.run_number` of deploy.yml: it goes
  up on every run, a re-run keeps it so a re-built leg matches the others; NSIS needs each part ≤ 65535). The
  version reaches the build through `tauri build --config` (with `bundle.createUpdaterArtifacts: true`), so
  tauri.conf.json keeps `1.0.0` for local builds, which make no update bundle. Hand-built copies are `1.0.0`, older
  than any release, so they are updated too.
* **Signing.** The bundles are signed with a minisign key made by `tauri signer generate`. The public key is in
  tauri.conf.json (`plugins.updater.pubkey`); the private key and its password are the repository secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, read only by the build step of the `desktop`
  job (no OIDC token there; `desktop-plan` only checks whether the key is set). `requireSignedVersion: true`: the
  signature carries the version it was signed for, so an older bundle can never be passed off as a newer one.
  Without the secrets the installers are still built, with no update bundle. Backup and a lost key:
  desktop/README.md.
* **Files** (web bucket, served by CloudFront under `/downloads/*`, at most 5 minutes at the edge, refreshed on every
  release):
  * `downloads/updates/<version>/Clip-Factory.app.tar.gz` (Mac, universal) and
    `downloads/updates/<version>/Clip-Factory-Setup.exe` (Windows: the signed NSIS installer itself): never
    overwritten (`immutable`).
  * `downloads/updates/mac.json`, `downloads/updates/windows.json`: `{version, url, signature, platforms}`, written by
    `desktop-upload` right after its bundle (no-cache).
  * `downloads/latest.json`, written by `desktop-manifest` after every upload, from the pointers: Tauri's static
    format, `{version, notes: "Desktop app", pub_date, platforms: {darwin-universal, darwin-aarch64, darwin-x86_64,
    windows-x86_64: {url, signature}}}`. `version` is the newest any target has; only targets with that version are
    listed (a target whose build failed is left out until it builds again, never offered another's version).
    No-cache.
  * The installers keep their keys (`downloads/Clip-Factory.dmg`, `downloads/Clip-Factory-Setup.exe`), so Get the
    app is unchanged.
* **In the app** (`desktop/src-tauri/src/update.rs`, release builds only): 5 s after start, then every 6 hours, read
  `https://dglrbjmf28m6c.cloudfront.net/downloads/latest.json`. Only https on that host, for the manifest and the
  bundle it names. Only a newer version (never a downgrade). Download (and on a Mac install) in the background,
  verified against the public key. Then one native dialog, asked once per run: title **"Clip Factory updated"**,
  message **"Restart to use the newest version."**, buttons **Restart now** / **Later**. Later: the Mac already has
  the new app in place for the next start; Windows runs the installer quietly when the app quits, without reopening
  it. Nothing asks again in that run. Failures go to stderr only, never an error dialog. The page gets no access to
  the updater or the dialog (capability still empty).
* **Copies that cannot update themselves** are every copy built before the updater: they set `__CF_DESKTOP__` but
  never `__CF_DESKTOP_VERSION__` (`cantSelfUpdate`, lib/background.ts). That includes copies built from main between
  2026-11-16 and the updater, which do show see-through. The oldest of them (built before 2026-11-16 16:54) also
  never set `__CF_GLASS__` (every newer copy sets it, `"none"` at the least), which picks their see-through note
  (`isOldDesktopApp`):
  * Settings › Look & feel › Background, see-through: in the oldest copies the note **"Update the app to see
    through."**; under the note, in any copy that cannot update itself, one big vermilion button **Update the app**
    (the real `none` note, §22.5, and the browser and phone notes are unchanged).
  * App-wide, in any copy that cannot update itself, the update bar (§12.2) shows the label **Update the app** with **Update** and **Later** (Later hides it
    until the next start), whenever no web update is waiting.
  * Both link to the installer for this computer (Mac `.dmg`, Windows `.exe`, from the user agent) at the same
    server with a **trailing dot** in the host (`https://<host>./downloads/...`, `oldAppDownloadUrl` in
    lib/device.ts). To the old app that is another site, so it opens the link in the system browser, which
    downloads it; the plain address would stay in the old window, which cannot save a download. CloudFront answers
    the dotted host (checked 2026-11-18). Plain http would not do: CSP `upgrade-insecure-requests` and HSTS make it
    the same site again.
* **Tests**: cargo (`update.rs`: allowed addresses, the config names the same manifest, a key and
  `requireSignedVersion`; `main.rs`: the version in the script, the dotted link leaves the old window), vitest
  (`cantSelfUpdate`, `isOldDesktopApp`, the notes, `oldAppDownloadUrl`), Playwright (`e2e/background.spec.ts`: an
  old wrapper, Mac user agent, gets the note, the button and the bar; a see-through wrapper with no version gets the
  bar; wrappers that name a version never do), `scripts/test-deploy-workflow.sh`
  (the key reaches only the desktop build; only desktop-manifest writes latest.json, after desktop-upload).

### 12.4 Kid-proof UX (a 6–8-year-old must manage it)
* One obvious next step per screen (one vermilion CTA), big targets (≥ 48 px on phones), icon + word on buttons
  (except the phone tab bar), short plain words (no jargon: "Make clips", "Upload", "Throw away"), friendly empty states
  that say exactly what to tap, no dead ends, every error says what to do next, destructive actions undoable for 8 s
  (toast with Undo) instead of scary dialogs, forms that can't be submitted wrong (paste button, auto-detect link,
  inline hints), progress always visible, celebrations on success.

### 12.5 Home, Jobs and the job page: rules from the UI audit

* **Home never waits forever.** Jobs and review clips must load; if they do not, the Working now card and the
  review row each show what went wrong with **Try again** (no endless skeletons). The views total is extra: a failed
  `GET /v1/insights` only blanks the stat ("Could not get the numbers right now…") and the lists still show.
* **Stop job survives leaving the page.** A Stop waiting for its 8 s Undo is kept outside the page
  (`screens/jobs/pendingStops.ts`), so going away and coming back shows "Stopping in a few seconds" again, not a
  second Stop job button. The cancel is sent once, when the Undo runs out. If the job finished, failed or was
  stopped elsewhere inside the window, the API's 409 is a quiet no-op (no error toast, no shake).
* **Clip tiles on the job page** (§16.8): a clip waiting for a look opens `/review#clip-{clipId}`; a kept one
  (confirmed, publishing, posted, failed) opens `/clips/{clipId}`; a thrown-away one is not a link (it is listed
  nowhere else) and does not lift on hover like one.
* **Empty Clips line** follows the job: working "Clips show up here as soon as they are made."; failed "No clips
  yet. Fix the problem above, then tap Try again."; canceled "No clips yet. This job was stopped. Tap Try again to
  start it again."; ready with none "This job made no clips. Go back to Home and try a different link."
* **Words** (§12.4): the job status pill says **Didn't work** (never "Failed"); the Home source switch is
  **Paste a link / Pick a video** (the help anchor stays `upload-video`).
* **Drag and drop on the new-job card** (`web/src/lib/drops.ts`): a video dragged from Finder (or the desktop)
  anywhere on the card switches to Pick a video and is picked like the file picker (same checks, words and motion);
  several files take the first video ("One video per job…"); another file says "That is not a video. Drop an MP4,
  MOV or WebM video."; a link (a uri-list, or dragged text that is a link) switches to Paste a link and is checked;
  a thumbnail dragged off a video page (its picture plus the page link) is taken as the link. Text or a link dragged
  into Notes goes into the note. While dragging, one opaque soft fill over the card says "Drop your video here" /
  "Drop your link here" / "Drop it here" (files with a link), its words kept on screen (no edges, no animation with
  less motion); it stays while the pointer holds still and goes on leaving the card or window, Escape or a drop.
  While an upload or a start runs it says "Upload still running" / "Starting your job…" and refuses the drop with a
  toast. A hidden status line says what each drop did ("Video picked: …", the error, "Link added. …") for screen
  readers. A drop outside the card is still refused by Ask's window guard. The same form serves Use a video file
  (`/?file=1&from=`). Covered by `web/test/drops.test.ts` and `web/e2e/drop-video.spec.ts`.
* **Jobs list on phones**: when a job started is never cut (the source part shortens with "…" instead), and a failed
  job's error is shown in full because its last sentence says how to fix it.
* **No blank pages**: a malformed `#anchor` (`/jobs#100%`) is used as typed instead of throwing, and render errors
  are caught by an error boundary (per page in the Shell, cleared on the next page; one around the whole app).
  Every page, including a job or clip page that is loading, missing or failed, has an `h1` (visually hidden when the
  card shows the words).
* **Mock knobs** (`window.__cfMockFaults`, for e2e): `jobsPageSize` (jobs list pages hold at most this many, so
  "Show older jobs" shows), `olderJobsFails` (the next N older pages fail), `createJobFails` (the next N Make clips
  fail with a server error). Covered by `web/e2e/audit-shell.spec.ts`.
* **Review screen** (`web/src/screens/review/`):
  * A refused Upload (a caption too long for a chosen place) opens the first too-long place row, scrolls it into view,
    focuses its box and names the platform: "Your X caption is longer than its platform allows. Make it shorter, then
    tap Upload.". Every row whose caption is too long carries `.is-over` and "Too long. Make it shorter." so it shows
    even while the row is closed.
  * Place rows (§36.1): one closed row per chosen place, no tab bar. A closed TikTok row also names the account:
    "Posting as <nickname>" (TikTok's rules). Review's launcher keeps clear of the rows (`data-help-dodge`).
  * The card goes two-column (video left) only when the card itself is at least 820 px wide (container query on
    `.review-list__item`, never a window media query), so the decision column never drops below about 400 px.
    In two columns the video sits on the card's vertical centre line beside the words (`align-self: center`) and
    scrolls with the page: never sticky, never fixed (owner request, 2026-11-20). Phones keep it at the top.
    Throw away and Keep share the row; once they wrap, each fills the row (`flex: 1 1 140px`, at most 260 px), so
    they line up. The source line's link icon sits inside the link and stays beside its words.
  * Thrown-away clips are kept in a module-level store (`web/src/lib/throwAways.ts`) while their 8 s Undo runs and
    after the decline goes through, so leaving Review and coming back inside the 8 s never shows the clip again, and
    Undo brings it back on whichever Review is on screen. A decline answered 409/404 (already kept or thrown away
    somewhere else) leaves the clip gone and shows a calm note instead of an error ("This clip was already kept or
    thrown away somewhere else, so there is nothing more to do."); any other failure brings it back with "… The
    clip is back in your list.".
  * Arriving from a clip link (`/review#clip-…`) scrolls to that clip once per arrival; later list changes never
    jump back to it.
  * When a card leaves while it holds the focus (Keep, Throw away), the focus moves to the next card's title (or
    the one before, or the empty state's Make clips); Undo focuses the card that came back (a decline that fails later
    brings the card back without taking the focus from what the owner is doing).
  * Filtered to one job (`/review?job=…`): the lede says the clips all come from one job and to tap Show every job
    for the rest, and the count reads "4 clips from this job waiting (5 in all)" (the total from `me.counts.review`,
    left out when it is not more).
