## 14. Serverless expansion: WebSocket API, REST API, durable functions, S3 Vectors

Everything stays serverless and in `eu-north-1`: CloudFront + S3 (web), S3 (media), S3 Vectors, DynamoDB, three API
Gateway APIs (HTTP for the app, WebSocket for live updates, REST for platform webhooks), Lambda (plain and durable),
AgentCore Runtime, Transcribe, Bedrock. Backend code is Python 3.13 (`api/`, `agent/`); infrastructure is Terraform
(`infra/`). No server, container service or VPC is added. Where this section and an earlier one disagree, this one wins.

### 14.1 What is removed (delete it from Terraform, code, tests and docs; nothing may still reference it)

| Removed | Replaced by |
|---|---|
| Lambda `cf-prod-publisher`, file `api/src/clipfactory_api/publisher.py` | `cf-prod-clip-flow` steps `ensure-posts` / `publish-{platform}` (§14.5) |
| Lambda `cf-prod-perf-check`, file `api/src/clipfactory_api/perf_check.py` | `cf-prod-clip-flow` wait + `metrics` / `distil` steps; the distil logic moves to `api/src/clipfactory_api/learn.py` |
| Lambda `cf-prod-watchdog`, file `api/src/clipfactory_api/watchdog.py` | `cf-prod-job-flow` callback heartbeat timeout (§14.4) |
| SQS `cf-prod-publish`, DLQ `cf-prod-publish-dlq`, their policies and the event source mapping | durable execution (no queue) |
| EventBridge Scheduler group `cf-prod`, role `cf-prod-scheduler`, one-time schedules `perf-{postId}` | `context.wait(48 h)` in `cf-prod-clip-flow` |
| EventBridge rule `cf-prod-watchdog` (rate 10 minutes), its target, permission and `event_invoke_config` | – (the only EventBridge rule since §16 is `cf-prod-stats`) |
| Env vars `PUBLISH_QUEUE_URL`, `PERF_CHECK_FUNCTION_ARN`, `SCHEDULER_ROLE_ARN`, `SCHEDULE_GROUP` | `JOB_FLOW_ARN`, `CLIP_FLOW_ARN` on `cf-prod-api` |
| Clip field `publishClaimAt`; clip `publishState` value `enqueued` | `publishState: "pending" \| "started"` (§14.5) |
| `api` module output `publish_dlq_name`; monitoring variable `dlq_name` and alarm `cf-prod-publish-dlq-not-empty` | durable-execution alarms (§14.9) |
| `infra/modules/api/tests/watchdog.tftest.hcl`; publisher/perf-check/watchdog cases in `api/tests/test_workers.py` | `infra/modules/flows/tests/*.tftest.hcl`, `api/tests/test_flows.py` (§14.12) |
| The API calling `InvokeAgentRuntime` with `process_job` | `cf-prod-job-flow` step `start-agent` (the API still sends `cancel`) |

Removing the old Lambdas, queue and schedules is a plain Terraform destroy on the next apply; no data migration is
needed (today every post is `pending_integration`, so no schedule or message is in flight).

### 14.2 Live updates: WebSocket API (Terraform module `realtime`)

**Resources.** `aws_apigatewayv2_api` `cf-prod-ws` (`protocol_type = "WEBSOCKET"`, `route_selection_expression =
"$request.body.action"`), stage `live` (`auto_deploy = true`), routes `$connect` (authorization `CUSTOM`, authorizer
below), `$disconnect`, `$default`, all `AWS_PROXY` integrations on `cf-prod-ws`. Authorizer `cf-prod-ws-token`:
`authorizer_type = "REQUEST"`, `identity_sources = ["route.request.querystring.token"]`, `authorizer_uri` = invoke ARN
of `cf-prod-ws-authorizer`. Do **not** set `authorizer_result_ttl_in_seconds`, `authorizer_payload_format_version` or
`enable_simple_responses` (HTTP-only; WebSocket authorizer results are never cached by API Gateway). Lambda
permissions for `apigateway.amazonaws.com` with source ARNs `${execution_arn}/*` (routes) and
`${execution_arn}/authorizers/*` (authorizer).

`ws_url` = `wss://{api-id}.execute-api.{region}.amazonaws.com/live`. `WS_ENDPOINT` (management API, used by
`cf-prod-ws` and `cf-prod-broadcast`) = `https://{api-id}.execute-api.{region}.amazonaws.com/live`, used as
`boto3.client("apigatewaymanagementapi", endpoint_url=WS_ENDPOINT)`.

**Logging (the token is in the query string, so it must never be logged).** Stage access log group
`/aws/apigateway/cf-prod-ws` (same retention as the others), JSON format with exactly: `requestId`, `connectionId`,
`eventType`, `routeKey`, `status`, `requestTime`, `integrationError`, `authorizerError`. No `$context.requestOverride.*`,
no query, no headers. `default_route_settings`: `logging_level = "ERROR"`, `data_trace_enabled = false`,
`throttling_rate_limit = 50`, `throttling_burst_limit = 100`. Execution logging relies on the account-level API Gateway
CloudWatch role (§14.3). The authorizer and handlers never log the token or the raw query string.

**`cf-prod-ws-authorizer`** (`clipfactory_api/realtime/authorizer.py`, 128 MB, 10 s). Pure standard-library RS256 check
of the Cognito **access** token: JWKS from `https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json`
(fetched with `urllib`, cached per container for 1 h; a `kid` not in the cache triggers one refetch), header `alg ==
"RS256"`, signature verified as PKCS#1 v1.5 with the SHA-256 DigestInfo prefix via `pow(sig, e, n)`, then claims
`iss == https://cognito-idp.{region}.amazonaws.com/{poolId}`, `token_use == "access"`, `client_id ==
USER_POOL_CLIENT_ID`, `exp > now` (no leeway), `sub` present. Valid tokens are cached per container by SHA-256 of the
token until `exp`. Result: `{ "principalId": sub, "policyDocument": { "Version": "2012-10-17", "Statement": [{
"Action": "execute-api:Invoke", "Effect": "Allow", "Resource": event["methodArn"] }] }, "context": { "sub": sub } }`.
Missing/invalid token: `raise Exception("Unauthorized")` (API Gateway answers 401). No AWS permissions beyond logs.

