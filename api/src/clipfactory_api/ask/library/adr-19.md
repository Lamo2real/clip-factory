## ADR-19 Unsigned desktop builds for now

- **Context.** Signing needs an Apple Developer Program membership (yearly fee, plus notarization) and a Windows
  code-signing certificate or Azure Trusted Signing account. The owner has neither yet, and the app has one user.
- **Decision.** Ship the `.dmg` and `.exe` unsigned. The Get the app card shows a one-line first-open hint (Mac:
  right-click → Open, or Open Anyway in Privacy & Security on macOS 15 and later; Windows: More info → Run anyway).
- **Alternatives.** Sign now (cost and setup before anyone needs it); offer only the PWA on desktop (the owner asked for
  files).
- **Consequences.** One extra click the first time on each computer. Some company-managed computers block unsigned apps
  outright; the browser install remains on the same card. Signing and notarization are a [roadmap](ROADMAP.md#later)
  item and need only secrets in GitHub and a few lines in the `desktop` job.
