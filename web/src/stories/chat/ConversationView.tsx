// One conversation with the creative director (docs/CONTRACTS.md §45.27): the messages, the project it is about,
// the model and effort line above the box, pictures, Send and Stop. A sent message shows at once; the answer arrives
// as it is written (the page asks every second while one is being written); its buttons wait for the owner's tap.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { A } from "../../components/ui.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Conversation, Message, ModelOverride, ProjectRef } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { ActionCard } from "./actions.tsx";
import { AiLine, AiSheet, DEFAULT } from "./ai.tsx";
import { rememberConversation } from "./device.ts";
import { Btn, Chip, Director, Empty, Icon, Progress, sentence, Waiting } from "./kit.tsx";
import { afterId, askedBefore, inFlight, LOCAL, mergeMessages } from "./messages.ts";
import { effortLabel, effortProblem, findModel, modelLabel, useModels, withOverride } from "./models.ts";
import { ProjectChip } from "./ProjectChip.tsx";
import { ChatText } from "./text.tsx";
import { pictureProblem, PICTURES_PER_MESSAGE, putPicture } from "./upload.ts";

export const MAX_TEXT = 8000;

export const SUGGESTIONS = ["Give me three funny ideas about ice", "Help me make a new character", "How do I start a video so people keep watching?"];

/** Pictures sent from this device this visit, shown from the file itself (the server's link may be a while). */
const localPictures = new Map<string, string>();

interface Attached {
  key: string;
  file: File;
  url: string | null;
  progress: number;
  assetId: string | null;
  problem: string | null;
}

let localSeq = 0;

function localMessage(convId: string, text: string, attachments: Message["attachments"]): Message {
  localSeq += 1;
  return {
    msgId: `${LOCAL}${localSeq}`,
    convId,
    role: "user",
    text,
    attachments,
    status: "pending",
    model: null,
    effort: null,
    effortApplied: null,
    usage: null,
    actions: [],
    createdAt: new Date().toISOString(),
  };
}

const nearBottom = () => typeof window !== "undefined" && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200;

