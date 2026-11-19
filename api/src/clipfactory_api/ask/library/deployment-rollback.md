## Rollback

- **Code**: revert the bad commit on `main` (`git revert <sha>` in a branch, pull request, automatic merge). The next
  deploy rebuilds and applies the previous state. The agent image tag is a hash of its sources, so the old image is
  reused if it is still in ECR.
- **Infrastructure state**: the state bucket is versioned; an older state version can be restored if a run is
  interrupted. Prefer fixing forward with a new commit.
- **Data**: DynamoDB point-in-time recovery restores the table to any second in the last 35 days (into a new table).
  Clips in S3 are not versioned; declined clips are deleted on purpose. The learning memory can be rebuilt from the
  Clip items (the clip flow embeds a clip again when its vector is missing).
- **Durable flows**: a rollback moves the `live` alias back; executions already running finish on the version they
  started on.
