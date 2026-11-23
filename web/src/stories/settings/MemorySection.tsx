// Lamo Stories › Settings › Memory (docs/CONTRACTS.md §45.27, §45.29 Memory): what Lamo Stories remembers, saved
// by the creative director from the chat ("remember") or added here. Add, edit and delete; each line up to 300
// letters. Every Lamo Stories agent reads the list (the newest 50) after its skills; Clip Factory never sees it.
import { useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { MemoryItem } from "../api/types.ts";
import { Btn, cheer, Chip, Empty, Failed, Loading, SetCard, SIcon, whenText } from "./bits.tsx";

export const MEMORY_MAX = 300;

function Counter({ n }: { n: number }) {
  return <span className={`st-stg-small${n > MEMORY_MAX ? " st-stg-over" : ""}`}>{`${n} of ${MEMORY_MAX} letters`}</span>;
}

function Row({ item, onSave, onDelete }: { item: MemoryItem; onSave: (text: string, el: HTMLElement | null) => Promise<boolean>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const id = `mem-${item.memId}`;
  return (
    <li className="st-stg-mem">
      {editing ? (
        <form
          className="st-stg-mem__form"
          onSubmit={(e) => {
            e.preventDefault();
            const el = e.currentTarget.querySelector<HTMLElement>("button[type=submit]");
            void onSave(text, el).then((ok) => ok && setEditing(false));
          }}
        >
          <label className="sr-only" htmlFor={id}>
            Change this memory
          </label>
          <textarea id={id} className="st-stg-textarea" rows={2} maxLength={MEMORY_MAX} value={text} onChange={(e) => setText(e.target.value)} />
          <Counter n={text.length} />
          <div className="st-stg-actions">
            <Btn main type="submit" off={!text.trim() ? "Type something first" : text.trim() === item.text ? "Nothing changed yet" : undefined}>
              Save
            </Btn>
            <Btn
              quiet
              onClick={() => {
                setText(item.text);
                setEditing(false);
              }}
            >
              Cancel
            </Btn>
          </div>
        </form>
      ) : (
        <>
          <p className="st-stg-mem__text">{item.text}</p>
          <div className="st-stg-mem__foot">
            <Chip tone={item.source === "chat" ? "sky" : "mint"}>{item.source === "chat" ? "From the chat" : "You added it"}</Chip>
            <span className="st-stg-small">{whenText(item.updatedAt)}</span>
            <span className="st-stg-mem__btns">
              <Btn quiet small label={`Change: ${item.text}`} onClick={() => setEditing(true)}>
                <SIcon name="pencil" size={20} />
                Change
              </Btn>
              <Btn quiet small danger label={`Delete: ${item.text}`} onClick={onDelete}>
                <SIcon name="trash" size={20} />
                Delete
              </Btn>
            </span>
          </div>
        </>
      )}
    </li>
  );
}

export function MemorySection({ ws }: { ws: string }) {
  const toast = useToast();
  const memory = useLoad(() => storiesApi().listMemory(ws), ws, "st-settings-memory");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const list = (memory.data ?? []).filter((m) => !hidden.includes(m.memId));

  const add = async (el: HTMLElement | null) => {
    const t = text.trim();
    if (!t) {
      toast.error("Type something to remember first.");
      return;
    }
    setBusy(true);
    try {
      const item = await storiesApi().addMemory(ws, t);
      memory.setData((l) => [item, ...(l ?? [])]);
      setText("");
      cheer(el);
      toast.success("Remembered. Every Clips Funded agent reads it from now on.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (item: MemoryItem, next: string, el: HTMLElement | null) => {
    try {
      const saved = await storiesApi().patchMemory(ws, item.memId, next.trim());
      memory.setData((l) => (l ? l.map((m) => (m.memId === saved.memId ? saved : m)) : l));
      cheer(el);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    }
  };
  const remove = (item: MemoryItem) => {
    setHidden((h) => [...h, item.memId]);
    toast.undo("Forgotten.", {
      onUndo: () => setHidden((h) => h.filter((id) => id !== item.memId)),
      onCommit: () => {
        void storiesApi()
          .deleteMemory(ws, item.memId)
          .then(() => memory.setData((l) => (l ? l.filter((m) => m.memId !== item.memId) : l)))
          .catch((e: unknown) => {
            toast.error(friendlyMessage(e));
            setHidden((h) => h.filter((id) => id !== item.memId));
          });
      },
    });
  };

  return (
    <div className="st-stg-cards">
      <SetCard title="Add something to remember" icon="plus" lede="A fact or a wish, in one short line. Like: Lamo likes slapstick endings.">
        <form
          className="st-stg-mem__add"
          onSubmit={(e) => {
            e.preventDefault();
            void add(e.currentTarget.querySelector("button[type=submit]"));
          }}
        >
          <label className="st-stg-label" htmlFor="mem-new">
            Remember this
          </label>
          <textarea id="mem-new" className="st-stg-textarea" rows={2} maxLength={MEMORY_MAX} value={text} placeholder="Pip always waves at the end" onChange={(e) => setText(e.target.value)} />
          <div className="st-stg-mem__addfoot">
            <Counter n={text.length} />
            <Btn main type="submit" off={busy ? "Saving…" : !text.trim() ? "Type something first" : undefined}>
              <SIcon name="plus" size={20} />
              Remember it
            </Btn>
          </div>
        </form>
      </SetCard>
      <SetCard title="What Clips Funded remembers" icon="note" lede="Every Clips Funded agent reads these before it works, newest first. Clip Factory never sees them.">
        {memory.error && !memory.data ? <Failed message={memory.error} onRetry={() => void memory.reload()} /> : null}
        {!memory.data && !memory.error ? <Loading label="Getting the memory…" /> : null}
        {memory.data && !list.length ? (
          <Empty title="Nothing remembered yet" mood="sleepy">
            Add a line above, or tell the chat "remember that…".
          </Empty>
        ) : null}
        {list.length ? (
          <ul className="st-stg-mems" aria-label="Memory">
            {list.map((m) => (
              <Row key={m.memId} item={m} onSave={(t, el) => save(m, t, el)} onDelete={() => remove(m)} />
            ))}
          </ul>
        ) : null}
      </SetCard>
    </div>
  );
}
