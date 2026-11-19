## Live numbers

| Metric | Read by the browser from |
|---|---|
| `best_clip_week_views`, `week_total_views`, `week_clips` | `GET /v1/weeks/{week}` |
| `review_waiting`, `jobs_running`, `clips_posted` | `GET /v1/me` |
| `latest_job` | `GET /v1/jobs?limit=1` |
| `clip_views` | `GET /v1/clips/{clipId}/performance` (only when asked on a clip page) |
| `skills_on` | `GET /v1/skills` |
| `accounts_connected` | `GET /v1/accounts` |

A failed read says "I couldn't get that number right now." and offers the button to the page that shows it.
