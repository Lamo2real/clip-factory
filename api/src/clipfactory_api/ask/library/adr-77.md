## ADR-77 Models and reasoning effort are the owner's, per workspace, agent, task and request, never substituted

- **Context.** The owner wants complete control over which model powers Clip Factory Stories (examples "Sable 5.2, Sable 5.1,
  Opus 5.5": the account's Claude Fable 5.2 / 5.1 and Opus 5.5), with a default, per-agent and per-task choices, a
  per-request override from the chat, the active model visible, no silent substitution, and the reasoning effort set
  separately and really sent where the model supports it. Fable 5.x, Opus 5.5, Sonnet 5.5 and Haiku 5.5 take
  `output_config.effort` (low to max) with adaptive thinking; their default efforts differ (Opus 5.5 and Haiku 5.5
  `medium`); they reject a thinking budget.
- **Options.** (1) One model setting; (2) a model per agent only; (3) four levels (request, task, agent, workspace)
  over a model list kept apart from Clip Factory's, each model listing the efforts it accepts, an availability check by
  a real call, and the effective choice recorded on every job and message.
- **Decision.** (CONTRACTS §45.25) Option 3, with `stories/config/models.json` as the list (IAM grants built from it),
  no automatic fallback model (a refused or unavailable model stops the task with its reason and a way to pick
  another), and usage and cost recorded per call, cost only where a price is known or the owner typed one.
- **Consequences.** The owner can mix models per task; jobs are reproducible; a model the account cannot reach is
  visible as such. A refusal is shown rather than retried on another model, so an occasional task needs the owner's
  tap to continue.
- **Later (2026-11-22, CONTRACTS §45.34–§45.35).** The owner asked that new models and providers can be added without
  rebuilding the app. `stories/config/models.json` is now only the bundled starting list: the owner adds Bedrock-hosted
  models (any maker) as `MODELDEF#` items, each saying how it is called (effort field, tools, prompt cache), merged per
  call by the API and the agent. The runtime role's model grant became a wildcard over the account's Bedrock models
  and inference profiles, so an added model works after Check models with no deploy. A maker outside Bedrock still
  needs code (a new client), which the `host` field on every model makes visible.
