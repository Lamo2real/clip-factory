## ADR-45 See-through glass over an app-owned backdrop

*Amended by
[ADR-87](#adr-87-the-logic-of-light-the-top-layer-is-brighter-every-lift-is-paid-for-reload-is-a-colourless-lens):
"no bone sheen" became "bone lifts paid for with green", and nested glass carries the relative raise. The no-edges rule
stands.*

- **Context.** The owner (2026-11-18): the app read as flat green, with no liquid, see-through glass: "make the
  entire application liquid glassy see-through, as I wanted before. You still should use these colors with the CTA and
  the green and the bone whites", and "for any edge in the application, wherever there might be, even the edge around
  a box ... make that transparent. No matter where it is, how many they are." The root cause was ADR-43's white
  ceiling: every panel was tinted for the worst backdrop anywhere (a white desktop), and the page added a 0.15 green
  veil and a frost on top, so on the web and on phones only 47 % of a near-flat green mesh showed through a panel, and
  the Colours look drew a 0.74 green veil over the whole screen.
- **Decision.**
  - *Veils are worked out against the backdrop the page really has.* Where the page draws its own backdrop (web,
    PWA, phones; see-through without native glass, and Picture before a picture), it is a known living mesh (deep teal,
    two vermilion glows, leaf, a breath of bone, two soft lenses, a darker field), and the panel tint is the least that
    keeps AA over its lightest corner: every blob subset × both field ends × every `saturate()` in the CSS. That is
    0.30, the new `PANEL_VEIL_FLOOR` (a pane reads as glass by its blur and shadow, not its tint). No page veil, no
    Clear frost. Colours split their need between the panels (up to 0.60) and the page. Picture: no page veil, 0.73
    panels.
  - *What content scrolls under still plans for white*: floating layers 0.73, the tab bar 0.59 (icons, 3:1), the
    question sheet 0.86. The window look (real desktop glass) keeps 0.73 until measured (Phase 2).
  - *One text set*, bone and lighter, in every look. Nested glass carries no tint. A green halo is comfort only.
  - *No edges anywhere.* Every border, outline, rim, inset line, hairline and ring is gone; controls read by their
    fill and chosen things by a soft glow. Allowed: the focus ring while `:focus-visible`, the found highlight and
    Ask's spotlight, progress bars and rings, the switch track, spinners, action blinks and text underlines. A unit
    test and an e2e scan of every screen enforce it.
- **Alternatives.** *A glyph rim (`-webkit-text-stroke`) as the AA mechanism*: WCAG does not treat a stroke as the
  text's background, it changes every word and breaks on emoji. *A stronger native tint*: squeezes the wallpaper's
  range. *A bone sheen in panels*: 4.48:1 over the worst panel, under AA. *Bounding the mesh by all blobs stacked*:
  wrong, because `saturate()` lifts a green-only subset more than a stack with vermilion, and sRGB mixing means the
  lightest corner is not always the one that needs the most green; the maths takes the largest veil over every corner.
  *Keeping 3:1 field boundaries for inputs by a lighter fill*: impossible with bone words at AA on a dark panel, so
  fields are told by a deeper well, their label and placeholder, and the focus ring.
- **Review follow-up (same release).** The grain over the living backdrop (bone noise in overlay, 0.1 × 0.55 at its
  peak) is in the maths now, so the panel tint there is 0.33, not 0.30. Tracks and the control fill carry panel + 0.15
  (was + 0.10): held over every spot, not only the lightest, a brown corner of the mesh and some owner colours needed
  more. Controls that sit straight on the page (the Library tabs) wear the control fill; the Ask launcher wears the
  floating layers' tint (it can rest on a white thumbnail); the Ask suggestions have a resting fill; refracting glass
  blurs before it bends (Chromium left the backdrop sharp the other way round); a text field tapped or clicked into
  shows a deeper well and a soft glow, the ring only after Tab; reduced transparency also raises the tab bar and the
  floating layers to 0.92; dark green words on bone never carry the halo.
- **Consequences.** About 67 % of the backdrop shows through every panel on the web and phones (47 % before), 100 %
  between panels (85 %); the default Colours look goes from a 0.74 page veil to 0 / 0.30. Supersedes the 0.45 floor
  of ADR-43. The Mac needs a measurement of the real bottle-green Liquid Glass before the window look's veils can
  change (CONTRACTS §22.2, Phase 2); nothing is stored differently, everything is worked out at read time.
