## ADR-58 Deleting a job: a hard delete behind a client-side Undo, posted clips never touched

- **Context.** The owner wants to delete jobs (failed ones, finished ones). A job owns working files (gigabytes of
  audio, picture parts and checkpoints) and clips, some of them posted on five platforms with numbers the learning
  relies on. A running job has an agent container and a durable flow that keep writing to it.
- **Options.** (1) A server-side soft delete (`deletedAt`, hidden from every read, a TTL purge later): Undo works on
  every device, but every read must filter it, list pages come back short, and the purge needs a scheduled job or a
  stream consumer with S3 rights (new infrastructure). (2) A hard delete sent after the 8-second Undo the app already
  uses for Stop job and Throw away (§16.8, §12.3). (3) A hard delete with only a confirm.
- **Decision.** (CONTRACTS §34) Option 2, behind one question that says exactly what happens. The server delete is
  ordered so it is safe to repeat: fence the job with a new `sessionId` (the agent and the flow already condition every
  write on theirs), stop the run outright, delete thrown-away clips and, only when the owner turns it on (off by
  default), the clips still in Review, then the files except the kept clips' folders, then the job. Kept and posted
  clips, their posts and numbers are never deleted: deleting a job is housekeeping, not taking anything down. The
  Review-clips switch is off by default because those clips have not been looked at yet; Undo covers a slip, the
  switch covers intent.
- **Consequences.** No infrastructure change. The Undo lives on the device that deleted (another device sees the job go
  when the delete is sent, 8 seconds later); a tab closed inside the window still sends it (`pagehide`, `keepalive`),
  and if that request is lost the job simply stays, never half-deleted. A clip whose job is gone keeps working and its
  "See the job" link says the job is gone. Select's Pick all failed picks the failed jobs loaded on screen, not older
  pages.
