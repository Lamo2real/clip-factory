## ADR-20 Update labels from "Area:" commit lines, then a folder map

- **Context.** The update bar should name what changed in a word or three: "'settings profile picture' or just
  'profile picture'. That's it." Labels must cost nothing to write and never be a sentence.
- **Decision.** `scripts/release-areas.sh` reads `Area: <label>` lines in the commits since the deployed version. If
  there are none, it maps the changed files through `web/areas.json` (longest prefix wins). If that finds nothing, the
  label is "Improvements"; the first deploy says "First release". At most three labels, 1–3 words each.
- **Alternatives.** Hand-written release notes (forgotten, too long); asking Claude to summarise the diff at deploy
  time (needs a model call in CI, can be wordy or wrong, and costs on every deploy); conventional-commit scopes
  (`feat(settings):` are developer words, not what the owner sees on screen).
- **Consequences.** Whoever commits (a person or an agent) decides the words; the folder map keeps labels sensible when
  they forget. Because pull requests are squash-merged, the `Area:` lines must reach the squashed commit
  ([GIT_WORKFLOW.md](GIT_WORKFLOW.md#area-lines-what-the-update-bar-says)).
