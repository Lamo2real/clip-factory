import { useId, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { Skill } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, Pill, Progress, Skeleton } from "../../components/ui.tsx";
import { bytes } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { Apple, Panel } from "./parts.tsx";

const LIMITS = { md: 1024 ** 2, zip: 20 * 1024 ** 2 };

/** Settings > Clip making > Skills: add a skill, and every skill with its switch, View and Delete (Undo). */
export function SkillsSection() {
  const { data, error, reload, setData } = useLoad(() => api().listSkills());
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const id = useId();
  const order = useRef<string[]>([]);
  if (data) for (const s of data) if (!order.current.includes(s.skillId)) order.current.push(s.skillId);

  /** Deleting waits 8 seconds for an Undo before it really happens. */
  function remove(skill: Skill) {
    setData((d) => d?.filter((x) => x.skillId !== skill.skillId) ?? d);
    const restore = () =>
      setData((d) =>
        !d || d.some((x) => x.skillId === skill.skillId)
          ? d
          : [...d, skill].sort((a, b) => order.current.indexOf(a.skillId) - order.current.indexOf(b.skillId)),
      );
    toast.undo(`Deleted ${skill.name}.`, {
      onUndo: restore,
      onCommit: () => {
        api()
          .deleteSkill(skill.skillId)
          .catch((e) => {
            restore();
            toast.error(`${friendlyMessage(e)} The skill is back in your list.`);
          });
      },
    });
  }

  async function upload(file: File) {
    const ext = file.name.toLowerCase().endsWith(".zip") ? "zip" : file.name.toLowerCase().endsWith(".md") ? "md" : null;
    if (!ext) return toast.error("That is not a skill. Tap Add a skill and pick a SKILL.md file or a .zip with one inside.");
    if (file.size > LIMITS[ext])
      return toast.error(ext === "md" ? "That skill file is too big. Pick one under 1 MB." : "That .zip is too big. Pick one under 20 MB.");
    setProgress(0);
    try {
      const up = await api().createSkillUpload(file.name);
      await putFile(up, file, setProgress);
      const skill = await api().createSkill({ skillId: up.skillId, key: up.key });
      setData((d) => [...(d ?? []), skill]);
      toast.success(`Added ${skill.name}. It is used from your next clips.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <Panel>
        <Apple id="add-skill">
          <input
            ref={input}
            type="file"
            accept=".md,.zip,text/markdown,application/zip"
            className="sr-only"
            id={`${id}-file`}
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button icon="upload" loading={progress !== null} onClick={() => input.current?.click()}>
            Add a skill
          </Button>
        </Apple>
        {progress !== null ? <Progress value={progress} label="Skill upload progress" /> : null}
      </Panel>
      <Panel>
        <Apple id="your-skills" wide>
          {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
          {!data && !error ? <Skeleton className="line-skel" /> : null}
          {data && data.length === 0 ? (
            <p className="muted">No skills yet. Tap Add a skill to teach Clip Factory how you like your clips.</p>
          ) : null}
          {data && data.length > 0 ? (
            <ul className="skill-list">
              {data.map((s) => (
                <li key={s.skillId}>
                  <SkillRow
                    skill={s}
                    onChange={(next) => setData((d) => d?.map((x) => (x.skillId === next.skillId ? next : x)) ?? d)}
                    onRemove={() => remove(s)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </Apple>
      </Panel>
    </>
  );
}

function SkillRow({ skill, onChange, onRemove }: { skill: Skill; onChange: (s: Skill) => void; onRemove: () => void }) {
  const toast = useToast();
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  async function toggle() {
    const next = !skill.enabled;
    onChange({ ...skill, enabled: next });
    try {
      onChange(await api().setSkillEnabled(skill.skillId, next));
    } catch (e) {
      onChange(skill);
      toast.error(friendlyMessage(e));
    }
  }

  async function view() {
    if (open) return setOpen(false);
    setOpen(true);
    if (content !== null) return;
    try {
      setContent(await api().skillContent(skill.skillId));
    } catch (e) {
      setOpen(false);
      toast.error(friendlyMessage(e));
    }
  }


  return (
    <div className={`skill${skill.enabled ? "" : " is-off"}`}>
      <div className="skill__main">
        <span className="skill__icon" aria-hidden="true">
          <Icon name={skill.format === "zip" ? "layers" : "file"} />
        </span>
        <div className="skill__text">
          <h3 className="skill__name user-text" id={`${id}-n`}>
            {skill.name}
          </h3>
          <p className="skill__desc clamp-2 user-text">{skill.description}</p>
          <span className="skill__meta">
            {skill.builtin ? <Pill tone="sage">Built in</Pill> : null}
            <span>
              .{skill.format} · {bytes(skill.size)}
            </span>
          </span>
        </div>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={skill.enabled}
          aria-labelledby={`${id}-n`}
          title={skill.enabled ? "Turn off" : "Turn on"}
          onClick={toggle}
        >
          <span className="switch__thumb" />
        </button>
      </div>
      <div className="skill__actions">
        <Button size="sm" variant="ghost" icon="eye" aria-expanded={open} aria-controls={`${id}-c`} onClick={view}>
          {open ? "Hide" : "View"}
        </Button>
        {skill.builtin ? (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            disabled
            title="Built-in skills can be switched off, not deleted"
            onClickCapture={() => toast.info("Built-in skills cannot be deleted. Use the switch to turn it off.")}
          >
            Delete
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="trash" onClick={onRemove}>
            Delete
          </Button>
        )}
      </div>
      {open ? (
        <div className="skill__content" id={`${id}-c`}>
          {content === null ? <Skeleton className="line-skel" /> : <pre className="code" tabIndex={0}>{content}</pre>}
        </div>
      ) : null}
    </div>
  );
}
