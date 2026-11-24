## 34. Delete jobs (owner request, 2026-11-20)

### 34.1 The owner's words and what they mean

"You should also allow me to delete jobs as well." He has failed jobs (a YouTube one that stopped at Find the video)
and finished ones he no longer needs to see. A job can be deleted from its row in Jobs, from its own page, and several
at once (Select, with Pick all failed). Deleting a job never takes down what was posted (ADR-58).

### 34.2 What goes and what stays

| | Deleted with the job | Kept |
|---|---|---|
| The job, its live status line (`JOBLIVE#`), its notification step (`NOTIFYSTEP#`) | always | |
| A working job's run | stopped first (§34.3) | |
| Thrown-away clips (`declined`: no file, shown only on the job page) | always | |
| Clips waiting in Review | only when the owner turned on "Also delete its N clips in Review" (off by default), and only while they still wait | otherwise; they keep working and still say which job they came from |
| Kept, posting, posted and post-failed clips, their posts, numbers, Library entries and vectors | never | always: the posts on YouTube, TikTok and the rest stay up |
| Files under `jobs/{jobId}/` (audio, words, picture, watch answers, checkpoints, cut and checked clips in `source/`, the folders of deleted clips) | always | the `jobs/{jobId}/clips/{clipId}/` folder of every clip that stays |
| The uploaded video (`uploads/{userId}/…`, a "Use a video file" job) | when no other job uses it | |
| A deleted Review clip's vector | yes (as Throw away does) | |

### 34.3 Order of one delete (`api/src/clipfactory_api/job_delete.py`)

1. **Fence.** `sessionId` becomes a new value and a working job becomes `canceled`, with an internal `deletingAt`. The
   agent and `cf-prod-job-flow` condition every write on their own `sessionId` (and the item existing), so the old run
   can no longer write the job or add a clip, and a resume or Try again of the old run ends quietly (`missing` or
   `superseded`). Canceled sends no notification (§32). The fence only applies to the `sessionId` that was read: if a
   Try again got in between, the delete reads again and fences (and stops) the newer session. While `deletingAt` is
   set, Try again and Stop job answer 409.
