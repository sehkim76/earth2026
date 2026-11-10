export function saveSessionSnapshot(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

export function loadSessionSnapshot<T>(
  key: string,
  validate: (value: unknown) => value is T,
): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSessionSnapshot(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    return;
  }
}

const GAME_SNAPSHOT_PREFIXES = [
  "galag:",
  "cube-rush-60:",
  "2048game:",
  "quiz-deadline:",
  "quiz-result:",
];

export function clearAllGameSnapshots(): void {
  try {
    if (typeof window === "undefined") {
      return;
    }
    const storage = window.sessionStorage;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && GAME_SNAPSHOT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      storage.removeItem(key);
    }
  } catch {
    return;
  }
}
