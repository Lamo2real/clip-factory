## Add or change a guide

1. Edit `web/src/features/help/helpKb.json`: a stable kebab-case `id`, `title`, `keywords` (everyday words a child
   would type), `answer` (≤ 400 characters), `steps` (≤ 6, the UI's exact button names), `actions` (≤ 2, each with a
   `to` path that exists and optional `highlight` ids).
2. Add at least one question for it to `web/src/features/help/helpEvals.json` (`{ "q": "...", "expect": "<id>" }`).
3. Run `npm test` in `web/`. The generator refreshes the corpus first; the evals run in both the web and the API
   tests: `api/tests/test_help_evals.py` reads the same `helpEvals.json` from the repository, on top of its own
   `api/tests/fixtures/help/evals.json` ([TESTING.md](TESTING.md#ask-clip-factory)).
4. Plain words, no em or en dashes, no keys or infrastructure words (the sensitive-word filter drops them and a test
   fails).
