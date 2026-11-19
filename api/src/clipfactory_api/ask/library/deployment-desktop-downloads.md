## Desktop downloads

The Mac `.dmg` and Windows `.exe` offered by **Get the app** are built by the `desktop` job in
[deploy.yml](../.github/workflows/deploy.yml) ([CONTRACTS.md §12.3](CONTRACTS.md#123-desktop-wrapper-desktop-tauri-v2),
[ARCHITECTURE.md flow 12](ARCHITECTURE.md#12-get-the-app-and-the-desktop-wrapper)).

| | Mac | Windows |
|---|---|---|
| Runner | `macos-latest` | `windows-latest` |
| Build | Tauri v2, target `universal-apple-darwin` (Apple silicon and Intel in one file) | Tauri v2, NSIS installer (installs for the current user, no admin prompt; fetches WebView2 if the PC lacks it) |
| File in the web bucket | `downloads/Clip-Factory.dmg` | `downloads/Clip-Factory-Setup.exe` |
| Signed | No (see below) | No (see below) |

**When it runs.** After the web deploy, only if one of these is true; otherwise the job is skipped in seconds:
- something under `desktop/` changed,
- the app icon changed,
- a download is missing from `downloads/` in the web bucket (for example the first deploy),
- the signing key is set and an update bundle is missing, and the installer there was built without the key (the
  first deploy with the updater, or the first after the secrets were set).

Then both apps are built, as version `1.<run number>.0`. Each installer records `updater=true|false` (whether the
key was used) next to its `source-hash`. When an installer was built with the key but its signed bundle is missing,
the build and `desktop-plan` show an error annotation instead of rebuilding on every deploy (which would give every
installed app a new version with nothing changed); the next change under `desktop/` tries again. A missing key is
an error annotation on every deploy too; neither fails the run.

The app address is read from the Terraform output `app_url` and built into the app. The build job has no OIDC token
(npm, cargo and the Tauri CLI run there, and none of them may be able to assume the deploy role); it hands the
installer to the small `desktop-upload` job, which assumes the role and copies it to the bucket. Then
`desktop-manifest` rewrites `downloads/manifest.json`
(`{ "version", "files": { "mac": { "path", "size" }, "windows": { "path", "size" } } }`) with no caching and
invalidates `/downloads/*` in CloudFront, so nobody gets an old file under the same name.

**Updates for installed apps** ([CONTRACTS.md §12.6](CONTRACTS.md), [ADR-46](DECISIONS.md)). The build also makes a
bundle signed with the `TAURI_SIGNING_PRIVATE_KEY` secret (given to the build step only). `desktop-upload` stores it
under `downloads/updates/<version>/` and writes `downloads/updates/<mac|windows>.json`; `desktop-manifest` then writes
`downloads/latest.json`, which every installed app reads at start and every 6 hours. The run summary says which
version installed apps update to.

**Forcing a rebuild** (for example after a custom domain changes `app_url`): delete the two files from `downloads/` in the
web bucket, then run the deploy by hand (Actions → deploy → Run workflow). Until it finishes, Get the app offers the
browser install, never a broken link.

**If the desktop job fails**, the web app is already live; the previous downloads and manifest stay. Fix and push again.

### Unsigned builds and the first open

There are no Apple or Microsoft code-signing certificates yet ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)),
so both systems warn once. The Get the app card shows the hint; these are the full steps:

| System | What you see | What to do (only the first time) |
|---|---|---|
| macOS 14 and earlier | "Clip Factory can't be opened because Apple cannot check it for malicious software." | Drag the app to Applications, then right-click (or Control-click) it → **Open** → **Open**. |
| macOS 15 and later | "Apple could not verify Clip Factory is free of malware." | Press **Done**. Open **System Settings → Privacy & Security**, scroll down, press **Open Anyway** next to Clip Factory, confirm with your password. |
| Windows 10 and 11 | "Windows protected your PC" (SmartScreen) | Press **More info** → **Run anyway**. Some browsers also ask to **Keep** the download first. |

After the first open the app starts normally. Signing and notarization are on the [roadmap](ROADMAP.md#later).

### Release labels ("Area:" lines)

The update bar says in a word or three what changed, for example `Settings · Profile picture`. Those words come from
lines like this at the end of a commit message:

```
feat: let the owner pick a profile picture

Area: Settings
Area: Profile picture
```

Rules, examples and the squash-merge detail are in [GIT_WORKFLOW.md](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says).
Without `Area:` lines the labels come from the changed folders (`web/areas.json`), and failing that the bar says
"Improvements".
