"""Lamo Stories' AI configuration, agents, skills, chat, memory, references, onboarding, usage, provider keys and
storage routes (docs/CONTRACTS.md §45.5, §45.25–§45.31, §45.33).

Every route is marked **S**: a ``clips`` id answers 409 and an id that is not the caller's answers 404, before the
body is read. Keys are built from the JWT's ``sub`` and the path's workspace id only; every item read is checked
again with ``guard.owned``. Served only by Lamo Stories' own Lambda (``workspaces/http.py``); nothing here imports
Clip Factory's route modules, calls Clip Factory's agent runtime or reads Clip Factory's models, skills, conversations
or tokens.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ... import validate
from ...app import App
from ...errors import not_found
from ...http import Request, Response, Route, no_content, ok, route
from .. import agents as agents_mod
from .. import ai_config as cfg
from .. import ai_resolve as res
from .. import chat, guard, memory, onboarding, provider_keys, references, skills, storage, usage

BASE = "/v1/workspaces/{ws}"


def _open(app: App, req: Request) -> tuple[str, str, dict[str, Any], datetime]:
    """The caller, the workspace id, the workspace (404 / 409 first) and now; starts the request's time budget for
    best-effort runtime calls."""
    cfg.begin_request(req.started)
    now = app.clock()
    workspace = guard.require_workspace(app.store, req.user_id, req.params["ws"], stories=True, now=now)
    return req.user_id, str(workspace["workspaceId"]), workspace, now


# --- AI configuration, models, usage --------------------------------------------------------------------------


def get_ai(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    ai = cfg.current(app.store, user_id, ws_id)
    agents = agents_mod.ensure(app.store, user_id, ws_id, now)
    return ok(
        {
            "ai": ai,
            "models": cfg.model_infos(app.store, user_id, ws_id, ai),
            "agents": [agents_mod.public(a) for a in agents.values()],
            "tasks": cfg.task_infos(ai, agents),
        }
    )


def put_ai(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    body = req.json()
    agents = agents_mod.ensure(app.store, user_id, ws_id, now)
    cleaned = cfg.clean_config(body, cfg.current(app.store, user_id, ws_id), agents)
    return ok({"ai": cfg.save(app.store, user_id, ws_id, cleaned, now)})


def check_models(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    keys = cfg.clean_check_models(req.json())
    return ok({"task": cfg.start_check_models(app, user_id, ws_id, keys, now)}, 202)


def put_price(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    key = req.params["modelKey"]
    found = res.model(key)
    if found is None:
        raise not_found(res.unknown_model(key))
    body = req.json()
    price = cfg.clean_price(body, short=True) if body else None
    ai = cfg.set_price(app.store, user_id, ws_id, key, price, now=now)
    status = cfg.model_status_items(app.store, user_id, ws_id).get(key)
    return ok({"model": cfg.model_info(found, status, ai)})


def get_usage(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    days = validate.query_int(req.query, "days", default=usage.MAX_DAYS, lo=1, hi=usage.MAX_DAYS)
    return ok({"usage": usage.summary(app.store, user_id, ws_id, days, now)})


# --- agents ---------------------------------------------------------------------------------------------------


def get_agent(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"agent": agents_mod.public(agents_mod.get(app.store, user_id, ws_id, req.params["agentId"], now))})


def patch_agent(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    agent_id = req.params["agentId"]
    if agent_id not in res.AGENT_IDS:
        raise not_found(agents_mod.NOT_FOUND)
    body = req.json()
    known = skills.known_ids(app.store, user_id, ws_id)
    item = agents_mod.patch(app.store, user_id, ws_id, agent_id, body, now=now, known_skills=known)
    return ok({"agent": agents_mod.public(item)})


# --- skills ---------------------------------------------------------------------------------------------------


def list_skills(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"skills": skills.list_all(app.store, user_id, ws_id, now)})


def skill_upload(app: App, req: Request) -> Response:
    user_id, ws_id, _, _ = _open(app, req)
    return ok(skills.upload(app, user_id, ws_id, req.json()))


def create_skill(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"skill": skills.create(app, user_id, ws_id, req.json(256 * 1024), now=now)}, 201)


def get_skill(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"skill": skills.get(app, user_id, ws_id, req.params["skillId"], now)})


def put_skill(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"skill": skills.put(app, user_id, ws_id, req.params["skillId"], req.json(256 * 1024), now=now)})


def delete_skill(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    skills.delete(app, user_id, ws_id, req.params["skillId"], now)
    return no_content()


def restore_skill(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"skill": skills.restore(app, user_id, ws_id, req.params["skillId"], req.json(), now=now)})


# --- chat -----------------------------------------------------------------------------------------------------


def list_chats(app: App, req: Request) -> Response:
    user_id, ws_id, _, _ = _open(app, req)
    return ok({"conversations": chat.list_conversations(app.store, user_id, ws_id)})


def create_chat(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"conversation": chat.create(app, user_id, ws_id, req.json(), now=now)}, 201)


def get_chat(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    after, before = req.query.get("after") or None, req.query.get("before") or None
    return ok(chat.get(app, user_id, ws_id, req.params["convId"], after, now=now, before=before))


def patch_chat(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"conversation": chat.patch(app, user_id, ws_id, req.params["convId"], req.json(), now=now)})


def delete_chat(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    chat.delete(app, user_id, ws_id, req.params["convId"], now)
    return no_content()


def send_message(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok(chat.send(app, user_id, ws_id, req.params["convId"], req.json(), now=now), 202)


def chat_attachment(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok(chat.attachment(app, user_id, ws_id, req.params["convId"], req.json(), now=now))


def stop_message(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    message = chat.stop(app, user_id, ws_id, req.params["convId"], req.params["msgId"], now=now)
    return ok({"message": message})


# --- memory ---------------------------------------------------------------------------------------------------


def list_memory(app: App, req: Request) -> Response:
    user_id, ws_id, _, _ = _open(app, req)
    return ok({"memory": memory.list_items(app.store, user_id, ws_id)})


def add_memory(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"item": memory.add(app.store, user_id, ws_id, req.json(), now=now)}, 201)


def patch_memory(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"item": memory.edit(app.store, user_id, ws_id, req.params["memId"], req.json(), now=now)})


def delete_memory(app: App, req: Request) -> Response:
    user_id, ws_id, _, _ = _open(app, req)
    memory.remove(app.store, user_id, ws_id, req.params["memId"])
    return no_content()


# --- reference videos -----------------------------------------------------------------------------------------


def list_references(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"references": references.list_refs(app, user_id, ws_id, now)})


def create_reference(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok(references.create(app, user_id, ws_id, req.json(), now=now), 201)


def complete_reference(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"reference": references.complete(app, user_id, ws_id, req.params["refId"], req.json(), now=now)})


def analyze_reference(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok(references.analyze(app, user_id, ws_id, req.params["refId"], req.json(), now=now), 202)


def get_reference(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok(references.get(app, user_id, ws_id, req.params["refId"], now))


def patch_reference(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    return ok({"reference": references.patch(app, user_id, ws_id, req.params["refId"], req.json(), now=now)})


def delete_reference(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    references.delete(app, user_id, ws_id, req.params["refId"], now)
    return no_content()


# --- onboarding, provider keys, storage -----------------------------------------------------------------------


def get_onboarding(app: App, req: Request) -> Response:
    user_id, ws_id, workspace, _ = _open(app, req)
    return ok({"onboarding": onboarding.state(app.store, user_id, ws_id, workspace)})


def patch_onboarding(app: App, req: Request) -> Response:
    user_id, ws_id, workspace, now = _open(app, req)
    return ok({"onboarding": onboarding.patch(app.store, user_id, ws_id, workspace, req.json(), now=now)})


def put_provider_key(app: App, req: Request) -> Response:
    user_id, ws_id, _, now = _open(app, req)
    provider = provider_keys.put_key(app, user_id, ws_id, req.params["providerId"], req.json(8 * 1024), now=now)
    return ok({"provider": provider})


def delete_provider_key(app: App, req: Request) -> Response:
    user_id, ws_id, _, _ = _open(app, req)
    provider_keys.delete_key(app, user_id, ws_id, req.params["providerId"])
    return no_content()


def get_storage(app: App, req: Request) -> Response:
    user_id, ws_id, _, _ = _open(app, req)
    return ok({"storage": storage.summary(app.store, user_id, ws_id)})


ROUTES: list[Route] = [
    route("GET", f"{BASE}/ai", get_ai),
    route("PUT", f"{BASE}/ai", put_ai),
    route("POST", f"{BASE}/ai/check-models", check_models),
    route("PUT", f"{BASE}/ai/prices/{{modelKey}}", put_price),
    route("GET", f"{BASE}/usage", get_usage),
    route("GET", f"{BASE}/agents/{{agentId}}", get_agent),
    route("PATCH", f"{BASE}/agents/{{agentId}}", patch_agent),
    route("GET", f"{BASE}/skills", list_skills),
    route("POST", f"{BASE}/skills/uploads", skill_upload),
    route("POST", f"{BASE}/skills", create_skill),
    route("GET", f"{BASE}/skills/{{skillId}}", get_skill),
    route("PUT", f"{BASE}/skills/{{skillId}}", put_skill),
    route("DELETE", f"{BASE}/skills/{{skillId}}", delete_skill),
    route("POST", f"{BASE}/skills/{{skillId}}/restore", restore_skill),
    route("GET", f"{BASE}/chat", list_chats),
    route("POST", f"{BASE}/chat", create_chat),
    route("GET", f"{BASE}/chat/{{convId}}", get_chat),
    route("PATCH", f"{BASE}/chat/{{convId}}", patch_chat),
    route("DELETE", f"{BASE}/chat/{{convId}}", delete_chat),
    route("POST", f"{BASE}/chat/{{convId}}/messages", send_message),
    route("POST", f"{BASE}/chat/{{convId}}/attachments", chat_attachment),
    route("POST", f"{BASE}/chat/{{convId}}/messages/{{msgId}}/stop", stop_message),
    route("GET", f"{BASE}/memory", list_memory),
    route("POST", f"{BASE}/memory", add_memory),
    route("PATCH", f"{BASE}/memory/{{memId}}", patch_memory),
    route("DELETE", f"{BASE}/memory/{{memId}}", delete_memory),
    route("GET", f"{BASE}/references", list_references),
    route("POST", f"{BASE}/references", create_reference),
    route("POST", f"{BASE}/references/{{refId}}/complete", complete_reference),
    route("POST", f"{BASE}/references/{{refId}}/analyze", analyze_reference),
    route("GET", f"{BASE}/references/{{refId}}", get_reference),
    route("PATCH", f"{BASE}/references/{{refId}}", patch_reference),
    route("DELETE", f"{BASE}/references/{{refId}}", delete_reference),
    route("GET", f"{BASE}/onboarding", get_onboarding),
    route("PATCH", f"{BASE}/onboarding", patch_onboarding),
    route("PUT", f"{BASE}/providers/{{providerId}}/key", put_provider_key),
    route("DELETE", f"{BASE}/providers/{{providerId}}/key", delete_provider_key),
    route("GET", f"{BASE}/storage", get_storage),
]
