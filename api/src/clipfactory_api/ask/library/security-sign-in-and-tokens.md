## Sign-in and tokens

| Setting | Value | What it means for the owner |
|---|---|---|
| Users | One, created by Terraform from `CF_OWNER_EMAIL`; sign-up is off | Nobody else can create an account. |
| Sign-in | The app's own screen, Secure Remote Password (SRP) through Amplify | The password is never sent in clear text, not even over HTTPS. |
| Access and ID tokens | 15 minutes | Refreshed silently in the background; the owner never notices. |
| Refresh token | 30 days, **rotated on every refresh**, 10-second grace period | Every refresh issues a new 30-day refresh token. Using the app at least once a month means never signing in again. After 30 days away, one sign-in. |
| Token revocation | On | Signing out revokes the refresh token. |
| User existence errors | Hidden | A wrong email and a wrong password give the same message. |
| MFA | Off | Owner's choice. Can be turned on later in Cognito without code changes. |

Tokens are stored by Amplify in the browser's local storage on each device. Signing out on one device does not sign
out others until their refresh token is used and found revoked.
