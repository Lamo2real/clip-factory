# Business requirements

Source: the owner's brief for Clip Factory Cloud (November 2026) and the owner's follow-up after the first build
(Get the app, the update bar, the desktop app and kid-proof design: BR-15 to BR-17, NFR-11, NFR-12, UX-12, UX-13), and
the owner's request for a fully serverless Python and Terraform stack with WebSockets, a REST API, durable functions
and S3 Vectors (NFR-02 AC3 and AC4, NFR-13 to NFR-16, BR-11 AC5, BR-18), and the owner's request to organise
Settings like a field of apple trees and to choose the click and error sounds (BR-13 AC3 to AC5, UX-09 update, UX-14,
UX-15), and the owner's request to see how every clip performs on each platform, refresh those numbers by itself
and pick the best clips of each week (BR-19 to BR-21, NFR-17, UX-16).
Every requirement below traces back to one of them. Where
the brief was open or unclear, the interpretation we chose is stated in [Interpretations and open questions](#interpretations-and-open-questions).

Numbering:
- **BR-xx** functional (what the product does)
- **NFR-xx** non-functional (how it runs: cloud, reliability, security, delivery)
- **UX-xx** design and experience

Each requirement has acceptance criteria (AC). A requirement is done when every AC holds. The technical detail lives
in [CONTRACTS.md](CONTRACTS.md); this file says *what* and *why*.

---

## Functional requirements

### BR-01 Add a video by link
The owner can start a job by pasting a link to a YouTube video, a YouTube stream (live or past), a Twitch VOD or a
Kick VOD.
- AC1: The New job screen accepts `youtube.com`, `youtu.be`, `twitch.tv` and `kick.com` links and shows the detected platform before starting.
- AC2: Any other link is refused with a plain message, before a job is created.
- AC3: `POST /v1/jobs` with `{ "source": { "type": "link", "url" } }` returns `201` and a job in `queued`.

### BR-02 Add a video by upload
The owner can upload a video file instead of a link ("I need to be able to upload").
- AC1: Files up to 5 GB of any `video/*` type can be uploaded from phone or desktop.
- AC2: The upload goes straight to S3 with a presigned URL (no file passes through a Lambda) and shows progress.
- AC3: A finished upload can be turned into a job (`source.type = "upload"`).

### BR-03 Cloud agent cuts the clips
An AI agent on Amazon Bedrock AgentCore, running Claude Fable 5.1, processes each job in the cloud.
- AC1: The agent runs on AgentCore Runtime (`cf_prod_clip_agent`) and calls Claude Fable 5.1 through Amazon Bedrock.
- AC2: The job runs without the owner's computer being on.
- AC3: The job goes through the steps resolve, download, transcribe, analyze, select, render, checklist, captions,
  finalize, and the app shows each step's status live (pushed over the WebSocket API within seconds, NFR-13; polling
  only while disconnected).

### BR-04 Between 5 and 10 viral clips per job
- AC1: Each finished job has between `clipMin` and `clipMax` clips (defaults 5 and 10; the owner can change both
  in Settings, within 1–10). The agent chooses how many within the range from what the source offers.
- AC2: When the source cannot give the minimum (for example a short video), the job still finishes with what it found
  and says so plainly.
- AC3: Each clip carries a moment type (rage, chaos, interaction, no-way, first reaction, hot take), a score from 1 to 10
  and a one-line reason.

### BR-05 Clips follow best practice from the owner's skills
"Clip them up into viral segments with the best practices based on the skill that I'm going to give you."
- AC1: Every clip is vertical 1080×1920, 20–45 seconds unless a skill says otherwise, with a 6–8 word text hook,
  burned-in captions and a cover image.
- AC2: Each clip runs the pre-post checklist from the enabled skills (section D of the built-in playbook) and shows
  every item as pass or fail. A failing clip gets one fix pass or is replaced by a spare moment.
- AC3: Each clip has a caption for every platform: YouTube title and description, Instagram, Facebook, TikTok and X.

### BR-06 Attach skills in Settings
"I should be able to attach skills in the settings of this application."
- AC1: The owner can upload a `SKILL.md` file (≤ 1 MB) or a `.zip` that contains one `SKILL.md` (≤ 20 MB).
- AC2: The skill's name and description are read from its frontmatter and listed in Settings › Clip making › Skills.
- AC3: Each skill can be turned on and off; owner skills can be deleted; built-in skills can only be turned off.
- AC4: The next job uses every enabled skill, with no redeploy.
- AC5: The owner can read any skill's content in the app.

### BR-07 Review clips in the app
"Send me those clips in the app. So the app will showcase the clips."
- AC1: A Review screen lists every clip waiting for a decision, newest job first, with a badge count in the navigation.
- AC2: Each clip plays in place (vertical player), and shows its hook, moment type, score, source timestamp (with a
  link to that point in the source when there is one), checklist and captions.
- AC3: Captions can be edited before confirming.

### BR-08 Confirm each clip before anything is posted
"If I click confirm on each video, then you will upload each video to those social media accounts."
- AC1: Nothing is ever posted without the owner pressing **Confirm** on that clip.
- AC2: Confirm creates one post per enabled platform and queues it for publishing.
- AC3: **Decline** removes the clip and deletes its video files. It is offered with an 8-second Undo first (UX-13 AC7);
  the request is sent only when the Undo window passes.
- AC4: Confirm and Decline (once its Undo window has passed) are final for that clip and each shows clear feedback.

### BR-09 Publish confirmed clips to the connected accounts (phase 2)
Upload to X, Meta (Facebook and Instagram) and YouTube; TikTok is added because the existing Clip Factory and its
legal pages already cover it.
- AC1 (phase 1): Confirmed posts are stored with status `pending_integration` and the app says "Waiting for the account connection".
- AC2 (phase 2): A queued post is uploaded through the platform's official API and gets its public URL.

