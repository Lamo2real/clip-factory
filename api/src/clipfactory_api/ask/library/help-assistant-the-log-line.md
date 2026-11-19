## The log line

Each `POST /v1/help/answers` writes one JSON line, `event: "help.answer"`, with `requestId`, `outcome`, `mode`
(`kb` or `model`), the number of candidates and, after a model call, `usageIn` and `usageOut` (token counts; the log
filter drops any field whose name contains "token"). Never the question or the answer. A question with pictures adds
`pictures` (how many), `picKB` (their size in KB) and `look` (`read`, `off`, `limit`, `cap`, `deadline`, `timeout`,
`error`, `bad_output` or `stop_<reason>`); never the pictures, what was read from them (`words`, `seen`) or their
base64.

| Outcome | Meaning |
|---|---|
| `kb`, `model` | Answered from the composer, or rewritten by the model |
| `unknown`, `refused` | No good match, or a question about secrets or other people (no model call) |
| `kb_cap` | The 2,000 model answers for these 30 days are used up |
| `kb_deadline` | Too little time left in the request to start a model call |
| `kb_skills` | The owner's skills could not be read, so the model was not asked |
| `kb_model_error`, `kb_model_timeout` | The model failed or was slow (these feed the alarm `cf-prod-help-model-failures`) |
| `kb_ungrounded` | The model's answer named a button, page, step or number the matches do not contain, wrote a link or domain, or repeated a price the owner typed |
| `kb_bad_output` | The model's answer was not valid JSON or did not fit the schema |
| `kb_stop_<reason>` | The model stopped early (`max_tokens`, `refusal`, `content_filtered`) |
| `model_unknown` | The model judged that the matches do not answer the question, so the owner sees "I don't know that one yet." |
| `off`, `rate_limited`, `bad_request`, `unavailable`, `error` | Turned off, too many questions, a bad body, the corpus could not be loaded, or an unexpected error |
