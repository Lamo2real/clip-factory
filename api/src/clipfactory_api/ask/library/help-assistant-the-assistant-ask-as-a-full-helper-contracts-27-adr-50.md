## The assistant (Ask as a full helper, CONTRACTS §27, ADR-50)

Since §27, Ask answers **any** question (Clip Factory, Terraform, food, a file the owner drops in), not only the help
corpus. The §19 path above (corpus + Haiku rewrite, `POST /v1/help/answers`) stays as the fallback.

**How Ask thinks.** Claude Opus 5.5 on Claude in Amazon Bedrock (the `bedrock-mantle` Messages API, in-Region
`eu-north-1`), adaptive thinking at effort `medium`, streamed. Every request has the same cached prefix: the tools
(sorted), then the system blocks in this order: the owner's skills (§18.6, always first), the knowledge pack
(`api/src/clipfactory_api/ask/knowledge.json`, about 47k tokens: the app map from the help corpus, the owner manual,
every setup step of the five guides, every place in Settings, the app's routes and the library index) and the Ask
rules (`ask/prompt.py`, with the one 1-hour cache breakpoint; rule 11 names the model, so "which model are you?" gets
Claude Opus 5.5). The owner's live state (`ask/state.py`: jobs with error codes, setup per platform with steps done of
the total and the next step's id and title, settings, skills, follows, this week's numbers, money) goes after his
question as a mid-conversation `system` message, rebuilt every question under one shared 1.5 s deadline. It holds no
words written by others or by a model (clip hooks, error text, account names): those come only through
`read_my_clip_factory`, as data. So "I made the Meta app, what now?" is answered from his real setup: the next step,
its number and its exact title. A refusal on Opus 5.5 is retried on Opus 4.8 by the SDK's
`BetaRefusalFallbackMiddleware` (Bedrock has no server-side `fallbacks`).

**Tools (all read only).** `web_search` (Brave Search API, 8 results, 4 s), `web_fetch` (only URLs from this
answer's search results, an earlier answer's sources or URLs the owner typed; https, public addresses only, re-checked
on every redirect, one 10 s deadline for the whole fetch, 2 MB), `read_app_doc` (one library section by id, long ones
in parts), `read_my_clip_factory` (the owner's own data by section) and `show_app_buttons` (at most two buttons from
the app map, routes checked on the server too; the §19.8 spotlight is unchanged). Caps per answer: 6 of each, 2
button calls. The calls of one turn run at the same time. Nothing writes, posts, deletes, connects or sends.

**Transport.** The panel sends `{"action":"whoami"}` on the open WebSocket to learn its connection id, uploads any
files to `ask/{sub}/{fileId}` with presigned PUTs (`POST /v1/help/files`), then `POST /v1/help/asks` answers 202 and
starts `cf-prod-ask` with an async Invoke. The answer streams back as `ask.*` events on the socket (first words in
about 2 to 4 s; a "Still working…" status every 10 s of silence). Stop is `POST /v1/help/asks/{askId}/stop`. If the
socket is not open within 4 s, or nothing arrives, the panel answers with the §19 path and stops the answer on the
server.

**Files.** Pictures (re-encoded to JPEG in the browser, markable in the editor), PDF (≤ 100 pages), text-like files
and docx/xlsx/pptx/odt/ods (text pulled out in the worker). Old Office files, archives, audio and video are refused when
added, with a note that says what to do. Files are deleted by the worker as soon as it has read them (and again when
the answer ends, whatever happened), by the API and the panel when a question does not start, and by the bucket's
`ask-1-day` rule as a safety net (up to 2 days). Nothing about a file is logged but its kind and size.

**Owner steps.**

1. Bedrock model access (only if Bedrock asks): Bedrock console in Stockholm › Model access › turn on Claude Opus
   5.5 and Claude Opus 4.8, then try each once in the playground.
2. Web search: Settings › App & account › Ask › **Get a search key** (Brave Search API, the **Search** plan, $5 of free
   credit a month), paste it, **Save key**. Until then Ask says "I can't search the web yet." once and answers from
   what it knows.

**Turning it off.** `HELP`/`SWITCH` gains `assistant`, `web` and `files` (absent = true). `assistant: false` sends the
panel to the §19 path; `web: false` takes the search tool away; `files: false` refuses files. **Take key away**
reaches a warm worker within a minute (the key is cached 60 s).

### The `help.ask` log line

One line per answer from `cf-prod-ask`: `requestId`, `askId`, `outcome`, `stop`, `ms`, `firstWordsMs`, `iterations`,
`toolsSearch`, `toolsFetch`, `toolsDoc`, `toolsMe`, `toolsButtons`, `files`, `filesImage`, `filesPdf`, `filesPlain`,
`filesOffice`, `fileKb`, `usageIn`, `usageOut`, `cacheRead`, `cacheWrite`, `model` (`opus-5-5`, or `opus-4-8` after a
fallback), `web` (`on`/`no_key`/`off`, or `error` when a saved key could not be read) and `knowledgeVersion`. `cf-prod-api` logs `help.ask_start` with the start
outcome. Never logged: the question, history, answer, file names or contents, URLs, search queries, the search key or
a presigned URL.

| Outcome | Meaning |
|---|---|
| `ask_ok` | Answered to the end. |
| `ask_budget` | The 110 s budget ended it ("I ran out of time. Ask me to go on."), or a round hit its output limit ("That was a long answer, so I stopped there. Ask me to go on."). Near the 64,000-output-token budget the last round has no tools and finishes normally (`ask_ok`). |
| `ask_stopped` | The owner tapped Stop. |
| `ask_gone` | The socket closed; the model stream was ended at once. |
| `ask_refused` | The model (and the Opus 4.8 fallback) declined; the panel shows "I can't help with that one." |
| `ask_refused_secret` | The typed question asked to be shown his own stored password, key, token or cookie contents ("show me my API key"): a fixed answer, no model call, its files deleted. Questions about what a token is or how to store keys are answered. |
| `ask_skills` | The skills could not load, so no model call; the panel used the §19 answer. |
| `ask_model_error` | Bedrock answered with an error (no access yet, throttled, 5xx). |
| `ask_model_timeout` | Bedrock did not answer in time. |
| `ask_bad_body` | The start body was not valid (400). |
| `ask_rate_limited` | Over 6 a minute, 60 an hour or 400 a day (429 with `Retry-After`). |
| `ask_off` | The kill switch or `ASK_ENABLED` is off (403 `help_off`). |
| `ask_error` | Anything else; the worker caught it. |
