// "About: Pip's icy morning": the project a conversation is about (docs/CONTRACTS.md §45.27), with a picker to
// choose or change it (ideas, videos, characters, reference videos) or "Nothing in particular".
import { useEffect, useState } from "react";
import { A } from "../../components/ui.tsx";
import type { ProjectRef } from "../api/types.ts";
import { Btn, Icon, Pick, Sheet, Waiting, type IconName } from "./kit.tsx";
import { knownProjectName, PROJECT_WORD, projectChoices, projectHref, projectName, type ProjectChoice } from "./project.ts";

const KIND_ICON: Record<ProjectRef["kind"], IconName> = { idea: "bulb", story: "clapper", character: "face", reference: "film" };
const KINDS: { value: ProjectRef["kind"]; label: string }[] = [
  { value: "idea", label: "Ideas" },
  { value: "story", label: "Videos" },
  { value: "character", label: "Characters" },
  { value: "reference", label: "References" },
];
const NONE = "__none";

export function ProjectChip({ ws, value, onChange }: { ws: string; value: ProjectRef | null; onChange: (ref: ProjectRef | null) => Promise<void> }) {
  const [name, setName] = useState<string | null>(value ? knownProjectName(value) : null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    if (!value) return;
    setName(knownProjectName(value));
    void projectName(ws, value).then((n) => {
      if (live) setName(n);
    });
    return () => {
      live = false;
    };
  }, [ws, value]);

  return (
    <div className="st-chat-project">
      {value ? (
        <A href={projectHref(value)} className="st-chat-project__chip">
          <Icon name={KIND_ICON[value.kind]} size={18} />
          <span>
            {PROJECT_WORD[value.kind]}: <b>{name ?? "…"}</b>
          </span>
        </A>
      ) : (
        <span className="st-chat-project__none">Not about anything in particular</span>
      )}
      <Btn quiet onClick={() => setOpen(true)}>
        {value ? "Change" : "Pick what it is about"}
      </Btn>
      {open ? (
        <ProjectSheet
          ws={ws}
          value={value}
          onClose={() => setOpen(false)}
          onPick={async (ref) => {
            await onChange(ref);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectSheet({ ws, value, onPick, onClose }: { ws: string; value: ProjectRef | null; onPick: (ref: ProjectRef | null) => Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<ProjectRef["kind"]>(value?.kind ?? "idea");
  const [list, setList] = useState<{ items: ProjectChoice[]; failed: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    void projectChoices(ws, kind).then((r) => {
      if (live) setList(r);
    });
    return () => {
      live = false;
    };
  }, [ws, kind]);

  const current = value && value.kind === kind ? value.id : value ? "" : NONE;
  async function choose(id: string) {
    setProblem(null);
    try {
      await onPick(id === NONE ? null : { kind, id });
    } catch {
      setProblem("That did not save. Try again.");
    }
  }

  return (
    <Sheet
      title="What is this chat about?"
      onClose={onClose}
      wide
      actions={
        <Btn main onClick={onClose}>
          Done
        </Btn>
      }
    >
      <Pick label="Kind of project" value={kind} options={KINDS} onChange={setKind} className="st-chat-pick--bar" />
      {list === null ? (
        <Waiting label="Finding them…" />
      ) : (
        <Pick
          label={`Pick ${KINDS.find((k) => k.value === kind)!.label.toLowerCase()}`}
          value={current}
          stack
          onChange={(id) => void choose(id)}
          options={[
            { value: NONE, label: "Nothing in particular", line: "A chat about anything." },
            ...list.items.map((it) => ({ value: it.ref.id, label: it.name, line: it.line })),
          ]}
        />
      )}
      {list && !list.items.length ? <p className="st-chat-sheet__lede">{list.failed ? "These did not load. Try again in a moment." : `No ${KINDS.find((k) => k.value === kind)!.label.toLowerCase()} yet.`}</p> : null}
      {problem ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {problem}
        </p>
      ) : null}
    </Sheet>
  );
}
