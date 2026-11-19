## Turning it off

- **Deploy flag:** `HELP_ENABLED` on `cf-prod-api` (`"true"` in prod). Off means the launcher disappears.
- **Kill switch, no deploy:** the DynamoDB item `HELP` / `SWITCH`. `enabled: false` turns the assistant off within
  60 seconds (open apps hide the launcher at their next status check, at most 5 minutes, and stop answering locally
  too). `model: false` keeps answering from search only. `pictures: false` turns pictures off (no look call; the
  picture button goes at the app's next status check). In Terraform, `help_enabled` (default true) and
  `help_monthly_cap` (default 2000) are optional variables of `infra/envs/prod`. The command is in
  [DEPLOYMENT.md](DEPLOYMENT.md#ask-clip-factory-kill-switch).
