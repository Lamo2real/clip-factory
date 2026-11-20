## Manual checks after the first deploy

1. Sign in with the temporary password and set a new one.
2. Add a short public YouTube video; watch the steps; review the clips.
3. Watch a job from a second device: steps and clips appear on both within a couple of seconds (live updates).
   Turn the network off and on: the app catches up by itself with no error.
4. Before any platform is set up, keep one clip; it shows "Waiting for the account connection" on each platform. In
   the Lambda console, the `cf-prod-clip-flow` durable execution `clip-<clipId>-1` ends with outcome `not_posted`.
5. Open `{hooks_url}/hooks/youtube?hub.mode=subscribe&hub.topic=https://www.youtube.com/xml/feeds/videos.xml%3Fchannel_id%3Dx&hub.challenge=hello`
   in a browser: it answers `hello`.
6. Install the app on a phone and on a desktop; scroll a long list on the phone and confirm there is no sound.
   Open Settings › Look & feel › Sounds, pick another click sound on the phone, and check the desktop plays it too
   after its next settings load. Find a setting by typing "sound".
7. Write a skill in Settings › Clip making › Skills (for example "Every caption ends with GG"), start another job and
   check that the clips, hooks and captions follow it. In CloudWatch Logs, the agent's `skills.block` line counts it.
   Edit it, read it back, delete it and Undo, then delete it for good.
8. Open **Get the app** on a Mac and on Windows; download, follow the first-open hint, and check that Get the app is
   gone inside the desktop app. On an iPhone, follow the three steps.
9. Upload a clip and open it from Library: five stacks read "Waiting for connection" with a link to Set up posting; Refresh
   numbers answers without calling any platform. In CloudWatch Logs, `/aws/lambda/cf-prod-stats` shows a `stats.tick`
   line every 15 minutes. In Library › This week, star the clip: "Learning from your picks…" turns into a "Best of
   week" learning within a minute or two.
10. Set up posting ([SETUP_POSTING.md](SETUP_POSTING.md)): open `{app_url}/about.html`, `/legal/privacy.html` and
   `/legal/terms.html` without signing in. Set up YouTube to the end, press **Check it**, then **Connect YouTube**: you
   come back with confetti and "Connected as …". In Secrets Manager (eu-north-1) you see `cf-prod/platforms/youtube/app`
   and `…/token`; in DynamoDB the `ACCOUNT#youtube` item has no token. Upload a short clip with **Only me** picked in
   "Who can see your clips": it appears on the channel as a private Short and the clip page shows its link. Press
   **Disconnect**, wait 8 s: the token secret is gone. Then the other four platforms the same way (X costs a little).
11. Push a small change with an `Area:` line; within 5 minutes the open app (browser and desktop app) shows the update
   bar with that label; press Reload and watch it finish.
12. **Watch the video** ([ADR-40](DECISIONS.md#adr-40-watch-the-whole-video-before-picking)): run a job on a short
   gaming video with a loud moment and a silent crash or stunt. The job shows ten steps; "Watch the video" ends with
   "Watched all …. Saw … big things."; at least one clip on Review carries a "Why:" line. In CloudWatch Logs for the
   agent: one `picture.ready`, one `watch.done` (its `fable` and `nova` counts equal the chunks and parts), `bedrock.usage`
   lines with token counts for the tools `report_scenes` and `check_moment` (add them up and correct the cost table
   in ADR-40), and no `deep.guard_tripped`. In S3, `jobs/<jobId>/source/` holds `picture.json`, `visual_log.json`,
   `signals.json` and `moments.json`. Press **Try again** on a finished copy of the job: Watch says "Used what it saw
   last time." If Nova's `watch.done` count is 0 with reason `denied` or `not_found`, open Amazon Nova 2 Lite once in
   the Bedrock console (eu-north-1) and check the EU inference profile is listed.
13. Open **Ask** on a phone and on a desktop. Ask "Where do I change my click sound?": the steps appear, **Open Sounds**
   goes to Look & feel › Sounds and the Click sound row lights up. Ask "How many views did my best clip get this
   week?" and check the number matches Library › This week. In CloudWatch Logs, `/aws/lambda/cf-prod-api` shows one
   `help.answer` line per question with no question text. If every answer comes back in plain words only, open
   Claude Haiku 5.5 once in the Bedrock console ([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).
14. **Real earnings** ([CONTRACTS §25.8](CONTRACTS.md#258-not-verified-live-each-failure-becomes-a-not-available-label-never-a-number)):
   these were not checked against the live platforms when the feature was built. Each failure becomes a "not shared"
   line, never a number.
   - In the deploy log, the plan says "0 to destroy" and the delete gate passes; `cf-prod-money` and the
     `cf-prod-money-daily` rule are new.
   - Open Settings › Posting › Money, pick your country, press **Check now**. In CloudWatch Logs,
     `/aws/lambda/cf-prod-money` shows one `money.run` line; every connected card shows real numbers or a plain reason.
   - YouTube, in this order: Google Cloud › Data access, add `yt-analytics-monetary.readonly` (same project, no new
     keys); Audience says **In production**; then **Allow money reading** (the "unverified app" screen is expected). You
     come back to Money with "Done!" and the pill is **Not yet**, **In the program** or **Earning**. Set up posting
     still says Connected and a test post still works. Compare one day's amount with YouTube Studio › Analytics ›
     Revenue (YouTube's number may still change at month end). Note whether the Shorts/long split appears.
   - Whether `yt-analytics-monetary.readonly` shows as a sensitive scope, and the YouTube API Services policy's limit
     on how long this data may be kept (until confirmed, only an explicit YouTube Disconnect deletes it).
   - Facebook: with a Page in content monetization, call `content_monetization_earnings` once (Graph API Explorer)
     and compare its unit and currency with Meta Business Suite › Monetization. Only when they match, set
     `facebook.moneyVerified` to `true` in `config/monetization.json` in a pull request.
   - TikTok: add `user.info.stats` and send the app for review. Check first whether that review pauses the live app's
     posting. After approval press **Allow follower reading**.
   - X: check that `verified_followers_count` comes back from `users/me`; if X refuses the field the card says "X didn't
     share this".
   - Open the official pages linked in `config/monetization.json` for TikTok, Instagram and X and confirm each number
     (`verifiedHow: official-snippet` today).
