"""Ask Clip Factory: the grounded in-app help assistant (docs/CONTRACTS.md §19).

Retrieval over a corpus built from the web app's own code, a composer that always gives a full answer without a
model, and an optional Claude Haiku step that only rewords that answer. Nothing here reads clips, jobs or posts,
and questions and answers are never stored or logged.

This package is imported lazily by ``routes/help.py``, so other routes pay nothing for it at cold start.
"""
