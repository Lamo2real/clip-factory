"""Workspaces: Lamo Clips (built in, today's app) and Lamo Stories (docs/CONTRACTS.md §45, ADR-70).

Lamo Clips is the built-in workspace ``clips``: its data stays exactly where it is (``USER#{userId}``) and is never
written as a workspace item. Every other workspace has a registry item in ``USER#{userId}#WSREG`` and its own
partition ``USER#{userId}#WS#{workspaceId}``, whose sort-key prefixes no stream, index or Lamo Clips reader sees.
"""
