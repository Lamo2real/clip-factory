## ADR-88 The sound samples are rendered ahead of time from the renderer's own synth

- **Context.** The owner (2026-11-23), on a character's Sounds tab: "id like everything here to be in samples so i can
  here what each sounds like". The videos' sounds come from one numpy synth in the stories agent
  (`stories/agent/.../audio.py`, CONTRACTS §45.11.3), with no audio files; the web had nothing to play.
- **Options.** (1) A TypeScript copy of the synth in the browser (Web Audio): two synths to keep equal, and what he
  hears drifts from the videos. (2) An API route that renders on demand: new infra, a wait on every tap, and Lambda
  time. (3) Render every sample ahead of time with the agent's own synth into small files the web serves.
- **Decision.** (CONTRACTS §45.40) Option 3. `python -m lamostories_agent.samples` renders each effect and each noise
  (both voices at all 31 pitch stops) as one event through `audio.mix`, the videos' chain without the final loudnorm,
  then mono, the end silence trimmed, one library gain (2.28, the loudest at -1 dBFS, so the files keep the videos'
  levels against each other) and a 64 kbps MP3: 705 files, 4.07 MB, under `web/public/sounds/stories/<recipe>/`.
  `recipe` hashes the tokens of audio.py and samples.py (comments do not count; `ast.dump` was not used because its
  text changes between Python versions) and the settings, so a changed synth is a new folder name that also gets past
  the 1-hour browser cache. The web plays them with Web Audio, one at a time, from a play button beside each chip;
  tapping a chip still only picks it.
- **Consequences.** No infra and no API. The repo holds 4 MB of MP3s; the service worker never precaches
  `public/sounds/`, so neither app's install grows. `test_sound_samples.py` fails while the files are stale (the
  recipe, the file list, and PCM spot renders against the manifest), and ci.yml runs it when the files or
  `samplesRoot.ts` change: after a change to audio.py, run the generator (it needs ffmpeg) and commit its output. The
  samples are the built-in synth's; when the workspace picks another effects maker the part says "Effects may sound a
  bit different in videos."
