## Content Rewards (CONTRACTS §38)

Paid clipping campaigns on Content Rewards ([CONTRACTS.md §38](CONTRACTS.md#38-content-rewards-campaigns-owner-request-2026-11-21),
[ADR-62](DECISIONS.md#adr-62-content-rewards-the-official-sign-in-through-the-desktop-apps-loopback-door-sending-from-the-cloud-a-reminder-when-it-cant),
the owner's steps in [SETUP_POSTING.md](SETUP_POSTING.md#content-rewards)). Nothing to set up in AWS or GitHub by
hand: the owner connects inside the Mac app, and the app makes its own secrets.

**Switched on (PR #88).** `infra/envs/prod` has `variable "content_rewards_enabled"` (bool, **default `true`**). It
sets `CONTENT_REWARDS` on `cf-prod-api`, `cf-prod-stats`, `cf-prod-clip-flow` and `cf-prod-campaigns`. It shipped
with default `false` while the parts were built in parallel (CONTRACTS §38.19: api, posting, agent, web, desktop,
docs), each merging in any order and passing CI alone. Off (`CONTENT_REWARDS = "off"`), every `/v1/contentrewards*`
route answers 503 `unavailable` ("Content Rewards is not switched on for this app yet."), the clip flow sends nothing,
the stats tick skips Content Rewards and the web app shows "Coming soon" on the Set up posting card.

**The switch PR.** After all six parts had merged, one last pull request (#88, builder A's line, 21 Nov 2026)
changed the default to `true`; its deploy set `CONTENT_REWARDS = "on"` everywhere, and that was the only change it
made. So no campaign clip could go out before the paid-partnership and caption code and the logo and on-screen
disclosure were in. To turn it off again, set the default back to `false` (revert that one line); no owner data is
touched either way.

**Make a campaign copy (CONTRACTS §39.3).** Its own switch, `variable "cr_remake_enabled"` (bool, **default
`true`**), sets `CR_REMAKE` on `cf-prod-api`, an in-place env change. It shipped `false` (the copy route answered 503
"Coming soon." and no fit offered a copy); its switch PR #93 set it to `true` once G, H and I of §39.4 had merged.
Turn it off the same way.

**What the first deploy with §38 adds** (additive only, the plan in the deploy log shows it):
- one new Lambda `cf-prod-campaigns` (the one zip, 512 MB, 120 s, async only, retries 0), its log group (same
  retention), its `cf-prod-*` role and policy (DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `Query`; `s3:GetObject`,
  `PutObject`, `DeleteObject` on `campaigns/*` only; the clip agent's model; X-Ray; **no Secrets Manager action**), and
  its place in the error and failed-invocation alarms;
- in place: new env vars (`CONTENT_REWARDS`, `CAMPAIGNS_FUNCTION_ARN`) and IAM on `cf-prod-api` and `cf-prod-stats`
  (invoke `cf-prod-campaigns`; the api also `campaigns/*` in the media bucket), `CONTENT_REWARDS` on the clip flow,
  and two widened stream filters (live updates and notifications gain `CAMPAIGN#`, `CRCONN`, `CRSUB#`, `CRMONEY`;
  notifications stay `MODIFY` only);
- no new schedule (Content Rewards checking rides the `cf-prod-stats` tick), no new output, nothing on the agent.

**The deploy role needs nothing new.** `cf-prod-campaigns` is one more Lambda, log group and `cf-prod-*` role with
the permissions boundary, all covered by the role's existing `lambda:*`, `logs:*`, `cloudwatch:*`, `xray:*`, the
`cf-prod-*` IAM statements and `iam:PassRole` to `lambda.amazonaws.com` (or `PowerUserAccess` in `infra/bootstrap`).
No change to `infra/bootstrap`. The Content Rewards secrets are **never** made by Terraform or the deploy role.

**Owner data.** Nothing that holds the owner's data is replaced or destroyed: no table, index, Cognito pool, bucket
or secret. The new items are new sort keys (`CRCONN`, `CRSTATE#`, `CAMPAIGN#`, `CRSUB#`, `CRMONEY`, `CROWNERS`) and new
attributes on jobs, clips, posts and settings; the media bucket gains the prefix `campaigns/`; the two secrets
`cf-prod/platforms/contentrewards/app` and `…/token` are created by `cf-prod-api` at runtime under the existing
prefix. The deploy's delete gate still prints "Delete gate: the plan deletes or replaces nothing that holds the
owner's data." If it ever says otherwise for this change, stop and fix the plan. Never deploy from a local AWS CLI:
only `deploy.yml` deploys.

**The desktop app.** The sign-in door ships in the next signed desktop release; the owner taps "Restart now" once.
An older app shows "Update the Clip Factory app first" on the Connect step.

**Cost.** One more small Lambda, a few Content Rewards calls a tick, one model call per campaign rules read (about
$0.02), and two more secrets ($0.80 a month).

### Campaign finder (CONTRACTS §41)

Campaigns on Content Rewards that match what the owner wants
([CONTRACTS.md §41](CONTRACTS.md#41-campaign-finder-campaigns-that-match-what-you-want-owner-request-2026-11-21),
[ADR-65](DECISIONS.md#adr-65-campaign-finder-content-rewards-public-pages-read-politely-joining-stays-the-owners-own-tap),
[ARCHITECTURE.md flow 22](ARCHITECTURE.md#22-campaign-finder-contracts-41-adr-65)). Nothing to set up in AWS, GitHub
or on Content Rewards by hand.

**Switched on (PR #136).** `infra/envs/prod` has `variable "cr_finder_enabled"` (bool, **default `true`**). It sets
`CR_FINDER` (`"on"` or `"off"`) on `cf-prod-api`, `cf-prod-stats` and `cf-prod-campaigns`; the modules default to
`false`, and an unset value is off. It shipped with default `false` while the parts were built in parallel
(CONTRACTS §41.6: P the reader, Q the routes, R infra, S web, T docs and help), each merging in any order and passing
CI alone (T after S). Off (`CR_FINDER = "off"`), every `/v1/contentrewards/finder…` route answers 503 `unavailable`
("Coming soon."), the overview has no `finder`, the `cf-prod-stats` tick never starts a look and `cf-prod-campaigns`
answers `{"action": "find", "outcome": "off"}`; the web hides the Campaigns entry card and Home's chips, and
`/campaigns/find` says "Find campaigns is coming soon to Clip Factory."

**The switch PR.** After P, Q, R, S and T had merged, one last pull request (#136, owner: R, merged 22 Nov 2026)
changed `envs/prod`'s default to `true` and updated `wiring.tftest.hcl`'s expectation. Its deploy (run 44984165179)
planned "Plan: 0 to add, 4 to change, 0 to destroy.": `CR_FINDER` `"off"` → `"on"` in place on the three Lambdas,
plus the usual per-deploy `VERSION` update (the new commit) on `cf-prod-api` and on another function,
`cf-prod-stories-api`. Nothing was added, deleted or replaced, and the delete gate printed "Delete gate: the plan
deletes or replaces nothing that holds the owner's data." From then on the `cf-prod-stats` tick starts a look every 6
hours, the owner's first "Find campaigns for me" starts one at once, and the first full read of Content Rewards'
campaign pages takes 3 to 5 days.

**Turning it off the same day if Content Rewards or Whop asks.** If Content Rewards or Whop asks Clip Factory to stop
reading its pages, set the default back to `false` (revert the switch PR's one line) in a pull request that day; its
deploy sets `CR_FINDER = "off"` on the three Lambdas, so no page is read from then on and every finder route answers
503. The stored items (`CRFIND`, `CRPUBLIC`) stay, nothing on Content Rewards or any platform changes, and turning it
on again later picks up where it was. The finder also stops reading by itself when Content Rewards' robots.txt stops
allowing these pages, or after it is blocked. Never deploy from a local AWS CLI: only `deploy.yml` deploys.

**What the deploys add** (additive only, the plan in the deploy log shows it):
- in place: the env var `CR_FINDER` on `cf-prod-api`, `cf-prod-stats` and `cf-prod-campaigns`, and the prefix
  `CRFIND` in the live-updates and notifications stream filters (notifications stay `MODIFY` only);
- no new Lambda, schedule, table, index, bucket, secret, grant or output: the look is a new action of the existing
  `cf-prod-campaigns`, started by the existing `cf-prod-stats` tick through the existing invoke grants, and reaches
  `contentrewards.com` over the Lambda's normal internet access (no VPC). `cf-prod-campaigns` still has no Secrets
  Manager action.

**The deploy role needs nothing new.** Env vars, stream-filter changes and the existing Lambda are all covered by the
role's current permissions; no change to `infra/bootstrap`.

**Owner data.** Nothing that holds the owner's data is replaced or destroyed. The new items are a new sort key
(`USER#{id}` / `CRFIND`), a new partition key value in the same table (`CRPUBLIC` with `CAMP#{uuid}`, `PUB#{uuid}` and
`STATE`, public campaign data only, `CAMP#` and `PUB#` expiring through the table's existing `ttl` attribute) and one
internal attribute on campaigns (`addedBy: "finder"`).

**Cost.** Cents a month: at most 6 short runs of `cf-prod-campaigns` a day, about 155 public pages a day, a few
hundred small table writes, no model call and no secret.