**`cf-prod-ws`** (`clipfactory_api/realtime/ws.py`, 128 MB, 10 s), dispatch on `requestContext.routeKey`:
* `$connect`: `sub = requestContext.authorizer.sub`; PutItem Connection `{pk: USER#{sub}, sk: CONN#{connectionId},
  gsi1pk: CONN#{connectionId}, gsi1sk: "CONN", type: "conn", userId, connectionId, connectedAt, ttl: now + 7200}`;
  return `{"statusCode": 200}`.
* `$disconnect`: `sub` from `requestContext.authorizer.sub` if present, else Query `gsi1` on `CONN#{connectionId}`;
  DeleteItem; always 200.
* `$default`: body `{"action": "ping"}` → PostToConnection `{"type": "pong", "at": "<ISO>"}`; anything else →
  `{"type": "error", "code": "bad_request"}`; always 200.
* IAM: `dynamodb:PutItem`, `dynamodb:DeleteItem`, `dynamodb:Query` on the table and `index/*`;
  `execute-api:ManageConnections` on `arn:aws:execute-api:{region}:{acct}:{wsApiId}/live/POST/@connections/*`.

**`cf-prod-broadcast`** (`clipfactory_api/realtime/broadcast.py`, 256 MB, 60 s).
* Table `cf-prod-data` gets `stream_enabled = true`, `stream_view_type = "NEW_AND_OLD_IMAGES"` (module `data`, output
  `stream_arn`).
* `aws_lambda_event_source_mapping`: `starting_position = "LATEST"`, `batch_size = 100`,
  `maximum_batching_window_in_seconds = 1`, `maximum_retry_attempts = 2`, `maximum_record_age_in_seconds = 600`,
  `bisect_batch_on_function_error = true`, `function_response_types = ["ReportBatchItemFailures"]`, and exactly one filter:
  `pattern = jsonencode({ dynamodb = { Keys = { sk = { S = [{ prefix = "JOB#" }, { prefix = "CLIP#" }, { prefix = "POST#" }, { prefix = "LEARNING#" }, { prefix = "WEEK#" }] } } } })`.
  (So `CONN#`, `HOOK#`, `SETTINGS`, `SKILL#`, `STAT#` and `RATE#…/BUDGET` changes never reach it.)
* Per batch: keep only the last record per (`pk`, `sk`) (heartbeats coalesce); `userId` = `pk` minus `USER#`; `type`
  from the `sk` prefix (`JOB#`→`job`, `CLIP#`→`clip`, `POST#`→`post`, `LEARNING#`→`learning`, `WEEK#`→`week`); INSERT/MODIFY →
  `op: "upsert"` from `NewImage`, REMOVE → `op: "delete"` from `OldImage`. Query the owner's connections
  (`pk = USER#{userId}`, `begins_with(sk, "CONN#")`) and PostToConnection to each. `GoneException` (410) → DeleteItem the
  Connection. Other post errors are logged and skipped (the web refetches on reconnect). Only a failed DynamoDB query
  reports the record as a batch item failure.
* Event (UTF-8 JSON, one message per changed item):
  ```ts
  type LiveEvent =
    | { type: "job"; op: "upsert"; id: string; item: Job }
    | { type: "clip"; op: "upsert"; id: string; item: Clip /* without videoUrl/coverUrl */ }
    | { type: "post"; op: "upsert"; id: string; item: Post }
    | { type: "learning"; op: "upsert"; id: string; item: Learning }
    | { type: "week"; op: "upsert"; id: string /* "yyyy-Www" */; item: WeekSummary /* §16.2 */ }
    | { type: "job" | "clip" | "post" | "learning" | "week"; op: "delete"; id: string }
    | { type: "job" | "clip" | "post" | "learning" | "week"; op: "upsert"; id: string; partial: true } // item too big: refetch
    | { type: "pong"; at: string } | { type: "error"; code: "bad_request" };
  ```
  `item` is built by the **same public-shape functions the HTTP API uses** (`jobs.public_job`, `clips.public_clip`
  without presigning, `posts.public_post`, the Learning shape, `weeks.public_week`), so internal fields (`sessionId`, `videoKey`,
  `publishState`, `flowExecutionArn`, …) never leave. If the serialized event exceeds 24 KB (frame limit 32 KB) send
  the `partial: true` form instead.
* IAM: `dynamodb:Query`, `dynamodb:DeleteItem` on the table; `dynamodb:DescribeStream`, `GetRecords`,
  `GetShardIterator`, `ListStreams` on the stream ARN; `execute-api:ManageConnections` as for `cf-prod-ws`.

**Web.** `web/src/lib/live.ts` (one shared connection for the signed-in app):
* Connect to `${wsUrl}?token=${encodeURIComponent(accessToken)}` with a fresh token from `fetchAuthSession()` on every
  attempt. Reconnect on any close with backoff 1, 2, 4, 8, 16, 30 s (cap 30 s, ±20 % jitter), reset after 60 s connected.
  Send `{"action":"ping"}` every 5 minutes (idle timeout is 10 min). Reconnect proactively after 110 minutes (2-hour
  connection cap). Close on sign-out; pause while `document.hidden` for > 5 minutes and resume on visible.
* Events update the screen caches in place (job list and detail, clip lists, Review, Library, posts, Insights); a
  `clip` upsert keeps the cached `videoUrl`/`coverUrl` (or refetches the clip when it has none); `partial: true` and
  each reconnect trigger a refetch of what is on screen.
* Polling stays as the fallback: the existing polls (e.g. `screens/jobs/Jobs.tsx`) run at their current intervals
  **only while disconnected**, and slow to every 30 s while live. No `wsUrl` (mock mode) → polling only.
* CSP (`infra/modules/frontend`): `connect-src` adds `wss://*.execute-api.${var.region}.amazonaws.com`.
* No visible UI beyond an optional small "Live" dot; never an error toast for a dropped socket.

### 14.3 Platform webhooks: REST API (Terraform module `hooks`)

