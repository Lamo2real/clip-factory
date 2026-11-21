## ADR-74 Safety videos only from checked guidance

- **Context.** The owner: "Safety-related educational content must be based on verified guidance. Do not generate
  potentially dangerous driving instructions without appropriate validation." Research on 2026-11-21 fetched road
  authorities' pages (UK Highway Code, National Highways, RoSPA, NY, California and Ontario driver handbooks, Transport
  Canada, Transport for NSW, Trafikverket) and found real disagreements (stay in the car or get out after a breakdown,
  neutral in a skid, braking with or without ABS).
- **Options.** (1) Trust the model; (2) a model check only; (3) a checked guidance list bundled with the app, the
  writer allowed only its uncontradicted steps, then a separate checker (the quality agent), and stories with problems
  held for the owner.
- **Decision.** (CONTRACTS §45.11.5) Option 3, and a safety topic with no guidance cannot be produced. (This ADR first
  also kept Clip Factory's skills block on Lamo Stories' calls; the owner's second request settled that the other way:
  ADR-78.)
- **Consequences.** Only 12 driving situations can be taught at first; adding one means adding checked sources. Some
  advice differs by country, so contradicted steps are left out and the video points to local rules.
