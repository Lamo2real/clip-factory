// Two lanes in one helper (§47.10, D1). The clips lane is Clip Factory's, exactly as in 1.1.0: its profile chrome/,
// port 9339, its Keychain login, and the top-level ledger, pacing, trial and backfill in state.json. A ws lane is one
// Clips Funded workspace's (@clips.funded): its own profile chrome-ws-{id}/, its own port (9340–9349), its own
// ledger, pacing and account in state.ws[id], and no Keychain login at all. The lanes share only the Clip Factory
// sign-in, the device id, settings.paused and run.lock.
import path from "node:path";

import { CLIPS_KEYCHAIN } from "./login.js";
import { event } from "./notify.js";
import { CDP_PORT, PROFILE, WS_PORT_BASE, WS_PORT_COUNT, wsProfile } from "./paths.js";
import { remember, saveState } from "./store.js";
import { REASONS, WS_REASONS, laneWords } from "./tiktok.js";
import { at, bare } from "./whoami.js";

/** A Clips Funded workspace id the helper accepts (its profile folder and state key are made from it). */
export const WS_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const iso = () => new Date().toISOString();

/** Every helper port in use: Clip Factory's and every ws lane's (the one-Chrome-at-a-time rule closes the others). */
export function helperPorts(root) {
  const ports = [CDP_PORT];
  for (const store of Object.values(root.ws || {})) if (Number.isInteger(store?.port)) ports.push(store.port);
  return [...new Set(ports)];
}

/** The lowest port of 9340–9349 no other ws lane has (and never Clip Factory's). null when all ten are taken. */
export function freePort(root, base = WS_PORT_BASE) {
  const taken = new Set(helperPorts(root));
  for (let p = base; p < base + WS_PORT_COUNT; p++) if (!taken.has(p)) return p;
  return null;
}

/** Clip Factory's lane. ``state`` is state.json itself, so every 1.1.0 key stays where it is. */
export function clipsLane(state, api) {
  return {
    id: "clips",
    kind: "clips",
    app: "Clip Factory",
    profile: PROFILE,
    port: CDP_PORT,
    keychain: CLIPS_KEYCHAIN,
    state,
    root: state,
    api,
    reasons: REASONS,
    otherPorts: () => helperPorts(state).filter((p) => p !== CDP_PORT),
    remember: (id, fields) => remember(state, id, fields),
    save: () => saveState(state),
    event: (kind, fields = {}) => event(kind, { account: "clips", ...fields }),
    /** D3: the handle of GET /v1/accounts' TikTok, cached in state.clipsAccount. */
    target: () => at(state.clipsAccount?.handle),
    pinnedUid: () => state.clipsAccount?.uid || null,
    /** What a post's handle check records: the uid of the first check that matched. */
    onWho: (res) => {
      if (res.verdict === "same" && state.clipsAccount && res.uid && !state.clipsAccount.uid) {
        state.clipsAccount = { ...state.clipsAccount, uid: res.uid, checkedAt: iso() };
        saveState(state);
      }
    },
  };
}

/** The ws lane's store in state.ws[id], made on first sight with the lowest free port (null: no port left). */
export function wsStore(root, workspaceId) {
  if (!WS_ID.test(String(workspaceId || ""))) throw new Error("That workspace id can't be a lane.");
  root.ws = root.ws && typeof root.ws === "object" ? root.ws : {};
  let store = root.ws[workspaceId];
  if (!store || !Number.isInteger(store.port)) {
    const port = freePort(root);
    if (port === null) throw new Error("No helper port is left for another workspace.");
    store = { ledger: {}, posted: [], lastPressedAt: null, account: null, ...(store || {}), port };
    root.ws[workspaceId] = store;
    saveState(root);
  }
  store.ledger = store.ledger && typeof store.ledger === "object" ? store.ledger : {};
  store.posted = Array.isArray(store.posted) ? store.posted : [];
  return store;
}

/**
 * The view of a ws lane that plan.js, beats.js and the post code read as "state": the device (shared), and this
 * lane's own ledger, posts and last press. Writes go to state.ws[id] only.
 */
