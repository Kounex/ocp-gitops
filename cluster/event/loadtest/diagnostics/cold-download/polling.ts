type PollingOptions<T> = {
  interval: number;
  load: (signal: AbortSignal) => Promise<T>;
  accept: (value: T) => void;
  reject: (error: unknown) => void;
  active: () => boolean;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/** One request per resource, with at most one coalesced follow-up. */
export function createPoller<T>(options: PollingOptions<T>) {
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn, delay) => setTimeout(fn, delay));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as number));
  let stopped = false;
  let running = false;
  let revision = 0;
  let failures = 0;
  let manualPending = false;
  let automaticPending = false;
  let resumeWanted = false;
  let timer: unknown = null;
  let resumeTimer: unknown = null;
  let requestTimer: unknown = null;
  let controller: AbortController | null = null;
  let waiters: (() => void)[] = [];

  function clearTimers() {
    if (timer !== null) clearTimer(timer);
    if (resumeTimer !== null) clearTimer(resumeTimer);
    timer = resumeTimer = null;
  }
  function settle() {
    const pending = waiters;
    waiters = [];
    pending.forEach((resolve) => resolve());
  }
  function schedule(started: number) {
    if (stopped || !options.active()) return;
    // Attendance checks retain their <=5s cadence; slower resources spread
    // their periodic load around the existing interval.
    const spread = options.interval <= 5000 ? 1 : 0.9 + random() * 0.2;
    const delay = failures
      ? Math.min(
          Math.max(60000, options.interval),
          options.interval *
            2 ** Math.min(failures, 4) *
            (0.8 + random() * 0.4),
        )
      : Math.max(0, started + options.interval * spread - now());
    timer = setTimer(() => {
      timer = null;
      automaticPending = true;
      launch();
    }, delay);
  }
  function launch() {
    if (stopped || running || (!manualPending && !options.active())) return;
    clearTimers();
    running = true;
    manualPending = automaticPending = resumeWanted = false;
    const id = revision;
    const started = now();
    const pendingController = new AbortController();
    controller = pendingController;
    let removeAbort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(new Error("Loading timed out. Please retry."));
      pendingController.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () =>
        pendingController.signal.removeEventListener("abort", abort);
    });
    // A half-open connection must not strand a resource's only in-flight GET.
    // Mutations retain their native transport/commit behavior.
    requestTimer = setTimer(() => {
      requestTimer = null;
      pendingController.abort();
    }, 15000);
    void (async () => {
      try {
        const value = await Promise.race([
          options.load(pendingController.signal),
          cancelled,
        ]);
        if (!stopped && id === revision) {
          failures = 0;
          options.accept(value);
          if (id === revision) settle();
        }
      } catch (error) {
        if (!stopped && id === revision) {
          ++failures;
          options.reject(error);
          if (id === revision) settle();
        }
      } finally {
        removeAbort();
        if (requestTimer !== null) clearTimer(requestTimer);
        requestTimer = null;
        running = false;
        controller = null;
        if (stopped) return;
        // Explicit callers await a read that starts after their mutation;
        // an older in-flight response must neither replace state nor satisfy it.
        if (waiters.length && id !== revision) manualPending = true;
        if (manualPending || automaticPending) launch();
        else if (resumeTimer === null) schedule(started);
      }
    })();
  }
  return {
    start() {
      automaticPending = true;
      launch();
    },
    refresh(): Promise<void> {
      if (stopped) return Promise.resolve();
      ++revision;
      manualPending = true;
      clearTimers();
      return new Promise((resolve) => {
        waiters.push(resolve);
        launch();
      });
    },
    activity() {
      if (stopped) return;
      if (!options.active()) {
        clearTimers();
        automaticPending = resumeWanted = false;
        return;
      }
      if (resumeWanted) return;
      resumeWanted = true;
      ++revision;
      clearTimers();
      // Attendance rechecks immediately on return. Other resources spread
      // reconnect traffic without delaying manual or post-action refreshes.
      const delay =
        options.interval <= 5000
          ? 0
          : random() * Math.min(1000, options.interval / 10);
      resumeTimer = setTimer(() => {
        resumeTimer = null;
        automaticPending = true;
        launch();
      }, delay);
    },
    stop() {
      stopped = true;
      clearTimers();
      if (requestTimer !== null) clearTimer(requestTimer);
      requestTimer = null;
      controller?.abort();
      settle();
    },
  };
}
