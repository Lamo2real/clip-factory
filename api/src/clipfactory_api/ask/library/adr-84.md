## ADR-84 Stories makers are lists of checked models, keyed hosts carry the owner's own keys, Clip Factory's app is shared only behind its reserve, and no account is ever shared

- **Context.** The owner asked to pick picture, video and sound models independently and to add models and providers
  without a rebuild, gave suggested efforts for small text edits (Low) and animation planning (High), kept the shared
  developer app on condition that Clip Factory is protected ("Keep it, protect CF"), and then made a hard rule that
  Funded Clips never posts to Clip Factory's accounts. Research on AWS's own model cards found Nova Canvas and Nova
  Reel ended on 2026-09-30, Stability AI's pictures and Luma AI Ray2 only in us-west-2, and no Bedrock sound or music
  model.
- **Options.** (1) One model per maker in the release file, as before; (2) lists of checked models per maker in
  `stories/config/models.json` plus the owner's own `MAKERDEF#` models, each called on Bedrock or a keyed host with
  the owner's key; (3) the same, plus a generic "any URL, any key" bridge for every kind. For sound: (a) Bedrock (none
  exists), (b) ElevenLabs on the owner's key for effects and instrumental music, with Amazon Polly as an opt-in spoken
  voice, (c) a text-to-speech narrator by default. For the shared app: (i) drop it, (ii) keep it with counters shared
  with Clip Factory, (iii) keep it with Funded Clips' own counters inside what Clip Factory's reserve leaves.
- **Decision.** (CONTRACTS §45.37) Option 2 with (b) and (iii). Ended models read ended with a one-tap replacement and
  are never called; Stability AI and Luma AI Ray2 are makers that are never the default (Luma behind the off-by-default
  `stories_video_west_bucket`); an added model is saved only when the agent can call it, and the access check costs
  nothing. Keys live in the existing provider-keys store; an OpenAI-compatible key is bound to one origin and the agent
  never sends it elsewhere. `text_edit` and `animation_plan` are tasks with Low and High. One shared-app counter for
  all of Funded Clips reserves Clip Factory's schedule plus headroom; a post with no room waits and goes out by itself.
  "Use it for both" is removed: an account that matches Clip Factory's by any stable identity is refused at connect
  and before every upload, and the match is remembered.
- **Consequences.** Every maker starts on the built-ins, with no voice; a real sound maker needs only the owner's
  ElevenLabs key and his pick; Luma AI Ray2 needs the Oregon bucket switched on and model access, then Try it. IAM
  changes are additive and in place (the agent's model checks, Polly, the Oregon bucket's grants; the story flow's
  Denys on provider keys and on Clip Factory's rate counters; one more attribute in each `ACCOUNT#` read). Clip
  Factory's own posting path and items are unchanged. If Clip Factory posts far more on X than its schedule, the
  month can pass the X limit by what Funded Clips spent; the card says so.
