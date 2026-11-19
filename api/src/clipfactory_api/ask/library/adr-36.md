## ADR-36 Instagram and Facebook get two separate Meta apps

- **Context.** Meta's new app dashboard groups permissions into **use cases**, and some use cases cannot be combined
  or removed once added. Instagram publishing uses "Manage messaging & content on Instagram" (Instagram API with
  Facebook Login, a Facebook Login for Business configuration with a user access token and the Page linked to the
  Instagram account; system-user tokens are for Tech Providers only); Facebook Page Reels use "Manage everything on
  your Page" (Facebook Login for Business, Page tokens).
- **Decision.** Two Meta apps: "Clip Factory" for Instagram and "Clip Factory Pages" for Facebook, each with one use
  case and its own keys and login configuration.
- **Alternatives.** *One app with both use cases* (some combinations are refused or need App Review; a wrong tick
  cannot be undone, which is not kid-proof).
- **Consequences.** A few repeated steps (developer account, Basic settings) and two key sets. Each platform can be
  disconnected or re-keyed alone.
