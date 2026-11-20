## 32. Notifications on the owner's phone and computer (owner request, 2026-11-20)

The owner adds Clip Factory to his iPhone's Home Screen (Share > Add to Home Screen) and wants to be told when clips
are ready, and to see on the Lock Screen what a video is doing. No App Store app (owner decision, 2026-11-20): this is
Web Push to the installed web app, the app icon's badge, and one notification per video that is replaced as it works.
See ADR-56.

### 32.1 What a web app can and cannot do on iPhone

* Web Push works on iOS and iPadOS 16.4 or later **only in the app opened from the Home Screen** (manifest
  `display: standalone`), never in a Safari tab, and permission can only be asked inside a tap.
* Every push must show a notification (`userVisibleOnly`): there are no silent pushes.
* The Badging API (`navigator.setAppBadge`) works for the Home Screen app once notifications are allowed.
* Lock Screen widgets and Live Activities need an App Store app (WidgetKit, ActivityKit). A web app cannot have them.
  Instead each video gets **one** notification whose tag is the job id, so the newest replaces the last. Whether iOS
  replaces a delivered notification with the same tag must be checked on a real iPhone; until it is, step updates stay
  off by default (§32.3), so only the important ones arrive.
* Mac Safari, Chrome, Edge, Firefox and Android get the same notifications from the same code.

### 32.2 The VAPID key

* `infra/modules/notify` makes the key from `ephemeral "tls_private_key" "vapid"` (ECDSA P-256) and writes it only to
  Secrets Manager `cf-prod/notify/vapid` with `secret_string_wo` (`secret_string_wo_version = 1`, never bumped). The
  key is never in a plan, the state or a log, and nobody ever pastes it anywhere.
* The secret has `prevent_destroy`: a new key would silently end every device's subscription. The delete gate still
  prints "Delete gate: the plan deletes or replaces nothing that holds the owner's data."
* The public key is worked out from the private key at runtime (`GET /v1/push/key`), so there is no second value to
  keep in step.

### 32.3 API, data and choices

| Route | What it does |
|---|---|
| `GET /v1/push/key` | `{publicKey}` (65 bytes, base64url). 503 "Notifications are not set up yet. Try again after the next update." until the key exists |
| `GET /v1/push/devices` | `{devices: [{deviceId, kind: "webpush", deviceLabel, createdAt, updatedAt}]}`: never the endpoint or keys |
| `PUT /v1/push/devices/{deviceId}` | `PushSubscription.toJSON()` plus `deviceLabel`. Idempotent; keeps `createdAt` |
| `DELETE /v1/push/devices/{deviceId}` | 204, also when already gone |
| `POST /v1/push/test` | `{deviceId?}`: "Notifications are on 🎉" to this device or every device; 429 within 10 s |

* `deviceId`: `[A-Za-z0-9_-]{8,64}`, made once per device and kept in `localStorage` (`cf.pushDevice`).
* The endpoint must be `https` on port 443 with no user info, on `web.push.apple.com`, `fcm.googleapis.com`,
  `updates.push.services.mozilla.com` or a `*.notify.windows.com` host; anything else is 400, so a saved
  subscription can never make Clip Factory post anywhere else. `p256dh` is a 65-byte P-256 point, `auth` 16 bytes.
  `deviceLabel` is one of iPhone, iPad, Mac, Windows, Android, Linux, Chromebook, This device. At most 20 devices.
* Items: `SK = PUSHSUB#<deviceId>` (`type: pushsub`, `endpoint`, `p256dh`, `auth`, `deviceLabel`, `createdAt`,
  `updatedAt`, and `gone` + `ttl` once a push service says it is gone). `PUSHSUB#` is not a broadcast prefix (§14.2),
  so subscriptions never travel over the WebSocket. `PUSHTEST`, `NOTIFIED#…` and `NOTIFYSTEP#…` are short-lived
  marks with a `ttl`.
* Settings gain `notify: {ready: true, stopped: true, resumed: true, steps: false}`. Unknown keys or non-booleans are
  400 "Notifications must say on or off for: clips ready, stopped, picked up, every step."; a missing key keeps its
  default.

### 32.4 One message

`api/src/clipfactory_api/push/webpush.py`: VAPID (RFC 8292, ES256 JWT, `aud` = the push service's origin, `exp`
12 h, `sub` = the app's https address) and `aes128gcm` (RFC 8291/8188, a fresh sender key and salt per message, one
4096-byte record). Headers: `TTL`, `Urgency`, and `Topic` for progress cards (a newer one replaces one not delivered
yet). The payload is JSON `{title, body, tag, url, quiet?, badge?}`, never a secret or an outside link. Sending uses
`urllib` with a 10 s timeout and never follows a redirect. `cryptography` is vendored (arm64 Linux only, checked by
the ELF header in `build_lambda.py`) and loads only when a message is sent.

