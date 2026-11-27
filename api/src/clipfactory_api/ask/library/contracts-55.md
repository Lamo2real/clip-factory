## 55. Your take: every clip gets a short comment of its own (owner request, 2026-11-27)

Platforms show plain re-uploads to fewer people, so each clip carries the channel's own comment. BR-36, ADR-111.

- **T1. The field.** The model writes `take` with each moment: one sentence in the clip's language, 5 to 14 words, at
  most 90 characters. It is the channel's opinion, verdict or context: something the viewer cannot see. It never
  describes the picture, repeats the hook or spoils the payoff; no emoji, hashtags, @handles or all caps; honest, never
  cruel, no claims about real people beyond the clip. Code (`moments.clean_take`, `take_problem`) strips emoji and
  control characters, collapses spaces, and refuses a take outside 4 to 16 words, over 90 characters, with `#` or `@`,
  or in all caps: the take is blanked and the moment is always kept (the agent's tool also tells the model why, so it can
  send the moment again with a better take). `MOMENTS_VERSION` stays 1: a
  saved moment without `take` reads as none.
- **T2. Settings (additive).** `takeOn` (default true), `takeVoice` (default true), `takeStyle` (default `""`; mojibake
  repaired, unseen characters dropped, spaces collapsed; over 120 characters is a 400; a non-boolean switch is a 400).
  The agent reads all three (`store.SETTINGS_DEFAULTS`). `takeStyle` reaches the model inside `<owner_style>`, as
  style, never as instructions.
- **T3. No take.** When `takeOn` is false, on a campaign job and on a campaign copy: none is asked for, drawn, spoken
  or stored. The campaign picture of §53 and §54 is unchanged.
- **T4. On screen.** One extra ASS event in `render.build_ass`, style `Take`: Inter Bold 46 (smaller over 54
  characters, never under 30), white on a 60% black box, at most 2 lines between x = 60 and x = 908, its bottom on
  y = 1168 (above the caption band, below the facecam). It shows from 0.4 s after the tease for
  max(4 s, voice + 0.8 s), never past 0.2 s before the end; with under 1.5 s of room it is left out. Hook and captions
  are unchanged, and a clip without a take renders byte for byte as before.
- **T5. Spoken.** With `takeVoice` on, `voice.py` asks Amazon Polly (`SynthesizeSpeech`) for an mp3, with the engine,
  voice and region from `takeVoice` in `config/models.json` (neural, Matthew, `eu-west-1`: `eu-north-1` has no neural
  voice). The voice starts with the text; the clip's own sound drops to about 30% under it, with short fades, and the
  loudness pass (§8) levels the result. Matthew speaks English, so a clip in another or an unknown language gets the
  text only. **Any voice failure (refused, region, timeout, empty sound, a mix ffmpeg rejects) never fails the job:**
  it is logged and the clip is made with the text only. One Polly call per take per job. Its letters and dollars are
  in the job's cost (`aiCost.voice`, §51) at the confirmed price, so the cost stays exact.
- **T6. Stored.** Clip fields `take` (only when not empty) and `takeSpoken: true` (only when the voice is in the
  file), both public. The IAM statement `SpokenTake` on Clip Factory's agent role allows `polly:SynthesizeSpeech` in
  `eu-west-1` only.
- **T7. Post text.** The captions prompt is given the take and told not to repeat it.
- **T8. Review.** Under the hook, one quiet read-only line: the small label "Your take" and the text (`user-text`).
  Nothing when the clip has none. It cannot be edited per clip yet.
- **T9. Settings › Clip making › Clips.** Three apples after `ai-model`: `your-take` (switch, "Your take"),
  `take-voice` (switch, "Say it out loud") and `take-style` (one line, "How you talk", 120 at most, saved on blur and
  0.8 s after typing stops; a save that fails leaves the typed words in the field). The last two are hidden while Your take is off.
- **T10. Tests.** `agent/tests/test_take.py`, `test_voice.py`; `api/tests/test_settings_and_system.py`,
  `test_clips.py`; `web/test/yourTake.test.tsx`; `infra/modules/agent/tests/runtime.tftest.hcl`.
