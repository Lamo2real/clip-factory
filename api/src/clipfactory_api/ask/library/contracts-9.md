## 9. Lambdas (one zip `api/dist/lambda.zip`, Python 3.13, arm64, package `clipfactory_api`)

| Function | Handler | Trigger | Environment |
|---|---|---|---|
| `cf-prod-api` | `clipfactory_api.http.handler` | HTTP API (all routes) | `TABLE_NAME`, `MEDIA_BUCKET`, `AGENT_RUNTIME_ARN`, `JOB_FLOW_ARN`, `CLIP_FLOW_ARN`, `VECTOR_BUCKET`, `VECTOR_INDEX`, `APP_URL`, `VERSION`, `STATS_FUNCTION_ARN`, `LEARN_FUNCTION_ARN` (§16), `HOOKS_URL`, `SECRET_PREFIX`, `OAUTH_STATE_SECRET`, `WEB_BUCKET`, `DISTRIBUTION_ID` (§17.9) |
| `cf-prod-stats` | `clipfactory_api.stats.handler.handler` | EventBridge rule `cf-prod-stats` `rate(15 minutes)` + async Invoke by `cf-prod-api` (manual refresh) | `TABLE_NAME`, `STATS_TIME_BUDGET_SECONDS=240` (§16.5), `SECRET_PREFIX` (§17.9) |
| `cf-prod-learn` | `clipfactory_api.weekly.handler` | async Invoke by `cf-prod-api` on `PUT /v1/weeks/{week}/best`; EventBridge rule `cf-prod-learn-daily` `cron(0 5 * * ? *)` (§16.12) | `TABLE_NAME`, `MODEL_ID`, `EMBED_MODEL_ID`, `VECTOR_BUCKET`, `VECTOR_INDEX` (§16.6), `MEDIA_BUCKET` (the owner's skills, §18.6) |
| `cf-prod-job-flow` (durable, alias `live`) | `clipfactory_api.flows.job_flow.handler` | async Invoke by `cf-prod-api` on the alias | `TABLE_NAME`, `AGENT_RUNTIME_ARN` |
| `cf-prod-clip-flow` (durable, alias `live`) | `clipfactory_api.flows.clip_flow.handler` | async Invoke by `cf-prod-api` on the alias | `TABLE_NAME`, `MEDIA_BUCKET`, `MODEL_ID`, `EMBED_MODEL_ID`, `VECTOR_BUCKET`, `VECTOR_INDEX`, `SECRET_PREFIX` (§17.9) |
| `cf-prod-ws-authorizer` | `clipfactory_api.realtime.authorizer.handler` | WebSocket `$connect` REQUEST authorizer | `USER_POOL_ID`, `USER_POOL_CLIENT_ID` |
| `cf-prod-ws` | `clipfactory_api.realtime.ws.handler` | WebSocket routes `$connect`, `$disconnect`, `$default` | `TABLE_NAME`, `WS_ENDPOINT`, `CONN_TTL_SECONDS=7200` |
| `cf-prod-broadcast` | `clipfactory_api.realtime.broadcast.handler` | DynamoDB Streams on `cf-prod-data` (filtered) | `TABLE_NAME`, `WS_ENDPOINT` |
| `cf-prod-hooks` | `clipfactory_api.hooks.handler` | REST API `cf-prod-hooks` (all routes) | `TABLE_NAME`, `APP_URL`, `VERIFY_TOKEN_PARAM=/cf-prod/hooks/verify-token`, `SECRET_PREFIX`, `OAUTH_STATE_SECRET` (§17.9) |

Details of every new function, and what replaced `cf-prod-publisher`, `cf-prod-perf-check`, `cf-prod-watchdog`,
the SQS publish queue and the EventBridge resources: §14.

* Confirm → API writes one `Post` per enabled platform (`pending_integration` while no account is connected for that
  platform, `queued` when connected) and starts the durable `cf-prod-clip-flow` (§14.5), which publishes the `queued`
  ones through the platform adapter (adapters arrive in phase 2; today every platform is `pending_integration`), waits
  48 hours, reads metrics (through the shared stats refresh, §16.5) and updates the clip's vector (the one-sentence
  48-hour Learning is retired, §16.12). Between and after those steps `cf-prod-stats` keeps every posted post's numbers fresh for 30 days (§16).
* A `running` job whose agent stops sending heartbeats for 6 minutes is resumed on a new session (at most twice,
  §30.1) through the job-flow callback heartbeat timeout (§14.4), not a scan; only after that does it become `failed`
  ("Making the clips stopped. Tap Try again to pick up where it left off.").
