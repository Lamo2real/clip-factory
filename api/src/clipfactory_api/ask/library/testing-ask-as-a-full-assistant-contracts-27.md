## Ask as a full assistant (CONTRACTS §27)

* **api** (`uv run pytest`): `tests/test_ask_worker.py` replays recorded model turns (`tests/fixtures/ask/*.json`,
  `tests/ask_support.py` builds the documented stream events) through a fake Mantle client: the request shape (model,
  64000, adaptive thinking, explicit effort, no sampling, no forced tool choice, strict and eager tools sorted, skills
  → knowledge → rules with the 1-hour breakpoint, APP STATE as a system message after the question), a byte-identical
  prefix across two questions, events and delta order, the search → fetch → answer loop with citations and sources,
  buttons, the prompt-injection fixture, refusal, model errors before and after words, gone, Stop, both budgets, no
  skills, the secrets hold-back, files read and deleted on every exit, `.tfvars` redaction and logs without content;
  and the review fixes (files leave S3 before the model runs, Stop before tools, parallel tools, a tool cut at the
  budget, the heartbeat, the output budget's last round, `max_tokens` said as cut, his key hidden in answers, ordinary
  Terraform/email/link text kept, a key read error is `error`, server-side route checks, search URLs with a fragment,
  an earlier answer's sources, APP STATE without outside words, the setup state's next step, one slow read).
  `tests/test_ask_api.py` covers the routes; `tests/test_ask_parts.py` the file readers, the SSRF guard, Brave, the
  key cache, the secrets filter (also run through the Node generator, so both filters agree), the knowledge pack and
  the tools (and the review fixes: a private key across many deltas, long tokens held, office redaction, NAT64/6to4/
  Teredo, one fetch deadline, DNS timeout, the narrow refusal and its real Settings places, library parts, the pack's
  setup steps and routes, the 60 s key cache); `test_ask_api.py` also deletes files on 403/409/429/503 and takes
  history sources; `tests/test_skills_everywhere.py` checks that `.messages.stream(` only appears in `learn.stream_messages`.
* **web** (`npm test`): `test/askAssistant.test.ts` (formats, kinds, refusals, carried files, the markup model, the
  event reducer, the link rule, `runAsk` timeouts, fallback, 409 retry, uploads and Stop, chat memory, `trimHistory`,
  markdown tables; files taken away on every ending that did not start, Stop on a timeout, sources in the history,
  "3 files added"). `node scripts/ask-knowledge.mjs --check` runs in CI.
* **Playwright** (mock build, `CF_E2E_PORT` for a free port): `e2e/ask-assistant.spec.ts` (streaming, sources, live
  links, Open buttons, Stop, general questions, the setup question, web not set up, the key card, drop on the panel
  and the launcher, paste, the §19 fallback, thumb zone, overflow, edges, screenshots at 375, 390, 768, 1440 and 1920
  in light and dark, less motion) and `e2e/ask-markup.spec.ts` (draw, box, arrow, undo, clear, Save with red pixels in
  the sent JPEG, keyboard only, Escape, the thumb zone, less motion), in `chromium`, `webkit` and `webkit-phone`;
  `e2e/ask-review.spec.ts` (chromium: the phone tray stays one row, the desktop tray is capped, drop and paste on the
  editor stay out of the tray, focus stays on Send/Stop, ctrl+wheel never zooms the page, the drawing area role, Tab
  order, the radio tool bar, a lost pointer, no long-press menu, Redo on tablets, 44 px take-away targets, "3 files
  added", files taken away after a 429, a token question answered, the launcher glow, the Get a search key button);
  `edges.spec.ts` and `contrast.spec.ts` cover Ask's tray, file tiles, status line, sources, editor and key card.
  `CF_ASK_SCREENS=/some/folder` also saves the screenshots there. The older `help.spec.ts` and
  `help-pictures.spec.ts` turn the mock assistant off (`localStorage cf-mock-assistant = off`) to keep testing §19 and §26.
* **infra** (`terraform test`): `modules/ask` (function, async config, no reserved concurrency, environment, exact IAM,
  bare model ids), `modules/api` (the additions and no new routes), `modules/monitoring` (Ask alarms) and `envs/prod`
  (bare Opus ids in eu-north-1, the `ask-1-day` rule next to the existing ones).
* **Manual, once after deploy**: drag a file from Finder onto Ask in the Mac app (the native drop handler stays off),
  and one real question each with a picture, a PDF and a web search.
