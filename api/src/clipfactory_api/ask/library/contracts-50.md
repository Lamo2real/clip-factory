## 50. What a job's AI cost (owner request, 2026-11-25)

The owner: "when a job is finished, I want to know the exact amount that Fable cost me, and the entire process in terms
of AI usage, so tokens spent. The cost of the tokens is what I want to know at the end of a job."

- **A1. Real usage, no extra calls.** Every model answer a job gets is counted from the answer itself: Bedrock
  Converse `usage` (input, output, cache read, cache write tokens) in `agent/.../bedrock.py` (so the moment fallback,
  the second look, the checklist, captions, the picture watching by Fable and Nova 2 Lite and the layout look all
  count), the Agent SDK result's usage for picking moments, Titan's input token count, and Transcribe's audio
  seconds. A copy of a clip ("Make a copy") is a job and counts the same way. Recording is bookkeeping only.
- **A2. One price list.** `pricing` in `config/models.json`, the only place prices live: US dollars per million input,
  output, cache read and cache write tokens per model, Titan, and Transcribe per minute, each with its source, plus
  `checkedOn`. Prices come from AWS's published price lists for eu-north-1 (Anthropic's page agrees for Claude). A
  line that cannot be confirmed has `confirmed: false`: the job shows its tokens, "price not known", and the total as
  "about". `approximate: true` (Haiku 5.5 costs more above 100,000 prompt tokens) also shows "about".
- **A3. Stored on the job, additive.** `Job.aiCost` `{v, models: [{key, label, calls, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, tokens, dollars?, estimated}], transcribe?: {seconds, minutes, dollars?,
  estimated}, totalTokens, totalCalls, totalDollars, estimated, pricesChecked}`. It is written with the job's own
  writes (heartbeat, ready, failed, canceled), so a failed or stopped job shows what it spent so far. A retry or
  resume adds to what the earlier runs wrote. Old jobs and jobs that never called a model have no `aiCost`: nothing
  is shown, never zeros. The API passes it through as it is.
- **A4. Not counted.** Ask, the weekly learning, lessons, campaign rules and the post-publish distil run in the API
  Lambdas, not inside a job, so they are not in a job's cost.
- **A5. The app.** The job page has one glass block, **What this cost**: the total in dollars (to the cent) large, the
  exact tokens under it, and a fold **See the details** with a row per model (calls, tokens in and out, dollars) and
  Transcribe's minutes. The numbers roll (§49). A failed or canceled job says "so far"; an estimate says "about" and
  the prices' date. The Jobs list shows the total next to the clip count of a finished job. No sparkle icon.
- **A6. Where there is no total.** Money and Home have no natural place for "AI cost this month" (they show
  earnings), so there is none.

Tests: `agent/tests/test_usage.py`, `web/test/aiCost.test.tsx`.
