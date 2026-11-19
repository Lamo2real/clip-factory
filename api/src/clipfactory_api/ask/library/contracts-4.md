## 4. Web runtime config

CloudFront serves `/config.json` (written by `scripts/write-web-config.sh` from Terraform outputs at deploy time,
`Cache-Control: no-store`):
```json
{ "region": "eu-north-1", "userPoolId": "eu-north-1_xxx", "userPoolClientId": "xxx",
  "apiUrl": "https://xxxx.execute-api.eu-north-1.amazonaws.com",
  "wsUrl": "wss://yyyy.execute-api.eu-north-1.amazonaws.com/live",
  "oauthCallbackBase": "https://zzzz.execute-api.eu-north-1.amazonaws.com/v1/oauth", "version": "<git sha>" }
```
`wsUrl` comes from the Terraform output `ws_url` and is required in production. The web treats it as optional
(absent in mock mode and in old configs → polling only, §14.2). `oauthCallbackBase` comes from `oauth_callback_base`
(§17.9, https, ends `/oauth`); the web treats it as optional too and uses it only until `GET /v1/setup` answers.
Local development: `web/public/config.json` is absent; `VITE_MOCK=1` (`npm run dev:mock`) runs the whole UI on an
in-memory mock API (fixtures + fake latency) with a fake signed-in owner. Playwright tests run in mock mode.
