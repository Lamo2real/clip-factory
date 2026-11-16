# Architecture

Clip Factory Cloud is a serverless application in one AWS account and one environment (`prod`, resource prefix
`cf-prod`, region `eu-north-1`). Backend code is Python 3.13 (`api/`, `agent/`); every AWS resource is Terraform
(`infra/`). There is no server, no container service to run and no VPC.

The diagram is [architecture/aws-architecture.drawio](architecture/aws-architecture.drawio) (a PNG copy is
[architecture/aws-architecture.png](architecture/aws-architecture.png)). Names, routes, shapes and keys are defined in
[CONTRACTS.md](CONTRACTS.md), especially [§14](CONTRACTS.md#14-serverless-expansion-websocket-api-rest-api-durable-functions-s3-vectors)
and [§16](CONTRACTS.md#16-clip-performance-stats-refresh-and-weekly-best-owner-request-2026-11-16) (clip numbers and the weekly best)
and [§18](CONTRACTS.md#18-skills-full-create-read-update-delete-every-ai-call-uses-every-skill-owner-request-2026-11-16) (skills, and every AI call using every skill);
this document explains how the pieces work together and why.

![Clip Factory Cloud on AWS](architecture/aws-architecture.png)

## Overview

The numbers match the numbered flows in the diagram.

```mermaid
flowchart LR
  owner(["Owner: browser, phone PWA or desktop app"])
  cf[CloudFront] --> web[("S3 cf-prod-web: app, config.json, version.json, downloads")]
  owner --> cf
  owner -- sign in, SRP --> cog[Cognito user pool]
  owner -- "1 HTTPS + JWT" --> http[API Gateway HTTP API]
  owner -- "1 presigned PUT and GET" --> media[(S3 cf-prod-media)]
  owner <-- "4 wss, token on connect" --> ws[API Gateway WebSocket API]
  http --> lapi[Lambda cf-prod-api]
  lapi --> ddb[(DynamoDB cf-prod-data)]
  lapi -- "2 async invoke, alias live" --> jf[["Durable Lambda cf-prod-job-flow"]]
  jf -- "3 InvokeAgentRuntime" --> rt[AgentCore Runtime cf_prod_clip_agent]
  rt -. "callback: heartbeat, success, failure" .-> jf
  rt --> bedrock[Bedrock: Claude Fable 5.1 and Titan Embeddings V2]
  rt --> tr[Amazon Transcribe]
  rt --> ddb
  rt --> media
  rt -- "7 what worked before" --> vec[(S3 Vectors cf-prod-vectors, index clips)]
  ws --> wsa[Lambda cf-prod-ws-authorizer]
  ws --> lws[Lambda cf-prod-ws]
  lws --> ddb
  ddb -- "4 stream, filtered" --> bc[Lambda cf-prod-broadcast]
  bc -- PostToConnection --> ws
  lapi -- "5 Keep, then 6 async invoke" --> clf[["Durable Lambda cf-prod-clip-flow"]]
  clf -- "publish, phase 2" --> social[YouTube, Instagram, Facebook, TikTok, X]
  clf -- "wait 48 h, metrics, distil" --> bedrock
  clf -- "6 upsert vector" --> vec
  platforms[Platform webhooks and OAuth, phase 2] --> rest[API Gateway REST API]
  rest --> hooks[Lambda cf-prod-hooks] --> ddb
  hooks --> ssm[SSM Parameter Store: verify token]
  os[OpenSearch Serverless: not deployed]:::off -. option .- vec
  evr[EventBridge rule cf-prod-stats, rate 15 minutes] -- "8 tick" --> st[Lambda cf-prod-stats]
  lapi -- "8 Refresh numbers, async" --> st
  st -- "8 due posts (gsi2), metrics, STAT#, RATE#" --> ddb
  st -. "8 batched reads, phase 2 tokens" .-> stapi[Platform stats APIs: YouTube, TikTok, Instagram, Facebook, X]
  lapi -- "9 weekly best saved, async" --> lrn[Lambda cf-prod-learn]
  lrn -- "9 Best of week learning" --> bedrock
  lrn -- "9 best true or false" --> vec
  lrn --> ddb
  classDef off stroke-dasharray: 5 5
```

## Services and why each one

Only managed, pay-per-use services. Nothing runs while the app is idle except storage. Why each choice was made is in
[DECISIONS.md](DECISIONS.md).

| Service | Resource | Why |
|---|---|---|
| Amazon CloudFront | web distribution | HTTPS, caching for the PWA, `config.json`, `version.json` and `downloads/manifest.json` never cached. Origin Access Control keeps the bucket private. The CSP allows `wss://*.execute-api.eu-north-1.amazonaws.com` for live updates. |
| Amazon S3 | `cf-prod-web` | The built web app, `version.json` (what is new), and `downloads/` (the desktop `.dmg` and `.exe` plus `manifest.json`). Private; only CloudFront reads it. |
| Amazon S3 | `cf-prod-media-<accountId>` | Uploads, extracted audio, transcripts, rendered clips and covers, skills and the optional YouTube cookies. Private, SSE-S3, sources expire after 14 days. Browsers use presigned URLs only. |
| Amazon S3 Vectors | bucket `cf-prod-vectors-<accountId>`, index `clips` (1024 dimensions, cosine, float32) | The learning memory: one vector per clip, so the agent can find "what worked before" and the app can show "Like clips that did well". Paid per request and per stored vector, nothing standing. See [ADR-25](DECISIONS.md#adr-25-s3-vectors-for-the-learning-memory-opensearch-not-deployed). |
| Amazon Cognito | user pool `cf-prod-users`, client `cf-prod-web` | One owner, admin-created. Short access tokens and a rotating 30-day refresh token. |
| Amazon API Gateway, HTTP API | `/v1` routes | The app's API. Cheapest type, with a built-in JWT authorizer. CORS for the app and `localhost:5173`. |
| Amazon API Gateway, WebSocket API | `cf-prod-ws`, stage `live` | Pushes job, clip, post and learning changes to open apps, so screens update without waiting for a poll. See [ADR-23](DECISIONS.md#adr-23-live-updates-over-a-websocket-api-polling-only-as-the-fallback). |
| Amazon API Gateway, REST API | `cf-prod-hooks`, stage `v1` | The one public, unauthenticated surface: platform webhooks and OAuth callbacks (phase 2), with per-method throttling, a usage plan, request validation and X-Ray. See [ADR-24](DECISIONS.md#adr-24-a-separate-rest-api-for-public-platform-webhooks). |
| AWS Lambda | `cf-prod-api` | Every `/v1` route: validation, DynamoDB, presigned URLs, skills (write, upload, read, change, delete), starting the two durable flows, cancel, Keep and Throw away, similar clips, a clip's performance, Refresh numbers (claims the posts, then invokes `cf-prod-stats`), the weeks and their picks (invokes `cf-prod-learn`). |
| AWS Lambda | `cf-prod-stats` | The numbers poller ([flow 13](#13-clip-numbers-the-poller-and-refresh-numbers)): every tick it reads the posts that are due from the sparse `gsi2`, reserves each platform's budget, reads the numbers in batches and writes them to the posts and `STAT#` snapshots. The Refresh button runs the same code at once. See [ADR-30](DECISIONS.md#adr-30-one-eventbridge-rule-and-a-due-queue-for-stats-polling). |
| AWS Lambda | `cf-prod-learn` | The weekly best ([flow 14](#14-best-of-the-week)): marks the starred clips' vectors `best`, asks Claude Fable 5.1 (with the skills block) for one "Best of week" learning. See [ADR-31](DECISIONS.md#adr-31-the-weekly-best-is-an-explicit-owner-signal). |
| Amazon EventBridge | rule `cf-prod-stats`, `rate(15 minutes)` | The only schedule in the system: one tick for the stats poller, its rate taken from the smallest interval in `config/platforms.json`. A few thousand invocations a month. See [ADR-30](DECISIONS.md#adr-30-one-eventbridge-rule-and-a-due-queue-for-stats-polling). |
| AWS Lambda, durable function | `cf-prod-job-flow` (alias `live`) | Starts the agent for a job and waits (no compute) for its callback; fails the job if heartbeats stop. Replaces the watchdog. See [ADR-22](DECISIONS.md#adr-22-lambda-durable-functions-for-the-job-and-clip-workflows). |
| AWS Lambda, durable function | `cf-prod-clip-flow` (alias `live`) | After Keep: makes the posts, publishes (phase 2), waits 48 hours (no compute), reads metrics, writes a learning, updates the clip's vector. Replaces the publish queue, the publisher, the scheduler and perf-check. |
| AWS Lambda | `cf-prod-ws-authorizer` | Checks the Cognito access token on `$connect` (standard library RS256 check, no extra packages). |
| AWS Lambda | `cf-prod-ws` | `$connect` stores the connection, `$disconnect` removes it, `$default` answers `ping`. |
| AWS Lambda | `cf-prod-broadcast` | Reads the DynamoDB stream and sends each change to the owner's open connections. |
| AWS Lambda | `cf-prod-hooks` | Answers webhook verification challenges, stores webhook events, redirects OAuth callbacks to Settings. |
| Amazon DynamoDB | `cf-prod-data` + stream | Single table for all entities including WebSocket connections, webhook events, stats snapshots (`STAT#`, 90-day TTL), the weekly picks (`WEEK#`) and the per-platform rate budgets (`RATE#`); a sparse `gsi2` holds only the posts due for a stats poll. On-demand, point-in-time recovery, TTL, stream `NEW_AND_OLD_IMAGES` feeding `cf-prod-broadcast`. See [ADR-05](DECISIONS.md#adr-05-one-dynamodb-table-single-table-design). |
| AWS Systems Manager Parameter Store | `/cf-prod/hooks/verify-token` (SecureString) | The Meta webhook verify token. Generated by Terraform as a write-only value, so it never enters the Terraform state. |
| Amazon Bedrock AgentCore Runtime | `cf_prod_clip_agent` | Runs the agent container for as long as a job needs, one isolated session per job. See [ADR-03](DECISIONS.md#adr-03-amazon-bedrock-agentcore-runtime--claude-agent-sdk-for-the-agent). |
| Amazon Bedrock | Claude Fable 5.1 (global profile), Titan Text Embeddings V2 (in-Region) | Fable: moment selection, facecam detection, checklist judgement, captions, learnings. Every Fable call, through the Agent SDK or Converse, gets the owner's skills block first ([flow 15](#15-skills-every-ai-call-gets-every-skill)). Titan: 1024-number embeddings of clip text for S3 Vectors (no skills: not text generation). |
| Amazon Transcribe | batch jobs | Word-level timestamps and language detection. |
| Amazon ECR | agent repository | The ARM64 agent image, tagged by a hash of its sources. |
| Amazon CloudWatch | logs, alarms | JSON logs for every function and the agent; access logs for the WebSocket and REST APIs (never the query string); alarms on Lambda errors, failed or timed-out durable executions, stream lag and REST 5xx. |
| Amazon SNS | `cf-prod-alarms` | Emails `alarm_email` when an alarm fires (optional). |
| AWS IAM | GitHub OIDC deploy role, one role per function, the API Gateway logging role | No long-lived keys anywhere; each function can touch only what it needs. |
| Amazon OpenSearch Serverless | not deployed | Shown dashed in the diagram as an option for keyword or hybrid search later ([ADR-25](DECISIONS.md#adr-25-s3-vectors-for-the-learning-memory-opensearch-not-deployed)). |
| GitHub Actions (not AWS) | CI, deploy, desktop runners | Tests and deploys through OIDC; builds the desktop app on `macos-latest` and `windows-latest` ([§12.3](CONTRACTS.md#123-desktop-wrapper-desktop-tauri-v2)). |

### Lambda functions

All nine share one zip (`api/dist/lambda.zip`), Python 3.13, arm64, JSON logs, X-Ray active
([CONTRACTS.md §9](CONTRACTS.md#9-lambdas-one-zip-apidistlambdazip-python-313-arm64-package-clipfactory_api)).

| Function | Started by | Memory / timeout | Durable |
|---|---|---|---|
| `cf-prod-api` | HTTP API | as before | no |
| `cf-prod-job-flow` | `cf-prod-api`, async invoke of alias `live` | 256 MB / 120 s per invocation; whole execution up to 8 h 30 min | yes, retention 14 days |
| `cf-prod-clip-flow` | `cf-prod-api`, async invoke of alias `live` | 512 MB / 900 s per invocation; whole execution up to 3 days | yes, retention 14 days |
| `cf-prod-ws-authorizer` | WebSocket `$connect` | 128 MB / 10 s | no |
| `cf-prod-ws` | WebSocket routes | 128 MB / 10 s | no |
| `cf-prod-broadcast` | DynamoDB stream (filtered) | 256 MB / 60 s | no |
| `cf-prod-hooks` | REST API | 256 MB / 10 s | no |
| `cf-prod-stats` | EventBridge rule `cf-prod-stats` (every 15 min) and `cf-prod-api` (async, Refresh numbers) | 256 MB / 300 s; stops starting requests after 240 s; async retries 0, event age 15 min | no |
| `cf-prod-learn` | `cf-prod-api`, async invoke on `PUT /v1/weeks/{week}/best` | 512 MB / 300 s; async retries 1, event age 1 h | no |

### What was removed

The expansion removed these, with nothing left that refers to them ([CONTRACTS.md §14.1](CONTRACTS.md#141-what-is-removed-delete-it-from-terraform-code-tests-and-docs-nothing-may-still-reference-it)):

| Removed | Replaced by |
|---|---|
| Lambda `cf-prod-publisher` | `cf-prod-clip-flow` steps `ensure-posts` and `publish-{platform}` |
| Lambda `cf-prod-perf-check` | `cf-prod-clip-flow` steps `wait-48h`, `metrics`, `distil` |
| Lambda `cf-prod-watchdog` and its EventBridge rule (every 10 minutes) | the job-flow callback heartbeat timeout (15 minutes) |
| SQS `cf-prod-publish` and its dead-letter queue | durable execution: steps retry and checkpoint, no queue |
| EventBridge Scheduler group, role and one-time `perf-{postId}` schedules | `context.wait(48 h)` inside `cf-prod-clip-flow` |
| The DLQ alarm | alarms on `DurableExecutionFailed` and `DurableExecutionTimedOut` |
| Polling as the only way to see progress | WebSocket push; polling stays as the fallback |

The watchdog's EventBridge rule stays gone. [§16](CONTRACTS.md#16-clip-performance-stats-refresh-and-weekly-best-owner-request-2026-11-16)
adds exactly one new rule, `cf-prod-stats`, for a different job (reading numbers for many posts on a clock), see
[ADR-30](DECISIONS.md#adr-30-one-eventbridge-rule-and-a-due-queue-for-stats-polling).

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
  start([job-flow starts]) --> cb["create_callback agent-done<br/>timeout 8 h, heartbeat timeout 15 min"]
  cb --> sa["step start-agent<br/>GetItem Job, InvokeAgentRuntime process_job + callbackId"]
  sa -- "job missing, another sessionId, or terminal" --> sup([outcome superseded])
  sa --> wait["cb.result(): no compute while waiting"]
  wait -- success --> fin["step finish: Job ready + clipCount if not already"] --> ready([outcome ready])
  wait -- "JobFailed" --> fail["step fail: Job failed with the agent's message"]
  wait -- "timeout or missed heartbeat" --> fail2["step fail: 'The agent stopped responding. Press Retry.'"]
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
  else container died (no heartbeat for 15 min)
    L->>F: resume with CallbackError (heartbeat timeout)
    F->>D: step fail: Job failed, "The agent stopped responding. Press Retry."
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
  participant V as S3 Vectors
  R->>D: job running, load settings, every skill (no switch), latest 10 learnings
  R->>S: read each skill's file, build the skills block once for the job
  R->>Y: resolve: metadata (title, channel, duration) or S3 head for uploads
  R->>Y: download: audio only, capped at maxSourceHours
  R->>S: audio.m4a
  R->>T: StartTranscriptionJob (word timestamps, auto language)
  T->>S: transcript.json
  R->>S: words.json, loudness.json
  R->>B: Titan: embed title, channel, notes, transcript start
  R->>V: QueryVectors top 8, this owner, status performed
  V-->>R: similar past clips with performance ("What worked before")
  R->>B: select: skills block + transcript windows + loudness + learnings + what worked before
  B-->>R: ranked moments (+ spares) with hooks and moment types
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
  ep --> pub{"any post queued?<br/>(phase 2: account connected)"}
  pub -- "yes, per platform" --> pp["step publish-{platform}<br/>3 attempts, backoff, idempotency key = postId"]
  pp -- "retries exhausted" --> pf["step post-failed-{platform}: post failed"]
  pp --> settle
  pf --> settle
  pub -- "no (today: every post pending_integration)" --> settle["step settle-clip<br/>posted, failed or confirmed"]
  settle -- "nothing posted" --> uv1["step upsert-vector (status confirmed)"] --> np([outcome not_posted])
  settle -- "at least one posted" --> w48["wait-48h: Duration 48 h, no compute"]
  w48 --> met["step metrics: views, likes, comments, shares per post"]
  met --> dis["step distil: Claude Fable 5.1, skills block first, writes one short Learning"]
  dis --> uv2["step upsert-vector (status performed + performance)"] --> done([outcome done])
```

```mermaid
sequenceDiagram
  autonumber
  participant C as cf-prod-clip-flow
  participant D as DynamoDB
  participant X as Platform API (phase 2)
  participant B as Bedrock (Fable 5.1, Titan V2)
  participant V as S3 Vectors
  C->>D: step ensure-posts
  loop each queued post (phase 2)
    C->>X: step publish-{platform}: upload with that platform's caption
    X-->>C: public URL
    C->>D: post posted, postedAt, perfCheckAt = postedAt + 48 h
  end
  C->>D: step settle-clip: clip posted
  Note over C: wait-48h: checkpoint, no compute, no schedule
  C->>X: step metrics: read views, likes, comments, shares
  C->>D: metrics on each post
  C->>D: step distil: read the owner's skill items
  C->>B: Converse with the skills block first, effort low, one sentence
  C->>D: Learning item (used by the next jobs, shown on Insights)
  C->>V: step upsert-vector: GetVectors, merge metadata, PutVectors (performed)
```

The `metrics` step reads the numbers through the same stats refresh as the poller ([flow 13](#13-clip-numbers-the-poller-and-refresh-numbers)),
so it shares the platforms' budgets. Every step is at-least-once, so each is written to be safe to repeat: posts are created only once (`postsCreated`),
a post is updated only while it is `queued`, and publishing passes `postId` as the platform's idempotency key. A
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

Ready for phase 2; nothing runs inline except storing the event.

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
  H-->>P: 302 to the app: /settings?account=youtube&status=coming_soon
```

The REST access log has no query string (OAuth callbacks carry `code` and `state`). Each method is throttled to 10
requests a second (burst 20), and `tiktok` and `x` answer `501` until phase 2.

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
  G->>AWS: write config.json (apiUrl, wsUrl) from outputs, sync web to S3, invalidate CloudFront
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
  participant P as Platform API (phase 2)
  participant B as cf-prod-broadcast
  participant W as Web app
  E->>S: scheduled event, every 15 min
  S->>D: Query gsi2: gsi2pk = STATS and gsi2sk <= "{now}#~" (up to 2,000 posts)
  S->>S: group by platform in STATS_ORDER, chunk by idsPerRequest (50, 20, 50, 50, 100)
  loop each platform not blocked, each chunk, until 240 s
    S->>D: reserve: one conditional UpdateItem on RATE#{platform}
    alt budget left
      S->>P: one batched read (tokens from Secrets Manager, phase 2)
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
  participant P as Platform API (phase 2)
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
  BLK --> A3[API: clip-flow distil, 48 h]
  BLK --> A4[API: cf-prod-learn, weekly best]
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
| `cf-prod-clip-flow` step `distil` | `learn.converse_text` | `skill_prompt.load_skills` just before the call |
| `cf-prod-learn` | `learn.converse_text` | `skill_prompt.load_skills` just before the call |

The Lambda loader reads the owner's `SKILL#` items with one Query and each file through a small in-memory cache keyed
by the S3 key (at most 64 files and 16 MB per container), so a warm Lambda reads S3 only after a skill changes. Both
`cf-prod-clip-flow` and `cf-prod-learn` may only `GetObject` under `skills/*` (no list); `cf-prod-learn` gets
`MEDIA_BUCKET`. A skill file that cannot be read is retried, then skipped and logged (`skills.skipped`); a failure to
read the skill items fails the step, whose normal retry runs, so no call quietly goes without skills.

**No way around it.** Each package has a test that reads its own source code and fails if a Converse, Agent SDK or
streaming model call is made anywhere except through these helpers, or without the `skills` argument. The only model
calls without skills are the Titan embeddings in `vectors.py`.

## Failure handling

| What can fail | What happens |
|---|---|
| A pipeline step (download blocked, Transcribe error, render error) | The step is marked `failed` with a plain message, the job becomes `failed`, the agent sends `JobFailed` to the job-flow callback, the app shows **Try again**. |
| One clip fails the checklist | One fix pass; if it still fails, a spare moment replaces it. The job finishes with the clips that pass. |
| The agent container dies or the session ends | Heartbeats to the callback stop; after 15 minutes the job flow's `fail` step marks the job failed ("The agent stopped responding. Press Retry.") and stops the session. No scan, no watchdog. |
| The job flow cannot start the agent | Step `start-agent` retries 3 times with backoff on throttling, 5xx and connection errors; then the execution fails and the `cf-prod-job-flow-durable-failed` alarm fires. |
| The API cannot start a flow | Job: `failed` with "Could not start. Press Try again." Clip: stays `publishState: pending`; the next Keep starts it again (same name, so never twice). |
| A job runs longer than 8 hours | The callback times out and the job fails with the same plain message; long sources are capped by `maxSourceHours`. |
| Bedrock throttling | The SDK retries with exponential backoff; the global profile spreads load across regions. |
| The owner cancels | The API sends `{action: cancel}` to the session and stops it; the agent marks the job `canceled` and sends `Canceled`, so the flow writes nothing. |
| Publishing a post fails (phase 2) | The `publish-{platform}` step retries 3 times with backoff; then `post-failed-{platform}` marks only that post `failed`. If every queued post failed, the clip shows **Try again**. |
| Reading metrics fails for a platform | That platform is skipped after 3 attempts; the others still count. The clip flow's `metrics` step uses the shared stats refresh and falls back to the stored numbers when a platform is blocked. |
| A platform limit is near or hit (stats) | The platform's `RATE#` budget gets `blockedUntil` (YouTube: 08:00 UTC; TikTok: 1 min; Meta: Meta's own wait, at least 60 min after a throttle; X: `x-rate-limit-reset` or the 1st of next month at the $10 cap). The poller skips it, its posts stay due, Refresh answers "Next check in …". A Meta throttle is never retried. |
| A stats read fails (5xx, network) | Retried twice (1 s, 4 s), except Meta throttles; then `statsError` holds a plain sentence on the post and it waits its normal interval. No tight loop, no raise. |
| The tick has more due posts than fit in 240 s | It stops starting requests at 240 s; the rest stay due and go first on the next tick. |
| Two ticks or a tick and a Refresh run at once | Budgets are conditional writes, so they cannot overspend together; a post read twice simply gets the newer numbers. |
| `cf-prod-learn` fails or is superseded | A newer save wins (the `revision` check); a failed invoke or model answer leaves "Could not learn this time. Change a pick to try again."; vector errors are logged and never stop the learning. |
| A skill file cannot be read (agent or Lambda) | Retried 3 times, then skipped and logged `skills.skipped`; the agent's `analyze` step says "1 could not be read". Reading the skill items themselves failing fails the step, and its normal retry runs. |
| The skills are too long for one call | Each is cut to 40,000 characters, all together to 120,000; a skill that does not fit is shortened or left out and named (`skills.block` log). Built-ins are never left out. |
| Bedrock refuses the prompt-cache point | Cache points are turned off for that process (`bedrock.cache_point_off`) and the call is retried without one. |
| Two screens save the same skill | The second save gets `409` ("This skill was changed somewhere else"); the app offers Use the newest or Save mine anyway. |
| Distil gets no usable answer (`max_tokens`, `refusal`, `content_filtered`) | Logged; no Learning is written; the vector is still updated. |
| S3 Vectors or Titan errors | Agent: the "What worked before" section is skipped. `/similar`: returns `[]`. Throw away: logged, the route still succeeds. |
| A durable execution fails or times out | Alarms `{fn}-durable-failed` and `{fn}-durable-timed-out` email the owner. A failed execution means a bug, because expected outcomes never raise. |
| A deploy happens during a 48-hour wait | The running execution stays on the version it started on; new executions use the new version. |
| The WebSocket drops (phone sleeps, network change, 2-hour cap) | The app reconnects with backoff 1–30 s, refetches what is on screen and polls while disconnected. No error is shown. |
| A WebSocket message cannot be delivered | `GoneException` deletes the stale connection; other errors are logged and skipped (the app refetches on reconnect). Connections also expire by TTL after 2 hours. |
| The broadcaster falls behind | Records older than 10 minutes are dropped (the app catches up on its next refetch); `cf-prod-broadcast-iterator-age` alarms when lag passes 5 minutes. |
| A webhook flood | REST per-method throttling (10/s, burst 20) answers `429`; the usage plan caps a month at 100 000 requests. |
| A presigned URL expires | URLs last 1 hour; the app refetches the clip or job and gets fresh ones. |
| Bad deploy | Revert the commit on `main`; the next deploy restores the previous state ([DEPLOYMENT.md](DEPLOYMENT.md#rollback)). |
| Data deleted by mistake | DynamoDB point-in-time recovery (35 days). |
| `version.json` cannot be read | The app shows no update bar and checks again in 5 minutes. It never blocks the app. |
| The new service worker is slow to activate | The reload bar creeps, and after 10 s the page reloads anyway. |
| `release-areas.sh` finds nothing usable | The label is "Improvements". The deploy never fails because of labels. |
| A desktop build fails | The `desktop` job fails on its own; the web deploy has already finished. The old files and `manifest.json` stay. |
| A download file is missing | `manifest.json` does not list it; Get the app falls back to the browser install. The next deploy rebuilds it. |

## Cost notes

Rough, for one owner running about 10 jobs a month on 2-hour sources. Everything else is close to free tier.

| Item | Driver | Rough monthly |
|---|---|---|
| Bedrock, Claude Fable 5.1 | Moment selection reads the transcript; checklist, captions, vision and distil are small. Every call also carries the skills block (up to 120,000 characters); its prompt-cache point makes the repeats within a job much cheaper | the largest line; a few dollars per job, depending on source length and skills |
| Bedrock, Titan Text Embeddings V2 | A few thousand tokens per job | cents |
| Amazon Transcribe | $0.024 per audio minute | 10 × 120 min ≈ $29 |
| AgentCore Runtime | CPU and memory per second while a job runs (30–60 min) | a few dollars |
| Lambda durable functions | A handful of durable operations per job and per clip, small checkpoints, 14 days retention; no charge while waiting | cents |
| S3 Vectors | A few hundred vectors, a few queries per job | cents |
| API Gateway (HTTP, WebSocket, REST) | Requests, WebSocket messages and connection minutes while the app is open | under $1 |
| DynamoDB (incl. stream reads by Lambda), other Lambdas, SSM standard parameter | Requests | under $1 |
| EventBridge rule + `cf-prod-stats` | about 2,900 ticks a month (every 15 min), each a few seconds; post writes and 90-day `STAT#` snapshots | cents |
| YouTube, TikTok, Instagram, Facebook APIs | Free within their quotas; the budgets stay well under them | $0 |
| X API (phase 2) | Pay per use: about $0.005 per post read, a post read again on the same UTC day free, so about $0.15 per post over its 30 days | capped at $10 by the app ([DEPLOYMENT.md](DEPLOYMENT.md#x-api-credits-for-clip-numbers)) |
| `cf-prod-learn` | One small Fable 5.1 call per changed set of weekly picks | cents |
| S3 | Clips kept; sources expire after 14 days | under $1 |
| CloudFront | Web app, config, `version.json` checks, desktop downloads (about 10 MB each) | under $1 |
| OpenSearch Serverless | not deployed (would have a standing minimum of OCUs) | $0 |
| GitHub Actions | macOS and Windows runners for the desktop app | free (public repository) |

`maxSourceHours` (default 6) is the main cost lever: it limits how much audio is transcribed and read by Claude.

## Limits

- **YouTube may block cloud IP addresses.** Requests from AWS addresses are sometimes asked to "sign in to confirm
  you're not a bot". Two ways out: add a `cookies.txt` from a signed-in browser in Settings (stored privately at
  `private/<userId>/youtube-cookies.txt`, used only by yt-dlp), or download the video yourself and upload it. The job
  error says which one to try.
- **Twitch and Kick** VODs can be subscriber-only or deleted after a while; those fail at the resolve step with a
  plain reason.
- **Very long streams** are processed up to `maxSourceHours` (1–12). A job must finish within the 8-hour callback
  timeout (the job flow's execution limit is 8 h 30 min).
- **Uploads** are limited to 5 GB per file.
- **AgentCore sessions** have a maximum lifetime; a job that would exceed it should lower `maxSourceHours`.
- **Durable functions**: the clip flow can run for up to 3 days; execution history is kept for 14 days. Durable
  settings can only be set when a function is created, so changing them means a new function.
- **WebSocket**: connections close after 10 minutes idle (the app pings every 5) and after 2 hours (the app reconnects
  at 110 minutes); one message is at most 128 KB, and the broadcaster keeps events under 24 KB.
- **S3 Vectors**: the index settings (1024 dimensions, cosine, the four non-filterable keys) are fixed at creation; a
  change needs a new index. Filterable metadata stays under 2 KB per vector.
- **Model location**: Claude Fable 5.1 is reached only through the global profile from `eu-north-1`, so prompts may be
  processed outside the EU, and the account must be opted in to `aws_review` data retention
  ([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).
- **Presigned URLs** last 1 hour.
- **One owner**: the data model supports more users, but sign-up is off.
- **Desktop builds are unsigned** ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)): macOS and Windows
  warn on the first open; the Get the app card explains the one extra click.
- **The desktop app has the app address built in.** If `app_url` changes (for example a custom domain), the desktop
  files must be rebuilt: delete them from `downloads/` and the next deploy rebuilds them
  ([DEPLOYMENT.md](DEPLOYMENT.md#desktop-downloads)). Already installed copies keep opening the old address.
- **No iPhone download.** Apple allows no app files outside its store; iPhone and iPad use Add to Home Screen.
- **Numbers are not live to the second.** YouTube's `viewCount` is cached and can trail YouTube Studio by minutes;
  since 31 March 2025 Shorts views count every play and replay. YouTube Analytics lags 48–72 hours, Meta says its
  numbers can be up to 48 hours late, and Meta's `reach` and skip rate are estimates. Each app counts views its own
  way, which the page says next to the total.
- **TikTok numbers need TikTok's audit.** An unaudited app can post only privately, and private posts have no public
  id and no numbers.
- **X's private numbers last 30 days.** Impressions, link clicks and watch-through percentages (`non_public_metrics`)
  are only given for posts younger than 30 days; after that only public numbers are read.
- **Facebook metrics are changing.** Graph API v25.0 retires `post_impressions_unique`, `total_video_impressions*` and
  `total_video_views_unique` when v26.0 ships, so they are never read; reach comes from
  `post_total_media_view_unique`, guarded (absent if it errors). The Graph version lives in `config/platforms.json`.
- **Snapshots last 90 days** (TTL); the latest totals stay on the post for as long as the clip exists.
