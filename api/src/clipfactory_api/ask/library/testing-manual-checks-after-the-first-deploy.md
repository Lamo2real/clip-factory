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
15. **Content Rewards** ([CONTRACTS §38.21](CONTRACTS.md#3821-not-verified-live-each-is-checked-at-the-owners-first-connect-or-first-campaign-post)):
   these were not checked against the live Content Rewards when the feature was built. The switch PR #88 has merged
   ([DEPLOYMENT.md](DEPLOYMENT.md#content-rewards-contracts-38)), so do them at the owner's first real Connect and
   first campaign post, with the steps in [SETUP_POSTING.md](SETUP_POSTING.md#content-rewards).
   - In the deploy log of the first §38 deploy, the plan adds `cf-prod-campaigns` and replaces nothing; the delete
     gate passes. Before the switch PR, Set up posting showed the Content Rewards card as "Coming soon"; now it shows
     the setup card.
   - In the Mac app, **Connect Content Rewards**. Note CR's approve screen and its words, whether CR took the
     registration from AWS and the five loopback redirects (a "Sign-in failed" page says no), and whether the answer
     carries `iss`. Secrets Manager (eu-north-1) now has `cf-prod/platforms/contentrewards/app` and `…/token`; the
     `CRCONN` item has no token. The card says "Ready: sends your clips for you" (the pilot granted
     `my_submissions:write`) or "Ready: you send clips yourself" (then send the email on "Content Rewards said no?").
   - Paste a campaign you joined: the card says "You're in" within a minute; check whether its rules came from CR's
     listed description or need the paste box, and that the TypeID match was logged as `cr.typeid_verified`.
   - Post the first campaign clip to YouTube: the post line goes "Sending…" → "Sent ✓" within a few minutes (or the
     "Send this to Content Rewards now" reminder arrives); YouTube Studio shows "Includes paid promotion" (no
     "YouTube didn't take the Paid promotion switch" line); an X post shows "Paid partnership". Note whether CR's
     30-minute clock started at the upload or after YouTube's processing.
   - When money arrives: the three tiles match CR's **Earnings**; follow the **Finance** or Whop steps once and note
     where Whop's screens differ.
   - Also note: whether the sign-in works on a port other than the five (CR's docs say "at any port"); whether the
     token request needed `resource`; the refresh answer's lifetime fields; a group link's JSON; any limit on the
     public JSON; that Instagram and Facebook Reels show no paid-partnership option; where the first brief that
     wants proof takes it (CR's **Support** chat is the fallback); and which Settings tab shows "Connect your Whop
     account" (the hint says **Profile**).
16. **Content Rewards: the two ways, all your money and the fit** ([CONTRACTS §39.6](CONTRACTS.md#396-not-verified-live)):
   not checked live when built. Do them after the §38 checks; the copy ones too, since the `cr_remake_enabled` PR #93
   has merged.
   - In the deploy log, the plan changes only the api's environment (`CR_REMAKE`) in place and replaces nothing.
   - Make normal clips from a link at `/` and count the taps to an upload: 5, with no campaign word on the form.
   - On the setup page, note whether **Continue with Google** is still on Content Rewards' sign-up page, how many
     taps Google's screens take and how many questions Content Rewards asks after sign-up; whether signing in at
     Content Rewards' sign-in page with a new email makes an account (then step 1 could fold into step 3).
   - Check whether Content Rewards' `mcp-tools.json` now has a tool that lists the accounts added there or says an
     account exists (then steps 1 and 2 could tick themselves).
   - A campaign clip on Review: the fit headline matches what Content Rewards later says about the clip (a brand that
     turns down a "Can earn" clip, or a channel the check called "I couldn't check", is worth a note). Check that
     the rules reader set `overlayRequired` only for a brief that asks for its own picture on top.
   - Note when the fit's language line says "I couldn't check the language" for a clip in a common language (the
     table may need that language).
   - On a campaign clip with banned content in its rules, a `no` for banned content matches what the clip shows (that
     `no` blocks the campaign upload).
   - Tap "Make a FaZe Clips copy" on a normal clip that fits: the copy shows right below in about 3 minutes, with the
     logo, "Paid partnership" for 3 seconds and #Ad. Note whether the brand or YouTube treats the copy and an earlier
     normal post of the same moment as reused content.
   - All your money: the YouTube row equals the Monthly card when YouTube is the only money place; the Content Rewards
     row equals Content Rewards' **Earnings** for the same days (note whether every paid payout has `paid_at` in UTC).
     Whether X's media revenue answers for the owner (then X could move from "not available" to a number later).
     Whether Meta's earnings metrics still answer
     ([CONTRACTS §25.8](CONTRACTS.md#258-not-verified-live-each-failure-becomes-a-not-available-label-never-a-number)).
17. **Campaign finder** ([CONTRACTS §41.6](CONTRACTS.md#416-who-builds-what-the-switch-tests-not-verified-live)): not
   checked live when built. The finder's switch PR #136 merged on 22 Nov 2026
   ([DEPLOYMENT.md](DEPLOYMENT.md#campaign-finder-contracts-41)), so the finder is on and these can be done now.
   - Done: in the deploy log of the switch PR #136 (run 44984165179), the plan was "Plan: 0 to add, 4 to change, 0 to
     destroy.": `CR_FINDER` `"off"` → `"on"` in place on `cf-prod-api`, `cf-prod-stats` and `cf-prod-campaigns`, plus
     the usual per-deploy `VERSION` update on `cf-prod-api` and `cf-prod-stories-api`; nothing added, deleted or
     replaced, and the delete gate passed.
   - Open Your campaigns › **Find campaigns**, keep the defaults and tap **Find campaigns for me**. In CloudWatch Logs,
     `/aws/lambda/cf-prod-campaigns` shows `finder.read` lines: note whether Content Rewards serves `robots.txt`, the
     sitemap and campaign pages to AWS addresses (a 403 or a bot wall means `blocked`, and the page says so), and
     whether any 429 comes back at 40 pages a look, 1 s apart.
   - Over the first days, the page's "I've looked at … campaigns so far" grows by about 40 a look; note whether the
     sitemap still lists every public campaign page, and whether a page reads as `unreadable` (Content Rewards' page
     format changed).
   - Open three matches on Content Rewards and compare: the pay per 1,000 views (and "Up to" for geo-priced ones),
     the money left, open or apply, and whether **Join Campaign** shows for open campaigns and **Apply** for
     application ones when signed in. Note any match whose rules, once joined, meet a stop (its own sound, its own
     picture on top, drafts first) that the overlay and sound sentence rules missed, and any page-language guess
     that was wrong.
   - Join one: tap **Join Campaign**, come back, tap **I joined: add it**. Note whether `list_my_campaigns` lists it
     right after the join once Content Rewards' sign-in yes has arrived (else "Checking that you joined…" covers it),
     and whether the TypeID match was used.
   - Signed in, tap **Ask Content Rewards** once and note whether Content Rewards' team answers the feature request.
   - Check once a week that Content Rewards' robots.txt still allows `/sitemap.xml` and `/c/campaigns/` (the finder
     checks it every day and stops by itself when it doesn't).

18. **Auto-posting** ([CONTRACTS §46.8 and §46.14](CONTRACTS.md#468-testing-with-nothing-public)): test the whole
   flow with nothing public before he turns it on for real. Not checked live when built.
   - In the deploy log, the plan adds only `module.autopost.*` and the two new alarms, with 0 to destroy; the delete
     gate passes and `scripts/check-plan-clips-unchanged.sh` has nothing to report.
   - With auto-posting still off, open Settings › Posting › Auto-posting: "Off. Nothing posts by itself.", Next up
     lists the clips in Review oldest first under "Would go first", and Where they go names the ready places with
     "TikTok: you post it yourself (TikTok's rule). Each clip gets Post it yourself."
   - Open **Test it first** and tap **Practice run now**: within 30 seconds Recent shows "Practice: would post “hook”
     to YouTube, Instagram and Facebook."; the clip stays in Review and nothing reaches any platform. Tap it again at
     once: "A test run just started. Wait a minute."
   - Turn on **Practice**, then **Post my clips by themselves**: "On, practising. Next practice: …". For the next hours,
     `/aws/lambda/cf-prod-autopost` in CloudWatch Logs shows one invocation every hour; note whether each starts
     within the first minute of the hour. Recent gains a practice run at each due time, exactly **Post every** hours
     apart, and nothing is sent.
   - Tap **Private test run**: the next clip leaves Review. YouTube Studio shows it as Private; on Facebook the Reel
     is under the Page's drafts, and from a browser that is not signed in as a Page admin it can't be found (note what
     you see: this is the unverified part); on Instagram nothing is published. Library says "Private test · only
     you", "Private test · draft on your Page" and "Private test · checked, not published", with no numbers.
   - Only then turn **Practice** off. The first live run posts the oldest clip at the time the page showed; its posts
     say "· by auto-posting" with **Open** links, and the clip is under **Post these on TikTok yourself**.

19. **Get paid** ([CONTRACTS §40.8](CONTRACTS.md#408-changes-to-earlier-sections-who-builds-what-tests-not-verified-live),
   "Not verified live"): not checked live when built. Do them at the owner's first use; each failure becomes "not
   available" or "can't check", never a number.
   - In the deploy log, the plan changes only the two stream filters and the api's environment (`WHOP_CONNECT`) in
     place, destroys nothing and replaces nothing; the five setup cards, "2 of 5 ready" and the five-row to-do list
     are unchanged.
   - YouTube: tap "Allow payment reading" with the Google account that has AdSense for YouTube. Note whether
     `accounts.list` returns that account, how Google writes a SEK amount in `payments`, whether `Payment.date` is the
     day Google sent it, whether Google showed more than its unverified-app screen, and whether `/channel/UC/monetization`
     opens **Earn**. When a hold appears, note its alert type and where the red message shows on **Payments**.
   - Note which error a switched-off AdSense API gives (`accessNotConfigured` or `SERVICE_DISABLED`; both are handled).
   - Meta: the payout steps' words in Sweden (is **Sign into your bank** offered?), the path **All tools** ›
     **Payouts**, and whether the Meta Business Suite addresses open after sign-in. For Facebook's estimate: read one
     day of `monetization_approximate_earnings` and compare it with Meta Business Suite › Insights › Earnings; if they
     match, a one-line PR sets `moneyVerified: true` (§40.3).
   - TikTok: whether Video Gifts and LIVE Gifts are open in Sweden, and the buttons after **Balance** › **LIVE
     rewards**.
   - X: the words of Creator Studio's Stripe button and whether Creator Studio shows paid-out history.
   - Whop (only after the `whop_connect_enabled` PR): whether a personal user can make an app and grant the four
     permissions, whether `GET /users/me` and `GET /payouts` accept his sign-in, whether Content Rewards pays into his
     own or a business balance, and the units of `destination_amount`.
