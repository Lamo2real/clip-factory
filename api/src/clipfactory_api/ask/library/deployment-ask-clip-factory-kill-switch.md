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
