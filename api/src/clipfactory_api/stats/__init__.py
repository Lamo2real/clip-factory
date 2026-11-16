"""Clip stats: per-platform numbers for every posted clip (docs/CONTRACTS.md §16.3–§16.5).

``config`` reads ``config/platforms.json`` (intervals, batch sizes, rate budgets), ``budget`` keeps each platform's
shared rate budget, ``refresh`` is the one code path that reads numbers (used by the 15-minute poller, the manual
Refresh button and the clip-flow's ``metrics`` step), ``poll`` is the EventBridge tick and ``handler`` the Lambda
``cf-prod-stats``. Nothing here imports the durable execution SDK.
"""

STATS_ORDER: tuple[str, ...] = ("youtube", "tiktok", "instagram", "facebook", "x")
