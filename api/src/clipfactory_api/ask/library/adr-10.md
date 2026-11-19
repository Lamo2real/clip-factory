## ADR-10 Feature branches, automatic merge after green CI, branches deleted

- **Context.** "Create them in separate feature branches, but when you merge them, which you're going to do
  automatically without my approval ... delete the feature branches afterwards."
- **Decision.** Every change goes through a `feat/`, `fix/`, `docs/` or `chore/` branch and a pull request, which merges
  (squash) automatically when CI is green. The branch is deleted after the merge. `main` deploys. See [GIT_WORKFLOW.md](GIT_WORKFLOW.md).
- **Consequences.** No human gate before production; CI is the gate, so it must stay strict.