export function ConversationView({
  ws,
  convId,
  listTitle,
  onConversation,
  onMissing,
}: {
  ws: string;
  convId: string;
  /** the name the list shows (renamed there, it changes here too) */
  listTitle?: string;
  onConversation: (c: Conversation) => void;
  onMissing: () => void;
}) {
  const models = useModels(ws);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadProblem, setLoadProblem] = useState<{ text: string; missing: boolean } | null>(null);
  const [round, setRound] = useState(0);
  const [text, setText] = useState("");
  const [pictures, setPictures] = useState<Attached[]>([]);
  const [override, setOverride] = useState<ModelOverride | null>(null);
  const [sheet, setSheet] = useState<null | { scope: "chat" | "once" }>(null);
  const [sheetProblem, setSheetProblem] = useState<string | null>(null);
  const [sheetSaved, setSheetSaved] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [failedSend, setFailedSend] = useState<{ localId: string; text: string; attachments: string[]; override: ModelOverride | null } | null>(null);
  const [whyNot, setWhyNot] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onConv = useRef(onConversation);
  onConv.current = onConversation;

  const show = useCallback((c: Conversation) => {
    setConv(c);
    onConv.current(c);
  }, []);

  useEffect(() => {
    let live = true;
    setLoadProblem(null);
    storiesApi()
      .getConversation(ws, convId)
      .then((r) => {
        if (!live) return;
        show(r.conversation);
        setMessages(r.messages);
        rememberConversation(convId);
        stick.current = true;
      })
      .catch((e: unknown) => {
        if (!live) return;
        const missing = (e as { code?: string })?.code === "not_found";
        if (missing) rememberConversation(null);
        setLoadProblem({ text: missing ? "We could not find that chat. It may have been deleted." : sentence(e, "The chat did not load. Try again."), missing });
      });
    return () => {
      live = false;
    };
  }, [ws, convId, round, show]);

  // When the page goes, the pictures that were never sent let go of their files.
  const shownPictures = useRef<Attached[]>([]);
  shownPictures.current = pictures;
  useEffect(
    () => () => {
      for (const p of shownPictures.current) if (p.url && !p.assetId) URL.revokeObjectURL(p.url);
    },
    [],
  );

  // Keep the newest words in view while they arrive, unless the owner scrolled up to read.
  useLayoutEffect(() => {
    if (stick.current) end.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);
  useEffect(() => {
    const onScroll = () => {
      stick.current = nearBottom();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const writing = messages.find((m) => m.role === "assistant" && inFlight(m)) ?? null;

  usePoll(
    async () => {
      const r = await storiesApi().getConversation(ws, convId, afterId(messages));
      show(r.conversation);
      setMessages((prev) => mergeMessages(prev, r.messages));
    },
    !!writing,
    1000,
  );

  if (loadProblem)
    return (
      <Empty
        mood="oops"
        title={loadProblem.missing ? "That chat is gone" : "The chat did not load"}
        action={
          loadProblem.missing ? (
            <Btn main icon="plus" onClick={onMissing}>
              Start a new chat
            </Btn>
          ) : (
            <Btn main icon="retry" onClick={() => setRound((n) => n + 1)}>
              Try again
            </Btn>
          )
        }
      >
        {loadProblem.text}
      </Empty>
    );
  if (!conv) return <Waiting label="Opening the chat…" />;

  const title = listTitle ?? conv.title;
  const current = withOverride(conv.effective, override);
  const model = findModel(models.models, current.model);
  const uploading = pictures.some((p) => !p.assetId && !p.problem);
  const effortBad = effortProblem(model, current.effort);
  const visionBad = pictures.length && model && !model.vision ? `${model.label} can't look at pictures. Pick another model, or take the pictures out.` : null;
  const blocked =
    sending || writing
      ? "Wait for the answer first."
      : !text.trim()
        ? "Type a message first."
        : text.length > MAX_TEXT
          ? `That is too long. Keep it under ${MAX_TEXT} letters.`
          : uploading
            ? "Wait for the pictures to finish."
            : pictures.some((p) => p.problem)
              ? "Take out the pictures that did not work first."
              : (effortBad ?? visionBad);

  async function send(words = text, attachmentIds = pictures.filter((p) => p.assetId).map((p) => p.assetId!), once = override) {
    if (!conv) return;
    const clean = words.trim();
    if (!clean) return;
    setSendProblem(null);
    setFailedSend(null);
    setWhyNot(null);
    const shown = attachmentIds.map((assetId) => ({ assetId, url: localPictures.get(assetId) ?? "", contentType: "image/*" }));
    const temp = localMessage(conv.convId, clean, shown);
    stick.current = true;
    setMessages((prev) => [...prev, temp]);
    setSending(true);
    setText("");
    setPictures([]);
    try {
      const body: { text: string; attachments?: { assetId: string }[]; override?: ModelOverride } = { text: clean };
      if (attachmentIds.length) body.attachments = attachmentIds.map((assetId) => ({ assetId }));
      if (once && (once.model || once.effort)) body.override = { ...(once.model ? { model: once.model } : {}), ...(once.effort ? { effort: once.effort } : {}) };
      const r = await storiesApi().sendMessage(ws, conv.convId, body);
      setMessages((prev) => [...prev.filter((m) => m.msgId !== temp.msgId), r.user, r.assistant]);
      setOverride(null);
      void storiesApi()
        .getConversation(ws, conv.convId, r.assistant.msgId)
        .then((c) => show(c.conversation))
        .catch(() => undefined);
    } catch (e) {
      setFailedSend({ localId: temp.msgId, text: clean, attachments: attachmentIds, override: once });
      setSendProblem(sentence(e, "Your message did not send. Check your connection and try again."));
    } finally {
      setSending(false);
    }
  }

  function retrySend() {
    if (!failedSend) return;
    const f = failedSend;
    setMessages((prev) => prev.filter((m) => m.msgId !== f.localId));
    void send(f.text, f.attachments, f.override);
  }

  function dropFailed() {
    if (!failedSend) return;
    const f = failedSend;
    setMessages((prev) => prev.filter((m) => m.msgId !== f.localId));
    setText(f.text);
    setFailedSend(null);
    setSendProblem(null);
  }

  async function stop() {
    if (!conv || !writing || stopping) return;
    setStopping(true);
    try {
      const m = await storiesApi().stopMessage(ws, conv.convId, writing.msgId);
      setMessages((prev) => mergeMessages(prev, [m]));
    } catch (e) {
      setSendProblem(sentence(e, "It did not stop. Try again."));
    } finally {
      setStopping(false);
    }
  }

  function tapSend() {
    if (blocked) {
      setWhyNot(blocked);
      return;
    }
    void send();
  }

  function keys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // On a phone Enter starts a new line; Send is the button.
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    tapSend();
  }

  async function addPictures(files: FileList | null) {
    if (!files || !conv) return;
    const room = PICTURES_PER_MESSAGE - pictures.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) setWhyNot(`You can add up to ${PICTURES_PER_MESSAGE} pictures to one message.`);
    for (const file of list) {
      localSeq += 1;
      const key = `pic-${localSeq}`;
      const problem = pictureProblem(file);
      const url = typeof URL.createObjectURL === "function" && !problem ? URL.createObjectURL(file) : null;
      setPictures((prev) => [...prev, { key, file, url, progress: 0, assetId: null, problem }]);
      if (problem) continue;
      try {
        const target = await storiesApi().chatAttachment(ws, conv.convId, { filename: file.name, contentType: file.type, size: file.size });
        await putPicture(target, file, (f) => setPictures((prev) => prev.map((p) => (p.key === key ? { ...p, progress: f } : p))));
        if (url) localPictures.set(target.assetId, url);
        setPictures((prev) => prev.map((p) => (p.key === key ? { ...p, progress: 1, assetId: target.assetId } : p)));
      } catch (e) {
        setPictures((prev) => prev.map((p) => (p.key === key ? { ...p, problem: sentence(e, "The picture did not upload. Take it out and add it again.") } : p)));
      }
    }
  }

  function removePicture(key: string) {
    setPictures((prev) => {
      const p = prev.find((x) => x.key === key);
      if (p?.url && !p.assetId) URL.revokeObjectURL(p.url);
      return prev.filter((x) => x.key !== key);
    });
    setWhyNot(null);
  }

  async function saveTitle() {
    if (!conv || renaming === null) return;
    const t = renaming.trim();
    if (!t) return setRenameProblem("Give it a name first.");
    if (t.length > 80) return setRenameProblem("Keep the name under 80 letters.");
    try {
      show(await storiesApi().patchConversation(ws, conv.convId, { title: t }));
      setRenaming(null);
      setRenameProblem(null);
    } catch (e) {
      setRenameProblem(sentence(e, "The name did not save. Try again."));
    }
  }

  async function setProject(ref: ProjectRef | null) {
    if (!conv) return;
    show(await storiesApi().patchConversation(ws, conv.convId, { projectRef: ref }));
  }

  async function saveSetting(patch: { model?: string | null; effort?: Conversation["effort"] }) {
    if (!conv) return;
    setSheetProblem(null);
    setSheetSaved(null);
    try {
      show(await storiesApi().patchConversation(ws, conv.convId, patch));
      setSheetSaved("Saved for this chat.");
    } catch (e) {
      setSheetProblem(sentence(e, "That did not save. Try again."));
    }
  }

  function openSheet(_part: "model" | "effort", once: boolean) {
    setSheetProblem(null);
    setSheetSaved(null);
    setSheet({ scope: once ? "once" : "chat" });
  }

  const chatSuggested = models.tasks?.find((t) => t.kind === "chat")?.suggestedEffort ?? null;
  const sheetValues =
    sheet?.scope === "once"
      ? { model: current.model, effort: current.effort }
      : { model: conv.model ?? DEFAULT, effort: conv.effort ?? DEFAULT };
  const sheetModel = findModel(models.models, sheet?.scope === "once" ? current.model : (conv.model ?? conv.effective.model));
  const fromLine =
    override && (override.model || override.effort)
      ? "Only the next message uses this. Your chat's setting stays."
      : conv.effective.from === "conversation"
        ? "Saved for this chat."
        : "From Lamo Stories › Settings › AI.";

  return (
    <div className="st-chat-conv">
      <header className="st-chat-conv__head">
        <A href={`${storiesHref({ name: "chat" })}?all=1`} className="st-chat-back">
          <Icon name="back" size={20} />
          All chats
        </A>
        {renaming === null ? (
          <div className="st-chat-conv__title-row">
            <h2 className="st-chat-conv__title">{title}</h2>
            <Btn quiet icon="pencil" label={`Rename ${title}`} onClick={() => setRenaming(title)} />
          </div>
        ) : (
          <div className="st-chat-rename">
            <label className="st-chat-field">
              <span className="st-chat-field__label">Name of this chat</span>
              <input
                className="st-chat-input"
                value={renaming}
                maxLength={80}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            </label>
            <div className="st-chat-rename__buttons">
              <Btn quiet onClick={() => setRenaming(null)}>
                Cancel
              </Btn>
              <Btn main onClick={() => void saveTitle()}>
                Save
              </Btn>
            </div>
            {renameProblem ? (
              <p className="st-chat-note st-chat-note--bad" role="alert">
                {renameProblem}
              </p>
            ) : null}
          </div>
        )}
        <ProjectChip ws={ws} value={conv.projectRef} onChange={setProject} />
      </header>

      {messages.length === 0 ? (
        <div className="st-chat-start">
          <Director size={72} mood="cheer" />
          <p className="st-chat-start__hello">Hi! I'm your creative director. What shall we make?</p>
          <div className="st-chat-start__ideas">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="st-chat-suggest" onClick={() => void send(s, [], override)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className="st-chat-msgs" aria-label="Messages">
          {messages.map((m) => (
            <MessageItem
              key={m.msgId}
              ws={ws}
              m={m}
              models={models.models}
              failedSend={failedSend?.localId === m.msgId}
              onRetry={() => {
                const asked = askedBefore(messages, m.msgId);
                if (asked) void send(asked.text, asked.attachments.map((a) => a.assetId), override);
              }}
              onPickModel={() => openSheet("model", true)}
            />
          ))}
        </ol>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {writing ? (writing.status === "pending" ? "The director is thinking." : "The director is writing.") : ""}
      </p>

      <div className="st-chat-compose">
        {pictures.length ? (
          <ul className="st-chat-pics" aria-label="Pictures to send">
            {pictures.map((p) => (
              <li key={p.key} className={`st-chat-pic${p.problem ? " is-bad" : ""}`}>
                {p.url ? <img src={p.url} alt={p.file.name} className="st-chat-pic__img" /> : <Icon name="picture" size={28} />}
                {!p.assetId && !p.problem ? <Progress value={p.progress} label={`Uploading ${p.file.name}`} /> : null}
                {p.problem ? <span className="st-chat-pic__problem">{p.problem}</span> : null}
                <Btn quiet icon="close" label={`Take out ${p.file.name}`} className="st-chat-pic__remove" onClick={() => removePicture(p.key)} />
              </li>
            ))}
          </ul>
        ) : null}
        <AiLine
          models={models.models}
          current={current}
          override={override}
          onceLabel="Just for this message"
          clearLabel="Use the chat's setting"
          onPick={openSheet}
          onClearOverride={() => setOverride(null)}
          hint={
            <p className="st-chat-ai__note">
              <span className="st-chat-ai__from">{fromLine}</span>
              {models.problem ? (
                <>
                  {" "}
                  {models.problem}{" "}
                  <button type="button" className="st-chat-linkbtn" onClick={models.reload}>
                    Try again
                  </button>
                </>
              ) : null}
            </p>
          }
        />
        <div className="st-chat-compose__row">
          <Btn icon="picture" label="Add a picture" off={pictures.length >= PICTURES_PER_MESSAGE} onClick={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void addPictures(e.target.files);
              e.target.value = "";
            }}
          />
          <label className="st-chat-compose__label">
            <span className="sr-only">Your message</span>
            <textarea
              ref={box}
              className="st-chat-box"
              rows={Math.min(6, Math.max(1, text.split("\n").length))}
              value={text}
              placeholder="Ask the director…"
              onChange={(e) => {
                setText(e.target.value);
                setWhyNot(null);
              }}
              onKeyDown={keys}
            />
          </label>
          {writing ? (
            <Btn main icon="stop" className="st-chat-send" off={stopping} aria-label="Stop the answer" onClick={() => void stop()}>
              <span className="st-chat-send__word">Stop</span>
            </Btn>
          ) : (
            <button type="button" className="st-chat-btn st-chat-btn--main st-chat-send" aria-label="Send" aria-disabled={blocked ? true : undefined} onClick={tapSend}>
              <Icon name="send" size={20} />
              <span className="st-chat-send__word">Send</span>
            </button>
          )}
        </div>
        {text.length > MAX_TEXT - 400 ? <p className="st-chat-ai__note">{`${text.length} of ${MAX_TEXT} letters`}</p> : null}
        {whyNot ? (
          <p className="st-chat-note" role="status">
            {whyNot}
          </p>
        ) : null}
        {sendProblem ? (
          <div className="st-chat-note st-chat-note--bad st-chat-note--row" role="alert">
            <span>{sendProblem}</span>
            {failedSend ? (
              <>
                <Btn main icon="retry" onClick={retrySend}>
                  Try again
                </Btn>
                <Btn quiet onClick={dropFailed}>
                  Edit it
                </Btn>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div ref={end} className="st-chat-end" />

      {sheet ? (
        <AiSheet
          title="Model and effort"
          models={models.models}
          scope={sheet.scope}
          scopes={[
            { value: "chat", label: "For this chat" },
            { value: "once", label: "Just for this message" },
          ]}
          onScope={(scope) => {
            setSheetProblem(null);
            setSheetSaved(null);
            setSheet({ scope });
          }}
          values={sheetValues}
          effortModel={sheetModel}
          suggested={chatSuggested}
          problem={sheetProblem}
          saved={sheetSaved}
          onModel={(key) => {
            if (sheet.scope === "chat") void saveSetting({ model: key === DEFAULT ? null : key });
            else setOverride((o) => ({ ...(o ?? {}), model: key }));
          }}
          onEffort={(e) => {
            if (sheet.scope === "chat") void saveSetting({ effort: e === DEFAULT ? null : (e as Conversation["effort"]) });
            else setOverride((o) => ({ ...(o ?? {}), effort: e as NonNullable<Conversation["effort"]> }));
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}

function MessageItem({
  ws,
  m,
  models,
  failedSend,
  onRetry,
  onPickModel,
}: {
  ws: string;
  m: Message;
  models: ReturnType<typeof useModels>["models"];
  failedSend: boolean;
  onRetry: () => void;
  onPickModel: () => void;
}) {
  const pics = m.attachments.map((a) => ({ ...a, shown: localPictures.get(a.assetId) ?? (a.url && !a.url.startsWith("mock:") ? a.url : null) }));
  if (m.role === "user")
    return (
      <li className={`st-chat-msg st-chat-msg--user${m.msgId.startsWith(LOCAL) ? " is-local" : ""}`}>
        <div className="st-chat-bubble">
          {pics.length ? (
            <div className="st-chat-bubble__pics">
              {pics.map((p) =>
                p.shown ? (
                  <img key={p.assetId} src={p.shown} alt="A picture you sent" className="st-chat-bubble__pic" />
                ) : (
                  <span key={p.assetId} className="st-chat-bubble__pic st-chat-bubble__pic--none">
                    <Icon name="picture" size={24} />
                  </span>
                ),
              )}
            </div>
          ) : null}
          <ChatText text={m.text} />
          {m.msgId.startsWith(LOCAL) && !failedSend ? <span className="st-chat-msg__meta">Sending…</span> : null}
          {failedSend ? <span className="st-chat-msg__meta st-chat-msg__meta--bad">Not sent</span> : null}
        </div>
      </li>
    );

  const settings = m.error && /Settings › AI/.test(m.error);
  return (
    <li className={`st-chat-msg st-chat-msg--assistant is-${m.status}`} aria-busy={inFlight(m) || undefined}>
      <Director size={40} mood={m.status === "failed" ? "oops" : m.status === "pending" ? "think" : "smile"} />
      <div className="st-chat-bubble">
        {m.status === "pending" ? (
          <p className="st-chat-thinking">
            Thinking
            <span className="st-chat-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </p>
        ) : null}
        {m.text ? (
          <div className="st-chat-text">
            <ChatText text={m.text} />
            {m.status === "streaming" ? <span className="st-chat-caret" aria-hidden="true" /> : null}
          </div>
        ) : null}
        {m.status === "stopped" ? <Chip tone="sky">Stopped</Chip> : null}
        {m.status === "failed" ? (
          <div className="st-chat-failed" role="alert">
            <p>{m.error || "The director could not answer this time. Try again."}</p>
            <div className="st-chat-failed__buttons">
              <Btn main icon="retry" onClick={onRetry}>
                Try again
              </Btn>
              {settings ? (
                <>
                  <Btn quiet onClick={onPickModel}>
                    Pick another model
                  </Btn>
                  <A href={storiesHref({ name: "settings", section: "ai" })} className="st-chat-link">
                    Open Settings › AI
                  </A>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        {m.status === "done" && m.actions.length ? (
          <div className="st-chat-actions">
            {m.actions.map((a, i) => (
              <ActionCard key={`${m.msgId}:${i}`} id={`${m.msgId}:${i}`} ws={ws} action={a} />
            ))}
          </div>
        ) : null}
        {m.model && m.status !== "pending" ? (
          <span className="st-chat-msg__meta">
            {modelLabel(models, m.model)} · {m.effortApplied === false ? "no effort setting" : effortLabel(m.effort)}
          </span>
        ) : null}
      </div>
    </li>
  );
}
