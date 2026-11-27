## For maintainers: keeping the app and this page in step

- The in-app steps are data files in `web/src/setup/` (one per platform, plus `contentrewards.ts`) and
  `web/src/getpaid/` (one per place, plus `bank.ts`; the server's `bank/__init__.py` `STEPS` keeps the same ids).
  Their contracts: [CONTRACTS.md §17.2](CONTRACTS.md#172-step-content-one-data-file-per-platform-websrcsetupyoutubetiktokinstagramfacebookxts),
  §38.3, §38.4 and §38.7 (Content Rewards), §40.1 (Get paid) and §40.5 (Your bank).
- This page must match them: every step title appears under its heading, word for word and in the app's order, with
  the same number. Under `## Content Rewards` each part is a `### Part N:` heading and each step a `####` heading;
  "once" and "each time" go on the line under a heading. Under `## Get paid` and `## Your bank` each step is a `####`
  heading (`#### 1. …`, optional ones as `#### Optional: …`). The web test `setup-docs.test.ts` checks the setup
  parts ([TESTING.md](TESTING.md#posting-setup)).
- When a platform renames a button: change the data file **and** this page together, keep the step id, set
  `checkedOn` and that section's "Steps checked on" date, and add the source to that section's list. If you are not
  sure, add an "If you see…" hint instead. Never add a typed-in amount anywhere.
- **Bold** in Content Rewards and Your bank means the other company's exact label.
- A new platform word on bank statements is a one-line PR in `bankread/filter.py`, with a golden case.
- Why it is built this way: ADR-33 to ADR-37, ADR-62, ADR-64 and ADR-82 in [DECISIONS.md](DECISIONS.md). How keys,
  tokens and the bank data are kept: [SECURITY.md](SECURITY.md#platform-keys-and-tokens).
