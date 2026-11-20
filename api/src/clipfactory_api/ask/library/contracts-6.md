## 6. DynamoDB (single table `cf-prod-data`, on-demand, PITR on, Streams `NEW_AND_OLD_IMAGES`)

Keys: `pk` (S), `sk` (S); GSI `gsi1` on `gsi1pk`/`gsi1sk` (projection ALL); sparse GSI `gsi2` on `gsi2pk`/`gsi2sk`
(S/S, projection ALL; only posts due for a stats poll carry these, §16.3); TTL attribute `ttl`.
`userId` is the Cognito `sub`. The stream feeds `cf-prod-broadcast` (§14.2).

| Item | pk | sk | gsi1pk / gsi1sk | Other attributes |
|---|---|---|---|---|
| Settings | `USER#{userId}` | `SETTINGS` | – | Settings fields |
| Job | `USER#{userId}` | `JOB#{jobId}` | – | Job fields + `type="job"`, `userId`, `sessionId` (AgentCore session), `heartbeatAt`, `flowRun`, `flowExecutionArn` (§14.4) |
| Job live line | `USER#{userId}` | `JOBLIVE#{jobId}` | – | `type="jobLive"`, `jobId`, `sessionId`, `step`, `text`, `detail?`, `tech?`, `since?`, `i?`, `n?`, `pct?`, `at`, `ttl` (7 days) (§31) |
| Clip | `USER#{userId}` | `CLIP#{clipId}` | `JOB#{jobId}` / `CLIP#{rank:03d}` | Clip fields (minus URLs, minus computed `totalViews`) + `type="clip"`, `userId`, `videoKey`, `coverKey`, `publishState`, `postsCreated`, `postIds` (§14.5), `flowRun`, `flowExecutionArn` (§14.5), `best`, `bestWeek` (§16) |
| Connection | `USER#{userId}` | `CONN#{connectionId}` | `CONN#{connectionId}` / `CONN` | `type="conn"`, `userId`, `connectionId`, `connectedAt`, `ttl` (§14.2) |
| Hook event | `HOOK#{platform}` | `HOOK#{hookId}` | – | `type="hook"`, `platform`, `receivedAt`, `headers`, `body`, `bodyEncoding`, `signature`, `ttl` (§14.3). Twitch and Kick (§24.4): `sk = HOOK#{message id}`, written only if absent, `signature: "valid"` always |
| Follow, reverse index, creator, noticed video, follow keys, tick lease, YouTube meter | see §24.2 | | – | §24 Follow creators |
| Account snapshot, money state, reported revenue, money prefs, money owners | see §25.6 | | – | §25 Real earnings (`ACCTSTAT#` has `ttl`) |
| Skill | `USER#{userId}` | `SKILL#{skillId}` | – | Skill fields + `type="skill"`, `key` (S3, current revision, §18.1); a legacy `enabled` attribute is ignored and removed on the next write |
| Post | `USER#{userId}` | `POST#{postId}` | `CLIP#{clipId}` / `POST#{platform}`; gsi2 `STATS` / `{statsDueAt}#{postId}` while polled | Post fields + internal `platformPostId`, `statsId`, `statsDueAt`, `insightsDueAt`, `refreshStartedAt`, `lastSnapshotAt` (§16.3) |
| Stat snapshot | `USER#{userId}` | `STAT#{postId}#{iso}` | – | `type="stat"`, `postId`, `clipId`, `platform`, `at`, `views`, `likes`, `comments`, `shares`, `final?`, `ttl` (90 days) (§16.3) |
| Week | `USER#{userId}` | `WEEK#{yyyy-Www}` | – | `type="week"`, WeekView fields without `clips` + `revision`, `unpickedClipIds` (§16.3) |
| Rate budget | `RATE#{platform}` | `BUDGET` | – | `type="rate"`, per-platform counters, `blockedUntil` (§16.4) |
| Learning | `USER#{userId}` | `LEARNING#{learningId}` | – | Learning fields (incl. `kind`, `week`, `title`, `clipIds`) |
| Creator lesson | `USER#{userId}` | `LESSON#{lessonId}` | – | `type="learning"`, `kind="creator"`, Lesson fields + `supportPostIds`, `statusBeforeOff?`, `relearnedAt?`, `deletedAt?` (§16.12) |
| Learn state | `USER#{userId}` | `LEARNSTATE` | – | `type="learnstate"`, `seen` (winner post ids looked at, per `{creatorKey}|{platform}`), `creators` (LessonCreator[]), `checkedAt`, `version` (§16.12) |
| Account | `USER#{userId}` | `ACCOUNT#{platform}` | – | §17.4 (tokens never here; Secrets Manager `cf-prod/platforms/*`); also `SETUP#{platform}` and `OAUTH#{nonce}`/`STATE` items (§17.4) |

Built-in skills are not items: the API lists `skills/*/SKILL.md` bundled in its package as `builtin: true`.
(Superseded by §18.1: the old `SKILL#builtin-<name>` on/off choice items, `type="skill_choice"`, are ignored everywhere
and deleted by `GET /v1/skills` when it sees them.)
