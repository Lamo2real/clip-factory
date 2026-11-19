## The model and its fallback

| Item | Value |
|---|---|
| Model | Claude Haiku 5.5 through the EU inference profile `eu.anthropic.claude-haiku-5-5` (from `config/models.json`, key `helpModel`) |
| Where it runs | EU Regions only (eu-central-1, eu-north-1, eu-south-1, eu-south-2, eu-west-1, eu-west-3) |
| Call | One Converse request, JSON schema output, `maxTokens` 700, thinking off, no tools, no streaming |
| Timeouts | 3 s to connect, 10 s to read, no retry (`max_attempts` 1: one attempt takes at most 13 s, two would outlive the 29 s Lambda); no call starts with less than 14 s left |
| Instructions | The owner's skills block first (CONTRACTS §18.6), then the help rules, which win on facts |
| When it is skipped | No match, a refusal, the kill switch says `model: false`, the skills could not be read, or 2,000 model answers in the current 30 days |
| What the owner sees on failure | The composed answer; never an error |
| Pictures (the look call) | Same model and profile, image blocks before the text, `maxTokens` 300, thinking off, JSON schema `{page, words, seen}`; 2 s to connect, 6 s to read, no retry; needs 12 s left; one more unit of the cap. `HELP_LOOK_MODEL_ID` can name another model (empty by default) |

The first call after a schema change can wait for Bedrock to compile the schema and fall back to the plain answer;
that is expected. If this AWS account has never used Haiku 5.5, open it once in the Bedrock console
([DEPLOYMENT.md](DEPLOYMENT.md#4-bedrock-model-access-and-data-retention)).
