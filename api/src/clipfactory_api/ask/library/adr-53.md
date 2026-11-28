## ADR-53 Ask answers the picture: screenshot rules, the setup guide as a tool, keyless official pages, no canned fallback, a model smoke check on deploy

- **Context.** On 19 Nov 2026 the
  owner sent Ask a phone screenshot of Facebook's **Edit profile › Manage connection**
  sheet and asked "What do I do now?". He got "Jobs working right now: 0 … Open Jobs". The assistant never ran: iOS had
  dropped the WebSocket while he was in Facebook, the panel waited 4 s, fell back to the §19 keyword help *without the
  picture*, and BM25 matched the one content word "now" to "Is anything running right now". Even with the model, the
  prompt had no picture rules, treated a guide checked on 16 Nov as the truth about Meta's screens, and could not read
  official pages without a Brave key. Some guide steps were also out of date (Facebook "full control", "Go live", the
  Instagram business portfolio, no hint for **Manage connection**).
- **Decision.**
  - *No fake answers.* A question with files never goes to the keyword help. Without files, the short help answers
    only a real match; open questions ("What do I do now?", "I'm stuck") are unknown in both retrievers. Otherwise
    the panel says plainly that Ask could not answer, keeps the picture and words, and shows **Try again**.
  - *Reach the model more often.* The panel wakes a dropped socket and waits 10 s more. Model errors before any words
    (access not enabled, throttling, 5xx, timeouts) retry once on Opus 4.8; the owner then reads a plain reason and
    the log says which.
  - *Pictures first.* New rules 12 and 13: name the screen, find the step with the new `read_setup_guide` tool (the
    picture wins over his ticks), say if it looks done, give the next taps and a `setup-step:{platform}:{stepId}`
    button that opens and lights that step. Picture and setup questions run at effort `high`.
  - *The guide can be wrong about other sites.* Rule 2 keeps KNOWLEDGE as the truth for Clip Factory's own pages only;
    for Meta, TikTok, Google and X, his picture and the official page win, and Ask says "Our guide is out of date
    here." with the source.
  - *The web without a key.* Anthropic's server web tools are still not on Bedrock (only the Claude API and Claude
    Platform on AWS, ruled out in ADR-51), so `web_fetch` now opens a fixed list of official documentation pages
    (exact host plus path prefix, never posts, Pages, forums or link shims; query dropped; every redirect hop stays
    official or on the same host; 3 per answer) and every page a setup step opens, with no key and no link in the
    chat, behind the same SSRF guard. The kill switch's `web: false` stops all of it except links he typed. Open search of
    any site still uses the owner's Brave key, mentioned at most once, at the end.
  - *Proof on every deploy.* `cf-prod-ask` takes `{"smoke": "ask"}`: the deployed model must say "red" for a tiny red
    PNG sent as an image block. deploy.yml's smoke job invokes it with the deploy role (which already has `lambda:*`)
    and fails the deploy otherwise. Only the main model counts. Until the owner's one-time Bedrock step, an access
    or model-id-not-found error only warns, so unrelated merges stay green.
  - *Guides re-checked on 19 Nov 2026* for Instagram, Facebook, YouTube and X (docs/SETUP_POSTING.md lists the
    changes and sources).
- **Alternatives considered.** *Moving Ask to Claude Platform on AWS for server web search and fetch*: still not EU
  in-Region and a second billing account (ADR-51). *Scraping a search engine's result pages without a key*: brittle
  and against most terms. *An AgentCore browser tool*: new infrastructure, availability in eu-north-1 unverified; left
  for later. *Adding `ads_management`/`ads_read` to Instagram's scopes*: only needed when the Page sits in a business
  portfolio with a Business Manager role; making the portfolio optional avoids that path without a scope change.
  *Switching Instagram to "Instagram API with Instagram Login"* (no Facebook Page): simpler for the owner, but a new
  OAuth flow and publisher; a later ADR.
- **Consequences.** The deploy warns when Bedrock has not let Clip Factory use Opus 5.5 in eu-north-1 yet (an owner
  step in the Bedrock console: Model catalog, use-case form, one playground message) and fails when the model cannot
  see pictures. Picture and setup answers cost more (effort
  high). Ask can be wrong about a Meta page that only draws with script; it then says it could not read it and
  works from the picture and the guide.
