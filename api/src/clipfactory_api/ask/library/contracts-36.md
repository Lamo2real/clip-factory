## 36. One simple Review card: Use my settings and one row per place (owner request, 2026-11-20)

The owner, on a Review card after §33: "How can I select platforms on the bottom bar AND tick/untick them under Upload
to? What's the difference? All I want: select all of them, click one button, upload. Plus one extra button for my
settings, and a dropdown per platform (e.g. TikTok paid partnership). For a standard upload I should only have to tap
one button." §33 had also removed the "Use my settings" preset he asked for and put TikTok's "Who can see it" on a bar
of buttons, although TikTok's rules ask for a dropdown. This section replaces §33.2's caption tabs, §33.4 and §33.5.
Decision record: ADR-60 (which corrects ADR-57).

### 34.1 The card, top to bottom

1. Clip info, video and Checks before posting, as before.
2. **Upload to** chips (§33.2, unchanged): only places that are set up, all ticked to start, remembered per device.
   They are the only place picker on the card.
3. **Use my settings**: one big soft-fill button (`.my-settings__btn`, a glass button, full width). It puts My
   settings on every ticked place. Done state: bone fill, a check, **Your settings are on**. Under it one plain line:
   "Your other places already use your settings. TikTok needs your tap each time." (before the tap, TikTok ticked),
   "Every place uses your settings. Tap a place below to change it for this clip." (after, or with TikTok unticked),
   "You changed some for this clip. Tap to put yours back." (after a change in a row). YouTube, Instagram, Facebook
   and X use My settings from the start (nothing in their rules asks for a tap); TikTok's choices go on only with this
   tap (or picks in its row), because TikTok wants the creator's own action and no default. Ticking Commercial content
   (Your brand / Branded content) is about one clip and keeps "Your settings are on".
