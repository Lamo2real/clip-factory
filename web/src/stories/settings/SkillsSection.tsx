// Lamo Stories › Settings › Skills (docs/CONTRACTS.md §45.26, §45.29 Skills): Lamo Stories' own skills, never Clip
// Factory's. Upload a SKILL.md (up to 1 MB) or a .zip (up to 20 MB) with its progress, or write one here (a name,
// when to use it, what to do); every save is a new version (the last 10 kept, any can be restored); switch a skill on
// or off; give it to agents or take it off them; built-ins (stories/skills/) can be switched off and taken off agents,
// never changed or deleted.
import { useEffect, useRef, useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Agent, AgentId, Skill } from "../api/types.ts";
import { Btn, cheer, Chip, Empty, Failed, Loading, Note, Progress, SetCard, SetSwitch, SIcon, sizeText, whenText } from "./bits.tsx";
import { useAi } from "./data.ts";

const MD_MAX = 1_000_000;
const ZIP_MAX = 20_000_000;

/** A file the owner picked, checked before anything is sent: a .md up to 1 MB or a .zip up to 20 MB. */
export function checkSkillFile(file: { name: string; size: number }): string | null {
  const ext = /\.(md|zip)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (!ext) return "That is not a skill. Pick a SKILL.md file or a .zip with one inside.";
  if (ext === "md" && file.size > MD_MAX) return "That skill file is too big. Pick one under 1 MB.";
  if (ext === "zip" && file.size > ZIP_MAX) return "That .zip is too big. Pick one under 20 MB.";
  if (!file.size) return "That file is empty. Pick another one.";
  return null;
}

/** The instructions part of a SKILL.md (what follows its front matter). */
export function skillBody(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(md);
  return (m ? m[1]! : md).trim();
}

export function sourceWords(s: Skill): string {
  if (s.builtin) return "Comes with Clip Stories";
  if (s.source === "written") return "Written by you";
  return s.format === "zip" ? "Uploaded .zip" : "Uploaded file";
}