**Resources.** `aws_api_gateway_rest_api` `cf-prod-hooks` (`endpoint_configuration { types = ["REGIONAL"] }`),
resources `/hooks/{platform}` and `/oauth/{platform}/callback`, methods `GET /hooks/{platform}`, `POST /hooks/{platform}`,
`GET /oauth/{platform}/callback`, `authorization = "NONE"`, `request_parameters = { "method.request.path.platform" =
true }`, request validator `cf-prod-hooks-params` (`validate_request_parameters = true`, `validate_request_body =
false`; webhook bodies vary per platform), `AWS_PROXY` integrations on `cf-prod-hooks`. `aws_api_gateway_deployment`
(with `triggers` = sha of the resources/methods/integrations) and stage `v1`: `xray_tracing_enabled = true`, access
log group `/aws/apigateway/cf-prod-hooks` with a JSON format of `requestId`, `ip`, `httpMethod`, `resourcePath`, `status`,
`responseLength`, `requestTime`, `integrationLatency` (**no query string**: OAuth callbacks carry `code`/`state`).
`aws_api_gateway_method_settings` `*/*`: `metrics_enabled = true`, `logging_level = "ERROR"`, `data_trace_enabled =
false`, `throttling_rate_limit = 10`, `throttling_burst_limit = 20`. `aws_api_gateway_usage_plan` `cf-prod-hooks` on
stage `v1` (throttle 10 rps / burst 20, quota 100 000 per month); no API key is required (platforms cannot send one), so
the per-method throttle is the effective limit and the usage plan is the ceiling for keyed clients later.

`hooks_url` = the stage invoke URL, `https://{id}.execute-api.{region}.amazonaws.com/v1`. Platform consoles get
`{hooks_url}/hooks/{platform}` and `{hooks_url}/oauth/{platform}/callback` (phase 2).

**Account-level logging role (per account and Region singleton).** `aws_iam_role` `cf-prod-apigw-cloudwatch` (trusted
by `apigateway.amazonaws.com`, managed policy `AmazonAPIGatewayPushToCloudWatchLogs`) and `aws_api_gateway_account {
cloudwatch_role_arn }`, both behind `var.manage_api_gateway_account` (default `true`; set `false` when the account's
setting is managed elsewhere, then that role must already exist). Needed by REST execution/access logs and WebSocket
logs. Serialize deployments (CreateDeployment is limited to 1 per 5 s per account): in `envs/prod`,
`module "realtime"` has `depends_on = [module.hooks]`.

**SSM.** `aws_ssm_parameter` `/cf-prod/hooks/verify-token`, `type = "SecureString"` (AWS managed key `aws/ssm`), value
from `ephemeral "random_password"` (length 40, `special = false`) written with `value_wo` / `value_wo_version = 1` so it
never enters the state. Adds provider `hashicorp/random` `>= 3.7.0, < 4.0.0` to `envs/prod` and the `hooks` module. The
owner reads it from the console when registering Meta webhooks.

**`cf-prod-hooks`** (`clipfactory_api/hooks.py`, 256 MB, 10 s). `platform` must be one of `youtube`, `instagram`,
`facebook`, `tiktok`, `x`, else 404 `not_found`. JSON errors use the §5 shape.
* `GET /hooks/{platform}` (verification):
  * `instagram`, `facebook` (Meta): `hub.mode == "subscribe"` and `hub.verify_token` equal (constant-time compare) to the
    SSM value (`GetParameter WithDecryption`, cached per container 5 min) → `200 text/plain` body = `hub.challenge`;
    wrong/missing → `403 forbidden`.
  * `youtube` (PubSubHubbub): `hub.mode` in `subscribe`/`unsubscribe`, `hub.topic` starting with
    `https://www.youtube.com/xml/feeds/videos.xml`, `hub.challenge` present → `200 text/plain` = `hub.challenge`; else
    `400 bad_request`.
  * `tiktok`, `x` → `501 not_implemented` until phase 2.
* `POST /hooks/{platform}`: body > 256 KB → `413 too_large`. `verify_signature(platform, headers, raw_body)` returns
  `"valid" | "unverified" | "invalid"`; phase 1 stub returns `"unverified"` for every platform (no app secrets yet);
  `"invalid"` → `401 unauthorized`. Otherwise PutItem Hook event `{pk: HOOK#{platform}, sk: HOOK#{hookId(ULID)}, type:
  "hook", platform, receivedAt, headers: {content-type, user-agent, x-hub-signature-256, x-hub-signature, x-tiktok-signature,
  x-twitter-webhooks-signature (only those present)}, body (raw text, or base64 when API Gateway flagged it),
  bodyEncoding: "text"|"base64", signature, ttl: now + 14 days}` and return `200 {"ok": true}`. Nothing else runs inline.
* `GET /oauth/{platform}/callback`: the real OAuth callback of §17.5 (`302` to
  `{APP_URL}/settings/posting/setup/{platform}?result={code}`; query never logged). The phase-1 `coming_soon` redirect is gone.
* IAM: `dynamodb:PutItem` on the table; `ssm:GetParameter` on
  `arn:aws:ssm:{region}:{acct}:parameter/cf-prod/hooks/verify-token` (the `aws/ssm` key needs no IAM statement).

### 14.4 Durable function `cf-prod-job-flow` (Terraform module `flows`)

Replaces the watchdog. Python SDK `aws-durable-execution-sdk-python` (synchronous API). File
`clipfactory_api/flows/job_flow.py`: `@durable_execution def handler(event, context: DurableContext)` is a thin
wrapper around `run_job_flow(ctx, event, deps)` so tests drive it with a fake context.

* **Start (by `cf-prod-api`).** On `POST /v1/jobs` and `POST /v1/jobs/{id}/retry` the API writes the Job (`queued`, new
  `sessionId`, `flowRun` = 1 on create, previous + 1 on retry) and then calls
  `lambda.invoke(FunctionName=JOB_FLOW_ARN, InvocationType="Event", DurableExecutionName=f"job-{jobId}-{flowRun}",
  Payload=json.dumps({"jobId", "userId", "sessionId", "run": flowRun}, sort_keys=True))`. `JOB_FLOW_ARN` is the
  **alias ARN** `arn:aws:lambda:{region}:{acct}:function:cf-prod-job-flow:live` (never unqualified, never `$LATEST`).
  The payload has no timestamps so a repeated start is identical. `DurableExecutionAlreadyStartedException` = already
  started (no-op). The `DurableExecutionArn` response header, when present, is stored as `flowExecutionArn`. If the
  invoke fails the job becomes `failed` with "Could not start. Press Try again." and the route still returns 201/200.
