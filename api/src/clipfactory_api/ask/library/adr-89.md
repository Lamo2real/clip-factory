## ADR-89 A car of the cast is a car prop with a castId, kept in its own `cars` map

- **Context.** The owner (2026-11-23) wants a character that is a car, made in cartoon style from real photos, picked
  among several generated cars, for a series "where its a guy buying a car and then driving it for the first time",
  with the main character. The built-in animator had people only (`cast`), and cars only as plain props.
- **Options.** (1) Make a car an actor in `cast`: every people part (geometry, motion, faces, bubbles, noises) would
  branch on the kind. (2) Keep `cast` people only and put the cast's cars in a separate `script.cars` map; a car prop
  with `castId` is drawn as that car, with its own `CarLook`. Also: (a) one model call per option, or (b) one call
  that makes 3 options, so the photos are sent once.
- **Decision.** (CONTRACTS §45.41, §45.42) Option 2, with (b). Two kinds: person and car ("an animal" and "a thing"
  need rigs of their own and are follow-ups). A car is drawn by `engine/car.ts` in the side and top views (8 bodies,
  paint patterns, windows with riders behind the glass, wheels, lights, optional eyes on the windscreen or in the
  headlights, off by default) and moves by prop actions (the new speed_up, bounce, honk, blink and stall). Plates are
  plain and badges never drawn: the engine has no text shapes, the prompt forbids makes and models, and the checker
  strips a brand that gets through. A cast is 1 to 3, at most one car and someone to drive it.
- **Consequences.** People code and old scripts are unchanged; the shape goldens keep every prim (only
  `ENGINE_VERSION` goes 5 to 6). The writer and the idea agent get the car as a cast entry with words, never a look.
  `CHAR#` gains `kind` and `car` (a missing kind is a person). A car design costs one call for 3 options, a person
  design what it cost before. A car is a character, so it lives in Characters with a Car tag (the first build's own
  Cars rail page made 12 pages and 32 px rows; the review took it out): the rail keeps 40 px targets.
