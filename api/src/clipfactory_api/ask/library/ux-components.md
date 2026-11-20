## Components

| Component | Notes |
|---|---|
| Button (primary) | Vermilion glass pill, icon + white text, 48 px tall minimum. One per screen (the update bar's Reload is the only extra). |
| Button (secondary) | Glass pill with a bone outline and bone text (the reference's outlined circle-arrow). |
| Button (quiet) | Text only with an underline on hover. |
| Card | Glass, `--r-md`, padding 16–24 px, `min-width: 0` so children can shrink. |
| Hero card | green glass, display headline with swash, primary CTA. |
| Stat block | Three numbers with labels, tabular figures. |
| Link input | Large pill input, shows the detected platform icon (YouTube, Twitch, Kick) as you type. |
| Upload drop zone | Dashed glass area, drag and drop on desktop, tap to pick on phones, progress bar while uploading. |
| Job progress | The ten steps as a vertical list with status icons; the running step pulses; the overall progress bar on top. |
| Clip card | 9:16 cover with play, hook, moment-type chip, score, duration, checklist summary. In Library it shows total views when measured and its whole top (cover and hook, never just the one-line hook) opens the clip's [performance page](#clip-performance-page); its post rows list the platforms in the one app-wide order and use the clip page's status words ("Posting", "Waiting for connection"); in Review a kept clip shows "See how it does". |
| Clip review | Vertical player, checklist, **Upload to** chips (only places that are set up; any number on; §33), captions per chosen place in tabs (editable), Upload (primary, "Upload to 4") and Throw away (ghost). All five caption tabs stay in sight: on a narrow card the tabs that are not open show only their platform mark, and a tab whose caption is too long shows a red dot. Two columns only when the card itself is at least 820 px wide, with the video on the card's vertical centre line, scrolling with the page (never sticky); once Throw away and Keep wrap, each fills the row. Overlays opened from a card (Post to TikTok, the small confirm sheet) are drawn on `document.body`, trap Tab and give the focus back on close (CONTRACTS §12.4, §17.8). |
| Skill row | Glass row that opens the skill's page: icon, title, description (two lines), **Always used** badge (green, on every row) and **Built in** badge, then where it came from in words (never ".md" or a size): "Written by you · Changed 16 Nov", "From a file · Changed 16 Nov", "From a file with extra files · Changed 16 Nov" (a `.zip`; its page says "From a file with {n} extra files") or "Comes with Clip Factory". No switch, no delete on the row. See [Skill pages](#skill-pages). |
| Toggle, select, inputs | 16 px text, glass background, vermilion focus ring `outline: 2px solid var(--vermilion); outline-offset: 2px`. |
| Toast | Glass, top on desktop, above the tab bar on phones, auto-hides after 4 s, `role="status"`. The Undo toast stays 8 s and shows a shrinking ring around its Undo button. |
| Empty state | One line of serif italic, one plain sentence that names the button to tap, one action. |
| Job status pill | Waiting (neutral), Working (green), Ready (ink), **Didn't work** (vermilion, never "Failed"), Canceled (neutral). The job's own error sentence says how to fix it and is shown in full, in the Jobs list too. |
| Error | Plain sentence, what to do next, and a Retry when possible. A screen that crashes while drawing shows "Something went wrong on this page" with **Try again** and **Go home** (the app around it stays); never a blank page. |
| Get the app card | See [Get the app card](#get-the-app-card). |
| Update bar | See [Update bar](#update-bar). |
| Platform stack | Glass card per platform on the clip page: mark, status chip, big number, only that platform's metric rows, sparkline, "Open on …". See [A platform stack](#a-platform-stack). |
| Performance lines | Decorative SVG Béziers from the preview to each stack, drawn in once. See [The lines](#the-lines). |
| Star toggle | "Best this week": green glass toggle, star icon + words, ≥ 48 px, `aria-pressed`. Never vermilion. |
| Setup to-do list | Glass column at the top right from 1440 px, a 48 px glass pill "Set up posting 2/5" on a glass bar below that; a row per platform with **Set up** and **Skip**; gone with "All set!" when each one is ready or skipped. See [Set up posting](#set-up-posting). |
| Ask launcher | green glass pill "Ask" with a sparkle (desktop) or a 56 px icon-only circle (phones). Never vermilion. See [Ask Clip Factory](#ask-clip-factory). |
| Ask panel | Glass, non-modal dialog; answers with numbered steps and up to two buttons. See [Ask Clip Factory](#ask-clip-factory). |
| Spotlight ring | bone ring with a soft vermilion glow around the control a help button points at; fades over 2.4 s; a still ring with reduced motion. |
