// Lamo Stories › Settings: loading and saving (docs/CONTRACTS.md §45.5, §45.25, §45.26, §45.29). Every change saves
// by itself, on top of the version it was given, one save at a time (changes made meanwhile go in the next save), so
// a change made elsewhere is never overwritten: a stale version answers 409, the page says so and loads again. The
// effective model and effort of each task come back from the API (the web only shows them, §45.25).
import { useCallback, useMemo, useRef, useState } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad, type Loaded } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Agent, AgentId, AiPicked, Effort, ModelInfo, StoriesAiConfig, StoriesConfig, TaskInfo, Workspace } from "../api/types.ts";
import workspaceDefaults from "../../../../stories/config/workspace-defaults.json";

export type AiData = { ai: StoriesAiConfig; models: ModelInfo[]; agents: Agent[]; tasks: TaskInfo[] };

export type AgentPatch = { instructions?: string; active?: boolean; model?: string | null; effort?: Effort | null; skillIds?: string[] };

const { $comment: _comment, ...DEFAULT_CONFIG } = workspaceDefaults as typeof workspaceDefaults & { $comment: string };
/** Lamo Stories' workspace defaults, from the one file the API's guard reads (stories/config/workspace-defaults.json). */
export const DEFAULTS: StoriesConfig = DEFAULT_CONFIG as unknown as StoriesConfig;

/** The stored settings with anything missing filled from the defaults (nested parts too). */
export function configOf(w: Workspace | null): StoriesConfig {
  const c = (w?.configuration ?? {}) as Partial<StoriesConfig>;
  return {
    ...DEFAULTS,
    ...c,
    providers: { ...DEFAULTS.providers, ...(c.providers ?? {}) },
    video: { ...DEFAULTS.video, ...(c.video ?? {}) },
    production: { ...DEFAULTS.production, ...(c.production ?? {}) },
  };
}

/**
 * The body of PUT …/ai: exactly the configuration's own keys (anything else the API sends back, now or later, is
 * never echoed into a save, where it would be refused as unknown), with `picked` only when the owner picked
 * something on purpose (§45.34: setup steps 1 to 3).
 */
export function aiBody(ai: Omit<StoriesAiConfig, "version">, version: number, picked: readonly AiPicked[] = []): StoriesAiConfig & { picked?: AiPicked[] } {
  return {
    defaultModel: ai.defaultModel,
    defaultEffort: ai.defaultEffort,
    tasks: ai.tasks,
    prices: ai.prices,
    version,
    ...(picked.length ? { picked: [...new Set(picked)] } : {}),
  };
}

/** What the owner changed that the API has not confirmed yet, shown over what the API last said. */
interface AiOver {
  ai: Omit<StoriesAiConfig, "version"> | null;
  agents: Partial<Record<AgentId, AgentPatch>>;
}

/** The API's answer with the owner's unconfirmed changes on top (so a quick second change starts from the first). */
export function withOver(d: AiData | null, over: AiOver): AiData | null {
  if (!d || (!over.ai && !Object.keys(over.agents).length)) return d;
  return {
    ...d,
    ai: over.ai ? { ...over.ai, version: d.ai.version } : d.ai,
    agents: d.agents.map((a) => (over.agents[a.agentId] ? { ...a, ...over.agents[a.agentId] } : a)),
  };
}

