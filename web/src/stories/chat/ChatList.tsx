// The list of conversations (docs/CONTRACTS.md §45.27: history stays with each conversation; rename, delete).
import { useState } from "react";
import { A } from "../../components/ui.tsx";
import type { Conversation } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { Btn, ago } from "./kit.tsx";
import { knownProjectName, PROJECT_WORD } from "./project.ts";

export function ChatList({
  conversations,
  activeId,
  onRename,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onRename: (convId: string, title: string) => Promise<string | null>;
  onDelete: (conv: Conversation) => void;
}) {
  const [editing, setEditing] = useState<{ convId: string; title: string; problem: string | null } | null>(null);

  async function save() {
    if (!editing) return;
    const t = editing.title.trim();
    if (!t) return setEditing({ ...editing, problem: "Give it a name first." });
    const problem = await onRename(editing.convId, t);
    if (problem) setEditing({ ...editing, problem });
    else setEditing(null);
  }

  return (
    <ul className="st-chat-list" aria-label="Your chats">
      {conversations.map((c) => {
        const about = c.projectRef ? `${PROJECT_WORD[c.projectRef.kind]}: ${knownProjectName(c.projectRef) ?? "…"}` : null;
        const when = ago(c.lastMessageAt ?? c.createdAt);
        if (editing?.convId === c.convId)
          return (
            <li key={c.convId} className="st-chat-row is-editing">
              <label className="st-chat-field">
                <span className="st-chat-field__label">New name</span>
                <input
                  className="st-chat-input"
                  value={editing.title}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setEditing({ ...editing, title: e.target.value, problem: null })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              </label>
              <div className="st-chat-row__buttons">
                <Btn quiet onClick={() => setEditing(null)}>
                  Cancel
                </Btn>
                <Btn main onClick={() => void save()}>
                  Save
                </Btn>
              </div>
              {editing.problem ? (
                <p className="st-chat-note st-chat-note--bad" role="alert">
                  {editing.problem}
                </p>
              ) : null}
            </li>
          );
        return (
          <li key={c.convId} className={`st-chat-row${c.convId === activeId ? " is-on" : ""}`}>
            <A href={storiesHref({ name: "chat_conv", convId: c.convId })} className="st-chat-row__main" aria-current={c.convId === activeId ? "page" : undefined}>
              <span className="st-chat-row__title">{c.title}</span>
              <span className="st-chat-row__line">{[about, when].filter(Boolean).join(" · ")}</span>
            </A>
            <Btn quiet icon="pencil" label={`Rename ${c.title}`} onClick={() => setEditing({ convId: c.convId, title: c.title, problem: null })} />
            <Btn quiet icon="trash" label={`Delete ${c.title}`} onClick={() => onDelete(c)} />
          </li>
        );
      })}
    </ul>
  );
}
