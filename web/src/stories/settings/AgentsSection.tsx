// Lamo Stories › Settings › Agents (docs/CONTRACTS.md §45.26, §45.29 Agents): Lamo Stories' own five agents, never
// Clip Factory's. Pick one on the bar, then: switch it on or off (the quality agent's fact check still runs for every
// driving-safety video), its model and effort ("Workspace default" otherwise), its instructions (edit, Save, Reset to
// the original words) and its skills (add, take off, and the order it reads them in).
import { useEffect, useMemo, useState } from "react";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Agent, AgentId, Effort, ModelInfo, Skill } from "../api/types.ts";
import { EFFORT_LABEL } from "../api/types.ts";
import { modelOf, notOffered, offers, pairText } from "./AiSection.tsx";
import { Btn, cheer, Chip, Empty, Failed, Loading, Note, refusedLine, SavedMark, SetCard, SetPick, SetSelect, SetSwitch, SIcon, statusSuffix, useSaved } from "./bits.tsx";
import { useAi, type AiData } from "./data.ts";

/** What each agent is for, in plain words (the API's agents carry their task list; these are the page's own lines). */
export const AGENT_LINE: Record<AgentId, string> = {
  creative_director: "Chats with you and finds and shapes ideas.",
  video_analysis: "Watches the reference videos you upload and writes up what works.",
  storyboard: "Writes each video's scenes and its post captions.",
  character: "Suggests a character's looks, faces and moves.",
  quality_assurance: "Checks the facts and takes a last look at every video.",
};

export const DRIVING_RULE = "Driving-safety videos are always checked.";
const INSTRUCTIONS_MAX = 8000;

