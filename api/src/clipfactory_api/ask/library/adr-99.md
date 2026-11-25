## ADR-99 Night drive's people are chunky

- **Context.** More shape for the owner's character, still cartoon (CONTRACTS §45.49). Poses, the camera and every
  saved character hang on `geometry()` and the stored `CharacterLook`, and a night person is at most 92 prims.
- **Options.** Three looks drawn from the real engine: Soft (same build, shaped parts), Tall (new proportions, a neck)
  and Chunky (bold toy-like shapes, joints unchanged). Reviewers scored appeal, phone readability and animation safety.
- **Decision.** Chunky, picked by the owner. Only night drive's drawing changes; `geometry()`, `motion.ts`, `scene.ts`,
  `shots.ts` and `CharacterLook` stay; joined same-colour shapes pay for the detail inside the same budgets.
- **Consequences.** `ENGINE_VERSION` 8 and new goldens; Bright and old scripts without `art` are unchanged; the bust
  body and wheel hands are partly today's drawing (§45.49). Amends
  [ADR-93](#adr-93-night-drive-is-a-drawing-style-in-the-one-engine-an-art-field-cuts-between-shots-surface-drawing-only)
  only for how a person is drawn.
