## Money (earnings guesses)

Contract: docs/CONTRACTS.md §21. Money is always a **best guess**, so it never looks like a bank balance.

- **Words.** "Earned about $0.42", "This clip earned about $3.31", "No money yet", "Earned less than 1¢" (never
  "$0.00" for a tiny amount, never "about less than 1¢"), "Earned $0.00" (an exact $0 never says "about"). A $0 always
  comes with its plain reason ("TikTok only pays for videos 1 minute or longer.", "Turn this on in Settings › Money if
  YouTube pays you.", on cards "These apps are switched off in Settings › Money."). Ranges use "to", never a dash.
  Every money screen uses the same short app names: YouTube, TikTok, Instagram, Facebook, X.
- **Honest by default.** YouTube, Facebook and X start on, so the owner sees what each clip probably earns there, and
  every place that shows them says plainly "This only counts if you are in {App}'s paid program." followed by that
  app's "Who gets paid" words (`kidRules`). TikTok (Sweden is not eligible, and the clips are under 60 s) and Instagram
  (invite-only) start off: they show $0 with "Turn this on in Settings › Money if TikTok pays you." A switched-off app
  with views says what it would be ("If YouTube paid you, this would be about $0.42.").
- **Look.** A `coin` icon in `--green-ink`, numbers in `tabular-nums`, a small green "Best guess" tag that is visible
  wherever an amount above $0 shows (clip page, Library card, This week card and week total). Money lines sit
  on a light green tint inside the glass card; no vermilion (money is not the main action), no green "profit" colour.
- **Explain on demand.** "How is this worked out?" is a text button with `aria-expanded`; it opens the amount used
  per app (each mark on the same small dark round tile as Settings › Money, hidden from screen readers, so X reads
  "X:" once, never "X X"), the paid-program line under every app that is on, and a link button to Settings › Money. Hover changes the underline only; no cursor CSS.
- **Settings › Posting › Money.** Three glass panels: "Do I get paid here?" (one switch per app with a Yes/No word,
  and under every app that is on, an info line "This only counts if you are in {App}'s paid program." with its
  `kidRules`),
  "Money for 1,000 views" (a `$` box per app, **Save**, **Use the usual**, errors under the box), "Where the numbers
  come from" (Show/Hide per app: "Who gets paid" and "What counts" in plain words, never the platforms' jargon; source
  links at least 44 px tall with "Checked 16 Nov 2026" style dates on their own line). Each app's mark sits on a small
  dark tile so X's mark and the word "X" never read as "X X". Every row wraps at 320 px.
