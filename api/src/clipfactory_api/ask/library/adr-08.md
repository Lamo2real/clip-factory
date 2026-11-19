## ADR-08 Token lifetimes: 15 minutes, 30 days, rotating refresh tokens

- **Context.** "The access token is refreshed every 15 minutes, but the refresh token should be refreshed every month
  ... I should be able to do it just once a month, unless I use the application actively."
- **Decision.** Access and ID tokens 15 minutes, refresh token 30 days, refresh-token rotation on (every refresh
  returns a new 30-day refresh token), 10-second grace period, revocation on.
- **Consequences.** An active owner never signs in again; after a month away, one sign-in. Details in [SECURITY.md](SECURITY.md).
