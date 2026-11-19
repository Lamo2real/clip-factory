## Ask Clip Factory kill switch

The help assistant is on in prod (`HELP_ENABLED = "true"`). To change it without a deploy, write the switch item
(signed in to the account, `eu-north-1`); `cf-prod-api` reads it at most every 60 seconds:

```bash
# Off: the launcher disappears and nothing answers (open apps notice within 5 minutes)
aws dynamodb put-item --table-name cf-prod-data --region eu-north-1 \
  --item '{"pk":{"S":"HELP"},"sk":{"S":"SWITCH"},"enabled":{"BOOL":false},"model":{"BOOL":true}}'

# On, but without the model (answers from search only)
aws dynamodb put-item --table-name cf-prod-data --region eu-north-1 \
  --item '{"pk":{"S":"HELP"},"sk":{"S":"SWITCH"},"enabled":{"BOOL":true},"model":{"BOOL":false}}'

# Back to normal
aws dynamodb delete-item --table-name cf-prod-data --region eu-north-1 \
  --key '{"pk":{"S":"HELP"},"sk":{"S":"SWITCH"}}'
```

Terraform does not manage this item. To turn help off for good, set the Terraform variable `help_enabled = false`
(for example `TF_VAR_help_enabled: "false"` in the `terraform plan` step of the deploy workflow) and deploy. The model
answers are capped at 2,000 per 30 days (`HELP_MONTHLY_CAP`, Terraform variable `help_monthly_cap`, a whole number);
past the cap help keeps answering from search.

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
