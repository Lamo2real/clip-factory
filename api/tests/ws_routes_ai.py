"""The ``/v1/workspaces`` AI, agents, skills, chat, memory, references, onboarding, usage and storage routes
(docs/CONTRACTS.md §45.5). Builder A2 fills this set."""

from __future__ import annotations

_B = "/v1/workspaces/stories"
_ID = "01JD0000000000000000000000"

EXPECTED: set[tuple[str, str]] = {
    ("GET", f"{_B}/ai"),
    ("PUT", f"{_B}/ai"),
    ("POST", f"{_B}/ai/check-models"),
    ("PUT", f"{_B}/ai/prices/opus-5-5"),
    ("PUT", f"{_B}/ai/models/opus-5-5"),
    ("DELETE", f"{_B}/ai/models/opus-5-5"),
    ("GET", f"{_B}/usage"),
    ("GET", f"{_B}/agents/creative_director"),
    ("PATCH", f"{_B}/agents/creative_director"),
    ("GET", f"{_B}/skills"),
    ("POST", f"{_B}/skills/uploads"),
    ("POST", f"{_B}/skills"),
    ("GET", f"{_B}/skills/{_ID}"),
    ("PUT", f"{_B}/skills/{_ID}"),
    ("DELETE", f"{_B}/skills/{_ID}"),
    ("POST", f"{_B}/skills/{_ID}/restore"),
    ("GET", f"{_B}/chat"),
    ("POST", f"{_B}/chat"),
    ("GET", f"{_B}/chat/{_ID}"),
    ("PATCH", f"{_B}/chat/{_ID}"),
    ("DELETE", f"{_B}/chat/{_ID}"),
    ("POST", f"{_B}/chat/{_ID}/messages"),
    ("POST", f"{_B}/chat/{_ID}/attachments"),
    ("POST", f"{_B}/chat/{_ID}/messages/{_ID}/stop"),
    ("GET", f"{_B}/memory"),
    ("POST", f"{_B}/memory"),
    ("PATCH", f"{_B}/memory/{_ID}"),
    ("DELETE", f"{_B}/memory/{_ID}"),
    ("GET", f"{_B}/references"),
    ("POST", f"{_B}/references"),
    ("POST", f"{_B}/references/{_ID}/complete"),
    ("POST", f"{_B}/references/{_ID}/analyze"),
    ("GET", f"{_B}/references/{_ID}"),
    ("PATCH", f"{_B}/references/{_ID}"),
    ("DELETE", f"{_B}/references/{_ID}"),
    ("GET", f"{_B}/onboarding"),
    ("PATCH", f"{_B}/onboarding"),
    ("PUT", f"{_B}/providers/runway/key"),
    ("DELETE", f"{_B}/providers/runway/key"),
    ("GET", f"{_B}/storage"),
    ("POST", f"{_B}/storage/cleanup"),
}
