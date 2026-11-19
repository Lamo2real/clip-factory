## 23. AI model choice for clip jobs (owner request, 2026-11-18)

The owner: "allow me to select whatever model I want … just by selecting them in the settings, in an appropriate
place in the settings". The model that makes a job's clips is the owner's pick from a short list; the default stays
Claude Fable 5.1, so nothing changes until the owner picks (docs/DECISIONS.md ADR-42).

### 23.1 The list (`config/models.json`)

`clipModels` lists, in display order, the keys the owner may pick; each entry has `label` and `line` (one plain line
for the picker) next to `modelId`. `agentModel` is the default and must be in the list.

| Key | Label | Line | Called as |
|---|---|---|---|
| `fable-5-2` | Claude Fable 5.2 | Smartest. Best at finding moments. | `global.anthropic.claude-fable-5-2` |
| `fable-5-1` (default) | Claude Fable 5.1 | Very smart. The usual one. | `global.anthropic.claude-fable-5-1` |
| `opus-5-5` | Claude Opus 5.5 | Smart and quicker. | `global.anthropic.claude-opus-5-5` |
| `sonnet-5-5` | Claude Sonnet 5.5 | Good and fast. Costs less. | `global.anthropic.claude-sonnet-5-5` |
| `haiku-5-5` | Claude Haiku 5.5 | Cheapest, fastest. Simpler picks. | `eu.anthropic.claude-haiku-5-5` (its own `profilePrefix`) |

The id is built like every other model: `<profilePrefix>.<modelId>`, the model's own `profilePrefix` winning over the
top-level one (§19.5). The help model (`helpModel`) and the second watcher (`watchModel`, Nova 2 Lite) do not change.

### 23.2 Settings (api, `settings.py`)

`Settings.clipModel: string`, default `"fable-5-1"` (`agentModel`). `PUT /v1/settings` takes a key of `clipModels`;
anything else is 400 "Pick one of the AI models in the list.". The API Lambdas do not ship `config/models.json`, so
`settings.CLIP_MODELS` mirrors `clipModels` and a test keeps them (and the default) equal, like `MAX_USD_PER_1000`.
A stored key no longer in the list, or a malformed one, reads as the default; a settings item saved before the field
existed keeps every other choice. The field is additive: nothing is renamed or dropped.

### 23.3 Agent (`config.py`, `pipeline.py`, `bedrock.py`)

* `load_config` reads `clipModels` into `Config.clip_models` (key → id) and `agentModel` into
  `Config.default_model_key`. `CF_MODEL_ID` stays the default's id.
* `resolve` reads the owner's settings and picks the job's model (`model.chosen` log): `clipModel` when it is in the
  list, else the default. One `Bedrock` client per model id is kept for the container's life (what a client learns,
  such as "no forced tool choice" or "no cache points", is learned once per model).
* Every Claude step of the job uses that client and id: the finder (Agent SDK `ANTHROPIC_MODEL`/`model`, and the
  Converse fallback), the Claude watcher, the second look, the facecam layout, the checklist review and the
  captions. Nova (the second watcher) and Titan (embeddings) are unchanged.
* A picked model other than the default makes one small structured call (`ready`, with the skills block first like
  every call, §18.6) right after `analyze` builds the skills block. When Bedrock refuses it as unavailable
  (`AccessDeniedException`, `ResourceNotFoundException`, or a `ValidationException` saying the model or profile is
  invalid, not available, not enabled or not offered on demand), the default model makes the rest of the job, the
  log says `model.fallback` and the job record says so. Any other failure of that call (busy, a timeout) keeps the
  pick. A model that answered once is not asked again.
* The Job item gains `model` (the key actually used, written in `resolve`) and `modelWanted` (the pick, only after a
  fallback; removed again when a retry uses the pick).
* Requests stay valid on all five models: no `thinking` (each runs adaptive thinking when it is left out; a thinking
  budget or `thinking: disabled` is refused), no `temperature`/`top_p`/`top_k`, `maxTokens` only. A refused forced
  `toolChoice` or cache point is switched off per client and the call sent again, as before. The Agent SDK keeps
  `effort: "high"` (every model takes it).

### 23.4 Infrastructure (`envs/prod`, `modules/agent`)

`envs/prod` builds `clip_model_profile_arns` (each model's profile in this region) and `clip_model_invoke_arns` (the
profiles, plus the foundation model in any region for a `global` profile, or in the listed `profileRegions` for a geo
profile) and passes them to the agent module, which adds them to the existing `InvokeFable` and `ReadProfile`
statements (same Sids: the role policy changes in place, nothing is replaced). `CF_MODEL_ID` and `ANTHROPIC_MODEL`
stay the default.

### 23.5 Web

Settings › Clip making › Clips gets the apple **AI model** (`#ai-model`): the five models as rows on a pick-one track
(radio group, the glide slides to the chosen row), each with its label, its line and "In use" on the chosen one. The
list, labels and lines come from `config/models.json` (`web/src/lib/models.ts`), the way §21 once read its config. A tap
saves `PUT /v1/settings {clipModel}`. A finished job's detail page says "Made with {label}." and, after a fallback,
"{wanted} could not be used, so the usual one was." The mock API checks and stores the field and stamps new jobs
with it.

### 23.6 Tests

* api: the mirror equals `config/models.json`; each key saves; anything else is 400; an old or bad stored value reads
  as the default.
* agent: `clipModels` and the profile prefixes; what counts as unavailable; a whole job with each pick (every Claude
  step on the picked client, the default untouched, the finder given the picked id, no sampling or thinking fields);
  a refused pick falls back for the whole job with `model.fallback` and `modelWanted`; a busy probe keeps the pick;
  an unknown pick uses the default; one client per model.
* infra: the five ids and the 15 invoke ARNs in `envs/prod`; the agent role's `InvokeFable` and `ReadProfile` cover
  every clip model without repeats and `CF_MODEL_ID` stays the default.
* web: unit (`test/models.test.ts`: the list from the config, the default, the settings apple, the mock API) and
  Playwright `e2e/ai-model.spec.ts` (five rows, the one in use marked, picking and arrow keys, "Made with" on a
  finished job, 48 px rows and no sideways scroll at 320 px).
