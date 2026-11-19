## For maintainers: keeping the app and this page in step

- The in-app steps are data files, one per platform: `web/src/setup/{youtube,tiktok,instagram,facebook,x}.ts`. The
  contract for their ids, titles, parts and wording rules is
  [CONTRACTS.md §17.2](CONTRACTS.md#172-step-content-one-data-file-per-platform-websrcsetupyoutubetiktokinstagramfacebookxts).
- This page must match them: under each `## {Platform}` heading, every step title appears with the same number, in
  the same part. The web test `setup-docs.test.ts` checks it ([TESTING.md](TESTING.md#posting-setup)).
- When a platform changes a button name: change the step in the data file **and** here, keep the step id, set
  `checkedOn` and the "Steps checked on" date on both, and add the source to the list below. If you are not sure, add
  an "If you see…" hint instead of changing the main sentence.
- Why it is built this way (bring your own keys, two Meta apps, same-tab Connect):
  [ADR-33](DECISIONS.md#adr-33-posting-setup-bring-your-own-keys-with-a-guided-list-per-platform) to
  [ADR-37](DECISIONS.md#adr-37-about-privacy-and-terms-on-the-apps-own-domain). How keys and
  tokens are kept: [SECURITY.md](SECURITY.md#platform-keys-and-tokens). How Connect and posting run:
  [ARCHITECTURE.md flow 16](ARCHITECTURE.md#16-set-up-posting-connect-and-real-posting).
