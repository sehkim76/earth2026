const IDLE_AFTER_MS = 2 * 60_000;
const inputEvents = ["pointerdown", "pointermove", "keydown", "wheel", "click"] as const;
const refreshOnReturn = new Set<() => void>();
let lastActivity = 0;

export function mapPollingActive(): boolean {
  return !document.hidden && Date.now() - lastActivity < IDLE_AFTER_MS;
}

/** Called for input and actual travel. Passive marker animations never renew activity. */
export function noteMapActivity(): void {
  if (document.hidden) return;
  const wasActive = mapPollingActive();
  lastActivity = Date.now();
  if (!wasActive) refreshOnReturn.forEach(refresh => refresh());
}

function visibilityChanged(): void {
  lastActivity = 0;
  if (!document.hidden) noteMapActivity();
}

/** Pause recurring requests when hidden or idle. Re-enter on input with one fresh snapshot. */
export function pollActiveMap(
  refresh: () => Promise<unknown> | void,
  interval: number,
  immediate = true,
): () => void {
  if (!refreshOnReturn.size) {
    lastActivity = Date.now();
    for (const event of inputEvents) window.addEventListener(event, noteMapActivity, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pageshow", visibilityChanged);
  }
  let timer: number | undefined;
  let disposed = false;
  let pending = false;
  let refreshAgain = false;
  const run = async (): Promise<void> => {
    window.clearTimeout(timer);
    if (disposed || !mapPollingActive()) return;
    if (pending) {
      refreshAgain = true;
      return;
    }
    pending = true;
    try {
      await refresh();
    } finally {
      pending = false;
      if (!disposed && mapPollingActive()) timer = window.setTimeout(run, refreshAgain ? 0 : interval);
      refreshAgain = false;
    }
  };
  const resume = (): void => { void run(); };
  refreshOnReturn.add(resume);
  timer = window.setTimeout(run, immediate ? 0 : interval);
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    refreshOnReturn.delete(resume);
    if (!refreshOnReturn.size) {
      for (const event of inputEvents) window.removeEventListener(event, noteMapActivity, true);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pageshow", visibilityChanged);
    }
  };
}
