// Lamo Stories › Settings: loading and saving (docs/CONTRACTS.md §45.5, §45.25, §45.26, §45.29). Every change saves
// by itself, on top of the version it was given, one save at a time (changes made meanwhile go in the next save), so
// a change made elsewhere is never overwritten: a stale version answers 409, the page says so and loads again. The
// effective model and effort of each task come back from the API (the web only shows them, §45.25).
import { useCallback, useRef, useState } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad, type Loaded } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Agent, AgentId, Effort, ModelInfo, StoriesAiConfig, StoriesConfig, TaskInfo, Workspace } from "../api/types.ts";
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

/** The AI settings: the configuration, the models with their last result, the agents and the tasks table. */
export function useAi(ws: string): Loaded<AiData> & {
  saveAi: (next: Omit<StoriesAiConfig, "version">) => Promise<boolean>;
  saveAgent: (agentId: AgentId, patch: AgentPatch | { reset: true }) => Promise<Agent | null>;
  busy: boolean;
} {
  const loaded = useLoad(() => storiesApi().getAi(ws), ws, "st-settings-ai");
  const toast = useToast();
  const { setData, reload } = loaded;
  const aiVersion = useRef<number | null>(null);
  if (loaded.data && (aiVersion.current === null || loaded.data.ai.version > aiVersion.current)) aiVersion.current = loaded.data.ai.version;
  const wanted = useRef<Omit<StoriesAiConfig, "version"> | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const [busy, setBusy] = useState(false);

  const failed = useCallback(
    async (e: unknown) => {
      toast.error(friendlyMessage(e));
      // Whatever was shown before the refusal goes back to what is stored.
      aiVersion.current = null;
      await reload();
    },
    [toast, reload],
  );

  const saveAi = useCallback(
    (next: Omit<StoriesAiConfig, "version">): Promise<boolean> => {
      wanted.current = next;
      // Shown at once; the save follows.
      setData((d) => (d ? { ...d, ai: { ...next, version: d.ai.version } } : d));
      if (running.current) return running.current;
      const run = (async () => {
        setBusy(true);
        let ok = true;
        try {
          while (wanted.current && aiVersion.current !== null) {
            const body = wanted.current;
            wanted.current = null;
            try {
              const saved = await storiesApi().putAi(ws, { ...body, version: aiVersion.current });
              aiVersion.current = saved.version;
            } catch (e) {
              wanted.current = null;
              ok = false;
              await failed(e);
              return false;
            }
          }
          // The effective model and effort of every task come from the API.
          await reload();
          return ok;
        } finally {
          running.current = null;
          setBusy(false);
        }
      })();
      running.current = run;
      return run;
    },
    [ws, setData, reload, failed],
  );

  // Each agent saves one change at a time, on top of the version its last save returned.
  const agentRuns = useRef(new Map<AgentId, Promise<unknown>>());
  const agentVersions = useRef(new Map<AgentId, number>());
  for (const a of loaded.data?.agents ?? []) if ((agentVersions.current.get(a.agentId) ?? -1) < a.version) agentVersions.current.set(a.agentId, a.version);
  const saveAgent = useCallback(
    (agentId: AgentId, patch: AgentPatch | { reset: true }): Promise<Agent | null> => {
      const before = agentRuns.current.get(agentId) ?? Promise.resolve();
      if (!("reset" in patch)) setData((d) => (d ? { ...d, agents: d.agents.map((a) => (a.agentId === agentId ? { ...a, ...patch } : a)) } : d));
      const run = before.then(async () => {
        setBusy(true);
        try {
          const saved = await storiesApi().patchAgent(ws, agentId, "reset" in patch ? patch : { ...patch, version: agentVersions.current.get(agentId) ?? 0 });
          agentVersions.current.set(agentId, saved.version);
          setData((d) => (d ? { ...d, agents: d.agents.map((a) => (a.agentId === agentId ? saved : a)) } : d));
          await reload();
          return saved;
        } catch (e) {
          agentVersions.current.delete(agentId);
          await failed(e);
          return null;
        } finally {
          setBusy(false);
        }
      });
      agentRuns.current.set(agentId, run.catch(() => undefined));
      return run;
    },
    [ws, setData, reload, failed],
  );

  return { ...loaded, saveAi, saveAgent, busy };
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
          setData(() => next);
          setSaved((n) => n + 1);
        } catch (e) {
          pending.current = null;
          toast.error(friendlyMessage(e));
          if (e instanceof ApiError && e.code === "conflict") version.current = null;
          await reload();
          break;
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [ws, setData, reload, toast]);

  const latest = useRef(workspace.data);
  latest.current = workspace.data;
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
