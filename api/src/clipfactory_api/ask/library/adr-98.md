## ADR-98 A vehicle's likeness is a measured outline plus named parts in one optional `detail` object

- **Context.** The owner wants the cartoon vehicle to be recognisable as the real model in the photos, "overboard
  with the realistic part", still cartoon and animated (CONTRACTS §45.48). Saved vehicles must not change, and the repo
  forbids any make, badge or logo.
- **Options.** (1) A library of about 45 model-like rows with a morph: strong near a row, 45 rows to hand-tune.
  (2) A free traced outline of about 20 points: closest in a picture, but self-crossing traces, side view only, parts
  float. (3) 35 whole-number landmarks (nose, windscreen, roof, deck, tail, axles, belt) plus named parts.
- **Decision.** Option 3, in one optional `CarLook.detail` object with a master switch: absent draws byte for byte as
  before; present uses a second drawer. One rules table in `carDetail.ts` is the source (the API reads a generated JSON
  copy, the agent reads the engine's catalog), `fitProfile` makes any in-range numbers drawable, presets are frozen
  under `v` 1, the options of a design are the same vehicle at different cartoon levels, and the budget is measured.
  `ENGINE_VERSION` stays 7.
- **Consequences.** About 2,500 new lines beside the classic drawer, which never gains detail. The AI's numbers from a
  photo can be off by a few points, so presets, a `study` step, four example profiles and the clamp carry the risk.
  Motorbike, plane and boat outlines and the second look are follow-ups. Amends
  [ADR-97](#adr-97-video-drafts-are-their-own-item-vehicles-are-car-bodies-shown-as-vehicles-roles-are-additive-fields)
  only for how a vehicle is drawn.