* **Steps** (names are contract; all DynamoDB writes are conditional on `sessionId = :sessionId`, so a superseded run
  never overwrites a newer one, and on the job not already being in the target state):
  1. `cb = context.create_callback(name="agent-done", config=CallbackConfig(timeout=Duration.from_hours(8),
     heartbeat_timeout=Duration.from_minutes(6)))`. A resumed attempt `n` (§30.1) uses `agent-done-n`,
     `start-agent-n` and the time left of the 8 h; the first attempt keeps these names so old executions replay.
  2. Step `start-agent` (retry: 3 attempts, exponential backoff, retryable on throttling/5xx/connection errors):
     GetItem the Job. Missing, another `sessionId`, or a terminal status (canceled or retried meanwhile) → return
     `{"skipped": true}` and the flow ends with outcome `superseded` without waiting. Already `running` with this
     `sessionId` → an earlier attempt of this step reached the agent: do not invoke again, go on to wait for the
     callback. Still `queued` → `InvokeAgentRuntime`
     (`runtimeSessionId = sessionId`, payload `{"action": "process_job", "jobId", "userId", "callbackId": cb.callback_id}`).
     The agent ignores a duplicate `process_job` (at-least-once step).
  3. `result = cb.result()` (no compute while waiting). Success → step `finish`: if the Job is not `ready`, set
     `ready` and `clipCount` from the result. Outcome `ready`.
  4. `CallbackError` with a timeout, a missed heartbeat or `ErrorType == "AgentStopped"` → resume (§30.1: steps
     `resume-n`, `stop-old-n`, then 1-3 again on the new session), at most twice. Otherwise, or after the last resume,
     step `fail`: if the Job is `queued`/`running` with this `sessionId`, set `failed` with `error` =
     the agent's `ErrorMessage` when `ErrorType == "JobFailed"`, else "Making the clips stopped. Tap Try again to pick
     up where it left off." (and `pickUp: true`, §30.6); then step `stop-session` (`StopRuntimeSession`, errors ignored). `ErrorType`
     `Canceled` / `Superseded` → no write (the API or the newer run already set the state). Outcome `failed` /
     `canceled` / `superseded`.
  The handler returns `{"jobId", "outcome"}` and never raises for these expected outcomes, so `DurableExecutionFailed`
  means a bug.
* **Agent side of the callback** (`agent/src/clipfactory_agent/callback.py`, boto3 `lambda` client in `CF_REGION`):
  * Heartbeat: `send_durable_execution_callback_heartbeat(CallbackId=...)` every 2 minutes from its own thread with its
    own client, only while the event loop is alive (timeout is 6 minutes; §30.3). Failures are logged, tried again
    after 20 s, never fatal.
  * Success after `finalize` wrote the Job `ready`: `send_durable_execution_callback_success(CallbackId=...,
    Result=json.dumps({"jobId", "clipCount"}).encode())`.
  * Failure: `send_durable_execution_callback_failure(CallbackId=..., Error={"ErrorType": "JobFailed" | "Canceled" |
    "Superseded", "ErrorMessage": <the Job's plain-sentence error, ≤ 256 chars>})`, `JobFailed` after the agent wrote
    the Job `failed`, `Canceled` after a cancel, `Superseded` when the session fence (§13 "One run per job") stops it.
  * Each send retries 3 times on throttling/5xx; "callback already closed / not found / timed out" errors are ignored.
  * IAM on the AgentCore runtime role: `lambda:SendDurableExecutionCallbackSuccess`,
    `lambda:SendDurableExecutionCallbackFailure`, `lambda:SendDurableExecutionCallbackHeartbeat` on
    `arn:aws:lambda:{region}:{acct}:function:cf-prod-job-flow:*` (built from the name in the `agent` module, no module
    reference, to avoid a cycle).
* **Cancel** is unchanged in the API (Job `canceled`, agent `cancel`, `StopRuntimeSession`); the agent sends `Canceled`,
  or, if the container is already gone, the heartbeat timeout ends the flow and step `fail` writes nothing.
* **Terraform:** `publish = true`, `aws_lambda_alias` `live` (`function_version = aws_lambda_function.job_flow.version`),
  `durable_config { execution_timeout = 30600, retention_period = 14 }`, `timeouts { delete = "60m" }`, runtime
  `python3.13`, arm64, 256 MB, function timeout 120 s, X-Ray active, JSON logs to `/aws/lambda/cf-prod-job-flow`. No
  Lambda destinations (unsupported for durable functions). Durable config can only be set at creation, so these are
  new functions. Old versions are kept (running executions stay pinned to the version they started on).
* **IAM (role `cf-prod-fn-job-flow`):** managed policy `AWSLambdaBasicDurableExecutionRolePolicy`
  (`lambda:CheckpointDurableExecution`, `lambda:GetDurableExecutionState` on `function:cf-prod-job-flow:*` + logs);
  `dynamodb:GetItem`, `dynamodb:UpdateItem` on the table; `bedrock-agentcore:InvokeAgentRuntime`,
  `bedrock-agentcore:StopRuntimeSession` on the runtime ARN and `/*`; X-Ray.
* **API IAM:** `lambda:InvokeFunction` on `arn:aws:lambda:{region}:{acct}:function:cf-prod-job-flow:*` and
  `...:function:cf-prod-clip-flow:*`. The API loses `sqs:SendMessage`.

### 14.5 Durable function `cf-prod-clip-flow` (Terraform module `flows`)

Replaces the publish queue, DLQ, publisher, Scheduler group/role and perf-check. File
`clipfactory_api/flows/clip_flow.py` (`handler` + `run_clip_flow(ctx, event, deps)`). Shared logic lives in
`clipfactory_api/posts.py` (post creation), `platforms/` (adapters), `learn.py` (distil) and `vectors.py` (§14.6).

