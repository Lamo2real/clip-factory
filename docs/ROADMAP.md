# Roadmap

## Phase 1: the cloud platform (this phase)

Infrastructure, CI/CD, sign-in, the clip agent on AgentCore with Claude Fable 5.1, the glass web app (phone, browser,
desktop PWA), skills in Settings, review with Confirm and Decline, and the learnings loop. Confirmed clips wait as "pending integration". Added after the first build: Get the app per device,
the unsigned Mac and Windows desktop app, the update bar with area labels and the eased Reload, and the kid-proof
rules ([CONTRACTS.md §12](CONTRACTS.md#12-get-the-app-updates-and-kid-proof-ux-added-by-the-owner-after-the-first-build)).
Added by the serverless expansion ([CONTRACTS.md §14](CONTRACTS.md#14-serverless-expansion-websocket-api-rest-api-durable-functions-s3-vectors)):
two Lambda durable functions (the job flow with the agent callback, and the clip flow with publishing, the 48-hour wait
and learning) in place of the queue, scheduler and watchdog; live updates over a WebSocket API; a REST API for platform
webhooks; and the S3 Vectors learning memory ("What worked before", "Like clips that did well").
See the [README](../README.md#status) for status.

## Phase 2: social integrations

Goal: confirmed clips are posted to the owner's accounts, and their numbers flow back 48 hours later.

| Platform | Connect with | Post with | Metrics for the 48-hour check | Notes |
|---|---|---|---|---|
| YouTube (Shorts) | Google OAuth 2.0 (`youtube.upload`, `youtube.readonly`) | YouTube Data API v3 `videos.insert` (resumable upload) | YouTube Analytics API or `videos.list` statistics | Default upload quota is limited per day; request more if needed. Videos under 3 minutes in 9:16 become Shorts. |
| Instagram (Reels) | Meta Login (Facebook Login for Business) with a Professional account linked to a Facebook Page | Instagram Graph API: create a `REELS` media container from a public video URL, then publish | Media insights (plays, likes, comments, shares) | Needs a Meta app with Instagram permissions reviewed by Meta. |
| Facebook (Page Reels) | Same Meta Login | Pages API video reels upload | Video insights | Same Meta app as Instagram. |
| TikTok | Login Kit | Content Posting API (direct post) | Video query / Display API | The app must pass TikTok's audit before posts can be public. The legal pages at the repo root exist for this review. |
| X | OAuth 2.0 with PKCE | Media upload (chunked) + post creation | Post public metrics | Posting needs a paid API tier; check the current plan before building. |

Work items:
1. **Accounts screen**: Connect, Reconnect, Disconnect per platform; several accounts per platform; status and handle.
2. **OAuth callback**: `GET {hooks_url}/oauth/{platform}/callback` on the REST API already exists and redirects to
   Settings; phase 2 swaps the redirect for the code exchange. Tokens stored in AWS Secrets Manager (one secret per connected account),
   Account items in DynamoDB without tokens (`ACCOUNT#<platform>#<id>`).
3. **Platform adapters** in `api/` behind one interface: `publish(clip, caption) → url`, `metrics(post) → numbers`,
   `refresh_token()`.
4. **Publishing**: implement `publish` in each adapter; the clip flow's `publish-{platform}` steps (3 attempts,
   backoff, `postId` as idempotency key) and the 48-hour wait already exist.
5. **Metrics**: implement `metrics` in each adapter; the clip flow's `metrics`, `distil` and `upsert-vector` steps then
   produce learnings on Insights and fill the learning memory.
6. **Webhooks**: verify signatures per platform with the app secrets (`verify_signature` today returns
   `unverified`), and act on stored `HOOK#` events (for example a post removed by the platform).
7. **Token refresh**: the adapters refresh a token when a `publish` or `metrics` step finds it close to expiry (a
   durable function with a daily wait if some platform needs refreshing without use), and mark accounts
   `needs_reconnect` when refresh fails, with a banner in the app.
8. **Per-clip platform choice** at Confirm (today: every platform enabled in Settings).
9. **Undo window**: a short delay after Confirm during which the owner can take it back.

## Later

- **Scheduled posting**: choose when each clip goes out (best time per platform from the learnings).
- **Custom domain** for the app (Route 53 or another DNS, an ACM certificate in `us-east-1`, CloudFront alias).
- **Push notifications** when a job is ready (Web Push for the PWA), for when the app is closed; while it is open,
  the WebSocket already updates the screen.
- **OpenSearch Serverless** next to S3 Vectors, only if keyword or hybrid search over clips is wanted
  ([ADR-25](DECISIONS.md#adr-25-s3-vectors-for-the-learning-memory-opensearch-not-deployed)); S3 Vectors can be exported to it
  through OpenSearch Ingestion once that integration leaves preview.
- **AWS WAF** on the REST API stage if webhook traffic is ever abused.
- **Live clipping**: follow a live Twitch or Kick stream and cut clips as it happens.
- **Campaigns**: bring back the local app's Whop / Content Rewards campaign reading (rules, rates, required tags).
- **Clip editor**: adjust start and end, swap the hook, re-render one clip.
- **More sources**: X videos, Instagram and TikTok links, podcasts.
- **Cost guard**: a monthly AWS Budget with an email alert, and a per-job estimate before starting.
- **Multiple users** (sign-up, per-user quotas), if the tool is ever shared.
- **Code signing and notarization for the desktop app** ([ADR-19](DECISIONS.md#adr-19-unsigned-desktop-builds-for-now)),
  so the first open needs no extra click:
  - Mac: an Apple Developer Program membership, a "Developer ID Application" certificate, signing in the `desktop` job,
    notarization with `xcrun notarytool`, and stapling the ticket to the `.dmg`. Certificate, password and team id
    become GitHub secrets.
  - Windows: an Authenticode certificate (or Azure Trusted Signing) used by the `desktop` job to sign the installer
    and the app, which also quiets SmartScreen once the file builds reputation.
  - Then drop the first-open hint from the Get the app card.
- **Linux download**: an `.AppImage` from an `ubuntu-latest` runner, listed in `downloads/manifest.json` (the card
  already supports it).

### Not planned

- **Auto-update inside the desktop app.** Not needed: the desktop app is a window around the live website, so every
  deploy reaches it at once through the update bar. The wrapper itself changes rarely; when it does, the new `.dmg` or
  `.exe` replaces the old one in Get the app. (If it ever bundles its own screens, add the Tauri updater with signed
  update files then.)
- **A downloadable iPhone app.** Apple allows none outside its store ([ADR-21](DECISIONS.md#adr-21-iphone-and-ipad-get-add-to-home-screen-steps-not-a-download));
  Add to Home Screen gives the same full-screen app.
