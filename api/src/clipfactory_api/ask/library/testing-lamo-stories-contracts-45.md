## Lamo Stories (CONTRACTS §45)

The list is CONTRACTS §45.19. Three checks matter most, because the owner put protecting Lamo Clips first:

* **Isolation, backend.** `api/tests/test_ws_keys.py` reads the stream prefixes from Terraform and proves no workspace
  key matches one; `test_ws_isolation.py` and `test_ws_destinations.py` prove every route and every publishing step
  fails closed on another user's or another workspace's ids, and that the credentials name is always the workspace's.
  `terraform test` holds the IAM walls (the story flow cannot read `cf-prod/platforms/*/token`; Lamo Clips' flows,
  stats and money cannot read `cf-prod/workspaces/*`).
* **Lamo Clips unchanged.** Every existing test passes untouched (the old route list in `test_http.py`, the OAuth
  callback cases, the agent server tests, the nav and Glide specs). The before/after screenshot comparison of
  `/`, `/jobs`, `/review`, `/library`, `/money` and `/settings` at 390, 1000 and 1440 px is pixel-identical with
  `STORIES_ON` false, and differs only inside the switcher's box with it true.
* **One engine.** The engine's vitest suite and the agent's golden-frame test run the same scripts; a change that moves
  a pixel in one and not the other fails.
