## ADR-58 One simple Review card: Use my settings, one row per place, TikTok's dropdown

Two taps for a standard upload; each platform's options in its own row; TikTok's privacy from a dropdown.

- **Context.** After ADR-57 the owner saw two platform bars on one card (the Upload to chips and the caption tab bar)
  and asked what the difference was. What he wants: tick the places, one button for his settings, a dropdown per
  platform (TikTok paid partnership, for example), one button to upload. ADR-57 had also removed the preset he asked
  for and replaced TikTok's privacy dropdown with a button bar, while TikTok's Content Sharing Guidelines ask for the
  privacy "from a dropdown" with no default.
- **Options.** (1) Keep the tab bar and add a preset button; (2) one collapsed row per ticked place holding its words
  and options, a server-side preset applied by one tap, and TikTok's controls in its row; (3) auto-apply everything,
  TikTok included, with no tap.
- **Decision.** (CONTRACTS §34) Option 2. `settings.postPreset` (additive, per owner, defaults: the most reach, never
  made for kids; the preset can never say made for kids) edited in Settings › Posting › My settings; confirm gains
  optional per-clip `options` for YouTube, Instagram and X, stored as post options and read by the publishers before
  the preset. YouTube, Instagram, Facebook and X use the preset from the start; TikTok's choices go on only with the
  owner's tap on Use my settings (his own action, as TikTok requires), so option 3 is out. TikTok's "Who can see it" is
  the app's own dropdown with no default, Everyone first. The caption tab bar is gone. The Ask launcher fades whenever
  it touches Upload or Use my settings.
- **Consequences.** A standard upload is Use my settings, then Upload to 4. The TikTok sheet stays for Library's Try
  again only. No table or infrastructure change: the preset is one more attribute on the settings item, written only
  when the owner saves; existing settings, clips and posts are untouched, and older clients post exactly as before.