4. **One closed row per ticked place** (`screens/review/PlaceRows.tsx`, a `<details>` with a soft fill and no edges):
   "YouTube · title, description and settings", "TikTok · caption and settings", "Instagram · caption and
   settings", "Facebook · caption and settings", "X · caption and settings" (X's name is for screen readers only, its
   mark reads "X"). Under the title one quiet line says what will be used ("Who can see it: Everyone · Made for kids:
   No · Gaming"; "Who can see it: Everyone · Comments on · Duet on · Stitch off"; "Reel · also in your feed"; "Reel on
   your Page · Everyone can see it"; "Who can reply: Everyone"); a too-long caption adds "Too long. Make it shorter."
   in vermilion ink. Tapping a row opens that place's own words (already written, with their limits) and every option:
   * YouTube: Title, Description, Who can see it (a `<Glide>` bar: Everyone / Link only / Only me, starting from
     `settings.youtubePrivacy`), Category (the app's own dropdown, Gaming first), **Made for kids** switch (off = No),
     Tell my subscribers.
   * TikTok: Posting as, Caption, **Who can see it** (§36.5), Comments, Duet, Stitch, Commercial content with Your
     brand (Promotional content) / Branded content (Paid partnership).
   * Instagram: Caption, Also show it in my feed (Reel).
   * Facebook: Caption, "Goes up as a Reel on your Page. Everyone can see it." (Page Reels are public; nothing to pick).
   * X: Caption, Who can reply (the app's own dropdown: Everyone, People you follow, Only people you mention, Verified
     accounts).
   With nothing set up (or the check failed) the rows hold the words only. There is no caption tab bar and no second
   place selector anywhere on the card.
5. "Going to: YouTube · TikTok · Instagram · Facebook" (or why Upload is off), TikTok's Music Usage Confirmation line
   (`.tt-legal`, + Branded Content Policy when branded) whenever TikTok is ticked, then **Throw away** and **Upload to
   4** (bottom right, vermilion on the top card). Upload is off, with one plain line in its place, while TikTok is
   ticked and not ready: "Tap Use my settings first. TikTok needs your tap.", "Asking TikTok…", "Pick who can see it on
   TikTok first.", "Pick Your brand or Branded content on TikTok first.", "This clip is too long for TikTok. Untick
   TikTok to upload it to the rest.", "TikTok did not answer. Tap Ask TikTok again, or untick TikTok."

A standard upload is two taps: **Use my settings**, then **Upload to 4**. The TikTok sheet no longer opens from the
card when places are set up: TikTok's controls are in its row and its legal line is beside Upload.

### 34.2 My settings (API, additive)

`Settings.postPreset` (stored in the owner's settings item; GET/PUT `/v1/settings` as every setting; per owner):

```json
{
  "youtube":   { "category": "20", "notifySubscribers": true, "embeddable": true },
  "tiktok":    { "privacy": "PUBLIC_TO_EVERYONE", "comments": true, "duet": true, "stitch": true },
  "instagram": { "shareToFeed": true },
  "facebook":  {},
  "x":         { "replies": "everyone" }
}
```

These are the defaults (the owner's ask: the most reach on every platform). An owner who never saved one reads them; a
stored value that no longer validates reads the defaults. A PUT may send any platforms; each one given is merged over
its defaults (`post_preset.check`). Validation: known platforms and keys only, booleans are booleans, `category` one of
20, 24, 23, 22, 17, TikTok `privacy` one of TikTok's four levels, `replies` one of the four above. **Made for kids can
never come from My settings**: `madeForKids` (or `selfDeclaredMadeForKids`, `forKids`) in a preset is refused with
"My settings never mark a clip as made for kids." YouTube's "who can see it" is not in the preset: it stays
`settings.youtubePrivacy` (one field, shown in both places). TikTok's Commercial content is not in it either (per clip).

**Settings › Posting › My settings** (`/settings/posting/my-settings`, `MySettingsBranch.tsx`): one section per
platform, X included ("This is used once it is." while X is not set up), each saving as it changes. YouTube's section
shows "Made for kids: No. My settings never mark a clip as made for kids." TikTok's says Commercial content is picked
per clip.

### 34.3 Confirm sends each place's options (API, additive)

`POST /v1/clips/{clipId}/confirm` gains optional `"options"`:

```json
{ "youtube":   { "privacy": "public", "category": "20", "madeForKids": false, "notifySubscribers": true, "embeddable": true },
  "instagram": { "shareToFeed": true },
  "x":         { "replies": "everyone" } }
```

Only YouTube, Instagram and X (TikTok's go in `tiktok`, §17.8; Facebook has none); each key optional, validated like
the preset (`madeForKids` is allowed here: YouTube asks every creator, and the card's switch starts off). Options for a
place that is not in `platforms` are dropped. They are stored on that place's post as the internal `postOptions`
(never returned). Publishers read the clip's option first, then My settings, then the old behaviour: YouTube
`privacyStatus` (else `youtubePrivacy`), `categoryId` (else preset, else 20), `selfDeclaredMadeForKids` true only when
the clip says so, `embeddable: false` only when asked, `&notifySubscribers=false` only when asked; Instagram
`share_to_feed`; X `reply_settings` (nothing sent for everyone). Older clients send no `options` and get exactly the
old posts. No table, index or infrastructure change; existing settings, clips and posts are untouched (the preset is
one more attribute on the settings item, written only when the owner saves).

### 34.4 Web

`lib/preset.ts` (defaults, `presetOf`, `cardOptionsFrom`, `optionsFor`, the mock's checks), `lib/tiktokChoices.ts`
`myTikTokChoices(preset.tiktok, creator)`: TikTok's privacy is the saved one when TikTok offers it, else Everyone, else
TikTok's first choice (Only me before the audit); Comments, Duet and Stitch as saved and off where the creator turned
them off; Commercial content off. TikTok's creator info is asked for when the owner taps Use my settings or opens the
TikTok row, never before. `uploadClip(..., platforms, options)`; `confirmClip(clipId, captions, tiktok, platforms,
options)`. Nothing about My settings is kept in localStorage.

### 34.5 TikTok's "Who can see it"

The app's own dropdown (`components/Dropdown.tsx`: a soft-fill button that opens a solid list, keyboard arrows,
Escape, never the OS list), labelled "Who can see it", with exactly `privacyOptions` (minus Only me when branded),
Everyone first, and the placeholder "Pick who can see it" until the owner picks or taps Use my settings. When only
`SELF_ONLY` is allowed: one choice and the line "TikTok keeps posts private until it approves your app." Used in the
TikTok row and on the Post to TikTok sheet (which still opens for Library's Try again, and on Upload while nothing is
set up but TikTok is connected).

### 34.6 Ask never covers Upload

The owner's screenshot showed the round Ask button over the right end of "Upload to 4". Upload and Use my settings carry
`data-help-clear`: the launcher (§19.8) fades out in place whenever it touches them at all (not only when it covers a
third), so the right end of Upload always takes the tap.

### 34.7 Tests

`api/tests/test_settings_and_system.py` (preset defaults, merge, never made for kids, bad choices),
`api/tests/test_upload_to.py` (options on posts, dropped for places not going, refused, publishers);
`web/test/reviewSheets.test.tsx` (rows, dropdown, Use my settings, the mock's checks); `web/e2e/review-card.spec.ts`
(two-tap standard flow and what is sent, one place picker, rows open per place, paid partnership, My settings page,
Ask never over Upload at 1000x650, 1440x900 and 390x844), `tiktok-sheet.spec.ts` (TikTok row compliance, before the
audit, Library's sheet), `upload-to.spec.ts`.
