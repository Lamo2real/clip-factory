## Data flows

### 1. Sign in and token lifetimes

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app
  participant C as Cognito
  participant A as HTTP API
  W->>C: signIn (SRP: email + password proof)
  C-->>W: first time: NEW_PASSWORD_REQUIRED
  W->>C: confirmSignIn (new password)
  C-->>W: access + ID token (15 min), refresh token (30 days)
  W->>A: GET /v1/me, Authorization: Bearer access token
  A->>A: JWT authorizer checks issuer, audience, expiry
  Note over W,C: Before the access token expires, Amplify refreshes it.<br/>Rotation returns a new 30-day refresh token each time.
  W->>C: refresh (REFRESH_TOKEN_AUTH)
  C-->>W: new access + ID token, new refresh token
```

An owner who opens the app at least once every 30 days never signs in again. After 30 days without use the refresh
token expires and the sign-in screen appears. See [SECURITY.md](SECURITY.md).

### 2. Create a job and start `cf-prod-job-flow`

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app
  participant A as cf-prod-api
  participant S as S3 media
  participant D as DynamoDB
  participant F as cf-prod-job-flow (durable)
  opt Upload instead of a link
    W->>A: POST /v1/uploads {filename, contentType, size}
    A-->>W: presigned PUT URL (1 h)
    W->>S: PUT the file (progress shown)
  end
  W->>A: POST /v1/jobs {source, clipTarget, notes}
  A->>A: validate link platform or upload key
  A->>D: put Job (queued, new sessionId, flowRun 1)
  A->>F: Invoke alias live, InvocationType Event,<br/>DurableExecutionName job-{jobId}-{flowRun}
  F-->>A: 202 + DurableExecutionArn
  A->>D: store flowExecutionArn
  A-->>W: 201 {job}
```

The start is idempotent: the payload has no timestamps, so starting the same name again either returns the running
execution or `DurableExecutionAlreadyStartedException`, which the API treats as "already started". **Retry** writes a
new `sessionId`, adds 1 to `flowRun` and starts `job-{jobId}-{flowRun}`. If the invoke itself fails, the job becomes
`failed` with "Could not start. Press Try again."

### 3. Job flow: the agent and its callback

`cf-prod-job-flow` replaces the watchdog. It costs nothing while it waits: the durable SDK checkpoints and the function
stops until the callback arrives.

```mermaid
flowchart TD
  start([job-flow starts]) --> cb["create_callback agent-done<br/>timeout 8 h, heartbeat timeout 6 min"]
  cb --> sa["step start-agent<br/>GetItem Job, InvokeAgentRuntime process_job + callbackId"]
  sa -- "job missing, another sessionId, or terminal" --> sup([outcome superseded])
  sa --> wait["cb.result(): no compute while waiting"]
  wait -- success --> fin["step finish: Job ready + clipCount if not already"] --> ready([outcome ready])
  wait -- "JobFailed" --> fail["step fail: Job failed with the agent's message"]
  wait -- "timeout, missed heartbeat or AgentStopped" --> resume["step resume-n: new sessionId, pickUp, note<br/>step stop-old-n; again on the new session (at most twice)"]
  resume --> cb
  resume -- "after 2 resumes" --> fail2["step fail: 'Making the clips stopped. Tap Try again to pick up where it left off.'"]
  wait -- "Canceled or Superseded" --> nowrite([outcome canceled or superseded, no write])
  fail --> stop["step stop-session: StopRuntimeSession"] --> failed([outcome failed])
  fail2 --> stop
```

```mermaid
sequenceDiagram
  autonumber
  participant F as cf-prod-job-flow
  participant D as DynamoDB
  participant R as Agent (AgentCore)
  participant L as Lambda durable callback API
  F->>F: create_callback agent-done
  F->>D: step start-agent: GetItem Job (queued, same sessionId?)
  F->>R: InvokeAgentRuntime {process_job, jobId, userId, callbackId}
  R-->>F: {accepted: true}
  Note over F: checkpoint, function stops, no compute
  loop while the job runs (at most every 5 min)
    R->>L: SendDurableExecutionCallbackHeartbeat
  end
  alt finished
    R->>D: Job ready, clipCount (finalize)
    R->>L: SendDurableExecutionCallbackSuccess {jobId, clipCount}
    L->>F: resume
    F->>D: step finish (no-op when already ready)
  else agent failed
    R->>D: Job failed with a plain reason
    R->>L: SendDurableExecutionCallbackFailure JobFailed
    L->>F: resume with CallbackError
    F->>R: step stop-session
  else container died (no heartbeat for 6 min) or got SIGTERM (AgentStopped)
    L->>F: resume with CallbackError (heartbeat timeout)
    F->>D: step resume-n: new sessionId, pickUp, "Picking up where it stopped…" (at most twice, §30)
    F->>D: after the last resume, step fail: "Making the clips stopped. Tap Try again to pick up where it left off."
    F->>R: step stop-session (errors ignored)
  end
```

Every write by the flow is conditional on the Job's `sessionId`, so an old run can never overwrite a newer retry.
**Cancel** is handled by the API (Job `canceled`, `cancel` to the agent, `StopRuntimeSession`); the agent sends
`Canceled` and the flow writes nothing.

### 4. The agent pipeline

The agent owns the job record from the moment it accepts. Each step updates `steps[i]`, `progress` and `heartbeatAt`;
each write reaches the app through the live updates of flow 5. Details are in [AGENT.md](AGENT.md).

