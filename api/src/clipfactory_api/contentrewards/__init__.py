"""Content Rewards campaigns (docs/CONTRACTS.md §38, ADR-62).

Content Rewards (CR) is its own connection, never a sixth ``Platform``: its sign-in (``CRCONN``), the campaigns the
owner added (``CAMPAIGN#``), what was sent for each campaign post (``CRSUB#``) and CR's own money numbers
(``CRMONEY``). Every CR call is made from ``cf-prod-api``, ``cf-prod-clip-flow`` or ``cf-prod-stats``; the token
lives only in Secrets Manager. ``cf-prod-campaigns`` (``handler.py``) reads untrusted brand text and outside files and
has no secret access at all.

Nothing here logs a token, code, state, cookie or key.
"""
