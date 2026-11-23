## ADR-80 Video generation is configured apart from the reasoning models; the built-in animator first

- **Context.** The second request separates reasoning models from image, video and audio generation and says an LLM
  cannot make a video by itself. Only Amazon Bedrock is set up; Nova Reel writes to a bucket in us-east-1 and makes
  realistic footage, which the platforms want labelled.
- **Options.** (1) The built-in 2D animator only; (2) add Nova Reel now, its US bucket always on; (3) a provider
  registry per kind, the built-in animator on, Nova Reel built behind a Terraform switch for its US bucket (off until
  the owner allows US storage), AI labels set by Clip Factory Stories' own publisher wrappers, and a generic key store for
  providers added later.
- **Decision.** (CONTRACTS §45.31) Option 3.
- **Consequences.** Videos are made today with the built-in animator; AI footage arrives when the owner allows the US
  bucket and enables the model; no external provider is claimed as working until one is added and checked live.
- **Amended by ADR-84 (2026-11-22).** Amazon ended Nova Reel and Nova Canvas on 2026-09-30: they read ended, and
  Luma AI Ray2 (us-west-2, behind `stories_video_west_bucket`) and Stability AI are the AI makers (§45.37 G7).
