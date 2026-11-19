## Failure handling

| What can fail | What happens |
|---|---|
| A pipeline step (download blocked, Transcribe error, render error) | The step is marked `failed` with a plain message, the job becomes `failed`, the agent sends `JobFailed` to the job-flow callback, the app shows **Try again**. |
| The picture cannot be fetched or prepared (no rendition that fits the disk, the download blocked or timed out, ffmpeg failed), or `CF_DEEP=off` | Logged (`picture.prep_failed`); the Watch step is `skipped` with "Could not watch the video this time. Picking from the words and the sound."; the job goes on as before the picture was watched. |
| Fable is throttled or refuses a request for its images | A throttled chunk is tried again after growing pauses and the calls in flight are halved, so a busy account slows the watching down instead of losing chunks (`deep.slow_down`); a request refused for its images or size is split into smaller ones and the accepted size is kept for the rest of the job (`bedrock.image_limit`). |
| Some or all Fable chunks still fail while watching (busy past six tries, a refusal, a bad answer, the deadline, the runaway guard) | Listed in `visual_log.failed`; Nova's events and the picture-change score still cover them. The step says "Watched most of the video (N of M parts)." only for parts neither model watched. |
| Nova 2 Lite is denied, missing or failing | That track stops at the first such answer; nothing else changes and the owner sees nothing. |
| Both watchers fail | The picture-change score still reaches the picker: "Saw where the picture moves fast. Picking with that, the words and the sound." |
| Transcribe refuses speaker labels | The job is started once more exactly as before; no `speakers.json`. |
| The second look fails for a moment, or `pickedFor` cannot be built | The moment is kept as picked; the clip card shows no "Why:" line. |
| One clip fails the checklist | One fix pass; if it still fails, a spare moment replaces it. The job finishes with the clips that pass. |
| The agent container dies, runs out of memory, freezes or the session ends | Heartbeats to the callback stop (or SIGTERM sends `AgentStopped`); after 6 minutes the job flow resumes the job on a new session from its saved moments and clips, at most twice; then it marks it failed ("Making the clips stopped. Tap Try again to pick up where it left off."), and Try again picks up. Deploys wait for running jobs when the agent changes. No scan, no watchdog (CONTRACTS §30). |
| The job flow cannot start the agent | Step `start-agent` retries 3 times with backoff on throttling, 5xx and connection errors; then the execution fails and the `cf-prod-job-flow-durable-failed` alarm fires. |
| The API cannot start a flow | Job: `failed` with "Could not start. Press Try again." Clip: stays `publishState: pending`; the next Keep starts it again (same name, so never twice). |
| A job runs longer than 8 hours | The callback times out and the job fails with the same plain message; long sources are capped by `maxSourceHours`. |
| Bedrock throttling | The SDK retries with exponential backoff; the global profile spreads load across regions. |
| The owner cancels | The API sends `{action: cancel}` to the session and stops it; the agent marks the job `canceled` and sends `Canceled`, so the flow writes nothing. |
| Publishing a post fails | `publish-`, `check-` and `finish-{platform}` retry 3 times on retryable errors; then only that post is `failed` with the platform's friendly sentence ("YouTube says slow down…", "Your X credits ran out…"). If every queued post failed, the clip shows **Try again**. Raw platform messages go to the logs only. |
| A platform token is dead (revoked, expired, password changed) | The post fails with "Connect {Platform} again in Settings › Posting › Set up posting, then press Try again."; the account becomes `needs_reconnect`, the setup page shows a vermilion **Connect again**, and the stats poller skips that platform. |
| A platform takes too long to process a video | After `maxChecks` YouTube and TikTok posts are marked posted (the platform finishes alone); Instagram, Facebook and X fail with "{Platform} could not finish this video. Press Try again." |
| A step that cannot be repeated is interrupted (TikTok init, Instagram publish, X post) | The post fails with "We are not sure it posted. Look on {Platform} before you press Try again." instead of risking a double post. |
| Two refreshes of a rotating token at once (TikTok, X) | A 30-second lease on the account item lets one refresh; the other waits and re-reads the new secret. The new token is written before it is used. |
| The Connect callback fails | The owner lands on the platform's setup page with one plain sentence and the step to redo (`denied`, `expired`, `keys_wrong`, `redirect_wrong`, `missing_permissions`, `no_channel`, `no_accounts`, `no_pages`, `platform_down`, `error`). |
| X credits run out | The X gate turns to "Your X credits ran out. Buy more in console.x.com › Billing › Credits, then press Try again."; the app's own $10 monthly cap stops X earlier. |
| Reading metrics fails for a platform | That platform is skipped after 3 attempts; the others still count. The clip flow's `metrics` step uses the shared stats refresh and falls back to the stored numbers when a platform is blocked. |
| A platform limit is near or hit (stats) | The platform's `RATE#` budget gets `blockedUntil` (YouTube: 08:00 UTC; TikTok: 1 min; Meta: Meta's own wait, at least 60 min after a throttle; X: `x-rate-limit-reset` or the 1st of next month at the $10 cap). The poller skips it, its posts stay due, Refresh answers "Next check in …". A Meta throttle is never retried. |
| A stats read fails (5xx, network) | Retried twice (1 s, 4 s), except Meta throttles; then `statsError` holds a plain sentence on the post and it waits its normal interval. No tight loop, no raise. |
| The tick has more due posts than fit in 240 s | It stops starting requests at 240 s; the rest stay due and go first on the next tick. |
| Two ticks or a tick and a Refresh run at once | Budgets are conditional writes, so they cannot overspend together; a post read twice simply gets the newer numbers. |
| `cf-prod-learn` fails or is superseded | A newer save wins (the `revision` check); a failed invoke or model answer leaves "Could not learn this time. Change a pick to try again."; vector errors are logged and never stop the learning. |
| A skill file cannot be read (agent or Lambda) | Retried 3 times, then skipped and logged `skills.skipped`; the agent's `analyze` step says "1 skill could not be read". Reading the skill items themselves failing fails the step, and its normal retry runs. |
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
| The help model is slow, failing or not yet subscribed | Timeouts (3 s connect, 10 s read, no retry) and a 24 s deadline end the call; the owner gets the composed answer. Ten failures in an hour raise `cf-prod-help-model-failures`. |
| The help model's answer is not grounded | Unknown action ids are dropped; an unknown bold button name, path or number sends back the composed answer (outcome `kb_ungrounded`). |
| The deployed help corpus cannot be fetched or is invalid | The last good copy stays in use, else the copy bundled in the zip. |
| The help API is unreachable or answers 5xx | The panel answers locally from the same corpus and shows "Copy the help code". |
| Too many help questions | `429` with `Retry-After`; the panel counts down and never retries by itself. |
| The help assistant must stop now | Kill switch `HELP` / `SWITCH` (60 s), no deploy ([DEPLOYMENT.md](DEPLOYMENT.md#ask-clip-factory-kill-switch)). |
| A download file is missing | `manifest.json` does not list it; Get the app falls back to the browser install. The next deploy rebuilds it. |
