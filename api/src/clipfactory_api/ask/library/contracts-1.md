## 1. Names, region, accounts

| Thing | Value |
|---|---|
| Repository | `Lamo2real/clip-factory-legal` (public). The legal pages at the repo root (`index.html`, `privacy.html`, `terms.html`, `style.css`, `.nojekyll`) are served by GitHub Pages and **must stay where they are**. |
| Resource name prefix | `cf-prod` (`local.name` in Terraform) |
| Region | `eu-north-1` (Stockholm), variable `region`. CloudFront is global. Unchanged by §14: Lambda durable functions (since 2025-12-18, python3.13), S3 Vectors, Titan Text Embeddings V2 (in-Region), AgentCore Runtime and batch Transcribe are all available here. |
| Model | Claude **Fable 5.1**, Bedrock model id `anthropic.claude-fable-5-1`, called through the **global** cross-region inference profile `global.anthropic.claude-fable-5-1` (the only way to reach it from eu-north-1: no in-Region model, no EU geo profile, so prompts may be processed outside the EU; the account must be opted in to data retention mode `aws_review`, a one-time owner step in docs/DEPLOYMENT.md). Embeddings: **Amazon Titan Text Embeddings V2** `amazon.titan-embed-text-v2:0`, in-Region, no profile (§14.6). The deep analysis's second watcher (§8, ADR-40): **Amazon Nova 2 Lite** `amazon.nova-2-lite-v1:0` through the **EU** profile `eu.amazon.nova-2-lite-v1:0` (`watchModel` in `config/models.json`, with its own `profilePrefix: "eu"` and `profileRegions`, like `helpModel`). Clip jobs: the owner may pick another model per job in Settings (`clipModel`, `clipModels` in `config/models.json`, §23); Fable 5.1 stays the default. Only `config/models.json` holds model ids. |
| Terraform state | S3 bucket `vars.CF_STATE_BUCKET` (default `lamo-labs-state-bucket`), key `clip-factory/prod/terraform.tfstate`, `use_lockfile = true`. |
| GitHub settings | variable `CF_DEPLOY_ROLE_ARN` (OIDC role, provided by the owner later), secret `CF_OWNER_EMAIL` (the only login), optional variables `CF_REGION`, `CF_STATE_BUCKET`. |
| Web origin | The CloudFront default domain (`https://dxxxx.cloudfront.net`), output `app_url`. No custom domain yet. |

`config/models.json`:
```json
{ "profilePrefix": "global", "agentModel": "fable-5-1",
  "models": { "fable-5-1": { "label": "Claude Fable 5.1", "modelId": "anthropic.claude-fable-5-1" } },
  "embeddingModel": { "label": "Amazon Titan Text Embeddings V2", "modelId": "amazon.titan-embed-text-v2:0",
                      "dimensions": 1024 } }
```
`embeddingModel.modelId` is used as is (in-Region, never prefixed with `profilePrefix`). Terraform reads it into
`local.embed_model_id`, `local.embed_dimensions` and `local.embed_model_arn =
"arn:aws:bedrock:${var.region}::foundation-model/${local.embed_model_id}"`.
