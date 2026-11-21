"""The campaign finder (docs/CONTRACTS.md §41, ADR-65): campaigns on Content Rewards that pay what the owner wants.

``cf-prod-campaigns`` (action ``find``) reads Content Rewards' **public** campaign pages that robots.txt allows, a few
times a day, anonymously and only from AWS (``source.py``), keeps them in one shared cache (``CRPUBLIC``), and matches
each owner's wants (``match.py``). It never calls Content Rewards' API, reads no secret and joins nothing: the owner
taps **Join Campaign** on Content Rewards himself. Q's api (``finderapi.py``) reads these items by their shapes only.
"""
