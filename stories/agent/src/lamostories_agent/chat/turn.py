"""One answer of the creative chat: ``chat_turn { userId, workspaceId, convId, msgId }`` (docs/CONTRACTS.md §45.27).

The API wrote the owner's message and this answer ``pending`` (with its ``sessionId``, ``heartbeatAt`` and the
owner's ``requested`` override). The creative director answers through builder E's model client with Lamo Stories'
tools only (``chat.tools``); its text is written into the answer as it streams, at most every 0.5 s (``streaming``,
each write also a heartbeat), and the answer ends ``done`` with its buttons, the effective model and effort and the
usage, or ``failed`` with one plain sentence. Stop (``stopped``) or the API's fence refuses the next write and the
turn ends without writing anything else.

The model and effort: the per-message override first, then the conversation's own setting (model and effort merged
separately), then the client's own levels (task, agent, workspace default). It never runs on another model. A short
text edit (rename, fix a word, shorten a caption) is the task ``text_edit`` instead of ``chat`` (§45.37 G5,
``edits``), so its own model and effort setting applies; the answer records the task it ran as.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

from lamostories_agent import models
from lamostories_agent.tasks import ideas
from lamostories_agent.tasks.ask import (
    REFUSED,
    assistant_turn,
    is_model_problem,
    named,
    owner_sentence,
    tool_calls,
    usage_of,
    user,
)
from lamostories_agent.tasks.common import Refused, Superseded, TaskFailed, clip, log, now_iso, owned, public, ws_pk
from lamostories_agent.tasks.fence import MSG_LIVE, Fence, run_with_heartbeat
from lamostories_agent.tasks.services import Services
from lamostories_agent.tasks.store import Expr
from lamostories_agent.tasks.work import agent_off, asked_of, called_of, merge_override, reply_called

from . import edits, history, tools

MAX_ROUNDS = 8
MAX_TEXT = 100_000  # an answer's text stays well inside DynamoDB's item size
MAX_TOKENS = 16000
FAILED = "The answer stopped. Tap Try again."
GONE = "This conversation was deleted."
TOO_MANY_STEPS = "\n\n(I stopped after several steps. Ask me to carry on.)"
EMPTY = "I don't have an answer for that. Try asking another way."
PICK_MODEL = {"kind": "open", "label": "Pick another model", "payload": {"href": "/stories/settings/ai"}}
# A model that takes no tools (ModelDef ``tools`` false, §45.35 D1): the chat runs without its tool actions and says
# so once per conversation (``toolsNotice`` on the answer that said it, internal).
NO_TOOLS = (
    "This model can only talk here. It can't use Clip Stories' tools, so it can't look at your ideas or "
    "characters or give you buttons. To get those, pick a Claude model in Clip Stories › Settings › AI."
)
STOPS_THE_TURN = frozenset({"ModelUnavailable", "EffortUnavailable", "AgentOff"})

CHAT_BRIEF = """Clip Stories studio notes for the creative chat (from the app, not the owner):
- You can look things up and draft with your tools: ideas, characters, stories and their storyboards, reference video analyses. You may create or update ideas and remember short facts the owner wants kept.
- Anything that makes or remakes a video, analyzes a reference video or saves a character is a button for the owner: use the offer_ and propose_ tools. Never say you made, remade, saved or posted something the owner still has to tap.
- Make the video (offer_make_video) can carry up to 3 analyzed reference videos (referenceIds): the writer then follows their study of structure and timing. A reference that is not analyzed yet needs the Analyze button first.
- Answer in short, friendly, plain words that a child could follow. No em or en dashes.
- The owner reads your answer in the app while it is written."""


def merged_override(requested: Any, conversation: dict[str, Any]) -> dict[str, Any] | None:
    """The message's own override over the conversation's setting, model and effort separately (§45.25 levels 1-2)."""
    return merge_override(requested, {"model": conversation.get("model"), "effort": conversation.get("effort")})


class Stream:
    """The answer's text as it arrives, written at most every ``every_s`` seconds (each write also a heartbeat).

    The client's ``on_text`` gets the current round's text **so far** (builder E's ConverseStream client; after a
    temporary error it starts that round again from the beginning), so each call replaces the round's text instead of
    adding to it. The earlier rounds of the tool loop stay, each its own paragraph."""

    def __init__(self, fence: Fence, every_s: float) -> None:
        self.fence = fence
        self.every_s = every_s
        self.rounds: list[str] = []  # the finished rounds' texts
        self.current = ""  # this round's text so far
        self._last = 0.0
        self._lock = threading.Lock()

    @property
    def text(self) -> str:
        parts = [*(r.strip() for r in self.rounds), self.current.lstrip()]
        return "\n\n".join(p for p in parts if p.strip())

    def gap(self) -> None:
        """A new round of the tool loop: its text starts on a new paragraph."""
        with self._lock:
            if self.current.strip():
                self.rounds.append(self.current)
            self.current = ""

    def add(self, so_far: str) -> None:
        """``on_text``: the round's whole text so far."""
        if not so_far:
            return
        with self._lock:
            self.current = so_far
            due = time.monotonic() - self._last >= self.every_s
        if due:
            self.flush()

    def settle(self, text: str) -> None:
        """The round's final text, from the reply (the same text the stream ended with)."""
        if text:
            with self._lock:
                self.current = text

    def flush(self) -> None:
        with self._lock:
            self._last = time.monotonic()
            text = self.text
        self.fence.write({"text": text[:MAX_TEXT], "status": "streaming", "heartbeatAt": now_iso()})


