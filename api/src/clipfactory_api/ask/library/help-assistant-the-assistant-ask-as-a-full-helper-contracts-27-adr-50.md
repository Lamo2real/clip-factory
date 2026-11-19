## The assistant (Ask as a full helper, CONTRACTS §27, ADR-50)

Since §27, Ask answers **any** question (Clip Factory, Terraform, food, a file the owner drops in), not only the help
corpus. The §19 path above (corpus + Haiku rewrite, `POST /v1/help/answers`) stays as the fallback.

**How Ask thinks.** Claude Opus 5.5 on Claude in Amazon Bedrock (the `bedrock-mantle` Messages API, in-Region
`eu-north-1`), adaptive thinking at effort `medium`, streamed. Every request has the same cached prefix: the tools
(sorted), then the system blocks in this order: the owner's skills (§18.6, always first), the knowledge pack
(`api/src/clipfactory_api/ask/knowledge.json`, about 43k tokens: the app map from the help corpus, the owner manual,
the library index) and the Ask rules (`ask/prompt.py`, with the one 1-hour cache breakpoint). The owner's live state
(`ask/state.py`: jobs, setup per platform, settings, skills, follows, this week, money) goes after his question as a
mid-conversation `system` message, rebuilt every question. A refusal on Opus 5.5 is retried on Opus 4.8 by the SDK's
`BetaRefusalFallbackMiddleware` (Bedrock has no server-side `fallbacks`).

**Tools (all read only).** `web_search` (Brave Search API, 8 results, 4 s), `web_fetch` (only URLs from this
answer's search results or URLs the owner typed; https, public addresses only, re-checked on every redirect, 6 s,
2 MB), `read_app_doc` (one library section by id), `read_my_clip_factory` (the owner's own data by section) and
`show_app_buttons` (at most two buttons from the app map; the §19.8 spotlight is unchanged). Caps per answer: 6 of
each, 2 button calls. Nothing writes, posts, deletes, connects or sends.

**Transport.** The panel sends `{"action":"whoami"}` on the open WebSocket to learn its connection id, uploads any
files to `ask/{sub}/{fileId}` with presigned PUTs (`POST /v1/help/files`), then `POST /v1/help/asks` answers 202 and
starts `cf-prod-ask` with an async Invoke. The answer streams back as `ask.*` events on the socket (first words in
about 2 to 4 s). Stop is `POST /v1/help/asks/{askId}/stop`. If the socket is not open within 4 s, or nothing arrives,
the panel answers with the §19 path.

**Files.** Pictures (re-encoded to JPEG in the browser, markable in the editor), PDF (≤ 100 pages), text-like files
and docx/xlsx/pptx/odt/ods (text pulled out in the worker). Old Office files, archives, audio and video are refused when
added, with a note that says what to do. Files are deleted by the worker when the answer ends, whatever happened, and
by the bucket's `ask-1-day` rule as a safety net. Nothing about a file is logged but its kind and size.

**Owner steps.**

1. Bedrock model access (only if Bedrock asks): Bedrock console in Stockholm › Model access › turn on Claude Opus
   5.5 and Claude Opus 4.8, then try each once in the playground.
2. Web search: Settings › App & account › Ask › **Get a search key** (Brave Search API, the **Search** plan, $5 of free
   credit a month), paste it, **Save key**. Until then Ask says "I can't search the web yet." once and answers from
   what it knows.

**Turning it off.** `HELP`/`SWITCH` gains `assistant`, `web` and `files` (absent = true). `assistant: false` sends the
panel to the §19 path; `web: false` takes the search tool away; `files: false` refuses files.

### The `help.ask` log line

One line per answer from `cf-prod-ask`: `requestId`, `askId`, `outcome`, `stop`, `ms`, `firstWordsMs`, `iterations`,
`toolsSearch`, `toolsFetch`, `toolsDoc`, `toolsMe`, `toolsButtons`, `files`, `filesImage`, `filesPdf`, `filesPlain`,
`filesOffice`, `fileKb`, `usageIn`, `usageOut`, `cacheRead`, `cacheWrite`, `model` (`opus-5-5`, or `opus-4-8` after a
fallback), `web` (`on`/`no_key`/`off`) and `knowledgeVersion`. `cf-prod-api` logs `help.ask_start` with the start
outcome. Never logged: the question, history, answer, file names or contents, URLs, search queries, the search key or
a presigned URL.

| Outcome | Meaning |
|---|---|
| `ask_ok` | Answered to the end. |
| `ask_budget` | The 110 s or 24,000-output-token budget ended it ("I ran out of time. Ask me to go on."). |
| `ask_stopped` | The owner tapped Stop. |
| `ask_gone` | The socket closed; the model stream was ended at once. |
| `ask_refused` | The model (and the Opus 4.8 fallback) declined; the panel shows "I can't help with that one." |
| `ask_refused_secret` | The typed question asked for a password, key, token or cookie contents: a fixed answer, no model call, its files deleted. |
| `ask_skills` | The skills could not load, so no model call; the panel used the §19 answer. |
| `ask_model_error` | Bedrock answered with an error (no access yet, throttled, 5xx). |
| `ask_model_timeout` | Bedrock did not answer in time. |
| `ask_bad_body` | The start body was not valid (400). |
| `ask_rate_limited` | Over 6 a minute, 60 an hour or 400 a day (429 with `Retry-After`). |
| `ask_off` | The kill switch or `ASK_ENABLED` is off (403 `help_off`). |
| `ask_error` | Anything else; the worker caught it. |