/** The AI settings: the configuration, the models with their last result, the agents and the tasks table. */
export function useAi(ws: string): Loaded<AiData> & {
  /** `picked`: what this change picks on purpose (the default model or effort), sent with it (§45.34) */
  saveAi: (next: Omit<StoriesAiConfig, "version">, picked?: AiPicked[]) => Promise<boolean>;
  saveAgent: (agentId: AgentId, patch: AgentPatch | { reset: true }) => Promise<Agent | null>;
  busy: boolean;
} {
  const loaded = useLoad(() => storiesApi().getAi(ws), ws, "st-settings-ai");
  const toast = useToast();
  const { setData, reload: loadAgain } = loaded;
  const aiVersion = useRef<number | null>(null);
  if (loaded.data && (aiVersion.current === null || loaded.data.ai.version > aiVersion.current)) aiVersion.current = loaded.data.ai.version;
  const agentVersions = useRef(new Map<AgentId, number>());
  for (const a of loaded.data?.agents ?? []) if ((agentVersions.current.get(a.agentId) ?? -1) < a.version) agentVersions.current.set(a.agentId, a.version);
  const wanted = useRef<Omit<StoriesAiConfig, "version"> | null>(null);
  // Picks waiting with the wanted change: a change that replaces another before it is sent keeps the other's picks.
  const wantedPicked = useRef<AiPicked[]>([]);
  const running = useRef<Promise<boolean> | null>(null);
  const [over, setOver] = useState<AiOver>({ ai: null, agents: {} });
  const [runs, setRuns] = useState(0);
  const work = useCallback((by: number) => setRuns((n) => n + by), []);

  // Asks the API again and shows its answer; an answer older than a newer ask is dropped.
  const asked = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++asked.current;
    let fresh: AiData;
    try {
      fresh = await storiesApi().getAi(ws);
    } catch {
      if (mine === asked.current) await loadAgain(); // shows the sentence the usual way
      return;
    }
    if (mine !== asked.current) return;
    if (aiVersion.current === null || fresh.ai.version > aiVersion.current) aiVersion.current = fresh.ai.version;
    for (const a of fresh.agents) if ((agentVersions.current.get(a.agentId) ?? -1) < a.version) agentVersions.current.set(a.agentId, a.version);
    setData(() => fresh);
  }, [ws, setData, loadAgain]);

  const failed = useCallback(
    async (e: unknown) => {
      toast.error(friendlyMessage(e));
      // Whatever was shown before the refusal goes back to what is stored.
      aiVersion.current = null;
      await refresh();
    },
    [toast, refresh],
  );

  const saveAi = useCallback(
    (next: Omit<StoriesAiConfig, "version">, picked: AiPicked[] = []): Promise<boolean> => {
      wanted.current = next;
      wantedPicked.current = [...new Set([...wantedPicked.current, ...picked])];
      // Shown at once; the save follows.
      setOver((o) => ({ ...o, ai: next }));
      if (running.current) return running.current;
      const run = (async () => {
        work(1);
        let ok = true;
        try {
          for (;;) {
            while (wanted.current && aiVersion.current !== null) {
              const body = wanted.current;
              const picks = wantedPicked.current;
              wanted.current = null;
              wantedPicked.current = [];
              try {
                const saved = await storiesApi().putAi(ws, aiBody(body, aiVersion.current, picks));
                aiVersion.current = saved.version;
              } catch (e) {
                ok = false;
                if (wanted.current === null) setOver((o) => ({ ...o, ai: null }));
                await failed(e);
              }
            }
            // The effective model and effort of every task come from the API.
            await refresh();
            // A change made while that answer was on its way is newer than it: send it too.
            if (wanted.current && aiVersion.current !== null) continue;
            wanted.current = null;
            setOver((o) => ({ ...o, ai: null }));
            return ok;
          }
        } finally {
          running.current = null;
          work(-1);
        }
      })();
      running.current = run;
      return run;
    },
    [ws, refresh, failed, work],
  );

  // Each agent saves one change at a time, on top of the version its last save returned; until the last one is
  // answered, every change waiting is shown over the answers.
  const agentRuns = useRef(new Map<AgentId, Promise<unknown>>());
  const agentWaiting = useRef(new Map<AgentId, number>());
  const saveAgent = useCallback(
    (agentId: AgentId, patch: AgentPatch | { reset: true }): Promise<Agent | null> => {
      const before = agentRuns.current.get(agentId) ?? Promise.resolve();
      agentWaiting.current.set(agentId, (agentWaiting.current.get(agentId) ?? 0) + 1);
      setOver((o) => {
        const mine = { ...(o.agents[agentId] ?? {}) };
        if ("reset" in patch) delete mine.instructions;
        else Object.assign(mine, patch);
        return { ...o, agents: { ...o.agents, [agentId]: mine } };
      });
      const run = before.then(async () => {
        work(1);
        let refreshed = false;
        try {
          const saved = await storiesApi().patchAgent(ws, agentId, "reset" in patch ? patch : { ...patch, version: agentVersions.current.get(agentId) ?? 0 });
          agentVersions.current.set(agentId, saved.version);
          setData((d) => (d ? { ...d, agents: d.agents.map((a) => (a.agentId === agentId ? saved : a)) } : d));
          return saved;
        } catch (e) {
          toast.error(friendlyMessage(e));
          // What was shown goes back to what is stored; a change still waiting goes on top of the stored version.
          agentVersions.current.delete(agentId);
          setOver((o) => {
            const { [agentId]: _gone, ...rest } = o.agents;
            return { ...o, agents: rest };
          });
          await refresh();
          refreshed = true;
          return null;
        } finally {
          const left = (agentWaiting.current.get(agentId) ?? 1) - 1;
          agentWaiting.current.set(agentId, left);
          if (!left) {
            // The tasks table follows the agent's model and effort (the API works them out).
            if (!refreshed) await refresh();
            if (!agentWaiting.current.get(agentId))
              setOver((o) => {
                const { [agentId]: _done, ...rest } = o.agents;
                return { ...o, agents: rest };
              });
          }
          work(-1);
        }
      });
      agentRuns.current.set(
        agentId,
        run.catch(() => undefined),
      );
      return run;
    },
    [ws, setData, refresh, toast, work],
  );

  const data = useMemo(() => withOver(loaded.data, over), [loaded.data, over]);
  return { ...loaded, data, reload: refresh, saveAi, saveAgent, busy: runs > 0 };
}