### BR-10 Connect social accounts (phase 2)
"This is a process to connect the social media accounts, of course. But we're gonna hold off that for now."
- AC1 (phase 1): Settings › Posting › Accounts lists YouTube, Instagram, Facebook, TikTok and X as "Not connected"; the Connect
  button explains that connecting arrives in the next phase (`501 not_implemented`).
- AC2 (phase 2): Each platform connects through its official sign-in (OAuth), tokens are stored in AWS Secrets Manager.

### BR-11 48-hour performance check feeding learnings
From "2 days after we've uploaded to the social media on the clips" (see interpretation I-01).
- AC1: When a clip is posted, its clip flow waits 48 hours (a durable wait that costs nothing while waiting) and then
  checks every post of that clip.
- AC2: The check stores views, likes, comments and shares on the post through the same stats refresh as BR-20, so it
  never goes over a platform's limit (phase 2 for real numbers).
- AC3: Claude distils one short learning from the owner's recent posts; the agent receives the latest 10 learnings
  on every job.
- AC4: The Insights screen lists the learnings and the posts with their numbers.
- AC5: After the check the clip is remembered with its numbers in the learning memory (NFR-14), so later jobs and the
  review screens can find it.

### BR-12 Job control
- AC1: The owner can cancel a queued or running job.
- AC2: A failed or cancelled job can be retried from the beginning; an already downloaded source is reused.
- AC3: A job whose agent stops responding is marked failed within 15 minutes of its last heartbeat with the message
  "The agent stopped responding. Press Retry." (job-flow callback heartbeat timeout, no scanning watchdog)

### BR-13 Settings
- AC1: Settings holds clip range, the longest source length to process (`maxSourceHours`, 1–12, default 6), sound
  on/off, the click sound and the error sound, reduce motion, the platforms to post to, skills, accounts and an
  optional YouTube `cookies.txt`.
- AC2: These settings are saved to the account (`PUT /v1/settings`), so they follow the owner across devices. The
  background picture is the one exception: it stays on the device (BR-14).
- AC3: Every setting has exactly one place in the Settings tree (UX-14,
  [CONTRACTS.md §15](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16)):
  Clip making (Clips, Skills, YouTube help), Posting (Accounts, Where clips go), Look & feel (Sounds, Motion,
  Background), App & account (Get the app, Updates, Account).
- AC4: `clickSound` and `errorSound` are whole numbers from 1 to 30. `PUT /v1/settings` refuses anything else with a
  plain message (400). Settings saved before they existed read as the defaults, 6 and 5.
- AC5: The owner's picks are the defaults for everyone: click sound 6 "Water drop", error sound 5 "Nope nope nope".

### BR-14 Background of the owner's choice
From "I should be able to see the background of my phone image" (see interpretation I-02).
- AC1: The owner can pick a background image in Settings; the glass surfaces show it through them. The image stays
  on that device (it is a personal look, not account data).
- AC2: Without an image the app shows its own soft animated sage, off-white and tomato backdrop.

