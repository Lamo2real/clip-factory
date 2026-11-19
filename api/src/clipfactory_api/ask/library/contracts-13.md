## 13. Notes added after the final review

* **Confirm is safe to repeat** (rules in §14.5): starting `cf-prod-clip-flow` is idempotent on its durable execution
  name, so a repeat confirm restarts nothing. The web shows "Try again" for clips with `status: "failed"`. Internal
  clip fields `publishState`, `postsCreated`, `postIds`, `flowRun` and `flowExecutionArn` are never returned by the API
  (`publishClaimAt` is gone).
* **No watchdog.** The watchdog and its re-queue of stuck confirms are removed (§14.1); a confirm whose flow did not
  start is retried by the next confirm.
* **One run per job.** Every agent write to a Job is conditional on `sessionId` = the session it was invoked with; a
  retry gives the job a new `sessionId` and the old run stops quietly at its next write.
* **Long sources.** Audio longer than 3 h 50 min is split for Transcribe into `jobs/{jobId}/source/audio.part{i}.m4a`
  and `transcript.part{i}*.json` (temporary, tagged `cf-retention=temporary`, 14-day lifecycle like the rest of `source/`).
* **Distil outcomes** (the clip-flow `distil` step, formerly perf-check) include `max_tokens`, `refusal` and
  `content_filtered` (logged; no Learning written).
* **TLS.** With the default `*.cloudfront.net` certificate CloudFront's protocol floor cannot be raised; TLS 1.2+ is
  enforced once a custom domain with an ACM certificate is attached (roadmap).
* **Words in the UI** (§12.4): "Keep" (was Confirm), "Throw away" (was Decline/Delete), "Try again" (was Retry).
