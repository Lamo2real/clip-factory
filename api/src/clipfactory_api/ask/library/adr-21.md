## ADR-21 iPhone and iPad get Add to Home Screen steps, not a download

- **Context.** "If it's on the iPhone, I'm not sure." iOS installs apps only from the App Store, from TestFlight, or,
  in the EU, from approved alternative marketplaces and Web Distribution, all of which need an Apple Developer
  Program membership, Apple's review or notarization, and a native app.
- **Decision.** On iPhone and iPad, Get the app shows three picture steps to add the PWA to the Home Screen (Share →
  Add to Home Screen → Add), with the real Share icon drawn inline. In other iOS browsers it first says "Open this
  page in Safari first".
- **Alternatives.** An App Store app wrapping the site (Apple rejects thin web wrappers, and it needs the membership and
  review); TestFlight (builds expire after 90 days).
- **Consequences.** No file and no store; the installed PWA runs full-screen and gets the same update bar. Push
  notifications for the PWA remain possible later (iOS 16.4+ supports Web Push for Home Screen apps).
