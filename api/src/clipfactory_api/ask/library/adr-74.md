## ADR-74 Safety videos only from checked guidance; Lamo Stories' AI calls keep the skills block

- **Context.** The owner: "Safety-related educational content must be based on verified guidance. Do not generate
  potentially dangerous driving instructions without appropriate validation." Research on 2026-11-21 fetched road
  authorities' pages (UK Highway Code, National Highways, RoSPA, NY, California and Ontario driver handbooks, Transport
  Canada, Transport for NSW, Trafikverket) and found real disagreements (stay in the car or get out after a breakdown,
  neutral in a skid, braking with or without ABS). Separately, the owner's standing rule (§18, ADR-32) is that every AI
  call gets all his skills, "no matter what", and the repository's scan tests enforce it; the new request wants the
  workspaces' configurations independent.
- **Options.** Safety: (1) trust the model; (2) a model check only; (3) a checked guidance list bundled with the app,
  the writer allowed only its uncontradicted steps, then a separate checker call, and stories with problems held for
  the owner. Skills: (a) give Lamo Stories no skills (breaks the standing rule and its tests); (b) send the skills block
  first on every Lamo Stories call too, with the Lamo Stories brief after it, and report the conflict.
- **Decision.** (CONTRACTS §45.11.5, §45.7) Option 3, and a safety topic with no guidance cannot be produced. Option
  (b), reported to the owner, who can ask for Stories-only skills later.
- **Consequences.** Only 12 driving situations can be taught at first; adding one means adding checked sources. Some
  advice differs by country, so contradicted steps are left out and the video points to local rules. Lamo Clips'
  clip-making skills reach the story writer; they mostly help hooks and captions.
