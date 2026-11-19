## ADR-46 The desktop app updates itself (signed bundles from our own CloudFront)

- **Context.** The owner (2026-11-18) saw "This computer can't show see-through" on macOS 27 with Liquid Glass. The
  installed Mac app was a copy from 2026-11-16 00:03, from before the see-through window. The pages update by
  themselves (the update banner, §12.2), the native window did not: nothing told the owner a new app existed, and
  "Get the app" is hidden inside the app. The owner wants it never to happen again, with no questions a 6-8 year old
  could not answer.
- **Decision.**
  - *The app updates itself* with Tauri's updater plugin (Rust side only; the page still gets no IPC). It reads
    `downloads/latest.json` on our own CloudFront 5 s after start and every 6 hours, downloads a newer version in the
    background, and asks once: "Clip Factory updated", "Restart to use the newest version.", Restart now / Later.
    Later applies at the next start. Failures are silent (stderr). Only https on our host; never a downgrade.
  - *Signed with our own minisign key*, `requireSignedVersion` on, so a bundle is bound to the version it was signed
    for. The private key lives only in two GitHub Actions secrets, read only by the build step of the job that has no
    OIDC token; a backup stays off the repository with the owner.
  - *Every desktop build is `1.<deploy run number>.0`*, all targets rebuilt together, so `latest.json` has one version
    for every platform. Bundles go under `downloads/updates/<version>/` (immutable), a pointer per target follows,
    and `latest.json` is written from the pointers after every upload.
  - *Copies that cannot update themselves name no version* (`__CF_DESKTOP_VERSION__`), see-through or not; the
    Background page and the update bar offer them the new app with one big button. The oldest also never set
    `__CF_GLASS__`, which tells them apart from computers that cannot show glass. The link uses the
    same host with a trailing dot, which the old app treats as another site and hands to the system browser (the old
    window cannot save a download; plain http is upgraded back to https by the CSP and HSTS).
- **Alternatives.** *GitHub Releases as the update source*: a second place to publish, and the repository is public
  while the app address is not advertised; our CloudFront already serves the installers. *A web-only "new app"
  banner keyed on the app version*: still a manual download and install every time, not kid-proof. *Updating in the
  page through IPC*: would give the remote page native commands, which the empty capability exists to prevent.
  *Silent restart without asking*: could close the app mid-review. *Date-based versions*: NSIS refuses version parts
  above 65535. *`tauri-plugin-process` for the restart*: `AppHandle::restart` in Tauri itself does the same from
  Rust, so the plugin would add a dependency and nothing else.
- **Consequences.** Copies installed from this release on keep themselves current; copies from before it need one
  manual install (the page now says so). If the signing key is lost, installed apps can no longer be updated
  automatically: a build with a new public key must be installed by hand once (desktop/README.md). If deploy.yml is
  renamed or recreated its run number restarts and versions would go down, which the updater refuses: the version
  rule must be moved past the last release then. The installers stay unsigned by Apple and Microsoft (§12.3); the
  updater replaces the app in place, so the first-open warning shows only for a manual install.
