## 56. Engagement and watch graph (owner request, 2026-11-27)

BR-37, ADR-112. The owner: count
engagement "as professionals do it", show how people watch from start to end,
"across all platforms", and "filter for each social media platform".

- **E1. The score.** Engagement rate by views, the way social media analysts count it: **(likes + comments + shares +
  saves) ÷ views × 100**, one decimal ("4.7%"), with one word: under 1 % Low, 1–3 OK, 3–6 Good, 6–10 Great, 10+
  Amazing. Per platform, only the numbers it really gives: YouTube likes + comments + shares; TikTok likes + comments +
  shares; Instagram likes + comments + shares + saves; Facebook reactions + comments-and-shares (one Meta number); X
  likes + replies + reposts + quotes + bookmarks. A missing number counts 0; a platform with no views is left out.
  **All** = every platform's interactions ÷ every platform's views (weighted by views). The parts sit in a fold with
  how it is counted. Nothing is weighted by kind: the plain sum is what published benchmarks use.
- **E2. The watch graph.** "How long people watch": the percent of viewers still watching from 0:00 to the clip's end.
  **All** averages the real curves, each resampled to 0–100 % of the clip and weighted by that platform's views. The
  steepest 5 % fall is marked "Most leave here · m:ss". YouTube can go above 100 % (rewatches); it is shown as given.
- **E3. Only real data.** A curve exists only where the platform sends one:
  - YouTube: Analytics `audienceWatchRatio` by `elapsedVideoTimeRatio`, one request per video with the 6-hourly
    insights (its own quota, not the Data API budget). The `yt-analytics.readonly` scope is already granted: **no
    reconnect.**
  - Facebook Reels: `video_insights.metric(post_video_retention_graph)`, a separate guarded request like reach (a
    refusal never breaks the other numbers). Same Page token: **no reconnect.**
  - Instagram: no curve in its API. Shown as markers: the average watch, and a dot at 3 s from the skip rate.
  - TikTok: no watch data in the Display API. One line says so. X: dots at 25/50/75/100 % from its playback counts.
  Platforms with no curve are never put in the All curve, and the line under the graph names the sources.
- **E4. The bar.** A pick-one bar (`<Glide>`): All, then the clip's platforms that have numbers, in STATS_ORDER. It
  filters the score and the graph. Hidden when there is only one platform.
- **E5. Stored, additive.** `Post.metrics.retention` `{points: [[x, y]...], readAt, source}`: x = percent of the clip
  (0–100), y = percent still watching, at most 101 points, sorted by x. Absent = no curve. A refresh that reads a curve
  replaces it; one that does not keeps the stored one. STAT# snapshots never carry it. `GET /v1/clips/{id}/performance`
  and the live post events pass it through `PostMetrics`. The score is worked out in the web (`lib/engagement.ts`).
- **E6. Where.** A glass section on the clip page, under the platform stacks: title, the big score and its word, the
  bar, the graph, one short line and the fold. Edge to edge on a phone; the line draws in eased (none with reduced
  motion).
