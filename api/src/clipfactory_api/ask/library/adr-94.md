## ADR-94 A skipped platform is hidden everywhere but Settings and Social accounts

Supersedes §17.13's skipped rows on the floating setup list, §45.36 E15 for platform steps and §45.36 E18's card
columns on Clips Funded's Social accounts. The contract is CONTRACTS §48.

- **Context.** The owner (2026-11-24, with a screenshot of Clips Funded's Dashboard showing "Finish setting up: 1 left
  · Connect X · Open setup" and "Connected accounts 4 of 5" after X was skipped): "if i skip on a platform setup then
  i dont want to see it anywhere except in settings or social accounts tab". In the same message, with a screenshot
  of Clip Factory's Set up posting: "can you make the social account page to look organized like this".
- **Decision.**
  1. *One rule in both apps (rule S).* A platform the owner confirmed as skipped, and that is not ready (Clip Factory)
     or not connected (Clips Funded), is left out of every reminder, count, "N left" list, nudge, "connect X" link and
     Ask suggestion. It shows only in Clip Factory › Settings › Posting › Set up posting and Clips Funded › Social
     accounts (and Clips Funded's setup, which its nav counts as Settings), each with Un-skip. Counts are "N of M"
     over the platforms not skipped. Ready or connected wins over a skip, and the skip is then dropped, so a platform
     that later needs the owner comes back.
  2. *Clips Funded keeps its existing store.* Platform skips are the platform keys of `ONBOARD.skipped`, written by
     the existing `PATCH …/onboarding {step, skipped}`. The API marks `SocialAccount.skipped`, gives
     `Onboarding.total` as 11 minus the platform steps skipped, and leaves skipped platforms out of the dashboard's
     accounts and Needs you. A read that finds a skipped platform connected drops the skip with one conditional put.
  3. *Social accounts becomes a list and pages.* The list page has a header card, a progress card ("N of M ready" with
     a ring) and a 2-column grid of rows (icon tile, name, one status word, one line, a check or an empty circle, a
     chevron). Each row has its Skip (asked first) or Un-skip and opens `/stories/connections/<p>`, which holds the
     platform's card as it was. The OAuth return lands on that page.
- **Alternatives.** *A new SKIPS item or route*: a migration and a Terraform change, for what `ONBOARD.skipped`
  already stores (the owner's X skip was in it). *Hiding a skipped platform from Social accounts too*: no way back,
  against "except in settings or social accounts tab". *Keeping skipped rows on the floating list with Un-skip*: the
  list is a reminder, which the owner said he does not want. *Keeping the masonry cards with rows above them*: two
  ways to do one thing on one page.
- **Consequences.** The owner's stored X skip takes effect on deploy, with no data rewritten. A skip never turns a
  posting switch off: in Clip Factory, "Your Mac posts TikTok" keeps posting if TikTok is skipped while it is on, and
  the clip page's stack for a skipped X with no post says only "Not posted here." (no Set up or Where clips go link).
  Whether a TikTok skip should also pause the Mac is left to the owner. Each app's skips stay its own.
