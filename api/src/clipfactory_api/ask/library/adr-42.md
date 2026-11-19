## ADR-42 The owner picks the AI model for clip jobs

- **Context.** The owner asked (2026-11-18) to "make the clips … with the AI agent core in Bedrock allow me to select
  whatever model I want. If I want Opus 5.5 … Fable 5.1 … Fable 5.2 … just by selecting them in the settings". One
  model, Claude Fable 5.1, was fixed in `config/models.json` (`agentModel`) and in the agent's environment.
- **Decision.**
  - *A short list in config, a pick in Settings.* `config/models.json` gains `clipModels` (Fable 5.2, Fable 5.1, Opus
    5.5, Sonnet 5.5, Haiku 5.5, in that order) with a label and one plain line each; the owner's pick is the new
    setting `clipModel` (Settings › Clip making › Clips › AI model). `agentModel` (Fable 5.1) stays the default, so
    nothing changes until the owner picks. The setting is additive; an unknown stored key reads as the default.
  - *Per job, not per deploy.* The pick travels with the owner's settings, which the agent already reads at the start
    of each job; no environment variable changes and no redeploy is needed to switch. Every Claude step of the job uses
    the picked model (finder, Claude watcher, second look, layout, review, captions); one Bedrock client per model id
    is cached in the container.
  - *Fall back rather than fail.* Whether a model is enabled on the account cannot be checked offline, and Fable 5.2,
    Opus 5.5 and Sonnet 5.5 may not be. A picked model's first call is small; if Bedrock refuses it as unavailable,
    the default makes the job, `model.fallback` is logged and the job records `model` and `modelWanted`, so the page
    can say so. Busy or failing calls do not count: those keep the pick.
  - *IAM for the list, in place.* The agent role's existing `InvokeFable` and `ReadProfile` statements gain every
    clip model's profile and foundation model ARNs (global profiles: any region; Haiku's EU profile: its six EU
    regions). Same Sids, so the policy changes in place.
  - *Requests every model takes.* No thinking budget, no `thinking: disabled`, no sampling settings; forced tool choice
    and cache points keep their switch-off-on-refusal fallbacks.
- **Alternatives.** *Any Bedrock model id typed by the owner* (not kid-proof, cannot be granted in IAM ahead of time,
  and a model that does not support tools or the skills block would fail jobs). *A deploy-time variable* (a redeploy
  per change; not "just by selecting"). *Letting the API check availability* (the API has no Bedrock access for these
  models and the answer can change; the agent finds out on the first call anyway).
- **Consequences.** Haiku keeps prompts in the EU; the global profiles may process them outside the EU, as Fable 5.1
  already did. A picked model costs what it costs: Bedrock bills each model at its own rate. A model's first call per
  container adds one small request. The API's list is a mirror of `clipModels` kept equal by a test, because the API
  Lambdas do not ship `config/models.json`.
