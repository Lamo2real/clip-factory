## Clip numbers and their limits

The stats poller ([ARCHITECTURE.md flow 13](ARCHITECTURE.md#13-clip-numbers-the-poller-and-refresh-numbers)) is
deployed by the same `terraform apply`: the Lambda `cf-prod-stats`, the Lambda `cf-prod-learn` and the EventBridge rule
`cf-prod-stats`. Its rate comes from [`config/platforms.json`](../config/platforms.json): the smallest
`minIntervalMinutes` (15) becomes `rate(15 minutes)`. To change an interval, a batch size or a budget, edit that one
file and push; Terraform and the code both read it ([ADR-29](DECISIONS.md#adr-29-stats-refresh-intervals-per-platform)).
With no account connected, no platform is called. A platform's numbers start once it is connected in Set up posting;
the scopes the setup asks for (listed in `config/platforms.json`, for example YouTube `youtube.readonly` and
`yt-analytics.readonly`, Instagram `instagram_manage_insights`, Facebook `read_insights`, X `tweet.read`) cover both
posting and numbers.

To pause automatic refreshing (for example while testing a platform app), disable the rule in the EventBridge console
(eu-north-1 → Rules → `cf-prod-stats` → Disable). The next deploy turns it back on. The Refresh button keeps working.

### X API credits for clip numbers

X has no free tier: posts and reads are **pay per use** ($0.015 per post, about $0.005 per post read;
the same post read again on the same UTC day is not charged again, which X calls a soft guarantee). What X needs is
part of the X setup ([SETUP_POSTING.md](SETUP_POSTING.md#x)):

1. An app in the X Developer Console (console.x.com) with OAuth 2.0 (PKCE), **Read and write**, the exact redirect URI,
   and the scopes `tweet.read`, `users.read`, `tweet.write`, `media.write`, `offline.access`.
2. **Credits** on that account (the setup says to buy the smallest amount, set a $10 spending limit and leave
   auto-recharge off). A clip posted and refreshed for its 30 days costs about $0.17 on X; ten clips a week stays near
   $7 a month.
3. The app's own guard: it counts the spend before every post and every read and stops X at **$10 a month**
   (`x.budget.monthlyUsd` in `config/platforms.json`); a post over the cap fails with "Clip Factory stopped X at your
   $10 limit this month." To change the cap, change that value (and the matching shared constant in the web app) and
   push. The X console's spending limit stays as a second fence.