/** The workspace's own settings (StoriesConfig), saved a change at a time with its version. */
export function useWorkspaceConfig(ws: string): {
  workspace: Loaded<Workspace>;
  config: StoriesConfig;
  save: (patch: Partial<StoriesConfig>) => void;
  saved: number;
  busy: boolean;
} {
  const workspace = useLoad(() => storiesApi().getWorkspace(ws), ws, "st-settings-ws");
  const toast = useToast();
  const { setData, reload } = workspace;
  const version = useRef<number | null>(null);
  if (workspace.data && (version.current === null || workspace.data.version > version.current)) version.current = workspace.data.version;
  const pending = useRef<Partial<StoriesConfig> | null>(null);
  const running = useRef(false);
  const [saved, setSaved] = useState(0);
  const [busy, setBusy] = useState(false);

  const latest = useRef(workspace.data);
  latest.current = workspace.data;
  // An answer is shown with the changes still waiting on top, so the next tap starts from what is on screen.
  const show = useCallback(
    (w: Workspace) => {
      const shown: Workspace = pending.current ? { ...w, configuration: { ...configOf(w), ...pending.current } } : w;
      latest.current = shown;
      setData(() => shown);
    },
    [setData],
  );

  const flush = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      while (pending.current && version.current !== null) {
        const patch = pending.current;
        pending.current = null;
        try {
          const next = await storiesApi().patchWorkspace(ws, { configuration: patch, version: version.current });
          version.current = next.version;
          show(next);
          setSaved((n) => n + 1);
        } catch (e) {
          // The refused change and the ones made on top of it go; the page shows what is stored. A change made
          // while that loads is sent next, on the stored version.
          pending.current = null;
          toast.error(friendlyMessage(e));
          if (e instanceof ApiError && e.code === "conflict") version.current = null;
          try {
            const fresh = await storiesApi().getWorkspace(ws);
            version.current = fresh.version;
            show(fresh);
          } catch {
            await reload();
          }
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [ws, show, reload, toast]);

  const save = useCallback(
    (patch: Partial<StoriesConfig>) => {
      const w = latest.current;
      if (!w) return;
      // Nested parts are sent whole (StoriesConfig's video, production and providers are replaced, not merged).
      const c = configOf(w);
      const full: Partial<StoriesConfig> = { ...patch };
      if (patch.providers) full.providers = { ...c.providers, ...patch.providers };
      if (patch.video) full.video = { ...c.video, ...patch.video };
      if (patch.production) full.production = { ...c.production, ...patch.production };
      pending.current = { ...(pending.current ?? {}), ...full };
      const next: Workspace = { ...w, configuration: { ...c, ...full } };
      latest.current = next;
      setData(() => next);
      void flush();
    },
    [setData, flush],
  );

  return { workspace, config: configOf(workspace.data), save, saved, busy };
}