export function wsView(root, store) {
  return {
    get device() {
      return root.device;
    },
    get ledger() {
      return store.ledger;
    },
    get posted() {
      return store.posted;
    },
    get lastPressedAt() {
      return store.lastPressedAt ?? null;
    },
    set lastPressedAt(value) {
      store.lastPressedAt = value;
    },
    lastBacklogAt: null,
  };
}

/** One Clips Funded workspace's lane. */
export function wsLane(root, workspaceId, api) {
  const store = wsStore(root, workspaceId);
  const id = `ws:${workspaceId}`;
  const state = wsView(root, store);
  return {
    id,
    kind: "ws",
    app: "Clips Funded",
    workspaceId,
    profile: wsProfile(workspaceId),
    port: store.port,
    keychain: null, // 1.2.0: no TikTok password at all
    state,
    store,
    root,
    api,
    reasons: WS_REASONS,
    otherPorts: () => helperPorts(root).filter((p) => p !== store.port),
    remember: (jobId, fields) => {
      store.ledger[jobId] = { ...(store.ledger[jobId] || {}), ...fields, at: iso() };
      saveState(root);
      return store.ledger[jobId];
    },
    save: () => saveState(root),
    event: (kind, fields = {}) => event(kind, { account: id, ...fields }),
    /** A job's only account: the one the server recorded on it. */
    target: (job) => at(job?.account?.handle),
    pinnedUid: (job) => {
      const pinned = store.account;
      return pinned?.uid && bare(pinned.handle) === bare(job?.account?.handle) ? pinned.uid : null;
    },
    /** What a handle check read: the account is set up while it reads the target, and not once it reads another. */
    onWho: (res, target) => {
      const want = at(target);
      if (res.verdict === "same" && want) {
        const was = store.account && bare(store.account.handle) === bare(want) ? store.account : {};
        store.account = { ...was, handle: want, ...(res.uid ? { uid: res.uid } : {}), setUpAt: was.setUpAt || iso(), checkedAt: iso() };
        saveState(root);
      } else if (res.verdict === "wrong") {
        const seen = at(res.seen);
        store.account = { ...(seen ? { handle: seen } : {}), checkedAt: iso() };
        saveState(root);
      }
    },
    /** The lane's Chrome profile is logged out of TikTok: not set up until the owner logs in again. */
    loggedOut: () => {
      if (store.account?.setUpAt) {
        const { setUpAt: _gone, ...rest } = store.account;
        store.account = { ...rest, checkedAt: iso() };
        saveState(root);
      }
    },
    pin: (account) => {
      store.account = { ...account, handle: at(account.handle), setUpAt: iso(), checkedAt: iso() };
      saveState(root);
    },
  };
}

/** Is this ws lane's profile logged in as the workspace's TikTok (``target``, the status's account handle)? */
export function setUpFor(store, target) {
  return Boolean(store?.account?.setUpAt && at(target) && bare(store.account.handle) === bare(target));
}

/**
 * A WsMacJob as the shared code reads it: its id in ``clipId`` (only ever sent back through wsClient), and the
 * fixed public defaults whatever the job says (D7): Everyone, Comments, Duet and Stitch on, the AI label on.
 */
export function normalizeWsJob(job) {
  return {
    ...job,
    clipId: String(job.publishingJobId),
    privacy: "PUBLIC_TO_EVERYONE",
    comment: true,
    duet: true,
    stitch: true,
    aiLabel: true,
    source: "upload",
  };
}

/** The lane's words for a stop reason (Clip Factory's texts that name the app or its login become Clips Funded's). */
export function reasonFor(lane, reason) {
  return laneWords(lane.kind, reason);
}

/** A Clips Funded video's file name in Downloads: "clips-funded-….mp4", whatever came. */
export function wsFileName(name) {
  const base = path.basename(String(name || ""));
  return /^clips-funded-[^/\\:\0]*\.mp4$/i.test(base) ? base : "clips-funded-story.mp4";
}

/** The ids an event or log line names for a lane's job. */
export function jobIds(lane, job) {
  return lane.kind === "ws" ? { publishingJobId: job.clipId, storyId: job.storyId } : { clipId: job.clipId };
}