* **Confirm rules** (`POST /v1/clips/{id}/confirm`):
  * `review` → one TransactWriteItems: the Clip becomes `confirmed` (`decidedAt`, `publishState: "pending"`,
    `postsCreated: true`, `postIds`, `flowRun: 1`, captions applied) **and** one Post per enabled platform, conditional
    on the clip still being `review` and `attribute_not_exists(postsCreated)`. `postIds` (internal) lists the clip's
    post ids, written in the same transaction, so Confirm and the clip-flow read one clip's posts by key (a strongly
    consistent GetItem + BatchGetItem) and never scan the owner's whole `POST#` range; clips from before `postIds`
    fall back to a strongly consistent read of every page of the owner's posts. Owner-wide reads (`Store.query_all`:
    weeks, stats, `/v1/me` counts, YouTube forget) follow every page with no silent item cap. Then start the flow; on success set
    `publishState: "started"` (+ `flowExecutionArn`). Response `{clip, posts}`.
  * `confirmed`/`publishing` with `publishState: "pending"` → start the flow again at once (same name and payload, so it
    is idempotent), 200. With `publishState: "started"` or status `posted` → 200 no-op with the current `{clip, posts}`.
  * `failed` (clip-flow ended with every queued post failed) → "Try again": `flowRun + 1`, failed posts back to
    `queued`, status `confirmed`, `publishState: "pending"`, start `clip-{clipId}-{flowRun}`, 200.
  * §33: with `platforms`, a `review` clip gets posts for exactly those places (each must be connected) and an
    internal-but-public `uploadTo`; on a `posted` or `failed` clip `platforms` names the failed posts to try again
    (a `posted` clip stays `posted`). See §33.3.
  * `declined` → 409 `conflict`.
* **Start:** `lambda.invoke(FunctionName=CLIP_FLOW_ARN /* alias ...:function:cf-prod-clip-flow:live */,
  InvocationType="Event", DurableExecutionName=f"clip-{clipId}-{flowRun}", Payload=json.dumps({"clipId", "userId",
  "run": flowRun}, sort_keys=True))`; `DurableExecutionAlreadyStartedException` = no-op. Names stay ≤ 64 chars of
  `[A-Za-z0-9-_]` (ULIDs qualify).
* **Steps** (names are contract; every step is idempotent because steps are at-least-once):
  1. `ensure-posts`: `posts.create_for_clip` (no-op when `postsCreated`; the same function the API uses), then if any
     post is `queued` set the clip `publishing`. Returns `[{postId, platform, status}]`.
  2. `publish-{platform}` for each `queued` post only (`pending_integration` posts are skipped, no step): adapter
     `publish(post, idempotency_key=postId)`; retry 3 attempts, exponential backoff, `retryable_error_types =
     [RetryablePublishError]`, `StepSemantics.AT_LEAST_ONCE_PER_RETRY` (an adapter whose platform has no idempotency
     key uses `AT_MOST_ONCE_PER_RETRY`). Post update conditional on `status = queued`: `posted`, `url`, `postedAt`,
     `perfCheckAt = postedAt + 48 h`, plus the stats fields of §16.3 (`platformPostId`, `statsId`, `privacy`,
     `statsDueAt = postedAt + minIntervalMinutes`, `gsi2pk = "STATS"`, `gsi2sk = "{statsDueAt}#{postId}"`; a private
     TikTok post without `statsId` gets no gsi2 attributes), written by `posts.mark_posted(...)`. Exhausted retries (`StepError`) → step `post-failed-{platform}` sets the post
     `failed` with a plain `error`.
  3. `settle-clip`: clip `posted` if ≥ 1 post is `posted`; `failed` if every queued post failed; `confirmed` if none
     was queued. If nothing was posted: step `upsert-vector` (status `confirmed`) and return outcome `not_posted` (today's
     path, while every platform is `pending_integration`).
  4. `context.wait(Duration.from_hours(48), name="wait-48h")`: no compute, no schedule.
  5. `metrics`: `stats.refresh.refresh_posts(deps, posted_posts, reason="flow", now)` (§16.5; the same code as the
     poller, so it respects every rate budget and writes `metrics` + a snapshot); a platform that is blocked or fails
     after 3 attempts keeps its latest stored `Post.metrics` (written by the poller), and only a post with no metrics
     at all is skipped.
  6. `distil`: **retired** (§16.12, ADR-41). The step keeps its name so a running flow replays the same steps, calls no
     model, writes nothing and returns `{"outcome": "retired"}`. Older 48-hour Learnings stay readable.
  7. `upsert-vector`: §14.6, status `performed`, `performance` = sums over the measured posts.
  Returns `{"clipId", "outcome": "done" | "not_posted"}`.
* **Terraform:** like job-flow, with `durable_config { execution_timeout = 259200, retention_period = 14 }` (48 h wait +
  publish/metrics/distil, 3 days), 512 MB, function timeout 900 s, log group `/aws/lambda/cf-prod-clip-flow`.
* **IAM (role `cf-prod-fn-clip-flow`):** `AWSLambdaBasicDurableExecutionRolePolicy`; the table read/write set the API uses
  (`GetItem`, `PutItem`, `UpdateItem`, `Query`, `BatchGetItem`, `TransactWriteItems`, `ConditionCheckItem`) on the table
  and `index/*`; `s3:GetObject` on `${media_bucket_arn}/jobs/*` (phase-2 uploads); `bedrock:InvokeModel` on `model_invoke_arns` (Fable
  profile + `foundation-model/anthropic.claude-fable-5-1` in any Region) and on the Titan ARN; `s3vectors:GetVectors`,
  `s3vectors:PutVectors` on the index ARN; X-Ray.

### 14.6 S3 Vectors: "what worked before" (Terraform module `vectors`)

