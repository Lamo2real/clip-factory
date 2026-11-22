// Lamo Stories › Chat (docs/CONTRACTS.md §45.16.7, §45.27): talk ideas through with the creative director. The list
// of chats (rename, delete with Undo), one chat at a time, and the model and effort line above the box. Opening Chat
// goes back to the chat that was open last on this device (cf.workspace.lastConversationId); "All chats" shows the
// list on a phone.
import "../styles/chat.css";
import { useCallback, useEffect, useState } from "react";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { Conversation } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { ChatList } from "../chat/ChatList.tsx";
import { ConversationView } from "../chat/ConversationView.tsx";
import { lastConversationId, rememberConversation } from "../chat/device.ts";
import { Btn, Director, Empty, sentence, UndoBar, Waiting } from "../chat/kit.tsx";
import { isPendingDelete, refusedDelete, scheduleDelete, undoDelete, usePendingDelete } from "../chat/undo.ts";
import { storiesGoLater, useAppActive } from "../pane.tsx";
import type { StoriesScreenProps } from "./types.ts";

function newestFirst(list: Conversation[]): Conversation[] {
  const at = (c: Conversation) => c.lastMessageAt ?? c.updatedAt ?? c.createdAt;
  return [...list].sort((a, b) => at(b).localeCompare(at(a)));
}

/** The address asked for the list itself ("All chats"), not the last chat. */
function wantsList(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).get("all") === "1";
}

export function ChatScreen({ ws, page }: StoriesScreenProps) {
  const convId = page.name === "chat_conv" ? page.convId : null;
  const [list, setList] = useState<Conversation[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const { pending, version } = usePendingDelete("conversation");
  const active = useAppActive();

  useEffect(() => {
    let live = true;
    storiesApi()
      .listConversations(ws)
      .then((l) => {
        if (!live) return;
        setList(newestFirst(l));
        setProblem(null);
      })
      .catch((e: unknown) => live && setProblem(sentence(e, "Your chats did not load. Try again.")));
    return () => {
      live = false;
    };
  }, [ws, round, version]);

  // Opening Chat goes back to the chat that was open last (unless the owner asked for the list). Never while Clip
  // Factory is on screen (this page kept behind it): the address is Clip Factory's then, and the owner stays there.
  useEffect(() => {
    if (!active || convId || !list || wantsList()) return;
    const last = lastConversationId();
    if (last && list.some((c) => c.convId === last) && !isPendingDelete("conversation", last)) navigate(storiesHref({ name: "chat_conv", convId: last }), { replace: true });
  }, [convId, list, active]);

  const onConversation = useCallback((c: Conversation) => {
    setList((prev) => (prev ? newestFirst([c, ...prev.filter((x) => x.convId !== c.convId)]) : prev));
  }, []);

  async function startChat() {
    if (creating) return;
    setCreating(true);
    setCreateProblem(null);
    try {
      const c = await storiesApi().createConversation(ws, {});
      setList((prev) => newestFirst([c, ...(prev ?? [])]));
      rememberConversation(c.convId);
      // After the wait: never while Clip Factory is on screen (it happens once Lamo Stories is back, §45.35 D17).
      storiesGoLater(storiesHref({ name: "chat_conv", convId: c.convId }));
    } catch (e) {
      setCreateProblem(sentence(e, "A new chat did not start. Try again."));
    } finally {
      setCreating(false);
    }
  }

  async function rename(id: string, title: string): Promise<string | null> {
    try {
      const c = await storiesApi().patchConversation(ws, id, { title });
      onConversation(c);
      return null;
    } catch (e) {
      return sentence(e, "The name did not save. Try again.");
    }
  }

  function remove(c: Conversation) {
    if (lastConversationId() === c.convId) rememberConversation(null);
    scheduleDelete({ kind: "conversation", id: c.convId, text: `Deleted “${c.title}”.`, run: () => storiesApi().deleteConversation(ws, c.convId) });
    if (convId === c.convId) navigate(`${storiesHref({ name: "chat" })}?all=1`, { replace: true });
  }

  const shown = (list ?? []).filter((c) => !(pending && pending.id === c.convId));
  const refused = refusedDelete("conversation");

  return (
    <section className="st-page st-chat" data-view={convId ? "conv" : "list"}>
      <header className="st-chat-head">
        <div className="st-chat-head__text">
          <h1 className="st-chat-head__title">Chat</h1>
          <p className="st-chat-head__lede">Talk ideas through with your creative director. Nothing is made until you tap a button.</p>
        </div>
        <Btn main icon="plus" off={creating} onClick={() => void startChat()}>
          New chat
        </Btn>
      </header>
      {createProblem ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {createProblem}
        </p>
      ) : null}
      {refused ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {refused}
        </p>
      ) : null}

      <div className="st-chat-layout">
        <aside className="st-chat-side" aria-label="Chats">
          {problem ? (
            <Empty
              mood="oops"
              title="Your chats did not load"
              action={
                <Btn main icon="retry" onClick={() => setRound((n) => n + 1)}>
                  Try again
                </Btn>
              }
            >
              {problem}
            </Empty>
          ) : list === null ? (
            <Waiting label="Finding your chats…" />
          ) : shown.length ? (
            <ChatList conversations={shown} activeId={convId} onRename={rename} onDelete={remove} />
          ) : (
            <Empty
              title="No chats yet"
              action={
                <Btn main icon="plus" off={creating} onClick={() => void startChat()}>
                  Start a chat
                </Btn>
              }
            >
              Ask for ideas, a new character or help with a story.
            </Empty>
          )}
        </aside>
        <div className="st-chat-main">
          {convId ? (
            <ConversationView key={convId} ws={ws} convId={convId} listTitle={list?.find((c) => c.convId === convId)?.title} onConversation={onConversation} onMissing={() => void startChat()} />
          ) : (
            <div className="st-chat-pick-one">
              <Director size={88} mood="cheer" />
              <p>Pick a chat on the left, or tap New chat.</p>
            </div>
          )}
        </div>
      </div>
      {pending ? <UndoBar text={pending.text} onUndo={() => undoDelete()} /> : null}
    </section>
  );
}
