## ADR-43 Bottle-green glass, bone words, vermilion actions

- **Context.** The owner asked (2026-11-18) to "refactor the entire application ... every single UI thing we have is
  going to be tailored towards these colors. It's still going to be liquid glassy ... the CTA should be still orange,
  and all CTAs should be orange. The font style could be the same, but the colors should change." The new colours are
  Bottle Green `#0F372B`, Bone `#EFE7DA` and Vermilion `#E8392B`, used like a dance-theatre reference page: a deep
  green field, bone serif headings and small bone navigation, bone hairlines, a bone outlined circle-arrow button, and
  vermilion as the one loud colour. They replace Sage `#9CAF88`, Off-white `#F7F5EF`, Tomato `#E8412C` and ink
  `#1E2A1B` (the design summary in CONTRACTS.md §11). The full design record is
  [theme-bottle-green.md](theme-bottle-green.md).
- **Decision.**
  - *Green is the surface, bone is the words and the lines, vermilion is the action.* Every glass tint, veil and scrim
    is bottle green; every text colour is light (`--ink` is bone); hairlines and rings are bone. The glass recipe
    (blur, saturation, lit rim, refraction), `<Glide>`, motion, celebrations, sounds and fonts are unchanged.
  - *Every action is the vermilion CTA.* `.btn--primary` (the screen's one main action) and the new `.btn--action`
    (every other action: the setup step's "I did this", Copy, Paste, "Use the example", the Ask panel's actions and
    Send) wear the same fill. The fill is vermilion a shade deeper (`rgb(206 48 36)` → `rgb(184 38 28)` at 0.97) so
    the white label reaches 4.96–6.03:1; white, bone and green on raw `#E8392B` are 4.16, 3.39 and 3.15:1. The "one
    main action per screen" rule stays for `.btn--primary`. Secondary buttons are bone-outlined glass; the selected
    item of every pick-one bar is a bone pill with green words.
  - *The contrast maths changes direction.* With light words the hardest backdrop is the lightest, so
    `lib/background.ts` plans for white behind every native glass (`glassCeiling`) and keeps the floor as a second
    check. Window look panels: Clear 0.73, Frosted 0.88 over a 0.30 frost. Picture: a 0.35 green veil and 0.65 panels.
    Colours: the lightest colour decides (the default needs 0.74). The Clip Factory colours become a dark green mesh,
    so panels there stay at 0.45. Fills under words are never lighter than their panel; every vermilion dot on glass
    has a bone ring.
  - *The desktop tint follows, the theme does not.* `GLASS_TINT` becomes `Color(15, 55, 43, 140)`. Readability does
    not depend on it (a tint can only darken a white ceiling), so no new measurement is needed; `Theme::Light` stays
    because the light material is the one that was measured.
  - *Owner data: read-time only.* The default background colours become `["#0f372b", "#efe7da", "#e8392b"]`. A stored
    value that is exactly the old default trio, in order, reads as the new default (the web's cached `cf.prefs` copy
    too); there is no migration job, the mapped value is written only when the owner next saves settings, as every
    default is, and every other choice (a reordering or subset too) is kept. The swatches add Bottle green, Bone and Vermilion and
    keep Sage and Cream, so an old pick keeps its name. Nothing in `infra/` changes.
  - *Icons follow.* The app icon becomes a bone italic "C" with the vermilion dot on bottle-green glass; the PWA
    theme colour and background are `#0F372B` and the page asks for `color-scheme: dark`.
- **Alternatives.** *Bone glass with green words* (the reference inverted): the window panels could stay thinner, but
  the app would read cream, not green, against the owner's "tailored towards these colors". *A green halo around the
  words* instead of a heavier panel: neither axe nor the rendered-contrast scan credits a text shadow, so it could not
  be held to the AA bar. *Only `.btn--primary` vermilion*: the owner asked for every CTA.
- **Consequences.** In the window look Clear panels carry 0.73 green (27% of the desktop shows through panels; the
  gaps still show all of it), heavier than the 0.44 of the light look, because a white desktop is now the hard case.
  Every colour test was rewritten for the new direction. The owner may want to re-upload the new 1024 px icon as the
  TikTok and Facebook developer-app icon; that is optional.
