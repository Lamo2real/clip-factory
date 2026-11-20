## ADR-61 Chat hype from replay where it is public, from the picture where it is not; never a reason to fail

- **Context.** The owner asked that a streamer's chat scrolling very fast, or flooding with one word, count as a sign
  of a viral moment. Chat is the crowd's loudness spike, but it lags the moment by a few seconds and is noisy (raids,
  giveaways, sub trains, bots, chat-only memes).
- **Options.** (1) Twitch Helix: has no VOD chat. (2) Paid third-party scrapers: cost, and chatter data leaves our
  control. (3) Twitch comments by cursor: needs a `Client-Integrity` token; we will not make or replay one. (4) OCR of
  on-screen chat: too costly for a speed signal. (5) Fold chat into `Signals`: it would bring the picture rules into
  the prompt when only chat exists. (6) Public replays where they exist (YouTube live chat via yt-dlp, Twitch comments
  by time offset, one Kick probe) plus a cheap chat box speed meter on the picture we already decode.
- **Decision.** (CONTRACTS §37) Option 6. Chat is its own optional field (`Brief.chat`, `chat.json`), shifted back by
  a lag learned from the loudness spikes, with code-level flags for raids, giveaways, subs and bots, and a skill block
  for what code cannot see (memes unrelated to the screen). Twitch GraphQL is undocumented and a terms grey zone: read
  only, low rate, offset paging only, stops for good on any integrity check, with a kill switch.
- **Consequences.** Twitch chat goes quiet if Twitch extends integrity checks to offset paging; Kick from AWS is
  nearly always blocked, so Kick and uploads mostly rely on the chat box; Mac-fetched or blocked YouTube jobs get no
  replay. The chat box finder can miss odd overlays (then there is no chat, which is safe). Bedrock cost under $0.05
  a job; the image grows by numpy. No infrastructure or owner data change.