### 32.5 `cf-prod-notify`

A second consumer of the table's stream (`cf-prod-broadcast` is the first), filtered to `MODIFY` records of `JOB#`
items, `LATEST`, records older than 10 minutes dropped. It compares the job before and after:

| Event | When | Choice | Body |
|---|---|---|---|
| ready | status became `ready` | `ready` | "Your clips are ready. Tap to look." |
| stopped | status became `failed` | `stopped` | "It stopped. Tap Try again." |
| resumed | a new run (`sessionId` changed) with `pickUp`, queued or running | `resumed` | "Picking up where it stopped." |
| step | a running job started another step, or its live line names another clip | `steps` | "Cutting the clips · step 7 of 10 · clip 3 of 10" |

* The title is the video's name cut to 40 characters, never a link. The tag is the job id; `url` is `/jobs/<id>`.
* The clip number comes from the running step's `message` (§30.6a, "Cutting clip 3 of 10…"); there is no extra write.
* Step cards: at most one every 2 minutes per job (`NOTIFYSTEP#<jobId>`), `TTL` 600, `quiet: true`.
* Each event is sent once per run: a conditional put on `NOTIFIED#<jobId>#<sessionId>#<event>` (2-day TTL) stops a
  stream retry from sending twice.
* `badge` is how many of the owner's jobs are queued or running after the change.
* A 404 or 410 marks the device `gone` with a 1-day TTL; the role has no `DeleteItem`. Any other failure is logged
  (device id and status only) and never retried; one bad device never holds up the others or the stream.

### 32.6 Service worker and badge

* `web/sw/sw.js` `push`: shows `title`/`body` with `tag`; a `quiet` card uses `renotify: false, silent: true`, the
  others `renotify: true`. A message that cannot be read still shows "Clip Factory" (iPhone requires it). `badge`
  sets or clears the app icon's number.
* `notificationclick`: focuses an open Clip Factory window and moves it to the job, or opens one. Only same-origin
  paths are ever opened.
* While the app is open, `AppBadge` (`web/src/lib/badge.ts`) keeps the number right from the job list and live job
  events, and on every return to the app.

### 32.7 The Mac and Windows app

The desktop app's web view has no Web Push. Settings says "The Mac and Windows app can't show notifications yet. Turn
them on in Clip Factory on your phone, or in Safari or Chrome." Native notifications there need
`tauri-plugin-notification` in a signed desktop release (a later change).

### 32.8 Settings › App & account › Notifications, and the job page

| Apple | What it shows |
|---|---|
| This device | iPhone in a Safari tab: "Add Clip Factory to your Home Screen first. Then open it from there and tap Turn on." and the Home Screen pictures (never a permission prompt). Can ask: a vermilion **Turn on** that asks for permission inside the tap, then subscribes and saves the device. On: "This device gets them, even when Clip Factory is closed." and Turn off here. Refused on iPhone: "Notifications are off for Clip Factory. Turn them on in Settings > Notifications > Clip Factory." |
| Clips ready, It stopped, Picked up again, Every step | On/off switches (`notify`) |
| Number on the app icon | On, With notifications, or Not here |
| Lock Screen widget | "Lock Screen widgets only come with App Store apps. Your notifications show there instead." and how Every step makes one card that changes |
| Send a test | Sends "Notifications are on 🎉" to this device |

A working job's page shows "Get told when your clips are ready, even with the app closed." with Turn on and Not now,
only where notifications can be turned on right there; Not now or turning them on hides it for good on that device.

### 32.9 Tests

* `api/tests/test_push.py`: a fake push service decrypts every message with the browser's key and checks the VAPID
  signature; routes (allow-list, idempotent PUT, delete, test and its 10 s limit, 503 without a key), settings,
  every event, one card per job, the clip number, the badge, choices, dedupe, the 2-minute limit, gone devices, one
  failing device, and no secret in the logs.
* `infra/modules/notify/tests/notify.tftest.hcl`: write-only key, `prevent_destroy`, the filter, no delete rights.
* `web/test/notifySettings.test.tsx`, `web/test/swPush.test.ts`, `web/test/badge.test.ts`, `web/e2e/notify.spec.ts`.