function SkillList({ agent, skills, onSave }: { agent: Agent; skills: Skill[]; onSave: (ids: string[]) => void }) {
  const [add, setAdd] = useState("");
  const mine = agent.skillIds.map((id) => skills.find((s) => s.skillId === id)).filter((s): s is Skill => !!s);
  const others = skills.filter((s) => !agent.skillIds.includes(s.skillId));
  const move = (i: number, by: number) => {
    const ids = [...agent.skillIds];
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    onSave(ids);
  };
  return (
    <div className="st-stg-skills">
      {mine.length ? (
        <ol className="st-stg-skilllist" aria-label={`${agent.name}'s skills, in the order it reads them`}>
          {mine.map((s, i) => (
            <li key={s.skillId} className="st-stg-skilllist__row">
              <span className="st-stg-skilllist__n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="st-stg-skilllist__text">
                <span className="st-stg-skilllist__title">{s.title}</span>
                <span className="st-stg-small">{s.enabled ? s.description : "Off in Skills, so this agent skips it for now."}</span>
              </span>
              {!s.enabled ? <Chip tone="sun">Off</Chip> : null}
              <span className="st-stg-skilllist__btns">
                <Btn quiet small label={`Move ${s.title} up`} off={i === 0 ? "It is first already" : undefined} onClick={() => move(i, -1)}>
                  <SIcon name="up" size={20} />
                </Btn>
                <Btn quiet small label={`Move ${s.title} down`} off={i === mine.length - 1 ? "It is last already" : undefined} onClick={() => move(i, 1)}>
                  <SIcon name="down" size={20} />
                </Btn>
                <Btn quiet small label={`Take ${s.title} off ${agent.name}`} onClick={() => onSave(agent.skillIds.filter((id) => id !== s.skillId))}>
                  <SIcon name="close" size={20} />
                </Btn>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="No skills yet" mood="sleepy">
          Add one below, or write one in Skills.
        </Empty>
      )}
      {others.length ? (
        <div className="st-stg-addskill">
          <SetSelect
            label="Add a skill"
            value={add}
            onChange={setAdd}
            options={[{ value: "", label: "Pick a skill" }, ...others.map((s) => ({ value: s.skillId, label: `${s.title}${s.enabled ? "" : " (off)"}` }))]}
          />
          <Btn
            main
            off={add ? undefined : "Pick a skill first"}
            onClick={(e) => {
              onSave([...agent.skillIds, add]);
              setAdd("");
              cheer(e.currentTarget);
            }}
          >
            <SIcon name="plus" size={20} />
            Add it
          </Btn>
        </div>
      ) : null}
      <p className="st-stg-small">The agent reads its skills in this order, before your memory and the task.</p>
    </div>
  );
}

function Instructions({ agent, onSave, onReset }: { agent: Agent; onSave: (text: string, el: HTMLElement) => void; onReset: () => void }) {
  const [text, setText] = useState(agent.instructions);
  const [asking, setAsking] = useState(false);
  // A save or a reset from the server shows its words.
  useEffect(() => setText(agent.instructions), [agent.instructions, agent.agentId]);
  const changed = text.trim() !== agent.instructions.trim();
  const custom = agent.instructions.trim() !== agent.defaultInstructions.trim();
  const id = `instr-${agent.agentId}`;
  return (
    <div className="st-stg-instr">
      <div className="st-stg-instr__head">
        <label className="st-stg-label" htmlFor={id}>
          What {agent.name} should do
        </label>
        {custom ? <Chip tone="sky">Your words</Chip> : <Chip tone="mint">The original</Chip>}
      </div>
      <textarea id={id} className="st-stg-textarea" rows={9} maxLength={INSTRUCTIONS_MAX} value={text} onChange={(e) => setText(e.target.value)} />
      <p className="st-stg-small">
        {text.length.toLocaleString("en-GB")} of {INSTRUCTIONS_MAX.toLocaleString("en-GB")} letters
      </p>
      {asking ? (
        <div className="st-stg-confirm" role="group" aria-label="Are you sure?">
          <p>Put back the original words? Your own words are lost.</p>
          <div className="st-stg-actions">
            <Btn
              main
              onClick={() => {
                setAsking(false);
                onReset();
              }}
            >
              Yes, reset
            </Btn>
            <Btn quiet onClick={() => setAsking(false)}>
              No, keep mine
            </Btn>
          </div>
        </div>
      ) : (
        <div className="st-stg-actions">
          <Btn main off={!changed ? "Nothing changed yet" : !text.trim() ? "Type what it should do first" : undefined} onClick={(e) => onSave(text, e.currentTarget)}>
            Save the words
          </Btn>
          {changed ? (
            <Btn quiet onClick={() => setText(agent.instructions)}>
              Undo my typing
            </Btn>
          ) : null}
          <Btn quiet off={!custom ? "These are the original words" : undefined} onClick={() => setAsking(true)}>
            <SIcon name="retry" size={20} />
            Reset
          </Btn>
        </div>
      )}
    </div>
  );
}

function ModelAndEffort({ agent, data, onSave }: { agent: Agent; data: AiData; onSave: (patch: { model?: string | null; effort?: Effort | null }) => void }) {
  const { models, ai } = data;
  const [draft, setDraft] = useState<{ raw: string | null; model: string } | null>(null);
  useEffect(() => setDraft(null), [agent.agentId]);
  const def = modelOf(models, ai.defaultModel);
  const usesKey = draft?.model ?? agent.model ?? ai.defaultModel;
  const uses = modelOf(models, usesKey);
  const usesEffort = uses && !uses.efforts.length ? null : (agent.effort ?? ai.defaultEffort);
  const refused = refusedLine(uses);
  return (
    <div className="st-stg-me">
      <div className="st-stg-me__pickers">
        <SetSelect
          label="Model"
          value={draft ? (draft.raw ?? "") : (agent.model ?? "")}
          options={[{ value: "", label: `Workspace default (${def?.label ?? ai.defaultModel})` }, ...models.map((m: ModelInfo) => ({ value: m.key, label: `${m.label}${statusSuffix(m)}` }))]}
          onChange={(v) => {
            const raw = v || null;
            const next = modelOf(models, raw ?? ai.defaultModel);
            if (agent.effort && next && !offers(next, agent.effort)) return setDraft({ raw, model: raw ?? ai.defaultModel });
            setDraft(null);
            onSave({ model: raw });
          }}
        />
        {uses && !uses.efforts.length ? (
          <p className="st-stg-assign__none">This model has no effort setting; it runs at its own level.</p>
        ) : (
          <SetSelect
            label="Effort"
            value={draft ? "pick" : (agent.effort ?? "")}
            invalid={!!draft}
            options={[
              ...(draft ? [{ value: "pick", label: "Pick a level" }] : [{ value: "", label: `Workspace default (${EFFORT_LABEL[ai.defaultEffort]})` }]),
              ...(uses?.efforts ?? []).map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
            ]}
            onChange={(v) => {
              if (v === "pick") return;
              const effort = (v || null) as Effort | null;
              if (draft) {
                const raw = draft.raw;
                setDraft(null);
                return onSave({ model: raw, effort });
              }
              onSave({ effort });
            }}
          />
        )}
      </div>
      {draft && uses && agent.effort ? (
        <Note tone="sun" role="alert">
          {notOffered(uses, agent.effort)}
        </Note>
      ) : null}
      <p className="st-stg-active">
        <span className="st-stg-active__word">Uses now</span>
        <strong>{pairText(models, usesKey, usesEffort)}</strong>
      </p>
      {refused ? <Note tone="coral">{refused}</Note> : null}
    </div>
  );
}

export function AgentsSection({ ws }: { ws: string }) {
  const ai = useAi(ws);
  const skills = useLoad(() => storiesApi().listSkills(ws), ws, "st-settings-skills");
  const { saved, flash } = useSaved();
  const [picked, setPicked] = useState<AgentId | null>(null);
  const agents = useMemo(() => ai.data?.agents ?? [], [ai.data]);
  const agent = agents.find((a) => a.agentId === picked) ?? agents[0];

  if (!ai.data) return ai.error ? <Failed message={ai.error} onRetry={() => void ai.reload()} /> : <Loading label="Opening the agents…" />;
  if (!agent) return <Empty title="No agents yet">They are made the first time Clip Stories opens. Reload the page.</Empty>;
  const data = ai.data;
  const save = async (patch: Parameters<typeof ai.saveAgent>[1], el?: HTMLElement | null) => {
    const out = await ai.saveAgent(agent.agentId, patch);
    if (out) {
      flash();
      if (el) cheer(el);
    }
    return out;
  };
  const taskLabel = (kind: string) => data.tasks.find((t) => t.kind === kind)?.label ?? kind;
  const quality = agent.agentId === "quality_assurance";

  return (
    <div className="st-stg-cards">
      <div className="st-stg-bar">
        <p className="st-stg-small">Clip Stories' own agents. Clip Factory's agent is separate and stays as it is.</p>
        <SavedMark saved={saved} busy={ai.busy} />
      </div>
      <SetPick
        label="Pick an agent"
        className="st-stg-agentpick"
        value={agent.agentId}
        onChange={(v) => setPicked(v)}
        options={agents.map((a) => ({
          value: a.agentId,
          label: a.name,
          chip: <Chip tone={a.active ? "mint" : "sun"}>{a.active ? "On" : "Off"}</Chip>,
          line: pairText(data.models, a.model ?? data.ai.defaultModel, modelOf(data.models, a.model ?? data.ai.defaultModel)?.efforts.length ? (a.effort ?? data.ai.defaultEffort) : null),
        }))}
      />
      <SetCard title={agent.name} icon="people" lede={AGENT_LINE[agent.agentId]} actions={null}>
        <p className="st-stg-small">Does: {agent.tasks.map(taskLabel).join(", ")}.</p>
        <SetSwitch
          label={agent.active ? `${agent.name} is on` : `${agent.name} is off`}
          checked={agent.active}
          description={
            quality
              ? `${DRIVING_RULE} With this off, other videos skip its checks and say "Quality check is off".`
              : agent.active
                ? "Switch it off and its work stops with a note saying it is off."
                : `Its work stops with "${agent.name} is switched off." until you switch it on.`
          }
          onChange={(v) => void save({ active: v })}
        />
        {quality && !agent.active ? (
          <Note tone="sun" role="status">
            Quality check is off. {DRIVING_RULE} Other videos go to review without its checks.
          </Note>
        ) : null}
      </SetCard>
      <SetCard title="Model and effort" icon="chip" lede="Leave it on Workspace default, or give this agent its own. A task can still have its own (Settings › AI).">
        <ModelAndEffort agent={agent} data={data} onSave={(patch) => void save(patch)} />
      </SetCard>
      <SetCard title="Instructions" icon="pencil" lede="The words this agent reads first, every time. Reset puts back the original.">
        <Instructions agent={agent} onSave={(text, el) => void save({ instructions: text.trim() }, el)} onReset={() => void save({ reset: true })} />
      </SetCard>
      <SetCard title="Skills" icon="book" lede="Know-how this agent reads. Only Clip Stories skills, never Clip Factory's.">
        {skills.data ? (
          <SkillList agent={agent} skills={skills.data} onSave={(ids) => void save({ skillIds: ids })} />
        ) : skills.error ? (
          <Failed message={skills.error} onRetry={() => void skills.reload()} />
        ) : (
          <Loading label="Getting the skills…" />
        )}
      </SetCard>
    </div>
  );
}
