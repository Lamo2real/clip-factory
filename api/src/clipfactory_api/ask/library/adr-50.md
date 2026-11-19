## ADR-50 Ask becomes a full assistant: Opus 5.5 on Bedrock Mantle in-Region, client-side web tools, HTTP start + WebSocket stream, files via a 1-day S3 prefix deleted after each answer

- **Context.** The owner (2026-11-19) wants Ask to answer any question, on any topic, while always knowing his app and
  his own setup, to check today's platform steps on the web, and to take files (drop, paste, attach) and pictures he
  can mark in red. §19's "only reword a help answer" cannot do that, and the 29 s API limit cannot hold a model that
  searches and reads.
- **Decision.**
  - *Model*: Claude Opus 5.5 on Claude in Amazon Bedrock (the `bedrock-mantle` Messages API) **in-Region in
    eu-north-1**, through the official Anthropic SDK (`AnthropicBedrockMantle`), adaptive thinking at effort medium,
    streamed. Refusals retry on Opus 4.8 through the SDK middleware (Bedrock has no server-side fallbacks).
  - *Knowledge*: a generated, committed, secrets-filtered pack (the help corpus as an app map, the owner manual and a
    library index) behind the skills block, cached for an hour; the owner's live state after his question as a
    mid-conversation system message; read-only tools for library sections, his own data and app buttons.
  - *Web*: Bedrock has no server web search or fetch, so both are client tools in the worker: Brave Search API (key
    in Secrets Manager, saved by the owner in Settings) and a fetch that only opens URLs from this answer's results or
    his own words, behind an SSRF guard.
  - *Transport*: `POST /v1/help/asks` returns 202 and starts `cf-prod-ask` asynchronously; the answer streams back as
    `ask.*` events over the existing WebSocket (its id learned with `whoami`). The §19 path stays as the fallback.
  - *Files*: uploaded with presigned PUTs to `ask/{sub}/`, read once by the worker and deleted as soon as they are in
    memory (again in its `finally`); the API and the panel delete them when a question does not start; a 1-day
    lifecycle rule is the safety net.
  - *Review of 2026-11-19*: APP STATE (system weight) holds only enums, numbers, ids and Clip Factory's own words;
    outside words go through a tool as data. The typed-question refusal is narrowed to asking for his own stored
    values, and answers pass a narrow filter (high-confidence key shapes and his stored key) so general and Terraform
    answers stay intact; the wide filter stays on the pack, APP STATE and files. Each fetch has one deadline inside the
    answer's budget, tools run in parallel, a heartbeat keeps the panel's silence timer from firing, and the output
    budget ends with a tool-free last round instead of a cut.
  - *Markup*: a client-only editor that saves one flattened JPEG in place of the picture; the original never leaves
    the device.
- **Alternatives considered.** *Claude Fable 5.2*: not on Mantle, twice the price, long turns. *Converse with native
  docx/xlsx documents*: a second model API off the SDK path. *A Lambda Function URL with response streaming*: Python
  has no native response streaming (a custom runtime) and the CSP would need a new origin. *WebSocket only*: 32 KB
  frames cannot carry a question with history and files. *Inline base64 files*: the 6 MB Lambda payload and the
  WebSocket frame limit. *Claude Platform on AWS with server web search*: not EU in-Region, a new billing account and
  console. *Reserved concurrency 3*: this account cannot reserve any (the deploy would fail); the per-owner rate limit
  bounds concurrency instead.
- **Consequences.** One owner step for web search (a free Brave key) and possibly one for Bedrock model access in
  Stockholm. Cost is bounded per answer (time, rounds, tokens) and watched by a daily token alarm instead of a monthly
  cap. The Lambda zip now carries the Anthropic SDK and two compiled wheels for arm64. Bedrock support for some
  request features (eager tool input, document blocks in tool results, the fallback credit header) is unconfirmed until
  the first deploy; each has a switch or an automatic way out.