/** Uploads one file to Lamo Stories' own skill store, with its progress; a skillId makes it a new version. */
function useSkillUpload(ws: string, done: (s: Skill) => void) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const upload = async (file: File, existing?: Skill, el?: HTMLElement | null) => {
    const problem = checkSkillFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setProgress(0);
    try {
      const target = await storiesApi().skillUpload(ws, { filename: file.name, ...(existing ? { skillId: existing.skillId } : {}) });
      await putFile({ key: target.key, uploadUrl: target.uploadUrl, headers: target.headers }, file, setProgress);
      const saved = existing ? await storiesApi().putSkill(ws, existing.skillId, { version: existing.version, key: target.key }) : await storiesApi().createSkill(ws, { skillId: target.skillId, key: target.key });
      done(saved);
      cheer(el);
      toast.success(existing ? `A new version of ${saved.title} is saved.` : `${saved.title} is saved. Give it to an agent to use it.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setProgress(null);
    }
  };
  return { progress, upload };
}

/** The file picker. While an upload runs it stays clickable (the deny sound) but opens nothing: never `disabled`. */
function FilePick({ label, onFile, off }: { label: string; onFile: (f: File, el: HTMLElement) => void; off?: string }) {
  const ref = useRef<HTMLLabelElement>(null);
  return (
    <label ref={ref} className="st-btn st-stg-btn st-stg-file" aria-disabled={off ? true : undefined} title={off}>
      <SIcon name="upload" size={20} />
      {label}
      <input
        className="sr-only"
        type="file"
        accept=".md,.zip,text/markdown,application/zip"
        aria-disabled={off ? true : undefined}
        onClick={(e) => {
          if (off) e.preventDefault();
        }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && ref.current && !off) onFile(f, ref.current);
        }}
      />
    </label>
  );
}

function WriteForm({ ws, onSaved, onCancel }: { ws: string; onSaved: (s: Skill) => void; onCancel: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="st-stg-form"
      aria-label="Write a skill"
      onSubmit={(e) => {
        e.preventDefault();
        const el = e.currentTarget.querySelector<HTMLElement>("button[type=submit]");
        if (!title.trim() || !description.trim() || !instructions.trim()) {
          toast.error("Fill in all three: its name, when to use it and what to do.");
          return;
        }
        setBusy(true);
        void storiesApi()
          .createSkill(ws, { title: title.trim(), description: description.trim(), instructions })
          .then((s) => {
            onSaved(s);
            cheer(el);
            toast.success(`${s.title} is saved. Give it to an agent to use it.`);
          })
          .catch((err: unknown) => toast.error(friendlyMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      <span className="st-stg-field">
        <label className="st-stg-label" htmlFor="sk-title">
          Its name
        </label>
        <input id="sk-title" className="st-stg-input" maxLength={60} value={title} placeholder="Slapstick timing" onChange={(e) => setTitle(e.target.value)} />
      </span>
      <span className="st-stg-field">
        <label className="st-stg-label" htmlFor="sk-when">
          When to use it
        </label>
        <input id="sk-when" className="st-stg-input" maxLength={300} value={description} placeholder="When a scene needs a funny fall" onChange={(e) => setDescription(e.target.value)} />
      </span>
      <span className="st-stg-field">
        <label className="st-stg-label" htmlFor="sk-what">
          What to do
        </label>
        <textarea id="sk-what" className="st-stg-textarea" rows={8} value={instructions} placeholder="Hold the moment before the fall for half a second…" onChange={(e) => setInstructions(e.target.value)} />
      </span>
      <div className="st-stg-actions">
        <Btn main type="submit" off={busy ? "Saving…" : undefined}>
          Save the skill
        </Btn>
        <Btn quiet onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function SkillDetail({ ws, skill, agents, onSaved, onAssign, onDelete }: { ws: string; skill: Skill; agents: Agent[]; onSaved: (s: Skill) => void; onAssign: (agentId: AgentId, on: boolean) => void; onDelete: () => void }) {
  const toast = useToast();
  const full = useLoad(() => storiesApi().getSkill(ws, skill.skillId), `${skill.skillId}:${skill.version}`);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(skill.title);
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const { progress, upload } = useSkillUpload(ws, onSaved);
  useEffect(() => {
    if (full.data) setInstructions(skillBody(full.data.content));
  }, [full.data]);
  useEffect(() => {
    setTitle(skill.title);
    setDescription(skill.description);
  }, [skill.title, skill.description]);

  const saveEdit = async (el: HTMLElement | null) => {
    setBusy(true);
    try {
      const s = await storiesApi().putSkill(ws, skill.skillId, { version: skill.version, title: title.trim(), description: description.trim(), instructions });
      onSaved(s);
      setEditing(false);
      cheer(el);
      toast.success(`Saved as version ${s.revisions.length}.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (revisionId: string, el: HTMLElement) => {
    setBusy(true);
    try {
      const s = await storiesApi().restoreSkill(ws, skill.skillId, revisionId);
      onSaved(s);
      cheer(el);
      toast.success("That version is back. It is saved as the newest one.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-stg-skill__detail">
      <h4 className="st-stg-subhead">Which agents use it</h4>
      <ul className="st-stg-assignlist" aria-label={`Agents that use ${skill.title}`}>
        {agents.map((a) => (
          <li key={a.agentId}>
            <SetSwitch label={a.name} checked={a.skillIds.includes(skill.skillId)} onChange={(on) => onAssign(a.agentId, on)} description={a.active ? undefined : "This agent is switched off."} />
          </li>
        ))}
      </ul>

      <h4 className="st-stg-subhead">What it says</h4>
      {full.error && !full.data ? <Failed message={full.error} onRetry={() => void full.reload()} /> : null}
      {!full.data && !full.error ? <Loading label="Opening the skill…" /> : null}
      {full.data && !editing ? (
        <>
          {skill.format === "zip" ? <p className="st-stg-small">A .zip skill: this is its SKILL.md. Its other files go along with it.</p> : null}
          <pre className="st-stg-pre" tabIndex={0} aria-label={`${skill.title}, its words`}>
            {full.data.content}
          </pre>
        </>
      ) : null}
      {editing ? (
        <form
          className="st-stg-form"
          aria-label={`Change ${skill.title}`}
          onSubmit={(e) => {
            e.preventDefault();
            void saveEdit(e.currentTarget.querySelector("button[type=submit]"));
          }}
        >
          <span className="st-stg-field">
            <label className="st-stg-label" htmlFor={`t-${skill.skillId}`}>
              Its name
            </label>
            <input id={`t-${skill.skillId}`} className="st-stg-input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
          </span>
          <span className="st-stg-field">
            <label className="st-stg-label" htmlFor={`d-${skill.skillId}`}>
              When to use it
            </label>
            <input id={`d-${skill.skillId}`} className="st-stg-input" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
          </span>
          <span className="st-stg-field">
            <label className="st-stg-label" htmlFor={`i-${skill.skillId}`}>
              What to do
            </label>
            <textarea id={`i-${skill.skillId}`} className="st-stg-textarea" rows={10} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </span>
          <div className="st-stg-actions">
            <Btn main type="submit" off={busy ? "Saving…" : undefined}>
              Save as a new version
            </Btn>
            <Btn quiet onClick={() => setEditing(false)}>
              Cancel
            </Btn>
          </div>
        </form>
      ) : null}

      {skill.builtin ? (
        <Note tone="sky">This skill comes with Clip Stories, so its words can't be changed. You can switch it off, or take it off an agent.</Note>
      ) : (
        <>
          <div className="st-stg-actions">
            {!editing && skill.format === "md" ? (
              <Btn onClick={() => setEditing(true)} off={!full.data ? "Opening…" : undefined}>
                <SIcon name="pencil" size={20} />
                Change it
              </Btn>
            ) : null}
            <FilePick label="Upload a new version" off={progress !== null ? "Uploading…" : undefined} onFile={(f, el) => void upload(f, skill, el)} />
          </div>
          {progress !== null ? <Progress value={progress} label="Upload progress" /> : null}
          <h4 className="st-stg-subhead">Versions</h4>
          <ol className="st-stg-versions" aria-label={`Versions of ${skill.title}`}>
            {skill.revisions.map((r, i) => (
              <li key={r.revisionId} className="st-stg-versions__row">
                <span>
                  <strong>Version {skill.revisions.length - i}</strong> · saved {whenText(r.savedAt)} · {sizeText(r.size)}
                </span>
                {i === 0 ? (
                  <Chip tone="mint">In use</Chip>
                ) : (
                  <Btn small off={busy ? "Working…" : undefined} label={`Bring back version ${skill.revisions.length - i}`} onClick={(e) => void restore(r.revisionId, e.currentTarget)}>
                    Bring it back
                  </Btn>
                )}
              </li>
            ))}
          </ol>
          <p className="st-stg-small">The last 10 versions are kept.</p>
          {asking ? (
            <div className="st-stg-confirm" role="group" aria-label="Are you sure?">
              <p>Delete {skill.title}? Agents stop using it.</p>
              <div className="st-stg-actions">
                <Btn
                  danger
                  onClick={() => {
                    setAsking(false);
                    onDelete();
                  }}
                >
                  Yes, delete it
                </Btn>
                <Btn quiet onClick={() => setAsking(false)}>
                  No, keep it
                </Btn>
              </div>
            </div>
          ) : (
            <Btn quiet danger onClick={() => setAsking(true)}>
              <SIcon name="trash" size={20} />
              Delete this skill
            </Btn>
          )}
        </>
      )}
    </div>
  );
}

export function SkillsSection({ ws }: { ws: string }) {
  const toast = useToast();
  const skills = useLoad(() => storiesApi().listSkills(ws), ws, "st-settings-skills");
  const ai = useAi(ws);
  const [open, setOpen] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const add = useSkillUpload(ws, (s) => {
    skills.setData((list) => (list ? [...list.filter((x) => x.skillId !== s.skillId), s] : [s]));
    setOpen(s.skillId);
  });
  const agents = ai.data?.agents ?? [];

  const put = (s: Skill) => skills.setData((list) => (list ? list.map((x) => (x.skillId === s.skillId ? s : x)) : list));
  const assign = async (skill: Skill, agentId: AgentId, on: boolean) => {
    const a = agents.find((x) => x.agentId === agentId);
    if (!a) return;
    const ids = on ? [...a.skillIds.filter((id) => id !== skill.skillId), skill.skillId] : a.skillIds.filter((id) => id !== skill.skillId);
    const saved = await ai.saveAgent(agentId, { skillIds: ids });
    if (saved) {
      put({ ...skill, agentIds: on ? [...skill.agentIds.filter((x) => x !== agentId), agentId] : skill.agentIds.filter((x) => x !== agentId) });
      toast.success(on ? `${a.name} uses ${skill.title} now.` : `${a.name} no longer uses ${skill.title}.`);
    }
  };
  // One switch save at a time per skill, each on the version the last answer gave; taps made meanwhile end in one
  // more save of the last position (so a quick double tap never sends a stale version).
  const toggles = useRef(new Map<string, { want: boolean; version: number }>());
  const toggle = async (skill: Skill, enabled: boolean) => {
    put({ ...skill, enabled });
    const busy = toggles.current.get(skill.skillId);
    if (busy) {
      busy.want = enabled;
      return;
    }
    const t = { want: enabled, version: skill.version };
    toggles.current.set(skill.skillId, t);
    try {
      let last: Skill | null = null;
      while (!last || last.enabled !== t.want) {
        last = await storiesApi().putSkill(ws, skill.skillId, { version: t.version, enabled: t.want });
        t.version = last.version;
      }
      toggles.current.delete(skill.skillId);
      put(last);
    } catch (e) {
      toggles.current.delete(skill.skillId);
      toast.error(friendlyMessage(e));
      await skills.reload();
    }
  };
  const remove = (skill: Skill) => {
    setHidden((h) => [...h, skill.skillId]);
    setOpen(null);
    toast.undo(`${skill.title} is deleted.`, {
      onUndo: () => setHidden((h) => h.filter((id) => id !== skill.skillId)),
      onCommit: () => {
        void storiesApi()
          .deleteSkill(ws, skill.skillId)
          .then(() => {
            skills.setData((list) => (list ? list.filter((x) => x.skillId !== skill.skillId) : list));
            void ai.reload();
          })
          .catch((e: unknown) => {
            toast.error(friendlyMessage(e));
            setHidden((h) => h.filter((id) => id !== skill.skillId));
          });
      },
    });
  };

  const list = (skills.data ?? []).filter((s) => !hidden.includes(s.skillId));
  const names = (s: Skill) => s.agentIds.map((id) => agents.find((a) => a.agentId === id)?.name ?? id);

  return (
    <div className="st-stg-cards">
      <SetCard title="Add a skill" icon="plus" lede="Upload a SKILL.md (up to 1 MB) or a .zip with one inside (up to 20 MB), or write one here.">
        <div className="st-stg-actions">
          <FilePick label="Upload a file" off={add.progress !== null ? "Uploading…" : undefined} onFile={(f, el) => void add.upload(f, undefined, el)} />
          <Btn main off={writing ? "The form is open below" : undefined} onClick={() => setWriting(true)}>
            <SIcon name="pencil" size={20} />
            Write one here
          </Btn>
        </div>
        {add.progress !== null ? <Progress value={add.progress} label="Upload progress" /> : null}
        {writing ? (
          <WriteForm
            ws={ws}
            onCancel={() => setWriting(false)}
            onSaved={(s) => {
              skills.setData((l) => (l ? [...l, s] : [s]));
              setWriting(false);
              setOpen(s.skillId);
            }}
          />
        ) : null}
      </SetCard>

      <SetCard title="Your skills" icon="book" lede="Built-in skills come first. A skill that is off is skipped by every agent.">
        {skills.error && !skills.data ? <Failed message={skills.error} onRetry={() => void skills.reload()} /> : null}
        {!skills.data && !skills.error ? <Loading label="Getting the skills…" /> : null}
        {skills.data && !list.length ? <Empty title="No skills yet">Upload one or write one above.</Empty> : null}
        <ul className="st-stg-skillcards" aria-label="Skills">
          {list.map((s) => {
            const isOpen = open === s.skillId;
            const users = names(s);
            return (
              <li key={s.skillId} className={`st-stg-skill${isOpen ? " is-open" : ""}${s.enabled ? "" : " is-off"}`}>
                <div className="st-stg-skill__head">
                  <div className="st-stg-skill__text">
                    <span className="st-stg-skill__title">{s.title}</span>
                    <span className="st-stg-small">{s.description}</span>
                  </div>
                  <div className="st-stg-skill__chips">
                    <Chip tone={s.builtin ? "sky" : s.source === "written" ? "mint" : "sun"}>{sourceWords(s)}</Chip>
                    {!s.builtin ? <Chip>{`${s.revisions.length} ${s.revisions.length === 1 ? "version" : "versions"}`}</Chip> : null}
                  </div>
                </div>
                <SetSwitch label={s.enabled ? "On" : "Off"} name={`Use ${s.title}`} checked={s.enabled} onChange={(v) => void toggle(s, v)} description={s.enabled ? "Agents that have it read it." : "Every agent skips it for now."} />
                <div className="st-stg-skill__foot">
                  <p className="st-stg-skill__users">{users.length ? `Used by: ${users.join(", ")}` : "No agent uses it yet."}</p>
                  <Btn quiet onClick={() => setOpen(isOpen ? null : s.skillId)} label={`${isOpen ? "Close" : "Open"} ${s.title}`}>
                    <SIcon name={isOpen ? "up" : "chevron"} size={20} />
                    {isOpen ? "Close" : "Open"}
                  </Btn>
                </div>
                {isOpen ? <SkillDetail ws={ws} skill={s} agents={agents} onSaved={put} onAssign={(id, on) => void assign(s, id, on)} onDelete={() => remove(s)} /> : null}
              </li>
            );
          })}
        </ul>
      </SetCard>
    </div>
  );
}
