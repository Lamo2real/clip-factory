## ADR-39 Help runs in cf-prod-api with Claude Haiku 5.5 through the EU profile

- **Context.** The pattern puts help in its own Lambda. Clip Factory has one owner, one HTTP API with a single
  `ANY /v1/{proxy+}` route and the Cognito JWT authorizer, and a few questions a day. The agent uses Claude Fable 5.1
  through the global profile (ADR-02). The help prompt holds the owner's question and the owner's skills.
- **Decision.** Two routes, `GET /v1/help` and `POST /v1/help/answers`, in the existing `cf-prod-api`; the help package
  is imported only on those routes, so other routes pay no cold-start cost. The model is **Claude Haiku 5.5** (the
  newest Haiku on Bedrock, checked 2026-11-16) through the **EU** inference profile `eu.anthropic.claude-haiku-5-5`, set
  as `helpModel` in `config/models.json` with a per-model `profilePrefix: "eu"` (Fable keeps the top-level `global`).
  Cost is capped in code: 6 questions a minute, 60 an hour and 2,000 model answers per 30 days, all as conditional
  DynamoDB writes on the existing table. A deploy flag (`HELP_ENABLED`) and a kill-switch item switch it off without a
  deploy.
- **Alternatives.** *A separate `cf-prod-help` Lambda* (a second deploy unit, role and log group for a few requests a
  day, with no isolation benefit for one owner). *The global profile* (questions and skills could be processed outside
  the EU for no gain at this volume). *Fable 5.1* (slower and dearer than needed to reword a few sentences, and
  `aws_review` retention). *A separate request-guard table* (one more table; the single-table design, ADR-05, covers it).
- **Consequences.** IAM grows by one statement: `bedrock:InvokeModel` on the EU profile and its six destination
  foundation models only. A new structured-output schema can take Bedrock up to about 90 s to compile once; that first
  call times out and falls back to the plain answer. Haiku 5.5 is billed through AWS Marketplace, so on an account that
  has never used it the first call may fail until the model has been opened once; help stays on plain answers until
  then. Like every model call (ADR-32), the help call goes through the shared `learn.converse_text`, so the owner's
  skills block comes first and the help rules after it; when the skills cannot be read, help answers without the model.
