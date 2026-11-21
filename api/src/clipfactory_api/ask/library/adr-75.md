## ADR-75 Providers behind a registry: built-in today, AI images off until a real call works

- **Context.** The owner wants room for more image, video, animation and audio providers "without rebuilding", and no
  integration shown as working when it is not. Only Claude (writing) is set up today; Nova Canvas needs a call to
  eu-west-1; Nova Reel needs a bucket in us-east-1 and AI-realism labels the shared publishers do not set.
- **Options.** (1) Hard-wire the built-in engine; (2) a registry per kind (writer, images, animation, audio) with
  one interface each, the built-in providers on, Nova Canvas built and off, Nova Reel interface only.
- **Decision.** (CONTRACTS §45.11.6) Option 2. A provider is `on` only after a real call answered; the Providers list
  says in one sentence what each missing one needs.
- **Consequences.** The first videos are fully built-in. Switching on Nova Canvas adds AI portraits and painted
  backgrounds; Nova Reel stays out until the owner wants a US bucket and the posting labels are added.