```mermaid
sequenceDiagram
  autonumber
  participant R as Agent (AgentCore)
  participant D as DynamoDB
  participant S as S3 media
  participant Y as Source site
  participant T as Transcribe
  participant B as Bedrock (Fable 5.1, Titan V2)
  participant N as Bedrock (Nova 2 Lite, EU)
  participant V as S3 Vectors
  R->>D: job running, load settings, every skill (no switch), latest 10 learnings
  R->>S: read each skill's file, build the skills block once for the job
  R->>Y: resolve: metadata (title, channel, duration) or S3 head for uploads
  R->>Y: download: audio only, capped at maxSourceHours
  R->>S: audio.m4a
  par in the background, while the words are written down
    R->>Y: the small picture rendition (up to 480p, no sound)
    R->>R: one ffmpeg pass: 2 fps parts of 300 s + picture change per second
    R->>S: picture/part-NNNN.mp4, picture.json
  and
    R->>T: StartTranscriptionJob (word timestamps, auto language, speaker labels)
    T->>S: transcript.json
    R->>S: words.json, speakers.json, loudness.json
  end
  par watch: both models see the whole picture
    R->>B: every 150 s: frames + that part's words (skills block first)
    B-->>R: what is seen: events with kind, strength, face, on-screen text
  and
    R->>N: every 300 s part as video (skills block first)
    N-->>R: what is seen, a second opinion
  end
  R->>S: watch/chunk-NNNN.json, watch/nova-NNNN.json, visual_log.json, signals.json
  R->>B: Titan: embed title, channel, notes, transcript start
  R->>V: QueryVectors top 8, this owner, status performed
  V-->>R: similar past clips with performance ("What worked before")
  R->>B: select: skills block + transcript windows with picture notes + loudness + hot spots + learnings + what worked before
  B-->>R: ranked moments (+ spares) with hooks and moment types
  R->>B: second look: every frame of each picked moment and spare + its words
  B-->>R: keep or not, small timing moves, an honest hook
  R->>S: moments.json
  loop each moment
    R->>Y: download only that section of video
    R->>B: one frame: where is the facecam?
    R->>R: ffmpeg: 1080x1920, hook, captions, cover
    R->>B: checklist judgement (with measured values)
    R->>S: clip.mp4, cover.jpg
    R->>D: Clip (status review)
  end
  R->>B: captions per platform
  R->>B: Titan: embed each new clip
  R->>V: PutVectors (status review)
  R->>D: job ready, clipCount
```

If the vector query fails, the agent logs `vectors.query_failed` and carries on without the section; fewer than three
`performed` hits are topped up with the owner's other clips.

