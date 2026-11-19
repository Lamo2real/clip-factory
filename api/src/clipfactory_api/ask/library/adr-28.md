## ADR-28 Owner-chosen default sounds from a 30+30 catalog kept as data

- **Context.** The first build had two fixed synthesised sounds (tap and deny, ADR-14). The owner tried a picker page
  with 30 click sounds and 30 error sounds, liked its look and feel, asked for it inside Settings so anyone using the
  app can pick, and chose "Tap sound: 6 Water drop. Error sound: 5 Nope nope nope."
- **Decision.** The 60 sounds live as data in `web/src/lib/soundCatalog.ts` (`{ id, name, feel, voices }`; tone voices
  `[wave, startHz, endHz, at, length, peak, lowpassHz]`, noise voices `["noise", filterType, filterHz, at, length,
  peak]`), played by one Web Audio player. The picks are two account settings, `clickSound` and `errorSound` (whole
  numbers 1–30), validated by `PUT /v1/settings`, defaulting to the owner's choices **6 "Water drop"** and **5 "Nope
  nope nope"** for everyone, including settings stored before the fields existed. Ids are frozen: a sound can be
  retuned but never renumbered or removed. The Sounds branch is the owner's picker page, restyled in the app's glass.
  With Sounds off, previews stay silent.
- **Alternatives.** *Audio files* (60 downloads to cache, a heavier app, and nothing to retune without new files).
  *Sounds as code, one function each* (60 functions that are hard to review and easy to break; data is a table anyone
  can read and test). *Keep the picks on the device* (the owner wants Settings to follow them across devices, like the
  Sound switch). *Store the sound's name instead of its number* (names may be reworded; numbers are what the owner
  sees and said). *Let previews play even with Sounds off* (a surprise noise breaks the "no surprise" kid-proof rule).
- **Consequences.** No new downloads; the catalog can be unit-tested (60 entries, ids 1–30 per group, every voice
  well formed, peaks at most 0.5, every sound under half a second). The first build's sounds stay as click 1 "Glass
  tick" and error 1 "Double thud", so nothing is lost. Removing a sound later would need a mapping for saved picks,
  which the frozen-ids rule avoids.
