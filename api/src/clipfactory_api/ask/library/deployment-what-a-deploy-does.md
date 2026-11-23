## What a deploy does

Triggered by a push to `main` ([deploy.yml](../.github/workflows/deploy.yml)) or by hand (Actions → deploy → Run workflow).

1. **Test and build** in parallel: web tests and the production build; Python lint, types and tests; the Lambda
   package `api/dist/lambda.zip`.
2. **Assume the role** through OIDC.
3. **State bucket**: [scripts/ensure-state-bucket.sh](../scripts/ensure-state-bucket.sh) creates the Terraform state
   bucket if it does not exist (versioned, encrypted, private). Every call checks that the bucket belongs to this
   AWS account (`--expected-bucket-owner`): if a bucket of that name belongs to someone else, the deploy stops and
   says to pick another `CF_STATE_BUCKET`, so the state (which holds secrets) is never written to someone else's
   bucket.
4. **Agent image**: [scripts/push-image.sh](../scripts/push-image.sh) builds the ARM64 image and pushes it to ECR,
   tagged with a hash of the agent's sources, so unchanged code is not rebuilt.
5. **Terraform** `init` (S3 backend with lockfile), `plan`, then `apply` of exactly that plan. No manual approval
   (the owner's choice).
   Between the delete gate and the apply, `scripts/wait-for-jobs.sh` (the drain, CONTRACTS §30.7) waits for jobs
   being made when the plan changes anything under `module.agent` (clip jobs) or `module.stories_agent` (Clips Funded's story
   jobs, AI tasks and streaming chat answers, each drained only when its own runtime changes): up to 25 minutes (a failed Scan is tried three times, then it goes on), counting `queued`/`running` jobs
   with a fresh heartbeat (counts only in the log, read only). A job still running after that resumes on the new
   agent version by itself.
   The apply creates or updates every resource, including the three API Gateway APIs (REST first, then WebSocket,
   because API Gateway allows one deployment every 5 seconds per account), every Lambda (with `cf-prod-campaigns`, [Content Rewards](#content-rewards-contracts-38)); the two durable ones
   publish a new version and move their `live` alias, and running executions stay on their old version), the stream
   trigger, the EventBridge rule `cf-prod-stats` (every 15 minutes, read from `config/platforms.json`), the vector
   bucket and index, the SSM parameter, the Connect state-key secret and the alarms (including `cf-prod-help-model-failures` and its log metric
   filter), and the AgentCore runtime's log group `/aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT` with 30-day
   retention like every other log group (created if the service has not made it yet). `cf-prod-api` gets the `HELP_*` settings (`HELP_ENABLED = "true"`, the EU Haiku profile from
   `config/models.json`, the cap and rate limits) and permission to call only that model. No extra deploy job is needed for them:
   they all come from the same Lambda zip and the same `terraform apply`.
   **Clips Funded** (CONTRACTS §45.15, §45.34): once its runtime `cf_prod_story_agent` is live, its own image
   (`stories/agent/Dockerfile`) is built and pushed between `terraform init` and `plan`; a failed build shows an
   `::error` line, keeps the live tag (output `stories_agent_image_tag`) and still ships Clip Factory. After the delete
   gate, the **Clip Factory check** (Clips Funded changes nothing of Clip Factory) reads the plan whenever Clips Funded
   work that feeds it is in the deploy (first-parent commits since the live release, `cf-prod-api`'s `VERSION`). A
   commit is Clips Funded work when it touches Clips Funded's folders (`stories/`, `web/src/stories/`,
   `infra/modules/stories_*`, `api/src/clipfactory_api/workspaces/`, the story flow, their tests) or names the app in
   its message: "Clips Funded", or an old name, "Funded Clips", "Clip Stories", "Clip Factory Stories" or "Lamo
   Stories", in any case, as whole words. It feeds the plan when it also touches `infra/`, `deploy.yml`, `agent/`,
   `skills/` or `config/`. It fails when the plan changes Clip Factory's agent, `cf-prod-api`, `cf-prod-hooks` (other than
   `STORIES_OAUTH_CALLBACK`), the HTTP API's settings, JWT authorizer, Lambda permission or stage (other than Clips
   Funded's own `route_settings`), or any Clip Factory route. A Clip Factory pull request that changes those and
   lands in the same unapplied range as Clips Funded infra work stops the deploy by design: check that the findings
   are that pull request's, then rerun from Actions → deploy → Run workflow with **Clip Factory changes on purpose**
   (`allow_clip_factory_change`) ticked, which turns the findings into warnings. It never lets a Clips Funded route
   take a Clip Factory path. A change only to `config/*.json`, `skills/` or `agent/` by a Clip Factory pull request
   changes Clip Factory's agent tag (`module.agent.terraform_data.image` is replaced) and passes the check.
   **Clips Funded's providers** (CONTRACTS §45.22, §45.31): Amazon Nova Reel needs `stories_video_us_bucket = true` in
   `infra/envs/prod` (a one-line pull request; it adds only the bucket `cf-prod-stories-video-<account>-us` in
   us-east-1, private, shots kept 14 days, and lets `cf_prod_story_agent` start Nova Reel there). It stays off until the
   owner allows Clips Funded to keep generated shots in the US. Then, in the AWS console, Bedrock › Model access: turn
   on Amazon Nova Reel in us-east-1 and Amazon Nova Canvas in eu-west-1 (Ireland) for character pictures. Clips Funded's
   reasoning models (Claude on Bedrock, and any model the owner adds in Settings › AI) need model access in their
   Regions; Settings › AI › Check models and Settings › Video › Try it (Nova Reel) show what works.
   **Since §45.37 (2026-11-22)** Amazon has ended Nova Reel and Nova Canvas (both read ended; never called), so the
   AI makers are: **Luma AI Ray2** for cut-aways, which needs `stories_video_west_bucket = true` in `infra/envs/prod`
   (a one-line pull request; it adds only the bucket `cf-prod-stories-video-<account>-usw2` in us-west-2 through the
   `aws.us_west_2` provider, private, TLS only, shots kept 14 days, and lets `cf_prod_story_agent` start Luma AI Ray2
   there), then Bedrock › Model access › Luma AI Ray2 in us-west-2 (Oregon), then Settings › Video › Try it;
   **Stability AI** pictures for portraits, which need Bedrock › Model access for Stability AI's models in us-west-2;
   **ElevenLabs** sound effects and instrumental music, which need only the owner's ElevenLabs key (Provider keys)
   and his pick of ElevenLabs as the Sound maker; and **Amazon Polly**'s spoken voice in eu-west-1, opt-in only (the
   runtime's own role; nothing to set up). The built-in makers stay the default and need nothing.
6. **Web**: [scripts/write-web-config.sh](../scripts/write-web-config.sh) writes `config.json` from the Terraform
   outputs, including `wsUrl` from `ws_url` and `oauthCallbackBase` from `oauth_callback_base` (both required; the
   script stops if one is missing); the build is synced to the web bucket (the sync never deletes TikTok's
   `tiktok*.txt` verification files, which the app uploads) and CloudFront is invalidated. The build includes the help
   corpus as `/assets/help-corpus.<hash>.json` and names it in `index.html`; `cf-prod-api` picks up the new corpus
   within 10 minutes (the Lambda zip carries the same file as its fallback).
7. **What's new**: `scripts/release-areas.sh <prev-sha> <new-sha>` turns the commits since the live version into up to
   three area labels ([how to write them](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)), and the deploy writes
   `/version.json` last, never cached. Open apps show the update bar within 5 minutes
   ([ARCHITECTURE.md flow 11](ARCHITECTURE.md#11-updates-versionjson-release-areas-and-the-update-bar)).
8. **Smoke test**: `GET /v1/health` must answer `{ "ok": true }`.
9. **Desktop app**: once the deploy has succeeded, its own workflow
   ([desktop.yml](../.github/workflows/desktop.yml)) rebuilds it when needed: see [Desktop downloads](#desktop-downloads).

The run summary shows `app_url`. The first deploy into an empty account takes about 15–20 minutes (CloudFront and
the AgentCore runtime are the slow parts); later deploys take a few minutes. One deploy runs at a time (the
`deploy-prod` group), and it ends with the smoke test: a desktop rebuild (about 10–15 minutes on the macOS and
Windows runners, after the web is already live) runs in desktop.yml and never holds up the next merge's deploy.