**The picture is optional at every point.** The watch step never fails a job: when the small rendition cannot be
downloaded, ffmpeg fails, or a model is throttled, refuses or is not allowed, the agent logs it and picks from the
signals it has, down to exactly the words-and-loudness pipeline it was before
([AGENT.md](AGENT.md#watching-the-video), [ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)). The
fan-out (8 Fable chunks, 4 Nova parts at a time) is plain asyncio inside the one container, so cancel, the session
fence and the heartbeats work as for every other step.

### 5. Live updates over the WebSocket API

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app (live.ts)
  participant G as WebSocket API (stage live)
  participant Z as cf-prod-ws-authorizer
  participant H as cf-prod-ws
  participant D as DynamoDB
  participant B as cf-prod-broadcast
  W->>W: fetchAuthSession(): fresh access token
  W->>G: connect wss://.../live?token=...
  G->>Z: $connect REQUEST authorizer
  Z->>Z: RS256 against the Cognito JWKS, iss, token_use access, client_id, exp
  Z-->>G: Allow, context.sub
  G->>H: $connect
  H->>D: put Connection CONN#{connectionId}, ttl 2 h
  G-->>W: connected (polling slows to every 30 s)
  Note over D,B: the agent, the API or a flow writes a Job, Clip, Post or Learning
  D->>B: stream batch (filter: JOB#, CLIP#, POST#, LEARNING#, WEEK# only)
  B->>B: keep the last change per item, build the public shape
  B->>D: query the owner's connections
  B->>G: PostToConnection {type, op, id, item}
  G-->>W: event, screen cache updated in place
  opt connection gone (410)
    B->>D: delete that Connection
  end
  loop every 5 min
    W->>G: {"action":"ping"}
    G->>H: $default
    H-->>W: {"type":"pong"}
  end
  Note over W,G: after 110 min the app reconnects itself (2-hour cap).<br/>On any close: back off 1, 2, 4, 8, 16, 30 s, then refetch what is on screen.
```

- Events carry the same public shapes as the HTTP API, so internal fields (`sessionId`, `videoKey`, `publishState`,
  `flowExecutionArn` and so on) never leave AWS. An event over 24 KB is sent as `partial: true` and the app refetches.
- The token is in the query string of the connect request, so the WebSocket access log has a fixed list of fields with
  no query and no headers, data tracing is off, and the Lambdas never log the token.
- Without a connection (mock mode, an old `config.json`, or a dropped socket) the app polls as before. Nothing on
  screen complains about a dropped socket.

### 6. Review, Keep and Throw away

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app
  participant A as cf-prod-api
  participant D as DynamoDB
  participant V as S3 Vectors
  participant C as cf-prod-clip-flow (durable)
  W->>A: GET /v1/clips?status=review
  A-->>W: clips with presigned video and cover URLs (1 h)
  W->>A: GET /v1/clips/{clipId}/similar
  A->>V: GetVectors(clipId), QueryVectors top 6, this owner, performed
  A-->>W: up to 5 "Like clips that did well"
  opt edit captions
    W->>A: PATCH /v1/clips/{clipId} {captions}
  end
  alt Keep (confirm)
    W->>A: POST /v1/clips/{clipId}/confirm
    A->>D: one transaction: clip confirmed, publishState pending, flowRun 1,<br/>one Post per enabled platform
    A->>C: Invoke alias live, Event, DurableExecutionName clip-{clipId}-{flowRun}
    A->>D: publishState started, flowExecutionArn
    A-->>W: {clip, posts} (celebration)
  else Throw away (after the 8-second Undo)
    W->>A: POST /v1/clips/{clipId}/decline
    A->>D: clip declined
    A->>A: delete clip.mp4 and cover.jpg
    A->>V: DeleteVectors(clipId), errors logged only
  end
```

Keep is safe to press twice: a clip whose flow is `pending` is started again with the same name and payload (a no-op if
it is already running), and a `started` or `posted` clip just returns its current state. A clip that ended `failed`
shows **Try again**, which starts `clip-{clipId}-{flowRun + 1}`.

### 7. Clip flow: publish, wait 48 hours, learn

```mermaid
flowchart TD
  s([clip-flow starts]) --> ep["step ensure-posts<br/>create posts if missing, clip publishing if any is queued"]
  ep --> pub{"any post queued?<br/>(account connected)"}
  pub -- "yes, one platform after another" --> pp["step publish-{platform}: start<br/>(saves publishHandle, 3 attempts)"]
  pp --> chk{"processing?"}
  chk -- yes --> wt["wait-{platform}-{n}: no compute"] --> ck["step check-{platform}-{n}"] --> chk
  chk -- "ready_to_finish" --> fin["step finish-{platform}"] --> chk
  chk -- done --> mp["post posted (in that step)"] --> settle
  pp -- "error, reconnect needed, over maxChecks" --> pf["post failed with a plain sentence"]
  pf --> settle
  pub -- "no (no account: pending_integration)" --> settle["step settle-clip<br/>posted, failed or confirmed"]
  settle -- "nothing posted" --> uv1["step upsert-vector (status confirmed)"] --> np([outcome not_posted])
  settle -- "at least one posted" --> w48["wait-48h: Duration 48 h, no compute"]
  w48 --> met["step metrics: views, likes, comments, shares per post"]
  met --> dis["step distil: retired, no model call (daily lessons instead)"]
  dis --> uv2["step upsert-vector (status performed + performance)"] --> done([outcome done])
```

```mermaid
sequenceDiagram
  autonumber
  participant C as cf-prod-clip-flow
  participant D as DynamoDB
  participant X as Platform API
  participant B as Bedrock (Fable 5.1, Titan V2)
  participant V as S3 Vectors
  C->>D: step ensure-posts
  loop each queued post, one platform after another
    C->>X: step publish-{platform}: start (create, upload the file in chunks)
    C->>D: publishHandle (so a replay resumes, never posts twice)
    loop while processing
      Note over C: wait-{platform}-{n}: no compute
      C->>X: step check-{platform}-{n}: status
    end
    C->>X: step finish-{platform} (Instagram, Facebook, X)
    X-->>C: post id and URL
    C->>D: post posted, postedAt, statsId, perfCheckAt = postedAt + 48 h
  end
  C->>D: step settle-clip: clip posted
  Note over C: wait-48h: checkpoint, no compute, no schedule
  C->>X: step metrics: read views, likes, comments, shares
  C->>D: metrics on each post
  Note over C: step distil: retired, no model call (the daily run learns from day-7 numbers)
  C->>V: step upsert-vector: GetVectors, merge metadata, PutVectors (performed)
```

The `metrics` step reads the numbers through the same stats refresh as the poller ([flow 13](#13-clip-numbers-the-poller-and-refresh-numbers)),
so it shares the platforms' budgets. Every step is at-least-once, so each is written to be safe to repeat: posts are created only once (`postsCreated`),
a post is updated only while it is `queued`, and every platform call that creates something first saves a
`publishHandle`, so a replayed step resumes the upload instead of starting a second one. The few calls that cannot be
repeated safely on the platform side (TikTok init, Instagram `media_publish`, X post) are at-most-once: if one is
interrupted, the post fails with "We are not sure it posted. Look on {Platform} before you press Try again."
Publishing in detail is in [flow 16](#16-set-up-posting-connect-and-real-posting). A
durable execution stays pinned to the Lambda version it started on, so a deploy during the 48-hour wait never changes
a running flow.

### 8. The learning memory (S3 Vectors)

Each clip gets one vector (`key = clipId`) built from its moment type, hook, YouTube title and summary, embedded by
Titan Text Embeddings V2 (1024 numbers, normalised). Filterable metadata: `userId`, `momentType`, `platforms`,
`status` (`review`, `confirmed`, `performed`) and `scoreBucket`; stored but not filterable: `hook`, `title`, `summary`
and `performance`.

| When | Who | What happens to the vector |
|---|---|---|
| Job finishes | agent | created, status `review` |
| Before moment selection | agent | the top 8 `performed` clips of this owner like this source become "What worked before" in the prompt |
| Owner opens a clip | API | `/similar` returns up to 5 of the owner's measured clips most like it |
| Keep, nothing posted | clip-flow | status `confirmed` |
| 48 hours after posting | clip-flow | status `performed` with the summed numbers |
| Owner stars it as best of the week | `cf-prod-learn` | metadata `best = true` (unstarred: `best = false`); `best` clips come first in "What worked before" |
| Throw away | API | deleted |

Two kinds of memory work together: **learnings** are short sentences about what works in general; **vectors** find
specific past clips that resemble the one at hand, with their real numbers.

### 9. Platform webhooks (REST API)

Webhooks: nothing runs inline except storing the event. The OAuth callback on the same API is [flow 16](#16-set-up-posting-connect-and-real-posting).

```mermaid
sequenceDiagram
  autonumber
  participant P as Platform (Meta, YouTube)
  participant G as REST API cf-prod-hooks (stage v1)
  participant H as cf-prod-hooks
  participant S as SSM Parameter Store
  participant D as DynamoDB
  P->>G: GET /hooks/instagram?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
  G->>H: AWS_PROXY (platform path parameter required)
  H->>S: GetParameter /cf-prod/hooks/verify-token (cached 5 min)
  H-->>P: 200 challenge (or 403)
  P->>G: POST /hooks/instagram (event)
  G->>H: AWS_PROXY
  H->>H: size limit 256 KB, signature check (phase 1: unverified)
  H->>D: put HOOK#instagram event, ttl 14 days
  H-->>P: 200 {"ok": true}
  P->>G: GET /oauth/youtube/callback?code=...&state=...
  H-->>P: 302 to the app: /settings/posting/setup/youtube?result=connected (flow 16)
```

The REST access log has no query string (OAuth callbacks carry `code` and `state`). Each method is throttled to 10
requests a second (burst 20), and the `tiktok` and `x` webhooks answer `501` (not built yet); their OAuth callbacks work.

### 10. Deploy

```mermaid
sequenceDiagram
  autonumber
  participant G as GitHub Actions (deploy.yml)
  participant I as IAM (OIDC role)
  participant TF as Terraform
  participant E as ECR
  participant AWS as AWS resources
  G->>G: tests, build web, build the Lambda zip (boto3 + durable SDK vendored)
  G->>I: AssumeRoleWithWebIdentity (repo, refs/heads/main)
  G->>TF: init (S3 state, lockfile), plan
  G->>E: build and push agent image (tag = hash of agent sources)
  G->>TF: apply the plan
  TF->>AWS: Cognito, three APIs, nine Lambdas (two durable, new version + alias live),<br/>EventBridge rule cf-prod-stats, table + stream + gsi2, buckets, vector bucket + index, SSM, runtime, alarms
  G->>AWS: write config.json (apiUrl, wsUrl, oauthCallbackBase) from outputs, sync web to S3 (keeps tiktok*.txt), invalidate CloudFront
  G->>AWS: write version.json with the release areas (flow 11)
  opt desktop/ or the icon changed, or a download is missing
    G->>AWS: desktop job: build .dmg and .exe, upload to downloads/ (flow 12)
  end
```

Step-by-step setup, including the one-time account settings, is in [DEPLOYMENT.md](DEPLOYMENT.md).

### 11. Updates: `version.json`, release areas and the update bar

Every deploy tells running apps that something is new, and in a word or three what it is
([CONTRACTS.md §12.2](CONTRACTS.md#122-update-banner-whats-new--reload)).

- **Build.** The web build embeds its own version (`VITE_APP_VERSION`, the short git sha).
- **Areas.** `scripts/release-areas.sh <prev-sha> <new-sha>` collects the labels. `prev-sha` is the `version` in the
  live `/version.json` in the web bucket. Rule, in order: the `Area:` lines in the commit messages between the two
  ([GIT_WORKFLOW.md](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)); otherwise the changed files mapped through
  `web/areas.json` (longest folder prefix wins, for example `web/src/routes/settings` → "Settings"); otherwise
  `["Improvements"]`. At most three labels, duplicates removed. With no live `version.json` (first deploy) the label
  is `["First release"]`.
- **Publish.** After the web files are synced, the deploy writes
  `{"version":"<short sha>","builtAt":"<ISO time>","areas":[...]}` to `/version.json` with `Cache-Control: no-store`.
  It is written **last**, so an app never sees a new version before its files are in place.
- **Detect.** The app fetches `/version.json` (bypassing every cache) on start, every 5 minutes, when the tab or window
  becomes visible, and when its service worker reports a waiting worker. A different `version` shows the update bar.
- **Reload.** The progress bar runs the [reload curve](UX_DESIGN_SYSTEM.md#the-reload-curve) while the app tells the
  waiting service worker to `skipWaiting`, waits for `controllerchange`, then reloads (at most 10 s).

```mermaid
sequenceDiagram
  autonumber
  participant G as deploy.yml
  participant R as release-areas.sh
  participant S as S3 cf-prod-web
  participant C as CloudFront
  participant W as Web app (browser, PWA or desktop app)
  participant SW as Service worker
  G->>S: get the live version.json
  S-->>G: {version: prev-sha} (none on the first deploy)
  G->>R: prev-sha, new-sha
  R->>R: Area lines in commits prev..new<br/>else changed paths via web/areas.json<br/>else Improvements (first deploy: First release)
  R-->>G: areas: Settings, Profile picture
  G->>S: sync new build (hashed assets, index.html, sw.js)
  G->>C: invalidate the cached app files
  G->>S: put version.json (no-store), last
  loop on start, every 5 min, on visible, on waiting worker
    W->>C: GET /version.json (cache: no-store)
    C-->>W: {version: new-sha, areas}
  end
  W->>W: new-sha differs from VITE_APP_VERSION: show the bar
  Note over W: New! · Settings · Profile picture · Later · Reload
  W->>SW: owner presses Reload: registration.update(), then postMessage SKIP_WAITING
  W->>W: progress 0 → 75 % in 0.8 s, then creep
  SW-->>W: controllerchange (new worker active, fresh files cached)
  W->>W: ease to 100 %, sparkle, location.reload()
```

Installed apps (phone PWA, desktop PWA and the desktop app) run the same code, so they show the same bar. The desktop
app never needs its own update: it loads the site, and the site updates itself.

### 12. Get the app and the desktop wrapper

The app offers the right install for each device ([CONTRACTS.md §12.1](CONTRACTS.md#121-get-the-app-sidebar-item-on-phones-a-card-in-settings-plus-a-one-time-banner-on-home))
and the Mac and Windows downloads come from a thin Tauri v2 window ([§12.3](CONTRACTS.md#123-desktop-wrapper-desktop-tauri-v2),
[ADR-18](DECISIONS.md#adr-18-a-thin-tauri-desktop-wrapper-not-electron)).

**The wrapper** (`desktop/`) bundles no screens. It opens `app_url` in the system web view (WebKit on macOS, WebView2 on
Windows), sets the title "Clip Factory" and the app icon, keeps a 380 × 600 minimum size, remembers size and position,
opens outside links in the normal browser, appends `ClipFactoryDesktop` to the user agent and sets
`window.__CF_DESKTOP__ = true`, so the web app hides Get the app inside it. Sign-in, tokens, the service worker and the
live connection work as in a browser; tokens live in the wrapper's own web storage.

**The build** is the `desktop` job in `deploy.yml`. It runs after the web deploy, only when `desktop/**` or the app
icon changed or a download is missing from the bucket:

```mermaid
sequenceDiagram
  autonumber
  participant G as deploy.yml (web job done)
  participant M as macos-latest runner
  participant Wn as windows-latest runner
  participant S as S3 cf-prod-web
  participant C as CloudFront
  participant W as Web app
  participant U as Owner's computer
  G->>G: desktop/** or icon changed, or downloads/ file missing?
  par matrix
    G->>M: app_url from Terraform output
    M->>M: tauri build, universal-apple-darwin → Clip-Factory.dmg (unsigned)
    M->>S: put downloads/Clip-Factory.dmg
  and
    G->>Wn: app_url from Terraform output
    Wn->>Wn: tauri build, NSIS → Clip-Factory-Setup.exe (unsigned)
    Wn->>S: put downloads/Clip-Factory-Setup.exe
  end
  G->>S: rewrite downloads/manifest.json {version, files:{mac, windows}} (no-cache)
  G->>C: invalidate /downloads/*
  W->>C: GET /downloads/manifest.json
  C-->>W: files for mac and windows (path, size)
  W->>W: detect device, pick the matching file or fall back to browser install
  U->>C: Download for Mac → /downloads/Clip-Factory.dmg
  U->>U: first open: right-click → Open (unsigned)
  U->>C: the desktop app loads app_url
```

**Phones** never get a file. Android installs the PWA through the browser's own prompt. iPhone and iPad get three
picture steps to Add to Home Screen, because Apple allows no app download outside its store
([ADR-21](DECISIONS.md#adr-21-iphone-and-ipad-get-add-to-home-screen-steps-not-a-download)).

**Hiding it once installed.** The web app checks `display-mode: standalone` / `window-controls-overlay`,
`navigator.standalone` (iOS), the desktop wrapper markers, and `cf.installed=1` in local storage (set on the
`appinstalled` event).

### 13. Clip numbers: the poller and Refresh numbers

The owner sees every clip's numbers per platform on `/clips/{clipId}`
([CONTRACTS.md §16.5](CONTRACTS.md#165-poller-and-refresh-lambda-cf-prod-stats)). One code path,
`stats.refresh.refresh_posts`, reads them for three callers: the EventBridge tick (`reason "poll"`), the Refresh button
(`"manual"`) and the clip flow's `metrics` step after 48 hours (`"flow"`). All three go through the same per-platform
budget, so together they can never pass a platform's limit.

**What makes a post due.** When a post is published, its `statsDueAt` is set and it gets `gsi2pk = "STATS"`,
`gsi2sk = "{statsDueAt}#{postId}"`. That sparse index is the due-queue: only posts inside their 30-day window carry
it. After each reading the next `statsDueAt` is `readAt + interval`, where the interval depends on the platform and
the post's age ([ADR-29](DECISIONS.md#adr-29-stats-refresh-intervals-per-platform)):

| Post age | YouTube, TikTok, X | Instagram, Facebook |
|---|---|---|
| up to 48 hours | every 15 min | every 30 min |
| up to 7 days | every 30 min | every 60 min |
| up to 30 days | every 2 h | every 6 h |
| 30 days | one final reading, then the post leaves `gsi2` | same |

YouTube's slow insights (YouTube Analytics: watch time, engaged views, shares, new subscribers) are read at most every
6 hours (`insightsDueAt`), because Google needs 48–72 hours to process them. Private TikTok posts (unaudited app) have
no stats id and never enter the queue.

**The tick.**

```mermaid
sequenceDiagram
  autonumber
  participant E as EventBridge rule cf-prod-stats
  participant S as cf-prod-stats
  participant D as DynamoDB (gsi2, RATE#, POST#, STAT#)
  participant P as Platform API
  participant B as cf-prod-broadcast
  participant W as Web app
  E->>S: scheduled event, every 15 min
  S->>D: Query gsi2: gsi2pk = STATS and gsi2sk <= "{now}#~" (up to 2,000 posts)
  S->>S: group by platform in STATS_ORDER, chunk by idsPerRequest (50, 20, 50, 50, 100)
  loop each platform not blocked, each chunk, until 240 s
    S->>D: reserve: one conditional UpdateItem on RATE#{platform}
    alt budget left
      S->>P: one batched read (tokens from Secrets Manager)
      P-->>S: numbers + headers (quota, BUC usage, x-rate-limit-reset)
      S->>D: record: headers, blockedUntil when a limit is near or hit
      S->>D: per post: metrics, statsDueAt, gsi2sk (or REMOVE gsi2 when final)
      S->>D: STAT# snapshot (first, every 60 min, 1 % change, or final, TTL 90 days)
    else blocked
      S->>S: skip the platform, its posts stay due for the next tick
    end
  end
  S->>S: log stats.tick {posts, requests, updated, blocked, errors}
  D->>B: stream: POST# changed
  B->>W: post upsert: the stack updates, the sparkline gains a point
```

**Refresh numbers.**

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app (clip page)
  participant A as cf-prod-api
  participant D as DynamoDB
  participant S as cf-prod-stats
  participant P as Platform API
  participant B as cf-prod-broadcast
  W->>A: POST /v1/clips/{clipId}/stats/refresh {platforms?}
  A->>D: Clip, Posts (gsi1 CLIP#), Accounts, RATE# budgets
  loop each platform in STATS_ORDER
    alt no post / private / no account / blocked
      A->>A: not_posted, private, not_connected or blocked (with nextAllowedAt)
    else
      A->>D: claim: SET refreshStartedAt, nextRefreshAt = now + cooldown<br/>if nextRefreshAt <= now and no refresh in the last 5 min
      A->>A: started, or too_soon when the claim fails
    end
  end
  A->>S: one Invoke (Event) {action refresh, userId, clipId, postIds of started}
  A-->>W: 202 {platforms: RefreshResult[]} (spinner, "Next check in 5 min")
  S->>D: reserve budget (same as the tick)
  S->>P: batched read
  S->>D: metrics, STAT#, then always REMOVE refreshStartedAt
  D->>B: stream: POST# changed
  B->>W: post upsert: new numbers, spinner stops
```

The cooldown is 5 minutes for YouTube, TikTok and X and 30 minutes for Instagram and Facebook, so pressing Refresh
again and again never spends more than the poller would. If the invoke itself fails, the API rolls the claims back and
answers `blocked` with "Could not check right now. Try again in a minute."

**Budgets** ([CONTRACTS.md §16.3](CONTRACTS.md#163-dynamodb-items)) are one item per platform (`RATE#{platform}`),
reserved with one conditional `UpdateItem` before every request, so two Lambdas at once can never both take the last
units:

| Platform | Counted as | Stop at | When a limit hits |
|---|---|---|---|
| YouTube | quota units per Pacific day (1 per `videos.list` call of up to 50 ids, 1 per Analytics report) | 7,000 of 10,000 (3,000 kept for uploads) | `quotaExceeded` / `rateLimitExceeded`: paused until 08:00 UTC |
| TikTok | requests per UTC minute | 300 of 600 | `429` / `rate_limit_exceeded`: paused 1 minute |
| Instagram, Facebook | Meta's `X-Business-Use-Case-Usage` header (call count, CPU time, total time, in %) | 75 % of any counter | throttle `80002` / `80001`: paused for Meta's `estimated_time_to_regain_access` (at least 60 min), **no retry** |
| X | requests per 15 minutes, plus an estimated spend | 1,000 of 3,500; $10 a month | `429`: paused until `x-rate-limit-reset`; monthly cap: paused until the 1st |

In phase 1 no account is connected, so every adapter answers `not_connected` and nothing reaches the network; the
poller, the queue and the budgets are already in place.

### 14. Best of the week

The owner stars the week's best clips in **Library › This week**; the picks teach the agent
([CONTRACTS.md §16.6](CONTRACTS.md#166-weekly-best-learning-lambda-cf-prod-learn),
[ADR-31](DECISIONS.md#adr-31-the-weekly-best-is-an-explicit-owner-signal), [AGENT.md](AGENT.md#best-of-the-week)).

A week is an ISO week (Monday start) in the **owner's own time zone**: the web computes `from` and `to` (local Monday
00:00 to the next Monday 00:00, as UTC instants, 167–169 hours across a clock change) and sends them with the week id.
A clip belongs to the week of its **anchor**: its earliest `postedAt`, or `decidedAt` while it is kept but not posted.

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app (This week)
  participant A as cf-prod-api
  participant D as DynamoDB
  participant L as cf-prod-learn
  participant V as S3 Vectors
  participant B as Bedrock (Fable 5.1, Titan V2)
  participant BC as cf-prod-broadcast
  W->>A: GET /v1/weeks/2026-W46?from=...&to=...
  A->>D: Query POST# and CLIP# of the owner, WEEK#2026-W46
  A-->>W: WeekView: clips sorted by views, picks, learnState
  W->>W: owner stars clips (optimistic), waits 800 ms after the last tap
  W->>A: PUT /v1/weeks/2026-W46/best {from, to, clipIds}
  alt same picks as stored
    A-->>W: 200 {week}, nothing else happens
  else changed
    A->>D: TransactWriteItems: WEEK (revision + 1, learnState learning),<br/>picked clips best = true, unpicked best = false
    A->>L: Invoke (Event) {userId, week, revision}
    A-->>W: 202 {week}: "Learning from your picks..."
    L->>D: GetItem WEEK: revision still the same? (else superseded, no write)
    L->>V: picked: metadata best = true, unpicked: best = false (errors logged only)
    L->>D: rows for every clip of the week (picked, hook, moment type, length, captions, numbers)
    L->>D: Query SKILL# items; files from S3 skills/ (cached by key): the skills block
    L->>B: Converse, skills block first, maxTokens 4000, effort low: one 1-3 sentence learning
    B-->>L: end_turn + text
    L->>D: same revision? Put Learning (kind week, "Best of week 2026-W46"), WEEK learnState done
  end
  D->>BC: stream: WEEK#, LEARNING#, CLIP# changed
  BC->>W: week and learning events: the learning appears in a glass quote
```

An empty set of picks deletes that week's learning and ends `skipped`. A model answer that is cut off, refused or
filtered ends `failed` ("Could not learn this time. Change a pick to try again."), and Bedrock errors are retried
twice. Because every write checks `revision`, a quick second save always wins over a slower first one.

### 15. Skills: every AI call gets every skill

The owner's rule: *"The whole AI system should use all of these skills by default, no matter what, as long as I add
them."* ([CONTRACTS.md §18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16),
[ADR-32](DECISIONS.md#adr-32-every-ai-call-gets-every-skill-through-one-shared-skills-block)).

**Create, read, update, delete.** Skills live in Settings › Clip making › Skills. The owner writes one by answering
three questions (`POST /v1/skills`, the API builds the `SKILL.md`), uploads a `.md` or `.zip` (presigned PUT, then
`POST /v1/skills`), reads any skill (`GET /v1/skills`, `GET /v1/skills/{skillId}`), changes their own
(`PUT /v1/skills/{skillId}`, with a `version` check so two screens cannot overwrite each other silently) and deletes
their own (`DELETE /v1/skills/{skillId}`, sent when the 8-second Undo ends). Built-in skills ship with the code and can
only be read. There is no on/off switch: `PATCH /v1/skills/{skillId}` only answers "Skills are always used now".

Every save writes a **new object** `skills/{userId}/{skillId}/{revisionId}/SKILL.md` (or `skill.zip`) and then moves
the DynamoDB item's `key` to it, so an object never changes after it is written: a running job keeps reading the file
it started with, and readers can cache files by key.

```mermaid
flowchart LR
  subgraph Settings["Settings › Clip making › Skills (web)"]
    W[Write / Upload] --> API
    R[Read] --> API
    E[Change] --> API
    X[Delete + Undo] --> API
  end
  API[cf-prod-api] --> D[("DynamoDB SKILL# items")]
  API --> S[("S3 skills/ revision files")]
  D --> L1[skills loader]
  S --> L1
  B0[built-in skills in the code] --> L1
  L1 --> BLK["one skills block<br/>built-ins, then the owner's by name"]
  BLK --> A1[Agent: Agent SDK moment picking]
  BLK --> A2[Agent: Converse fallback, facecam, checklist and hooks, captions]
  BLK --> A3[API: cf-prod-learn, daily lessons from day-7 numbers]
  BLK --> A4[API: cf-prod-learn, weekly best]
  BLK --> A5[API: Ask Clip Factory, Haiku rewrite]
  T[Titan embeddings] -.no skills, not text generation.-> V[(S3 Vectors)]
```

**One rule, two builders.** The agent (`agent/`) and the Lambdas (`api/`) each have the same small builder,
`skills_block(docs)`, checked against one shared reference file byte for byte. It puts every skill's `SKILL.md` text
inside `<owner_skills>`, built-ins first, then the owner's by name, at most 40,000 characters per skill and 120,000 in
total (built-ins are never the ones left out). `compose_system(block, task_system)` makes the block the **first**
part of every system prompt, followed by a Bedrock prompt-cache point when the block is 8,000 characters or more, so
the many calls of one job pay for the long, stable part once. If Bedrock refuses the cache point, it is turned off for
that process and the call is retried without it.

| Where | Model calls | How the skills are loaded |
|---|---|---|
| Agent (AgentCore Runtime) | Agent SDK moment picking; Converse: moment fallback, facecam, checklist (with the hook rewrite), captions | once per job at `analyze`; also written to `.claude/skills/` for the SDK |
| `cf-prod-learn` (weekly best, daily lessons) | `learn.converse_text` | `skill_prompt.load_skills` just before the call |
| `cf-prod-api`, Ask Clip Factory ([flow 17](#17-ask-clip-factory-the-help-assistant)) | `learn.converse_text` (Haiku 5.5, JSON schema) | `skill_prompt.load_block` per answer that reaches the model |

The Lambda loader reads the owner's `SKILL#` items with one Query and each file through a small in-memory cache keyed
by the S3 key (at most 64 files and 16 MB per container), so a warm Lambda reads S3 only after a skill changes. Both
`cf-prod-clip-flow` and `cf-prod-learn` may only `GetObject` under `skills/*` (no list); `cf-prod-learn` gets
`MEDIA_BUCKET`. A skill file that cannot be read is retried, then skipped and logged (`skills.skipped`); a failure to
read the skill items fails the step, whose normal retry runs, so no call quietly goes without skills.

**No way around it.** Each package has a test that reads its own source code and fails if a Converse, Agent SDK or
streaming model call is made anywhere except through these helpers, or without the `skills` argument. The only model
calls without skills are the Titan embeddings in `vectors.py`.

### 16. Set up posting, Connect and real posting

The owner sets up each platform once in **Settings › Posting › Set up posting**
([CONTRACTS.md §17](CONTRACTS.md#17-posting-setup-a-setup-list-per-platform-real-connect-real-posting-owner-request-2026-11-16),
the steps in [SETUP_POSTING.md](SETUP_POSTING.md)): make a developer app on the platform's website by following the
step cards, paste its keys, press **Check it**, then **Connect**. Numbered **10** in the diagram.

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner (web app)
  participant A as cf-prod-api
  participant SM as Secrets Manager
  participant D as DynamoDB
  participant P as Platform (consent page, token endpoint)
  participant H as cf-prod-hooks (REST GET /oauth/{platform}/callback)
  O->>A: GET /v1/setup (steps done, gates, values to copy: redirect URI, privacy URL, ...)
  O->>A: PUT /v1/setup/{platform}/keys {clientId, clientSecret, configId?}
  A->>SM: create or put cf-prod/platforms/{platform}/app
  A->>D: SETUP#{platform}: keysSavedAt, masked hints only
  O->>A: POST /v1/setup/{platform}/check
  A->>P: key test (dummy code or client credentials)
  O->>A: POST /v1/accounts/{platform}/connect
  A->>SM: GetSecretValue cf-prod/oauth/state-key (cached 5 min)
  A->>D: OAUTH#{nonce} (TTL exp + 5 min)
  A-->>O: authorizeUrl (state = v1.nonce.exp.HMAC; PKCE challenge for YouTube and X)
  O->>P: same tab: sign in, approve
  P->>H: 302 ?code&state
  H->>H: verify HMAC, expiry, platform
  H->>D: consume OAUTH#{nonce} once (conditional delete)
  H->>SM: read app keys
  H->>P: exchange code (exact redirect URI, PKCE verifier), read profile
  H->>SM: write cf-prod/platforms/{platform}/token (or pending choices for Meta)
  H->>D: ACCOUNT#{platform} connected (name, avatar), SETUP#{platform}
  H-->>O: 302 {app_url}/settings/posting/setup/{platform}?result=connected
  D-->>O: live event "setup" (stream → cf-prod-broadcast → WebSocket)
```

**Values the owner copies.** `GET /v1/setup` serves every value a platform asks for, built from `APP_URL` and
`HOOKS_URL`: the website (`/about.html`), privacy and terms (`/legal/…`, on the app's own domain because TikTok
verifies by URL prefix and Google lists every domain, [ADR-37](DECISIONS.md#adr-37-about-privacy-and-terms-on-the-apps-own-domain)),
the data-deletion URL and one exact redirect URI per platform. TikTok's verification file is uploaded through the API
into the web bucket root and invalidated in CloudFront.

**The callback** is the only public step. It trusts nothing in the request except a state that it signed, that has not
expired and that has not been used; it always redirects to one fixed page with a code from a fixed list, never logs
the query, and stores tokens only in Secrets Manager ([ADR-34](DECISIONS.md#adr-34-oauth-with-a-signed-single-use-state-tokens-only-in-secrets-manager),
[SECURITY.md](SECURITY.md#platform-keys-and-tokens)). Meta can return several Pages or Instagram accounts: the choices
wait in a short-lived `pending` secret and the owner picks one in the app (`POST /v1/accounts/{platform}/choose`).
Instagram uses Facebook Login for Business with a **user** access token: the callback exchanges it for the
long-lived one (`fb_exchange_token`), reads `me/accounts` with each Page's `instagram_business_account`, and keeps
only the Pages that have one. One → connected at once; several → `choose`; none → `no_accounts`. The token secret then
holds the Instagram account id, the Page id and that Page's access token, which posting and numbers use.

**Gates.** What each platform still has to allow is a gate on the setup: YouTube `published_app` (the Google app must
be **In production**, or tokens die after 7 days), TikTok `app_review` and `posting_audit` (until both pass, posts are
"Only me"), Facebook `app_live` (Reels stay visible to the owner until the app is Live), X `credits`. A platform is
**ready** when it is connected and no gate needs the owner.

**Posting.** The clip flow ([flow 7](#7-clip-flow-publish-wait-48-hours-learn)) asks `SecretsTokenProvider` for the
token (refreshed 5 minutes before expiry; TikTok and X rotate refresh tokens, so a 30-second lease serialises
refreshes and the new secret is written before use), then runs the platform's publisher
([ADR-35](DECISIONS.md#adr-35-every-upload-is-sent-as-a-file-and-posting-waits-inside-the-clip-flow)). Every upload is
sent as a file read from S3 in 8 MB ranges:

| Platform | Start | Check (durable wait between) | Finish |
|---|---|---|---|
| YouTube | resumable session on `www.googleapis.com/upload/youtube/v3/videos`, 8 MB chunks, privacy from Settings | `videos.list` processing status, every 30 s, up to 60 | – |
| TikTok | `creator_info`, then Direct Post `init` with the Post to TikTok sheet's choices, `FILE_UPLOAD` chunks | `status/fetch`, every 15 s, up to 80; the public id may come later (follow-up loop) | – |
| Instagram | publishing limit check, `REELS` container, upload to `rupload.facebook.com/ig-api-upload` | container `status_code`, every 60 s, up to 15 | `media_publish`, permalink |
| Facebook | `video_reels` start, upload to `rupload.facebook.com/video-upload` | video `status`, every 30 s, up to 40 | `video_reels` finish `PUBLISHED` |
| X | `media/upload` initialize, 4 MB appends, finalize | media status after `check_after_secs`, up to 20 | `POST /2/tweets` with links removed |

Disconnect (after an 8-second Undo in the app) revokes the token where possible, deletes the token secret and, for
YouTube, asks `cf-prod-stats` to `forget` stored YouTube numbers.

### 17. Ask Clip Factory: the help assistant

The owner asks "how do I…" or "where is…" and gets short steps plus a button that opens the page and lights up the
control ([CONTRACTS.md §19](CONTRACTS.md#19-ask-clip-factory-grounded-in-app-help-assistant-owner-request-2026-11-16),
[HELP_ASSISTANT.md](HELP_ASSISTANT.md), [ADR-38](DECISIONS.md#adr-38-bm25-over-vectors-for-help-and-the-model-is-optional),
[ADR-39](DECISIONS.md#adr-39-help-runs-in-cf-prod-api-with-claude-haiku-55-through-the-eu-profile)).

**Build time.** `web/scripts/help-corpus.mjs` turns the router, the navigation, the Settings tree, the screens and the
curated guides (`helpKb.json`) into `help-corpus.json` (committed). The Vite build also emits a content-hashed copy,
`/assets/help-corpus.<hash>.json` (cached forever), and names it in a `cf-help-corpus` meta tag in `index.html` (never
cached), so the API always finds the corpus that matches the deployed screens. `build_lambda.py` bundles the same file
into the Lambda zip as the fallback.

```mermaid
sequenceDiagram
  autonumber
  participant W as Web app (Ask panel)
  participant A as cf-prod-api (help)
  participant D as DynamoDB
  participant C as CloudFront (app)
  participant B as Bedrock (Haiku 5.5, EU profile)
  W->>A: POST /v1/help/answers {question, history ≤ 4, context}
  A->>D: HELP / SWITCH (at most every 60 s)
  A->>D: USER# / HELP#RATE: conditional update (6 a minute, 60 an hour)
  opt corpus older than 10 minutes
    A->>C: GET /index.html, read the cf-help-corpus meta
    A->>C: GET /assets/help-corpus.{hash}.json (same origin only)
  end
  A->>A: when filter (device, os, installed), refusal check, BM25 top 6, compose
  alt known, model allowed, cap reserved (HELP / CAP#window)
    A->>B: Converse: the owner's skills block, then the rules, JSON schema, maxTokens 700
    B-->>A: {known, text, steps, actionIds, sourceIds}
    A->>A: ground check (buttons, paths, numbers), else the composed answer
  end
  A-->>W: answer, mode, requestId (one help.answer log line, no text)
  opt answer has a live number
    W->>A: GET /v1/weeks/{week} or /v1/me (the owner's token, as the pages do)
  end
  W->>W: button: route check, unsaved guard, navigate, spotlight data-help
```

- **Without the model** the composed answer is complete; the model only rewords it. Unknown and refused questions
  never reach Bedrock. Any model problem (timeout, bad JSON, a stop reason, an invented button or number) returns the
  composed answer with `mode: "kb"`.
- **Skills**: like every model call ([flow 15](#15-skills-every-ai-call-gets-every-skill)), the help call goes through
  `learn.converse_text`, so the owner's skills block (`skill_prompt.load_block`) comes first and the help rules after
  it; the rules keep facts to the knowledge, the skills set the tone and the clip advice. If the skills cannot be read,
  the model is not called and the composed answer is used (outcome `kb_skills`).
- **In the browser**: help calls use their own quiet `fetch` (27 s timeout), so no page refetches. On a network
  error, a timeout or a 5xx the panel answers from its own copy of the corpus with the same rules; on 429 it shows a
  countdown and never retries by itself; on `help_off` the launcher disappears and the local copy is not used.

### 18. Ask as a full assistant (CONTRACTS §28, ADR-51)

```
browser ── whoami ──▶ cf-prod-ws ──▶ {connectionId}
browser ── POST /v1/help/files ──▶ cf-prod-api ──▶ presigned PUTs ──▶ cf-prod-media ask/{sub}/{fileId}
browser ── POST /v1/help/asks ──▶ cf-prod-api ── async Invoke ──▶ cf-prod-ask
cf-prod-ask ── skills, knowledge pack, APP STATE (DynamoDB reads) ──▶ Claude Opus 5.5 (Bedrock Mantle, eu-north-1)
            ◀── tool calls: web_search (Brave) · web_fetch (SSRF-guarded) · read_app_doc · read_my_clip_factory · show_app_buttons
cf-prod-ask ── PostToConnection ask.* ──▶ the owner's socket ──▶ the panel streams the answer
cf-prod-ask ── finally: delete ask/{sub}/{fileId}
```

The HTTP API keeps its 29 s limit: the answer runs in `cf-prod-ask` (150 s, async, never retried) and comes back as
events on the WebSocket the app already holds. The search key is the owner's own, in Secrets Manager
(`cf-prod/ask/search-key`). Everything Ask knows about the app is a generated pack shipped in the zip
(`api/src/clipfactory_api/ask/knowledge.json`, `ask/library/`), behind the owner's skills and cached for an hour.
When the socket, the model or the assistant switch is not there, the panel answers with §17 (above) instead.