* **Resources:** `aws_s3vectors_vector_bucket` `cf-prod-vectors-{accountId}` (default SSE-S3, `force_destroy = false`);
  `aws_s3vectors_index` `clips`: `data_type = "float32"`, `dimension = 1024`, `distance_metric = "cosine"`,
  `metadata_configuration { non_filterable_metadata_keys = ["hook", "title", "summary", "performance"] }`. Every argument
  forces replacement, so these values are frozen (a new key needs a new index). Outputs `vector_bucket`,
  `vector_bucket_arn`, `vector_index` (`clips`), `vector_index_arn`.
* **Embeddings:** Titan Text Embeddings V2 via `bedrock-runtime` **InvokeModel** (not Converse), body
  `{"inputText": text, "dimensions": 1024, "normalize": true}`, read `embedding`; sent to S3 Vectors as
  `{"float32": [...]}`. **Clip text (identical in `api` and `agent`, both test it against the same fixture):**
  `f"{momentType}\n{hook}\n{captions['youtubeTitle']}\n{summary}"[:8000]`.
* **Vector:** `key = clipId`; filterable metadata `userId` (string), `momentType` (string), `platforms` (list of
  strings: the enabled platforms at finalize, the posted ones after the check), `status` (`"review" | "confirmed" |
  "performed"`), `scoreBucket` (`"low"` score ≤ 4, `"mid"` 5–7, `"high"` ≥ 8); non-filterable `hook`, `title`
  (`youtubeTitle`), `summary`, `performance` (JSON string of `Performance`, absent until measured); filterable `best`
  (boolean, §16.6: `true` while the owner has the clip starred "Best this week"; written `false` by agent finalize;
  every later metadata write merges and keeps it; a new filterable key needs no new index). Filterable metadata
  stays under 2 KB.
* **Who writes/reads:**

  | Who | When | Calls | IAM (index ARN unless noted) |
  |---|---|---|---|
  | agent | finalize: one `PutVectors` for all new clips, status `review` | Titan + `put_vectors` | `s3vectors:PutVectors`, `bedrock:InvokeModel` on the Titan ARN |
  | agent | before `select`: query text `f"{title}\n{channel}\n{notes}\n{transcript[:4000]}"` (one embedding), first `topK=4` with filter `{"$and": [{"userId": {"$eq": sub}}, {"best": {"$eq": true}}]}`, then `topK=8` with `{"$and": [{"userId": {"$eq": sub}}, {"status": {"$eq": "performed"}}]}`; merge (dedupe by key, best hits first), cap 8; fewer than 3 hits in total → again with `{"userId": {"$eq": sub}}` only; any error → skip, log `vectors.query_failed` (§16.7) | Titan + `query_vectors(returnMetadata=True, returnDistance=True)` | `s3vectors:QueryVectors`, `s3vectors:GetVectors` |
  | learn | `cf-prod-learn`: `best=true` on picked clips, `best=false` on unpicked ones (get, merge, put; missing vector → embed from the Clip item) | as clip-flow | `s3vectors:GetVectors`, `s3vectors:PutVectors`, Titan |
  | clip-flow | `upsert-vector`: `get_vectors(keys=[clipId], returnData=True, returnMetadata=True)`, merge metadata, `put_vectors`; vector missing → embed from the Clip item | as listed | `s3vectors:GetVectors`, `s3vectors:PutVectors`, Titan |
  | api | decline: `delete_vectors(keys=[clipId])` (errors logged, never fail the route) | | `s3vectors:DeleteVectors` |
  | api | `GET /v1/clips/{id}/similar` | see below | `s3vectors:GetVectors`, `s3vectors:QueryVectors` |

  The agent's prompt section is titled "What worked before" and lists per hit: moment type, hook, title, summary,
  performance (views, likes) and similarity, and "Owner's pick: best of the week" for `best` hits; it is advice, never
  a rule.
* **`GET /v1/clips/{clipId}/similar`** (`routes/clips.py`, `vectors.py`): 404 if the clip is not the caller's;
  `get_vectors(keys=[clipId], returnData=True)` (none → `{"clips": []}`); `query_vectors(topK=6, filter={"$and":
  [{"userId": {"$eq": sub}}, {"status": {"$eq": "performed"}}]}, returnMetadata=True, returnDistance=True)`; drop the clip
  itself; `similarity = round(1 - distance, 2)`; BatchGetItem the hits' Clip items (drop missing/declined) to add a
  presigned `coverUrl`; return at most 5 as `SimilarClip[]` sorted by similarity. Vector errors → `{"clips": []}` + log.
* **Web:** Review and Library show a "Like clips that did well" strip (cover, hook, views) under the clip, hidden when
  empty; mock mode has fixtures.

### 14.7 Decision: OpenSearch is not deployed

OpenSearch Serverless bills a standing minimum of OCUs whenever a collection exists, while S3 Vectors already gives
per-request-priced vector search with metadata filters for this single-owner app. If keyword or hybrid search is
needed later, S3 Vectors can be exported to OpenSearch Serverless (a **preview** integration through OpenSearch
Ingestion, not GA). The architecture diagram shows OpenSearch Serverless as a dashed "not deployed (option)" box.
Recorded as an ADR in `docs/DECISIONS.md`.

### 14.8 Terraform layout, wiring, outputs

