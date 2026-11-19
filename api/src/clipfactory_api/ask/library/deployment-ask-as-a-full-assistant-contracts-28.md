## Ask as a full assistant (CONTRACTS §28)

`cf-prod-ask` deploys with everything else (`ask_enabled = true` in prod). Two owner steps, both only once:

1. **Bedrock model access (only if Bedrock asks for it).** Open the Bedrock console in **Stockholm (eu-north-1)** →
   **Model access** → turn on **Claude Opus 5.5** and **Claude Opus 4.8** → try each once in the playground. Until then
   answers fail with an access error (`ask_model_error`, alarm `cf-prod-ask-model-failures`) and Ask gives the plain
   §19 answers.
2. **Web search.** In the app: **Settings › App & account › Ask** → **Get a search key** (Brave Search API) → make a
   free account and pick the **Search** plan ($5 of free credit a month, about 1,000 searches) → copy the key →
   paste it → **Save key**. The app stores it in Secrets Manager as `cf-prod/ask/search-key`; Terraform never does.
   Until then Ask says "I can't search the web yet." and answers from what it knows.

The kill switch item gains three attributes (absent = on):

```bash
# The assistant off: the panel answers with the §19 path again
aws dynamodb put-item --table-name cf-prod-data --region eu-north-1 \
  --item '{"pk":{"S":"HELP"},"sk":{"S":"SWITCH"},"assistant":{"BOOL":false}}'

# The assistant on, but no web search and no files
aws dynamodb put-item --table-name cf-prod-data --region eu-north-1 \
  --item '{"pk":{"S":"HELP"},"sk":{"S":"SWITCH"},"web":{"BOOL":false},"files":{"BOOL":false}}'
```

**Alarm `cf-prod-ask-model-failures`**: 10 or more model errors or timeouts in an hour (step 1 above is the usual
cause). **Alarm `cf-prod-ask-tokens-day`**: more than 20M new input tokens in a day (`ask_tokens_alarm_threshold`); it
blocks nothing. If either keeps firing, turn the assistant off with the first command.

After the first deploy, check once (CI's deploy role, never a local deploy): one question in the app with a picture, a
PDF and "#search"-style words, and see the `help.ask` line in `/aws/lambda/cf-prod-ask` say `ask_ok`. If it says
`ask_model_error` with status 400 on every answer, set `ASK_EAGER_TOOLS=false` (Terraform variable `ask_eager_tools = false`,
for example `TF_VAR_ask_eager_tools: "false"` in the deploy workflow's plan step) and deploy.

### Alarm emails

Every alarm (Lambda errors, failed or timed-out durable executions, live-update lag, webhook 5xx, help model
failures; [CONTRACTS.md §14.9](CONTRACTS.md)) goes to the SNS topic `cf-prod-alarms`, which emails `CF_ALARM_EMAIL`,
or `CF_OWNER_EMAIL` when that secret is not set. After the first deploy (and after changing the address) AWS sends
an email titled "AWS Notification - Subscription Confirmation" from `[hidden]`: press
**Confirm subscription** in it (check spam). Until then no alarm email arrives. To check, open SNS in the console
(eu-north-1) → Topics → `cf-prod-alarms`: the subscription must say Confirmed, not Pending confirmation.

**Alarm `cf-prod-help-model-failures`** (10 or more `kb_model_error` or `kb_model_timeout` answers in an hour) means
the Haiku calls are failing. The owner still gets plain answers. The usual cause on a new account is the Marketplace
first-call step: open Claude Haiku 5.5 once in the Bedrock console playground in `eu-north-1`
([step 4](#4-bedrock-model-access-and-data-retention)). If it keeps firing, turn the model off with the second command
above until it is fixed.