class Turn:
    def __init__(
        self, svc: Services, *, user_id: str, workspace_id: str, conv: dict[str, Any], msg: dict[str, Any], fence: Fence
    ) -> None:
        self.svc = svc
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.pk = ws_pk(user_id, workspace_id)
        self.conv = conv
        self.msg = msg
        self.fence = fence
        self.conv_id = str(conv["convId"])
        self.msg_id = str(msg["msgId"])
        self.ctx = models.CallContext(
            user_id, workspace_id, "creative_director", fence.session_id, conv_id=self.conv_id, msg_id=self.msg_id
        )
        self.override = merged_override(msg.get("requested"), conv)
        self.stream = Stream(fence, svc.stream_every_s)
        self.toolbox = tools.Toolbox(svc, user_id, workspace_id, self.pk, fence, catalog=svc.catalog)
        self.usage = {"input": 0, "output": 0}
        self.reply: models.Reply | None = None
        self.earlier: list[dict[str, Any]] = []  # this conversation's earlier messages (whatever is summarized)
        self._about: tuple[str, dict[str, Any]] | None = None  # the conversation's project (kind, item), read once
        self._about_read = False
        self.task = edits.CHAT  # the answer's task: ``text_edit`` for a short text edit (§45.37 G5)

    # --- the conversation ----------------------------------------------------------------------------------------

    def _history(self) -> list[dict[str, Any]]:
        items = self.svc.store.query(self.pk, f"MSG#{self.conv_id}#")
        msgs = [m for m in history.ordered(items, self.conv_id) if owned(m, self.user_id, self.workspace_id)]
        # Everything but this answer: the owner's question can share its millisecond (and so sort after it), and
        # nothing newer exists while an answer is pending (the API refuses a second message).
        before = [m for m in msgs if str(m.get("msgId") or "") != self.msg_id]
        self.earlier = before
        cut = self.conv.get("summaryUpToMsgId")
        if isinstance(cut, str) and cut:
            before = [m for m in before if str(m.get("msgId")) > cut]
        return [m for m in before if history.usable(m)]

    def _summarize(self, text: str) -> str:
        reply = self.svc.model.complete(
            self.ctx,
            task="chat",
            messages=[user(history.SUMMARY_PROMPT, "CONVERSATION:\n" + text)],
            override=self.override,
            max_tokens=4000,
        )
        self._count(reply)
        return reply.text if reply.stop_reason != "refusal" else ""

    def _maybe_compact(self, msgs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
        summary = self.conv.get("summary") if isinstance(self.conv.get("summary"), str) else None
        if not history.needs_compaction(msgs):
            return msgs, summary
        try:
            done = history.compact(self._summarize, msgs, summary)
        except Exception as e:
            if isinstance(e, Superseded) or named(e, STOPS_THE_TURN):  # the answer itself would fail the same way
                raise
            log("warning", "stories.compaction_failed", conv=self.conv_id, error=type(e).__name__)
            return msgs[-history.COMPACT_MESSAGES :], summary
        if done is None:
            return msgs, summary
        new_summary, up_to, recent = done
        write = (
            Expr()
            .set({"summary": new_summary, "summaryUpToMsgId": up_to})
            .exists()
            .eq("userId", self.user_id)
            .eq("workspaceId", self.workspace_id)
        )
        try:
            self.fence.transact([("update", self.pk, f"CONV#{self.conv_id}", write), self.fence.check_op()])
        except Refused as e:  # the conversation was deleted while this answer started
            raise TaskFailed(GONE) from e
        log("info", "stories.conversation_compacted", conv=self.conv_id, kept=len(recent))
        return recent, new_summary

    def _project_item(self) -> tuple[str, dict[str, Any]] | None:
        """The idea, story, character or reference this conversation is about (its own partition only), read once."""
        if not self._about_read:
            self._about_read = True
            ref = self.conv.get("projectRef")
            if isinstance(ref, dict) and ref.get("kind") in ("idea", "story", "character", "reference"):
                kind = str(ref["kind"])
                prefix = {"idea": "IDEA#", "story": "STORY#", "character": "CHAR#", "reference": "REFVID#"}[kind]
                item = self.svc.store.get(self.pk, f"{prefix}{ref.get('id')}")
                if item and owned(item, self.user_id, self.workspace_id):
                    self._about = (kind, item)
        return self._about

    def _shape(self) -> str:
        """The video's shape the chat plans for (§45.36 E5): the story's own format when the conversation is about a
        story, else the workspace's default from Settings › Video."""
        about = self._project_item()
        cfg = ideas.workspace_config(self.svc, self.user_id, self.workspace_id)
        return ideas.shape_of(cfg, about[1] if about and about[0] == "story" else None)

    def _project(self) -> str:
        about = self._project_item()
        if about is None:
            return ""
        kind, item = about
        keep = (
            "ideaId",
            "storyId",
            "characterId",
            "refId",
            "title",
            "name",
            "logline",
            "category",
            "status",
            "personality",
        )
        shown = {k: v for k, v in public(item).items() if k in keep}
        return f"This conversation is about this {kind} (read it with your tools for more): {shown}"

    # --- the answer ----------------------------------------------------------------------------------------------

    def _count(self, reply: models.Reply) -> None:
        u = usage_of(reply)
        self.usage["input"] += u["input"]
        self.usage["output"] += u["output"]

    def _task(self) -> str:
        """``text_edit`` when the owner's message (the newest of his) is a short text edit, else ``chat``."""
        asked = next((m for m in reversed(self.earlier) if m.get("role") == "user"), None)
        if asked is None:
            return edits.CHAT
        pictures = len([a for a in asked.get("attachments") or [] if isinstance(a, dict)])
        return edits.chat_task(str(asked.get("text") or ""), pictures=pictures)

    def run(self) -> None:
        msgs, summary = self._maybe_compact(self._history())
        self.task = self._task()
        messages = history.to_messages(
            self.svc,
            msgs,
            user_id=self.user_id,
            workspace_id=self.workspace_id,
            conv_id=self.conv_id,
            preface=[ideas.house_brief(self._shape()), CHAT_BRIEF, self._project()],
            summary=summary,
        )
        specs = tools.specs()
        stopped_early = False
        for round_no in range(MAX_ROUNDS):
            self.stream.gap()
            reply = self.svc.model.complete(
                self.ctx,
                task=self.task,
                messages=messages,
                override=self.override,
                tools=specs,
                max_tokens=MAX_TOKENS,
                on_text=self.stream.add,
            )
            if self.fence.lost.is_set():
                raise Superseded(self.fence.sk)
            self.reply = reply
            self._count(reply)
            self.stream.settle(reply.text)
            if reply.stop_reason == "refusal":
                raise TaskFailed(REFUSED)
            calls = tool_calls(reply)
            if not calls:
                break
            messages.append(assistant_turn(reply))
            results = []
            for call in calls:
                result, ok = self.toolbox.run(call["name"], call["input"])
                results.append(
                    {
                        "toolResult": {
                            "toolUseId": call["id"],
                            "content": [{"json": result}],
                            "status": "success" if ok else "error",
                        }
                    }
                )
            messages.append({"role": "user", "content": results})
            if round_no == MAX_ROUNDS - 1:
                stopped_early = True
        text = self.stream.text.strip()[:MAX_TEXT]
        if stopped_early:
            text += TOO_MANY_STEPS
        if not text and not self.toolbox.actions:
            text = EMPTY
        last = self.reply
        notice = bool(last and last.tools_off) and not any(m.get("toolsNotice") for m in self.earlier)
        if notice:
            text = f"{text}\n\n{NO_TOOLS}".strip()[:MAX_TEXT] if text != EMPTY else NO_TOOLS
        fields: dict[str, Any] = {
            "text": text,
            "status": "done",
            "actions": self.toolbox.actions,
            "model": last.model if last else None,
            **(reply_called(last) if last else {}),  # what was really called (§45.35 D5)
            "effort": last.effort if last else None,
            "effortApplied": last.effort_applied if last else None,
            "usage": dict(self.usage),
            "task": self.task,  # chat, or text_edit for a short text edit (§45.37 G5)
            "heartbeatAt": now_iso(),
        }
        if notice:
            fields["toolsNotice"] = True
        self.fence.write(fields)

    def fail(self, sentence: str, *, pick_model: bool, error: BaseException | None = None) -> bool:
        """Ends the answer ``failed``. With no reply yet, the model and effort it was sent with stay on the message
        (the API wrote them on the pending answer; a model or effort refusal names them too), so a failed answer still
        shows what was asked (§45.34)."""
        actions = [*self.toolbox.actions, PICK_MODEL] if pick_model else list(self.toolbox.actions)
        reply = self.reply
        fields: dict[str, Any] = {
            "text": self.stream.text.strip()[:MAX_TEXT],
            "status": "failed",
            "error": clip(sentence, 500),
            "actions": actions,
            "usage": dict(self.usage),
            "task": self.task,
            "heartbeatAt": now_iso(),
        }
        asked = asked_of(error)
        if reply is not None:
            fields.update({"model": reply.model, "effort": reply.effort, "effortApplied": reply.effort_applied})
            fields.update(reply_called(reply))
        elif asked is not None:
            fields.update({"model": asked[0], "effort": asked[1], "effortApplied": False})
            fields.update(called_of(error))
        if asked is not None:  # the answer stopped on its model call (§45.35 D5)
            fields["failed"] = True
        return self.fence.try_write(fields)


async def run_turn(svc: Services, payload: dict[str, Any]) -> str:
    """One answer to its end; returns done, failed, superseded or skipped (for logs and tests)."""
    user_id = str(payload.get("userId") or "")
    workspace_id = str(payload.get("workspaceId") or "")
    conv_id = str(payload.get("convId") or "")
    msg_id = str(payload.get("msgId") or "")
    try:
        pk = ws_pk(user_id, workspace_id)
    except ValueError:
        return "skipped"
    sk = f"MSG#{conv_id}#{msg_id}"
    msg = await asyncio.to_thread(svc.store.get, pk, sk)
    if (
        not msg
        or not owned(msg, user_id, workspace_id)
        or msg.get("role") != "assistant"
        or msg.get("status") not in MSG_LIVE
        or not msg.get("sessionId")
        or (payload.get("sessionId") and payload["sessionId"] != msg["sessionId"])
    ):
        log("info", "stories.turn_not_live", msg=msg_id, status=(msg or {}).get("status"))
        return "skipped"
    fence = Fence(svc.store, pk, sk, str(msg["sessionId"]), live=MSG_LIVE)
    conv = await asyncio.to_thread(svc.store.get, pk, f"CONV#{conv_id}")
    if not conv or not owned(conv, user_id, workspace_id):
        ok = await asyncio.to_thread(fence.try_write, {"status": "failed", "error": GONE, "heartbeatAt": now_iso()})
        return "failed" if ok else "superseded"
    conv.setdefault("convId", conv_id)
    msg.setdefault("msgId", msg_id)
    turn = Turn(svc, user_id=user_id, workspace_id=workspace_id, conv=conv, msg=msg, fence=fence)
    try:
        off = await asyncio.to_thread(agent_off, svc, pk, "creative_director")
        if off:
            raise TaskFailed(off)
        await run_with_heartbeat(fence, svc.heartbeat_s, turn.run)
    except Superseded:
        log("info", "stories.turn_superseded", msg=msg_id)
        return "superseded"
    except Exception as e:
        sentence = owner_sentence(e)
        model_problem = is_model_problem(e)
        if sentence is None:
            log("error", "stories.turn_crashed", msg=msg_id, error=type(e).__name__, detail=str(e))
        ok = await asyncio.to_thread(turn.fail, sentence or FAILED, pick_model=model_problem, error=e)
        return "failed" if ok else "superseded"
    return "done"
