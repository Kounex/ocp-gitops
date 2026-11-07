import { createPoller } from "./polling.ts";
import type { Bootstrap, QuestSync, Viewer } from "./types.ts";

export function viewerIdentity(viewer: Viewer) {
  return JSON.stringify([
    viewer.authenticated,
    viewer.id,
    viewer.role,
    viewer.team_id,
    viewer.can_manage_rooms,
    viewer.can_manage_users,
  ]);
}

function contentIdentity(data: QuestSync) {
  return JSON.stringify([
    viewerIdentity(data.viewer),
    data.revisions.content,
    data.revisions.roster,
    data.revisions.progress,
  ]);
}

export interface QuestSessionState {
  data: Bootstrap | null;
  live: QuestSync | null;
  loading: boolean;
  error: string;
  syncError: string;
}

type SessionOptions = {
  loadBootstrap: (signal: AbortSignal) => Promise<Bootstrap>;
  loadSync: (signal: AbortSignal) => Promise<QuestSync>;
  publish: (state: QuestSessionState) => void;
  active: () => boolean;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/** One heartbeat owns identity/nonce/attendance; full content is revision-driven. */
export function createQuestSession(options: SessionOptions) {
  const now = options.now ?? (() => performance.now());
  let stopped = false;
  let live: QuestSync | null = null;
  let cached: Bootstrap | null = null;
  let candidate: Bootstrap | null = null;
  let identityGeneration = 0;
  let initialized = false;
  let loading = true;
  let syncError = "";
  let contentError = "";
  let contentFailures = 0;
  let contentVersion = 0;
  let retryAt = 0;
  let requestedKey: string | null = null;
  let fullTask: Promise<void> | null = null;
  let confirmationTask: Promise<void> | null = null;

  function publish() {
    if (stopped) return;
    options.publish({
      // Full reads never replace the accepted live viewer/nonce pair.
      data: live && cached ? { ...cached, ...live, rooms: cached.rooms } : null,
      live,
      loading,
      error: syncError || contentError,
      syncError,
    });
  }
  function installCandidate() {
    if (
      candidate &&
      live &&
      contentIdentity(candidate) === contentIdentity(live)
    ) {
      cached = candidate;
      candidate = null;
      ++contentVersion;
      contentError = "";
      contentFailures = 0;
      retryAt = 0;
    }
  }
  function confirmIdentity() {
    if (confirmationTask || stopped) return;
    const task = heartbeat.refresh();
    confirmationTask = task;
    void task.then(() => {
      if (confirmationTask === task) confirmationTask = null;
    });
  }
  function ensureContent(force = false, allowHidden = force) {
    if (stopped) return;
    if (!allowHidden && !options.active()) return;
    const key = live ? contentIdentity(live) : null;
    if (!force && cached && key === contentIdentity(cached)) return;
    const requestKey = JSON.stringify([identityGeneration, key]);
    if (fullTask && requestedKey === requestKey) return;
    if (!force && now() < retryAt) return;
    requestedKey = requestKey;
    const task = full.refresh();
    fullTask = task;
    void task.then(() => {
      if (fullTask === task) fullTask = null;
    });
  }
  function authFailure(error: unknown) {
    const status = (error as { status?: number })?.status;
    if (status !== 401 && status !== 403 && status !== 404) return false;
    ++identityGeneration;
    cached = candidate = null;
    live = null;
    initialized = true;
    return true;
  }

  const heartbeat = createPoller<QuestSync>({
    ...options,
    interval: 5000,
    load: options.loadSync,
    accept(value) {
      if (
        !live ||
        viewerIdentity(value.viewer) !== viewerIdentity(live.viewer)
      ) {
        ++identityGeneration;
        cached = null;
        contentError = "";
        contentFailures = 0;
        retryAt = 0;
      }
      live = value;
      initialized = true;
      syncError = "";
      installCandidate();
      publish();
      ensureContent();
    },
    reject(error) {
      authFailure(error);
      syncError =
        error instanceof Error
          ? error.message
          : "Unable to refresh event information.";
      loading = false;
      publish();
    },
  });
  const full = createPoller<{ value: Bootstrap; generation: number }>({
    ...options,
    interval: 10000,
    // Full content has no periodic/focus/offline stream of its own.
    active: () => false,
    async load(signal) {
      const generation = identityGeneration;
      return { value: await options.loadBootstrap(signal), generation };
    },
    accept({ value, generation }) {
      if (generation !== identityGeneration) return;
      if (!initialized) {
        live = value;
        initialized = true;
      }
      candidate = value;
      loading = false;
      contentError = "";
      installCandidate();
      publish();
      // A full response may have read a newer write/session than the last
      // heartbeat. Confirm it instead of ordering opaque tokens or refetching
      // unchanged content in a loop. Never expose an unconfirmed candidate.
      if (candidate) confirmIdentity();
    },
    reject(error) {
      if (authFailure(error)) confirmIdentity();
      contentError =
        error instanceof Error ? error.message : "Unable to refresh the rooms.";
      ++contentFailures;
      retryAt =
        now() + Math.min(60000, 5000 * 2 ** Math.min(4, contentFailures));
      loading = false;
      publish();
    },
  });

  async function drainContent() {
    while (!stopped && (fullTask || confirmationTask)) {
      await (confirmationTask ?? fullTask);
    }
  }
  return {
    start() {
      if (options.active()) ensureContent(true);
      heartbeat.start(5000);
    },
    async refresh() {
      if (stopped) return;
      retryAt = 0;
      await heartbeat.refresh();
      ensureContent(!!contentError, true);
      await drainContent();
    },
    async navigation() {
      if (stopped) return;
      // Returning to the lobby also reconciles out-of-band native changes.
      const version = contentVersion;
      await heartbeat.refresh();
      ensureContent(contentVersion === version);
      await drainContent();
    },
    activity() {
      heartbeat.activity();
    },
    stop() {
      stopped = true;
      heartbeat.stop();
      full.stop();
    },
  };
}