2. **Stop.** The job's runtime session, whatever the job's status (a failed job's container may still be uploading),
   is stopped outright (`StopRuntimeSession`, like Try again's backstop), not sent a cancel whose wind-down would write again. The stop is awaited before the files go,
   so the old container cannot write new ones afterwards. A failed stop is logged; the fence still holds.
3. **Clips** as in §34.2 (a conditional delete: a Review clip kept on another device a moment ago is kept).
4. **Files** (`Media.delete_prefix_except`) and the upload. A file under `clips/{clipId}/` is spared when that clip's own
   item still exists (a consistent read), because the job's clip list comes from an eventually consistent index.
5. **Items:** `JOBLIVE#`, `NOTIFYSTEP#`, then the job itself. The stream's `REMOVE` reaches every open screen as
   `{type: "job" | "clip", op: "delete"}` (§14.2), so other devices update at once.

A delete that breaks halfway (S3 down) answers an error and leaves the job fenced and stopped; the next delete
finishes it. Deleting a job that is not there answers `deleted: false`: a second delete, a delete from another device,
or another owner's job id (the key is always the caller's own, so another owner's job is never read, fenced or
changed). Several jobs run five at a time, at most 25 per call, well inside the API's 29 seconds.

### 34.4 Contract

`DELETE /v1/jobs/{jobId}?clips=keep|delete` and `POST /v1/jobs/delete {jobIds, clips}` (§5). The API's IAM already
lists and deletes under `jobs/*` and `uploads/*`: no infrastructure change, nothing the deploy's delete gate could see.

### 34.5 Undo (web, `web/src/lib/jobDeletes.ts`)

As for Stop job (§16.8) and Throw away (§12.3), the delete waits 8 seconds: "Job deleted." (or "3 jobs deleted.") with
Undo. The job leaves every list at once (Jobs, Home's Working now, the job page, which shows "This job is gone"), and
so do its Review clips when they go too; the running count, the Review badge and "N jobs working" drop at once and stay
adjusted until the server's own counts arrive. Undo brings everything back and sends nothing. When the toast ends, or
the page closes (`pagehide`, sent with `keepalive`), the delete is sent: one job with `DELETE`, several with
`POST /v1/jobs/delete` in batches of 25. A delete that fails brings back the jobs it could not delete with "… The job
is back in your list." The deleted jobs stay hidden on that device afterwards, so a poll answered a moment earlier
cannot show one again. Why not a server-side soft delete: ADR-58.

### 34.6 What the owner sees

* **Jobs:** each row has a bin button at its bottom right (the thumb's corner on a phone; the middle right on wider
  screens), labelled "Delete job: {title}", quiet until hovered or focused, then the danger colours. It sits beside the
  row's link, never inside it. Touch screens always show it; with a mouse it shows on the row under the pointer, or
  when the keyboard is on the row (Tab to the row, Tab again to its bin), so a column of bins never sits under Ask's
  button and makes it fade (§19.8) and a page change from Jobs stays still (§20.16).
* **Next to the sidebar** (768–959 px) a row keeps its phone layout, so its words keep their room. **Select** (next to Make clips) turns each row into one big tick box (`role="checkbox"`,
  Space or Enter toggles it) and shows a bar at the bottom of the screen: "N jobs picked" (or "Tap the jobs to
  delete"), **Cancel**, **Pick all failed (N)** (the failed jobs on screen) and **Delete N** (danger, at the bottom
  right). Escape leaves Select. While selecting, a second **Cancel** (×) sits where Select was (so Make clips never moves; a
  second tap within 400 ms of Select does nothing) and ends Select like the bar's Cancel, never reading like a confirm
  that would delete. After either Cancel, Escape or a delete the focus goes back to Select; Stop job moves the focus to its "Stopping…" note.
* **Job page:** **Delete job** (ghost, bin) first in the actions, so Try again or Check these clips keep the corner.
  After the question the page goes back to All jobs, where the Undo toast is.
* **The question** (`DeleteJobsSheet`, a `Sheet`): "Delete this job?" / "Delete 3 jobs?", then what happens:
  "It is still working, so it stops first." (or "2 are still working, so they stop first."; only when one is),
  "Its working files go away.", "Clips you kept or posted stay. Your posts stay up too.", a switch "Also delete its
  4 clips in Review" (only when there are some; off; its note says "They stay in Review." or "They go with the job."),
  and "You can undo for 8 seconds." **Keep it** is first, focused, and what Escape or a tap outside mean; **Delete job**
  / **Delete 3 jobs** uses the danger style (never the vermilion of an action).
* **A clip from a deleted job:** "See the job this clip came from" opens "This job is gone" with "It was deleted, or the
  link is wrong. Clips you kept from it still work." and See all jobs.
* No `cursor:` styles, no edges: the tick and the bar are fills; the motions are the existing ones and stop under
  reduced motion.

### 34.7 Ask

The help guide "Delete a job" (`helpKb.json`, highlights Select and the Jobs tab) and the regenerated corpora
(`node web/scripts/help-corpus.mjs`, `node web/scripts/ask-knowledge.mjs`).

### 34.8 Tests

* `api/tests/test_job_delete.py`: a failed job and every item and file it leaves; idempotent; another owner's job is
  never touched (single and batch); input checks; a running or queued job is fenced, canceled and its session stopped
  (no cancel signal); the old run's conditional writes fail afterwards; a broken delete leaves the job fenced and the
  next one finishes it; a failed stop does not block; Review clips kept by default and deleted when asked; kept,
  posting, posted and post-failed clips, their posts and files never deleted; a Review clip kept meanwhile is kept;
  the upload goes only when no other job uses it; other jobs' and owners' files stay; several at once, each once, the
  running count after; `cf-prod-job-flow` never brings a deleted job back (finished or timed-out callback).
* `web/test/jobDeletes.test.ts`: the question's words, Undo sends nothing, one call or batches of 25 with the clip
  choice, a failed delete brings the job back, the two HTTP calls (`keepalive`).
* `web/e2e/delete-jobs.spec.ts`: row Delete, the wording, Keep it focused and Escape, Undo, a working job, the Review
  clips switch, the bin with the keyboard, bins always shown on touch and on the hovered row with a mouse, the job page and a clip's link to a deleted job, Select with Pick all failed and one call, a failed
  delete, and the fit at 1000×650 and 390×844 (no sideways scroll, a 44 px target, the bar on screen).