### BR-15 Get the app, matched to the device
Added after the first build ([CONTRACTS.md §12.1](CONTRACTS.md#121-get-the-app-sidebar-item-on-phones-a-card-in-settings-plus-a-one-time-banner-on-home)).
"When I use the app through the browser, there should be a feature in the sidebar to download it to the machine ...
it should basically recommend the operating system ... if it's a Mac, then it should be a DMG file ... if it's on
Windows ... an exe file."
- AC1: From 768 px up, the sidebar has a **Get the app** item. On phones it is the **Settings › App & account › Get the app**
  branch plus a one-time banner on Home (the phone tab bar keeps its five items).
- AC2: The app detects the device (Mac, Windows, Linux, ChromeOS, Android, iPhone or iPad) and shows **one** big button
  for it, in plain words:

  | Device | Main button | Second choice |
  |---|---|---|
  | Mac | "Download for Mac" → `/downloads/Clip-Factory.dmg` | "or install from this browser" |
  | Windows | "Download for Windows" → `/downloads/Clip-Factory-Setup.exe` | "or install from this browser" |
  | Linux, ChromeOS | Install from the browser (Linux also gets the `.AppImage` when one is listed) | – |
  | Android | "Install app" (the browser's own install prompt) | picture steps: menu ⋮ → Install app |
  | iPhone, iPad | three picture steps: Share icon → "Add to Home Screen" → Add (no download button) | in Chrome, Firefox and others: "Open this page in Safari first" |

- AC3: Which desktop files exist is read from `/downloads/manifest.json`. When the file for this device is missing,
  the card offers the browser install instead. A download button never leads to a missing file.
- AC4: The Mac and Windows cards show a one-line hint for the first open of an unsigned app (see NFR-11).
- AC5: The file size is shown next to the download button ("Download for Mac · 9 MB").

### BR-16 Never offer the app once it is installed
"Once you actually download it, then it should not show you that part of the application to install it again."
- AC1: Get the app (sidebar item, the Settings branch and Home banner) is hidden when the app runs installed: the browser
  reports `display-mode: standalone` or `window-controls-overlay`, iOS reports `navigator.standalone`, or the desktop
  app is detected (`window.__CF_DESKTOP__` or `ClipFactoryDesktop` in the user agent).
- AC2: After the browser's `appinstalled` event the device remembers it (`cf.installed=1`) and stops offering the app
  in that browser too.
- AC3: "Not now" on the Home banner hides it for 30 days on that device. The sidebar item and the Settings branch stay
  available until the app is installed. Once installed, the branch leaves the Settings tree and search; its old
  address says "You already have the app." with a Back button, so a saved link is never a dead end.

### BR-17 Update bar: what is new, and a Reload button
"For every single update that I make ... I should have a reload button in the bottom of the page ... And there should
be a brief word of the area where a new feature has been modified ... 'settings profile picture' or just 'profile picture'."
- AC1: Every deploy publishes `/version.json` with the version, the build time and up to three **area labels**.
- AC2: The app compares that version with its own on start, every 5 minutes, when it comes back to the screen, and
  when the service worker finds a new version. When they differ, a glass bar slides up at the bottom of the page
  (above the phone tab bar), in the browser and in installed apps alike.
- AC3: The bar shows a sparkle, the area labels as small pills (for example `Settings · Profile picture`) and a tomato
  **Reload** button. No sentences, no version numbers, no technical words.
- AC4: Each label is 1–3 words; there are at most 3. They come from the `Area:` lines in the commits since the last
  deploy, else from the folders that changed, else "Improvements"; the very first deploy says "First release"
  ([GIT_WORKFLOW.md](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)).
- AC5: "Later" hides the bar until the next check.

### BR-18 "Like clips that did well" while reviewing
- AC1: Review and Library show, under a clip, up to 5 of the owner's own clips that were posted and measured and are
  most like it, each with cover, hook and views.
- AC2: The strip is hidden when there are none (today, until posting exists) and never shows an error.
- AC3: A clip thrown away is removed from this memory.

### BR-19 See how a clip did on each platform
"I will see which ones get most views and how many views they get and what the status is from each social media
platform ... so that I can click on any video and see how they performed for each social media platform."
([CONTRACTS.md §16](CONTRACTS.md#16-clip-performance-stats-refresh-and-weekly-best-owner-request-2026-11-16),
[the page](UX_DESIGN_SYSTEM.md#clip-performance-page))
- AC1: Tapping any clip in Library opens its performance page at `/clips/{clipId}`. On Review, a kept clip's card
  shows "See how it does", which opens the same page. Back returns to where the owner came from (else Library).
- AC2: The page always shows five platform stacks, in this order: YouTube, TikTok, Instagram, Facebook, X. Each stack
  shows its status in plain words: Posted, Posted privately, Waiting for connection, Posting, Failed or Not posted.
- AC3: Each stack shows only the numbers that platform really gives (YouTube: views, likes, comments, and daily
  insights such as watch time; TikTok: views, likes, comments, shares; Instagram: likes, comments, and views, reach,
  saves and watch time that can take 2 days; Facebook: plays, reactions, watch time; X: video views, impressions,
  likes, reposts, replies, bookmarks). A number the platform did not return is left out, never shown as 0.
- AC4: The top of the page shows the total views across platforms with the note "(each app counts views its own
  way)", and the platform with the most views carries a crown.
- AC5: Each stack shows when its numbers were last checked ("Updated 3 min ago"), a small views-over-time line once
  there are two or more readings, and an "Open on {Platform}" link to the post.
- AC6: A stack with no numbers is calm, never red (except Failed), and says what to do: connect the account, turn the
  platform on, wait, or press Try again on Review.
- AC7: A clip still in review, a thrown-away clip, or another owner's clip gives "This clip has no numbers yet. Keep it
  first." with a way back.

### BR-20 Numbers that refresh by themselves, and a Refresh button
"The stats on the video for each social media platform should be a API call where I can just refresh it. But also, it
should do it every 15 minutes or 30 minutes. Or whatever the lowest limit is for each API."
([ADR-29](DECISIONS.md#adr-29-stats-refresh-intervals-per-platform),
[ADR-30](DECISIONS.md#adr-30-one-eventbridge-rule-and-a-due-queue-for-stats-polling))
- AC1: Every posted post is checked automatically: YouTube, TikTok and X every 15 minutes, Instagram and Facebook every
  30 minutes, for the first 48 hours; then every 30 / 60 minutes up to 7 days and every 2 / 6 hours up to 30 days;
  then one final reading. The intervals live in one file, `config/platforms.json`.
- AC2: YouTube's slower insights (watch time, engaged views, shares, new subscribers) are read at most every 6 hours,
  because YouTube needs 2–3 days to process them.
- AC3: The page has one tomato **Refresh numbers** button that asks every platform at once
  (`POST /v1/clips/{clipId}/stats/refresh`). New numbers appear on screen by themselves within seconds (WebSocket), and
  the button spins while they are on the way.
- AC4: A refresh never goes over a platform's limit: a platform checked moments ago answers "Next check in 4 min";
  a platform that is resting after a limit answers when it can be asked again. When every platform has to wait, the
  button reads "Next check in … min" and a tap plays the error sound with a toast saying when.
- AC5: Instagram and Facebook results carry "{Platform} numbers can take up to 2 days to settle."
- AC6: While the page is open and the live connection is down, it refetches every 60 seconds.

### BR-21 Pick the best clips of each week, so the next clips are cut better
"I should be able to select the ones for the week. So each week, I will select the ones that perform best during
that week, so that it knows how to edit better in the future."
([ADR-31](DECISIONS.md#adr-31-the-weekly-best-is-an-explicit-owner-signal), [AGENT.md](AGENT.md#best-of-the-week))
- AC1: Library has two tabs, "All clips" and "This week". This week lists the week's kept clips sorted by total views,
  each with its cover, hook, views per platform and a big **Best this week** star (≥ 48 px).
- AC2: ‹ and › arrows move between weeks (› is off on the current week). A week runs Monday to Sunday in the owner's
  own time zone; a clip belongs to the week of its first post (or, if not posted yet, the week it was kept).
- AC3: Starring and unstarring is instant and saved once, 800 ms after the last tap, with "Saved. Clip Factory will
  learn from your picks." Up to 10 picks a week. The star on the clip's performance page is the same choice.
- AC4: After a save, Claude Fable 5.1 compares the picks with the rest of that week (hooks, moment types, length,
  captions, numbers) and writes one short "Best of week" learning; the page shows "Learning from your picks…" and then
  the learning itself. If it cannot, it says "Could not learn this time. Change a pick to try again."
- AC5: The agent reads the latest 4 "Best of week" learnings first, before the other learnings, and the starred clips
  come first in "What worked before", labelled "Owner's pick: best of the week".
- AC6: Unstarring everything in a week removes that week's learning and the clips' "best" mark. Changing picks again
  replaces the learning; an older save never overwrites a newer one.
- AC7: An empty week says "No clips this week yet. Make clips on Home." with a link.

---

## Non-functional requirements

### NFR-01 Everything runs on AWS
- AC1: Web hosting, API, agent, storage, database, scheduling and sign-in are all AWS services in one account.
- AC2: The owner's computer is not needed for any step.

### NFR-02 Serverless architecture
- AC1: No EC2 instances, no always-on containers, no VPC, no servers to patch: CloudFront, S3 (web, media),
  S3 Vectors, Cognito, API Gateway (HTTP, WebSocket and REST APIs), Lambda (plain and durable functions), DynamoDB
  with Streams, SSM Parameter Store, one EventBridge rule (the stats tick, BR-20), AgentCore Runtime, Bedrock,
  Transcribe, CloudWatch and SNS.
- AC2: Idle cost is close to zero (pay per request and per stored byte). Services with a standing minimum charge are
  not deployed (OpenSearch Serverless, [ADR-25](DECISIONS.md#adr-25-s3-vectors-for-the-learning-memory-opensearch-not-deployed)).
- AC3: "The entire infrastructure should be serverless, meaning CloudFront, S3 buckets, DynamoDB, OpenSearch if we're
  using that, S3 vectors, API gateway, WebSockets, HTTP, REST API on those API gateways, and Lambda, and durable
  functions in Lambda." Each of these is used for a real job (OpenSearch is shown as an option, not deployed), see
  [ARCHITECTURE.md](ARCHITECTURE.md#services-and-why-each-one).
- AC4: All backend code is Python and all infrastructure is Terraform ([ADR-26](DECISIONS.md#adr-26-python-for-every-backend-terraform-for-every-resource-serverless-only)).

### NFR-03 Model: Claude Fable 5.1
- AC1: The agent and every Claude call use Claude Fable 5.1 through the global cross-region inference profile
  `global.anthropic.claude-fable-5-1`.
- AC2: The model id lives only in `config/models.json`.

### NFR-04 Infrastructure as code, set up completely
- AC1: Every AWS resource is defined in Terraform under `infra/`; nothing is created by hand except the OIDC deploy role.
- AC2: A first deploy into an empty account creates the whole system, including the owner's user.

### NFR-05 CI/CD
- AC1: Every push and pull request runs lint, type checks, tests and a Terraform validation (`ci.yml`).
- AC2: Every push to `main` deploys production (`deploy.yml`) through a GitHub OIDC role; no long-lived AWS keys.
- AC3: The owner supplies only `CF_DEPLOY_ROLE_ARN` (variable) and `CF_OWNER_EMAIL` (secret).

### NFR-06 Sign-in with Cognito, about once a month
"Make sure that the access token is refreshed every 15 minutes, but the refresh token should be refreshed every month."
- AC1: Access and ID tokens last 15 minutes and refresh silently.
- AC2: The refresh token lasts 30 days and is rotated on every refresh, so an owner who uses the app stays signed in.
- AC3: After 30 days without using the app, the owner signs in again.

### NFR-07 Robustness
- AC1: A failed step is shown with a plain reason and a Retry button.
- AC2: Stuck jobs are detected by the job flow's callback heartbeat timeout; publishing retries inside the clip flow
  and marks only the failing post `failed`; failed or timed-out durable executions raise an alarm.
- AC3: Data is protected by DynamoDB point-in-time recovery; clips are kept until declined.

### NFR-08 Git workflow
"Create features in separate feature branches ... merge them automatically ... delete the feature branches afterwards."
- AC1: Work lands through feature branches and pull requests into `main`.
- AC2: A pull request merges automatically once CI is green, without the owner's approval.
- AC3: The branch is deleted after the merge. See [GIT_WORKFLOW.md](GIT_WORKFLOW.md).

### NFR-09 Documentation
- AC1: Business requirements, architecture, agent, design system, deployment, security, testing, decisions, roadmap and
  git workflow each have their own markdown file in `docs/`.
- AC2: A draw.io architecture diagram with native AWS icons lives at `docs/architecture/aws-architecture.drawio`,
  in the style of the owner's reference diagram.

### NFR-10 Keep the legal pages
- AC1: `index.html`, `privacy.html`, `terms.html`, `style.css` and `.nojekyll` stay at the repository root for GitHub Pages.

### NFR-11 Desktop app builds
The Mac and Windows downloads in BR-15 come from a thin desktop app ([CONTRACTS.md §12.3](CONTRACTS.md#123-desktop-wrapper-desktop-tauri-v2),
[ADR-18](DECISIONS.md#adr-18-a-thin-tauri-desktop-wrapper-not-electron)).
- AC1: The desktop app is a native window that opens the live web app (`app_url`); it bundles no copy of the screens,
  so every web deploy reaches it at once through the update bar (BR-17).
- AC2: Window title "Clip Factory", the app icon, minimum size 380 × 600, size and position remembered, outside links
  open in the normal browser.
- AC3: `deploy.yml` builds it on GitHub's macOS runner (one universal `.dmg` for Apple silicon and Intel) and Windows
  runner (an installer `.exe`), uploads both to `downloads/` in the web bucket and rewrites `downloads/manifest.json`.
- AC4: It is rebuilt only when `desktop/` or the app icon changes, or when a file is missing from the bucket.
- AC5: Builds are unsigned for now ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)); the Get the app
  card tells the owner how to open them the first time. Signing is on the [roadmap](ROADMAP.md#later).
- AC6: A failed desktop build never breaks the web deploy; the previous files and manifest stay in place.

### NFR-12 Release labels without extra work
- AC1: The area labels in BR-17 are produced by `scripts/release-areas.sh` during the deploy, from commit `Area:`
  lines, then the folder map `web/areas.json`, with no manual release notes.
- AC2: `/version.json` and `/downloads/manifest.json` are never cached (by CloudFront or the service worker), so a new
  version is noticed within 5 minutes.

---

### NFR-13 Live updates
"API gateway, WebSockets."
- AC1: While the app is open and connected, a change to a job, clip, post, learning or week's picks appears on screen within about
  2 seconds of being written, without a refresh.
- AC2: Only the signed-in owner's own changes are sent, in the same shape as the HTTP API; internal fields never reach
  the browser.
- AC3: The connection is opened with the owner's access token, which is never written to any log.
- AC4: A dropped connection is invisible to the owner: the app reconnects by itself (1 s up to 30 s apart), refetches
  what is on screen, and polls while disconnected. No error message is shown for it.
- AC5: Without a live connection (mock mode, old config) the app works exactly as before with polling.

### NFR-14 Learning memory
"S3 vectors."
- AC1: Every clip the agent makes is stored as a vector of its text (moment type, hook, title, summary) with the
  owner's id, status, platforms and score band.
- AC2: Before choosing moments, the agent receives up to 8 of the owner's posted and measured clips most like the new
  source ("What worked before"), as advice, never as a rule.
- AC3: 48 hours after posting, the clip's memory is updated with its numbers.
- AC4: If the memory cannot be read or written, jobs and screens carry on without it.
- AC5: The memory has no standing cost (pay per request and per stored vector).
- AC6: Clips the owner starred as best of the week are marked `best` in the memory and are offered to the agent
  first (BR-21).

### NFR-15 Durable workflows
"Lambda, and durable functions in Lambda."
- AC1: The job workflow (start agent, wait, finish or fail) and the clip workflow (posts, publish, wait 48 hours,
  metrics, learning, memory) each run as one Lambda durable function, written in Python.
- AC2: Starting a workflow twice for the same job run or clip run never runs it twice.
- AC3: Waiting (for the agent, for 48 hours) uses no compute; no queue, schedule or scanning job is needed.
- AC4: A deploy never changes a workflow already in flight.

### NFR-16 Public webhook endpoint
- AC1: Platforms reach `{hooks_url}/hooks/{platform}` and `{hooks_url}/oauth/{platform}/callback` on a separate REST
  API, so the app's own API accepts only the owner's token.
- AC2: The endpoint is throttled (10 requests a second, burst 20), stores events for 14 days, and never logs query
  strings (OAuth codes).
- AC3: Meta and YouTube verification challenges are answered today; TikTok and X answer "not implemented" until phase 2.

### NFR-17 Stay inside every platform's limits and costs
"Whatever the lowest limit is for each API."
([CONTRACTS.md §16.4](CONTRACTS.md#164-configplatformsjson-read-by-terraform-and-by-the-code-copied-into-the-zip))
- AC1: The automatic refresh and the Refresh button share one budget per platform, kept in DynamoDB and reserved with
  one conditional write before every request, so two refreshes at once can never go over a limit together.
- AC2: YouTube: at most 7,000 of the 10,000 daily quota units are used for numbers (3,000 stay for uploads); a quota
  error pauses YouTube until the quota resets (08:00 UTC).
- AC3: TikTok: at most 300 requests a minute (the limit is 600); a "rate limit exceeded" answer pauses it for a minute.
- AC4: Instagram and Facebook: the `X-Business-Use-Case-Usage` header is read after every call; at 75 % of any
  counter, or on a throttle error (80002, 80001), the platform pauses for at least the time Meta gives, and a throttled
  call is never retried (retrying makes Meta's block longer).
- AC5: X: at most 1,000 requests per 15 minutes (the limit is 3,500), and an estimated spend cap of **$10 a month**;
  re-reading the same post on the same UTC day counts as free. At the cap, X pauses until the next month, and Settings ›
  Posting › Accounts says so in one line.
- AC6: Batches use each platform's largest request size (YouTube 50 ids, TikTok 20, Instagram and Facebook 50, X 100).
- AC7: Only metrics the platforms still support are read: never Meta `impressions`, `plays`, `post_impressions_unique`
  or `total_video_impressions*`; X video views come from the video's own `view_count`, never from impressions.
- AC8: Platform tokens never reach DynamoDB, logs or responses; no request is made for a platform without a connected
  account (phase 1: no request at all).
- AC9: An expected failure (limits, a deleted post, an expired token) never stops the poller and never repeats in a
  tight loop: the post waits its normal interval and shows the reason in plain words.

---

## Design and experience requirements

### UX-01 Colours
- AC1: Primary call-to-action buttons are tomato red `#E8412C`, every one of them.
- AC2: The rest of the palette combines sage `#9CAF88` and off-white `#F7F5EF`, with ink `#1E2A1B` for text.

### UX-02 Liquid glass everywhere
"I want them to be liquid glassy so that you can almost see through the application."
- AC1: Every surface (cards, bars, sheets, dialogs, inputs) is translucent with backdrop blur and a light edge highlight;
  no solid panels.
- AC2: Text on glass meets WCAG AA contrast (4.5:1 for body text) on the default backdrop.
- AC3: Where `backdrop-filter` is not supported, surfaces fall back to a more opaque tint that stays readable.

### UX-03 Layout inspired by the reference site
"Take inspiration from that, how it's all placed and in a cohesive manner."
- AC1: Large serif italic headline on a sage hero card, pill buttons, cards in a row, a stat block.
- AC2: The person in the reference image is not used; only the layout, colours and feel are.

### UX-04 Fonts: Inter and Times
- AC1: Display headlines use Times New Roman (fallback Tinos, then serif), often italic.
- AC2: Everything else uses Inter.

### UX-05 Nothing overflows its box
"The text is running out of the box ... Make sure to never let that happen."
- AC1: No text or image crosses the edge of its container at any width from 320 px up.
- AC2: Automated Playwright tests check every screen at phone, tablet and desktop widths.

### UX-06 Phone navigation: icons only
- AC1: Below 768 px wide, a bottom glass tab bar shows icons only (no words), each with an accessible label.
- AC2: Tap targets are at least 48×48 px (raised from 44 by UX-13); the bar respects the phone's safe area.

### UX-07 Desktop navigation: collapsible sidebar
- AC1: From 768 px up, a left glass sidebar with icons and names.
- AC2: A hamburger button (three stripes) collapses it to icons only; the choice is remembered.

### UX-08 Pleasant, "dopamine" feedback
- AC1: Key moments celebrate: Confirm, a job finishing, a skill added. Ordinary clicks do not.
- AC2: Motion is short (under 400 ms for feedback) and respects "reduce motion" (system or app setting).

### UX-09 Two click sounds, never on scroll
- AC1: Clicking an enabled control plays the owner's **click sound** (default 6 "Water drop").
- AC2: Clicking a disabled control, an error toast, or a failed action plays the owner's **error sound** (default
  5 "Nope nope nope"), which sounds clearly different.
- AC3: Scrolling, swiping or dragging on a phone never makes a sound (sounds are tied to the `click` event only).
- AC4: Sounds can be turned off in Settings › Look & feel › Sounds.
- AC5: Changing the pick in Settings changes the sound everywhere in the app at once, with no reload.

### UX-10 Phone, browser and desktop install
- AC1: The app works in any modern browser on phone and computer.
- AC2: It installs as a PWA on the phone home screen and on the desktop (Chrome, Edge, Safari).
- AC3: On Mac and Windows it can also be downloaded as a desktop app (BR-15, NFR-11).

### UX-11 Plain English
- AC1: Every label, message and error is a plain sentence a non-technical owner understands.

### UX-12 Reload that feels fast and fun
"Once you click reload, there should be a nice UI to where it goes fast to 80% or to 70%, and then it's almost like
it's slow in and slow out, but in the middle, it's really quick ... so that the user's dopamine is still being hit."
- AC1: Pressing Reload turns the bar into a progress bar that runs from 0 to 75 % in about 0.8 s on an ease-in-out
  curve: a soft start, a quick middle, a soft landing ([the curve](UX_DESIGN_SYSTEM.md#the-reload-curve)).
- AC2: While the new version installs (service worker update, fresh files), the bar keeps creeping forward slowly; it
  never stops dead and never goes backwards.
- AC3: When the new version is ready, it eases to 100 %, a small sparkle plays, and the page reloads by itself.
- AC4: After 10 seconds it reloads anyway, so the bar can never hang.
- AC5: With reduce motion on, the bar simply fills, with no sparkle.

### UX-13 Kid-proof: a 6–8-year-old can use it
"The entire application should be idiot proof. So even a 6-year-old should be able to use it, or an 8-year-old."
([CONTRACTS.md §12.4](CONTRACTS.md#124-kid-proof-ux-a-68-year-old-must-manage-it), [checklist](UX_DESIGN_SYSTEM.md#kid-proof-checklist))
- AC1: Every screen has one obvious next step: exactly one tomato button (the update bar's Reload is the only extra).
- AC2: Tap targets are at least 48 × 48 px on phones.
- AC3: Buttons show an icon **and** a word (the phone tab bar is the one icon-only place, UX-06).
- AC4: Words are short and everyday: "Make clips", "Keep", "Throw away", "Try again". No jargon on screen.
- AC5: Empty screens say exactly what to tap ("Nothing here yet. Tap **Make clips** to start.").
- AC6: No dead ends: every screen has a way forward or back, and every error says what to do next.
- AC7: Throwing something away shows a toast with **Undo** for 8 seconds instead of an "Are you sure?" dialog; the
  action is only carried out when the 8 seconds pass.
- AC8: Forms cannot be filled in wrong: a Paste button next to the link box, the link checked as it is typed, hints
  right under the field, and the main button only active when the input is valid (a click on it before then plays the
  deny sound and points at what is missing).
- AC9: Progress is always visible while something is happening, and success is celebrated (UX-08).

### UX-14 Settings organised like a field of apple trees
"There is a field which is the entire settings, then we have apple trees which has multiple trees, and each tree has
multiple branches, and each branch has multiple apples, but they also have leaves ... so that it is all organized."
([CONTRACTS.md §15.1](CONTRACTS.md#15-settings-as-a-tree-and-choosing-your-click-sounds-owner-request-2026-11-16),
[Settings tree](UX_DESIGN_SYSTEM.md#settings-tree))
- AC1: Settings (the **field**) opens on four **trees**: Clip making, Posting, Look & feel, App & account. Each tree
  holds **branches**; each branch holds **apples** (the things you change), each with a **leaf** (one short line of
  help) unless its name already says it all. No setting sits loose outside a branch.
- AC2: Every tree and branch has its own address (for example `/settings/look-and-feel/sounds`). Opening that address
  directly, reloading, the browser's Back button and bookmarks all land on the same place. The old addresses
  (`/settings#skills` style anchors, `/get-app`, `/settings?account=…&status=…`) keep working.
- AC3: Every tree and branch page shows a breadcrumb (`Settings › Look & feel › Sounds`), each part a link. On phones a
  big Back button goes one level up.
- AC4: Below 1024 px wide, Settings drills down one level at a time. From 1024 px, a folder panel on the left shows the
  whole tree: trees open and close like folders, the current branch is highlighted, and which folders are open is
  remembered on that device.
- AC5: A **Find a setting** box on the Settings page searches every apple, leaf, tree and branch name while you type.
  Picking a result opens its branch, scrolls to it and highlights it. No match says "No setting called that. Try
  another word."
- AC6: The tree, the folder panel and search are kid-proof (UX-13): at most one tomato button per screen, 48 px
  targets on phones, plain words, nothing overflows from 320 px, and everything works with a keyboard and a screen
  reader.

### UX-15 Pick your click and error sounds
"Include this entire page in the Clip Factory to allow the ... user of the application to select the normal click and
the error clicks. And I actually like the UI ... and the UX." The owner's picks: "Tap sound: 6 Water drop. Error
sound: 5 Nope nope nope." ([CONTRACTS.md §15.3](CONTRACTS.md#153-sounds), [the picker](UX_DESIGN_SYSTEM.md#the-sounds-branch-the-picker))
- AC1: Settings › Look & feel › Sounds shows the owner's sound picker: 30 numbered click sounds ("When it works") and
  30 numbered error sounds ("When it can't"), each card with its number, name and feel, the same names and sounds as
  the picker page the owner tried.
- AC2: Tapping a card plays its sound and makes it the pick (a "Pick" badge, `aria-pressed`). One pick per group.
- AC3: "Try it: Sign in" plays the click sound with a "Signed in" toast; with **Make it fail** on, it plays the error
  sound with a small shake and "Wrong password. Try again." Nothing is really signed in or out.
- AC4: A pick saves at once and follows the owner to every device; if the save fails, the pick goes back and the app
  says so in plain words.
- AC5: New accounts, and accounts that never picked, use click sound 6 "Water drop" and error sound 5 "Nope nope nope".
- AC6: With Sounds off, the cards say "Sounds are off" with a "Turn sounds on" button, and tapping a card picks it
  without playing anything.
- AC7: The sounds are defined as data (one catalog entry per sound) and played by one player; numbers never change
  meaning, so a saved pick always plays the same sound.

### UX-16 The performance page: the video on top, smooth lines to five stacks
"It should be quite a nice design actually. So we should have the video on top, like the preview of it, the thumbnail
of it, and then there's like ... lines that go, in a smooth manner, leading to each vertical stack of information ...
So maybe 5 lines ... for both the phone resolution and the normal laptop's resolution or PC ... monitors."
([anatomy per screen size](UX_DESIGN_SYSTEM.md#clip-performance-page))
- AC1: The clip's 9:16 video sits on top, centred in a rounded glass frame, with its cover as the poster; it never
  plays by itself.
- AC2: Five smooth curved lines grow out of the bottom of the video, one to the top of each platform stack. They draw
  in once, one after another (80 ms apart, 900 ms each), and the stacks rise in as their line arrives. The best
  platform's line is tomato, the others sage. With reduce motion (system or app setting) the lines are simply there.
- AC3: Laptops and monitors (≥ 1024 px): five equal columns side by side, the lines fanning out from the video and
  ending exactly at the top centre of each stack.
- AC4: Tablets and small laptops (600–1023 px): three stacks in the first row, two in the second, the second-row lines
  running straight down the gaps between the first-row cards, never over a card.
- AC5: Phones (< 600 px): one column of full-width cards; one trunk line runs from the video down the left edge, and a
  small curved branch leads into each card.
- AC6: Nothing overflows at any width from 320 px; numbers never get cut off; labels wrap.
- AC7: Kid-proof (UX-13): the only tomato button is **Refresh numbers**; the **Best this week** star is a big sage
  toggle; every state has words; the page works with a keyboard and a screen reader (the lines are decoration and are
  hidden from screen readers; each stack is a labelled section).

---

## Interpretations and open questions

| Id | The brief said | What we built | Open? |
|---|---|---|---|
| I-01 | "I should also be able to, 2 days after we've uploaded to the social media on the clips" (sentence not finished) | A 48-hour performance check per post that reads its numbers and turns them into learnings for the next jobs (BR-11). | Confirm this is what was meant. |
| I-02 | "I should be able to see the background of my phone image instead of the actual solid color" | A web page cannot see the phone's wallpaper; browsers do not expose it. The glass shows the app's animated backdrop, or a background image the owner picks in Settings (BR-14). | No. |
| I-03 | "Run this whole thing on Claude Fable 5.1" | Bedrock model `anthropic.claude-fable-5-1` through the global cross-region profile (NFR-03, [ADR-02](DECISIONS.md)). | No. |
| I-04 | "X, Meta (Facebook and Instagram), and YouTube" | Those four plus TikTok, because the existing app and legal pages cover TikTok. The owner can turn any platform off in Settings. | No. |
| I-05 | "Clip it up into 5 videos or 10 videos ... anything between" | A range 5–10 by default, changeable in Settings (BR-04). | No. |
| I-06 | "A Twitch stream, or a Kick stream" | Past broadcasts (VODs) and clips. A live stream that is still running is processed up to the moment the job starts. | Is clipping a live stream as it happens wanted later? |
| I-07 | "I don't care about security at all" | Convenience first (long sessions, no MFA, auto-merge), but data stays private and the account stays protected ([SECURITY.md](SECURITY.md)). | No. |
| I-08 | "I'm going to give you the OIDC role later" | Deploys need `CF_DEPLOY_ROLE_ARN`; until it is set, the deploy workflow stops with a clear message ([DEPLOYMENT.md](DEPLOYMENT.md)). | Waiting for the role. |
| I-09 | "Download it to my desktop" | First build: installable PWA (UX-10, [ADR-11](DECISIONS.md#adr-11-installable-pwa-for-phone-and-desktop)). After the owner asked for a `.dmg` and an `.exe`: a thin desktop app as well (BR-15, NFR-11, [ADR-18](DECISIONS.md#adr-18-a-thin-tauri-desktop-wrapper-not-electron)). | No. |
| I-10 | YouTube downloads from the cloud | YouTube may block requests from AWS addresses. The owner can add a `cookies.txt` in Settings, or upload the file instead ([ARCHITECTURE.md](ARCHITECTURE.md#limits)). | Watch after the first deploys. |
| I-11 | Custom domain | Not mentioned; the app uses its CloudFront address for now ([ROADMAP.md](ROADMAP.md)). | Does the owner want a domain? |
| I-12 | "If it's on the iPhone, I'm not sure" | Apple allows no app download outside the App Store (and, in the EU, outside approved marketplaces), so iPhone and iPad get three picture steps to add the web app to the Home Screen (BR-15, [ADR-21](DECISIONS.md#adr-21-iphone-and-ipad-get-add-to-home-screen-steps-not-a-download)). | No. |
| I-13 | "A brief word of the area ... 'settings profile picture' or just 'profile picture'. That's it." | 1–3 word labels, at most three, written as `Area:` lines in commits, with a folder map as the fallback (BR-17, [ADR-20](DECISIONS.md#adr-20-update-labels-from-area-commit-lines-then-a-folder-map)). | No. |
| I-14 | "Even a 6-year-old should be able to use it" | Concrete, testable rules (UX-13) and everyday words on screen: Confirm reads "Keep", Decline reads "Throw away", New job reads "Make clips". The API and these documents keep their technical names. | No. |
| I-15 | "Once you click reload ... it goes fast to 80% or to 70%" | 75 % in about 0.8 s on an ease-in-out curve, then a slow creep until the new version is ready, then ease to 100 % (UX-12). | No. |
| I-16 | "OpenSearch if we're using that, S3 vectors" | S3 Vectors holds the learning memory (NFR-14). OpenSearch Serverless is not deployed because it bills a standing minimum even when idle; it is shown dashed in the diagram as an option ([ADR-25](DECISIONS.md#adr-25-s3-vectors-for-the-learning-memory-opensearch-not-deployed)). | Only if keyword search is wanted later. |
| I-17 | "WebSockets, HTTP, REST API on those API gateways" | Three APIs, each with one job: HTTP API for the app, WebSocket API for live updates, REST API for platform webhooks (NFR-13, NFR-16). | No. |
| I-18 | "Durable functions in Lambda" | Two durable functions replace the queue, the scheduler, the publisher, the perf-check and the watchdog (NFR-15, [ADR-22](DECISIONS.md#adr-22-lambda-durable-functions-for-the-job-and-clip-workflows)). | No. |
| I-19 | "Python for backend ... Terraform for the infrastructure as code" | Already the case; recorded as [ADR-26](DECISIONS.md#adr-26-python-for-every-backend-terraform-for-every-resource-serverless-only). The web app (TypeScript) and desktop wrapper (Rust) are front end. | No. |
| I-20 | "A field ... apple trees ... branches ... apples, but they also have leaves" | Field = all of Settings, trees = four big groups, branches = sections, apples = the settings you change, leaves = their one-line help (UX-14). The "multiple trees" are the four trees; the field is the Settings page itself. | Are four trees the right split? |
| I-21 | "Include this entire page ... select the normal click and the error clicks" | The whole sound picker (both groups of 30, Try it with Make it fail) becomes the Sounds branch, in the app's glass style (UX-15). "Tap sound" and "error sound" are called **Click sound** and **Error sound** on screen. | No. |
| I-22 | Get the app inside the tree | Get the app moves into App & account and, like the sidebar item, disappears once the app is installed (BR-16). | No. |
| I-23 | "There's like 4 lines ... So maybe 5 lines" | Five lines, one per platform the app posts to: YouTube, TikTok, Instagram, Facebook, X (UX-16). | No. |
| I-24 | "Every 15 minutes or 30 minutes. Or whatever the lowest limit is for each API" | The safe floor per platform, not the hard limit: 15 min for YouTube, TikTok and X, 30 min for Instagram and Facebook (whose numbers settle over 2 days anyway), slower as a post ages, for 30 days (BR-20, [ADR-29](DECISIONS.md#adr-29-stats-refresh-intervals-per-platform)). | Is 30 days of refreshing long enough? |
| I-25 | "What the status is from each social media platform" | The posting status per platform (Posted, Posted privately, Waiting for connection, Posting, Failed, Not posted) next to its numbers (BR-19 AC2). | No. |
| I-26 | "Select the ones that perform best during that week" | The owner stars them by hand (up to 10 a week); the app sorts by views to help, but never picks for the owner, because each app counts views differently and the owner's taste is the signal ([ADR-31](DECISIONS.md#adr-31-the-weekly-best-is-an-explicit-owner-signal)). | Should the app suggest picks later? |
| I-27 | "So that it knows how to edit better in the future" | The picks shape **which moments are chosen and how they are hooked and captioned** (a "Best of week" learning and "best" clips first in "What worked before"). Editing itself (cuts, layout) follows the skills; a clip editor is on the [roadmap](ROADMAP.md#later). | Does the owner want the picks to change editing style directly? |
| I-28 | Real numbers on TikTok | TikTok shows posts from unaudited apps only privately and gives them no numbers, so TikTok reads "Posted privately. TikTok shows numbers after the app is approved." until the app passes TikTok's audit ([ROADMAP.md](ROADMAP.md#phase-2-social-integrations)). | Waiting for TikTok's audit. |
| I-29 | X numbers cost money | X has no free tier for reading posts; reads are paid per post. The app caps its own spend at $10 a month and says so in Settings (NFR-17 AC5, [DEPLOYMENT.md](DEPLOYMENT.md#x-api-credits-for-clip-numbers)). | Is $10 a month the right cap? |

## Out of scope for this phase

- Connecting social accounts and posting to YouTube, Instagram, Facebook, TikTok and X (BR-09, BR-10 phase 2).
- Reading real post metrics (BR-11 AC2 phase 2). The clip flow's 48-hour wait, learnings and memory, the stats poller,
  the Refresh button, the performance page and the weekly best all exist; with no connected account every platform
  reads "Waiting for connection" and no platform is called (BR-19 to BR-21).
- OpenSearch Serverless (an option, not deployed).
- Whop or Content Rewards campaign reading from the local app.
- More than one user.
- A custom domain.
- Signed and notarized desktop builds, and a store listing for phones (NFR-11 AC5, [ROADMAP.md](ROADMAP.md#later)).