```
infra/modules/
  data/       + stream_enabled, stream_view_type = NEW_AND_OLD_IMAGES; output stream_arn; + sparse GSI gsi2 (§16.3)
  stats/      NEW (§16.9): cf-prod-stats (+ EventBridge rule cf-prod-stats), cf-prod-learn, roles, log groups
  api/        only cf-prod-api + the HTTP API (queue, DLQ, scheduler, watchdog, publisher, perf-check removed);
              new inputs job_flow_arn_prefix, clip_flow_arn_prefix (function:NAME, for IAM ":*"), job_flow_alias_arn,
              clip_flow_alias_arn, vector_bucket, vector_index, vector_index_arn, stats_function_arn,
              learn_function_arn (§16.9); output function_names = { api = ... }
  flows/      NEW: cf-prod-job-flow, cf-prod-clip-flow (+ roles, log groups, alias live, durable_config)
              inputs: name, region, account_id, lambda_zip_path, table_name/arn, media_bucket/_arn, agent_runtime_arn,
              model_id, model_invoke_arns, embed_model_id, embed_model_arn, vector_bucket, vector_index, vector_index_arn,
              log_retention_days; outputs job_flow_alias_arn, clip_flow_alias_arn, function_names, durable_function_names
  realtime/   NEW: cf-prod-ws API + stage live, authorizer, cf-prod-ws-authorizer, cf-prod-ws, cf-prod-broadcast, ESM
              inputs: name, region, account_id, lambda_zip_path, table_name/arn, stream_arn, user_pool_id,
              user_pool_client_id, log_retention_days; outputs ws_url, ws_api_id, ws_endpoint, function_names
  hooks/      NEW: cf-prod-hooks REST API + stage v1 + usage plan, cf-prod-hooks Lambda, SSM verify token,
              API Gateway account CloudWatch role (var.manage_api_gateway_account)
              inputs: name, region, account_id, lambda_zip_path, table_name/arn, app_url, log_retention_days,
              manage_api_gateway_account; outputs hooks_url, hooks_api_id, verify_token_parameter, function_names
  vectors/    NEW: vector bucket + index clips; outputs vector_bucket, vector_bucket_arn, vector_index, vector_index_arn
  agent/      + env CF_VECTOR_BUCKET, CF_VECTOR_INDEX, CF_EMBED_MODEL_ID; + IAM: callbacks (§14.4), S3 Vectors and
              Titan (§14.6); new inputs vector_bucket, vector_index, vector_index_arn, embed_model_id, embed_model_arn
  monitoring/ − dlq alarm/var; + durable alarms, broadcast iterator-age alarm (§14.9);
              inputs function_names (merged map of every module's function_names), durable_function_names
  frontend/   CSP connect-src + wss://*.execute-api.<region>.amazonaws.com
```
All Lambdas share one zip (`var.lambda_zip_path`), python3.13, arm64, JSON logs, X-Ray active, log retention as today.
Function ARNs used in another module's IAM are built from names (`arn:aws:lambda:{region}:{acct}:function:{name}`), as
the existing code does, so modules never form a cycle. `envs/prod` wiring: `flows` uses `agent`, `data`, `storage`,
`vectors`; `api` uses `flows` and `vectors`; `realtime` uses `data`, `auth` and `depends_on = [module.hooks]`;
`hooks` uses `data`, `frontend`. New env outputs (§10): `ws_url = module.realtime.ws_url`, `hooks_url =
module.hooks.hooks_url`, `vector_bucket`, `vector_index`, `job_flow_alias_arn`, `clip_flow_alias_arn`.

### 14.9 Monitoring (SNS topic `cf-prod-alarms` as today)

* `Errors > 0` (5 min, Sum, alarm `{fn}-errors` as today) for `cf-prod-api`, `cf-prod-job-flow`, `cf-prod-clip-flow`,
  `cf-prod-ws`, `cf-prod-broadcast`, `cf-prod-hooks`, `cf-prod-stats`, `cf-prod-learn` (§16.9). Not for `cf-prod-ws-authorizer`: rejecting a token raises by
  design, so its `realtime` `function_names` output leaves it out.
* `AWS/Lambda` `DurableExecutionFailed > 0` and `DurableExecutionTimedOut > 0` (dimension `FunctionName`, 5 min, Sum,
  `notBreaching`) for `cf-prod-job-flow` and `cf-prod-clip-flow`: names `{fn}-durable-failed`, `{fn}-durable-timed-out`.
* `cf-prod-broadcast-iterator-age`: `IteratorAge` Maximum > 300 000 ms for 3 × 5 min.
* `cf-prod-hooks-5xx`: `AWS/ApiGateway` `5XXError` Sum > 0 on `ApiName = cf-prod-hooks`, stage `v1`.

### 14.10 Packaging, CI/CD, deploy role

* `api/pyproject.toml` dependencies: `boto3>=1.43` (must expose `invoke(..., DurableExecutionName=...)`,
  `send_durable_execution_callback_*` and the `s3vectors` client; a unit test asserts these exist in the vendored copy)
  and `aws-durable-execution-sdk-python` pinned to its current major version (`>=X,<X+1`, exact version in `uv.lock`).
  `api/scripts/build_lambda.py` vendors both into `api/dist/lambda.zip`; the HTTP/realtime/hooks handlers never import
  the durable SDK (cold starts). The agent image's boto3 must meet the same floor.
* `scripts/write-web-config.sh` writes `wsUrl` from `ws_url` (required). `deploy.yml` needs no new job: the zip and
  `terraform apply` cover the new functions.
* `docs/DEPLOYMENT.md` lists the extra permissions the OIDC deploy role (`CF_DEPLOY_ROLE_ARN`) needs: `s3vectors:*` on
  `bucket/cf-prod-vectors-*`; `apigateway:*` on `/restapis*`, `/apis*`, `/account`, `/usageplans*`; `ssm:PutParameter`,
  `GetParameter(s)`, `DeleteParameter`, `AddTagsToResource`, `ListTagsForResource`, `DescribeParameters` on
  `parameter/cf-prod/*`; `lambda:*` on `function:cf-prod-*` (including `PublishVersion`, alias and durable-execution
  actions, `ListDurableExecutionsByFunction`, `StopDurableExecution` used during destroy); `iam:PassRole` for
  `cf-prod-apigw-cloudwatch`; `dynamodb:DescribeStream`/`ListStreams`. The Bedrock `aws_review` data-retention opt-in for
  Fable 5.1 is a one-time owner step there too.
* The deploy role cannot escalate through IAM: it may create `cf-prod-*` roles or grant them permissions
  (`CreateRole`, `PutRolePolicy`, `AttachRolePolicy`, `PutRolePermissionsBoundary`) only with the permissions boundary
  `cf-prod-role-boundary` (no IAM, Organizations or account actions), may never delete that boundary, and passes roles
  only to Lambda, AgentCore and API Gateway (`infra/bootstrap`, tested offline). Every module role sets
  `permissions_boundary` from `role_permissions_boundary_arn` (repository variable `CF_ROLE_BOUNDARY_ARN`).
* `deploy.yml`: only jobs that run no npm, cargo or other build tool hold `id-token: write` (the desktop installers are
  built without it and uploaded by `desktop-upload`); every action is pinned to a full commit SHA with its version in a
  comment; `scripts/ensure-state-bucket.sh` passes `--expected-bucket-owner <this account>` on every S3 call and stops
  when the state bucket belongs to another account. `scripts/test-deploy-workflow.sh` and
  `scripts/test-ensure-state-bucket.sh` (run by CI) check all three.
* `docs/architecture/aws-architecture.drawio` and `docs/ARCHITECTURE.md` show: CloudFront+S3 web, Cognito, HTTP API →
  `cf-prod-api`, WebSocket API → authorizer / `cf-prod-ws`, DynamoDB stream → `cf-prod-broadcast` → WebSocket, REST API →
  `cf-prod-hooks` (+ SSM), `cf-prod-job-flow` ↔ AgentCore (callback), `cf-prod-clip-flow` (48 h wait) → Bedrock (Fable,
  Titan) and S3 Vectors, Transcribe, ECR, media bucket, CloudWatch/SNS, GitHub OIDC, and OpenSearch Serverless dashed
  "not deployed".

### 14.11 Who builds what (parallel builders; each stays inside its files)

| Builder | Owns |
|---|---|
| infra | `infra/**` (all modules above, tftests), `config/models.json` |
| api-core | `api/src/clipfactory_api/{http,app,clips,jobs,posts,learn,vectors}.py`, `routes/*`, `platforms/*`, `api/scripts/build_lambda.py`, `api/pyproject.toml`, `uv.lock`, related tests; deletes publisher/perf_check/watchdog |
| api-flows | `api/src/clipfactory_api/flows/{__init__,job_flow,clip_flow}.py`, `tests/test_flows.py`, the fake durable context in `tests/fakes.py` |
| api-edge | `api/src/clipfactory_api/realtime/{__init__,authorizer,ws,broadcast}.py`, `hooks.py`, their tests |
| agent | `agent/**` (callback, vectors, "What worked before", duplicate `process_job`) |
| web + ci/docs | `web/**` (live.ts, polling fallback, similar strip, Settings `coming_soon`), `scripts/write-web-config.sh`, `.github/**`, `docs/**` except this file |

The §16 split (clip performance, stats, weekly best) is in §16.10.

Shared function names across builders: `posts.create_for_clip(store, user_id, clip, settings, now) -> list[Post]`,
`learn.distil(store, bedrock, model_id, user_id) -> str` (outcome), `vectors.embed_text(clip) -> str`,
`vectors.upsert_clip(...)`, `vectors.delete_clip(user_id, clip_id)`, `vectors.similar(user_id, clip_id, k=5)`,
`jobs.public_job`, `clips.public_clip(item, with_urls: bool)`, `posts.public_post`.

### 14.12 Test expectations (all run offline in CI: no AWS calls, fakes only)

* **api** (`pytest`): job create/retry invokes the **alias** ARN with `InvocationType="Event"`, the exact
  `DurableExecutionName` and a deterministic payload; `DurableExecutionAlreadyStartedException` is a no-op; confirm
  rules of §14.5 (review, pending, started, failed → `-2` name, declined 409); decline deletes the vector and survives a
  vector error; `/similar` drops self, filters by user and `performed`, returns ≤ 5, `[]` on errors; the vendored boto3
  exposes the durable and `s3vectors` APIs; `vectors.embed_text` matches the shared fixture.
* **flows** (`tests/test_flows.py` with `FakeDurableContext`: `step` runs immediately and records names, `wait` records
  the duration, `create_callback` returns a callback whose `result()` returns or raises a preset `CallbackError`): job-flow
  success → `finish`; timeout/heartbeat → `fail` with the plain message; `Canceled`/`Superseded` → no write; skipped start
  when the job is missing, has another sessionId or is terminal (no re-invoke when already running with this sessionId); sessionId fence on every write. clip-flow: pending-only posts → `not_posted`, no
  wait; queued post published once even when the step is replayed; exhausted retries → post `failed`; 48 h wait name and
  duration; distil outcomes; vector upsert with `performed` and performance JSON.
* **realtime/hooks**: authorizer accepts a token signed with the fixed test RSA key in `tests/fixtures/jwks.json` and
  rejects wrong `iss`/`client_id`/`token_use`/expired/bad signature/unknown `kid`, and never logs the token;
  `$connect`/`$disconnect`/`ping`; broadcast coalescing, type mapping, delete from `OldImage`, `GoneException` cleanup,
  24 KB → `partial`, internal fields absent; hooks: Meta challenge ok/403, YouTube challenge, tiktok/x 501, POST stores
  a HOOK item with 14-day `ttl`, 413 over 256 KB, OAuth callback per §17.12 (was the `coming_soon` 302), unknown
  platform 404, query string never logged.
* **agent**: `callbackId` → heartbeat every 2 min from a thread (§30.3), success after `ready`, `JobFailed`/`Canceled`/`Superseded`
  failures, closed-callback errors ignored, no callback without `callbackId`; duplicate `process_job` ignored; finalize
  puts vectors with the §14.6 metadata; query fallback (< 3 performed hits) and skip on error.
* **web** (Vitest + Playwright mock mode): backoff sequence and fresh token per attempt, cache merge of each event
  type, `partial` refetch, polling only while disconnected (30 s while live), no `wsUrl` → polling; "Like clips that did
  well" strip hidden when empty; no overflow from 320 px.
* **infra** (`terraform test` with mock providers, `terraform validate`, `fmt -check`): flows have `publish = true`,
  alias `live`, `durable_config` 30600 / 259200 s and retention 14, `timeouts.delete = "60m"`, no destinations; the ESM
  has exactly one filter with the five prefixes (§16 adds `WEEK#`); the WebSocket authorizer sets no TTL/payload version; WS and REST logs
  contain no query/`requestOverride` and `data_trace_enabled = false`; index is float32/1024/cosine with the four
  non-filterable keys; no `aws_sqs_queue` or `aws_scheduler_*` remains, and the only `aws_cloudwatch_event_rule` is
  `cf-prod-stats` (§16.9); outputs of §10 exist.
