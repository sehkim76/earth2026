import { AUTH_DEVICE_STORAGE_KEY, AUTH_NICKNAME_STORAGE_KEY } from "@/lib/auth-claim";

export interface GameSearchParams {
  eventKey: string;
  userId: string;
  nickname: string;
  exitUrl: string;
  from: string;
}

const EMPTY_GAME_PARAMS: GameSearchParams = {
  eventKey: "",
  userId: "",
  nickname: "",
  exitUrl: "",
  from: "",
};

export function readGameSearchParams(): GameSearchParams {
  if (typeof window === "undefined") {
    return EMPTY_GAME_PARAMS;
  }
  try {
    const query = new URLSearchParams(window.location.search);
    const pick = (...names: string[]): string => {
      for (const name of names) {
        const value = query.get(name)?.trim();
        if (value) {
          return value;
        }
      }
      return "";
    };
    return {
      eventKey: pick("eventKey", "eventkey"),
      userId: pick("userId", "userid"),
      nickname: pick("nickname"),
      exitUrl: pick("exitUrl", "exiturl") || "/map",
      from: pick("from"),
    };
  } catch {
    return EMPTY_GAME_PARAMS;
  }
}

export function makeScoreNonce(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.floor(Math.random() * 36 ** 6).toString(36);
  return `${timePart}${randomPart}`;
}

export function buildGameExitPath(params: {
  exitUrl: string;
  from: string;
  score: number;
  eventKey?: string;
}): string {
  const safeScore = Number.isFinite(params.score) ? Math.max(0, Math.trunc(params.score)) : 0;
  const completedEventParam =
    params.eventKey?.startsWith("neutral-") &&
    (params.exitUrl.startsWith("/map") || (!params.exitUrl && params.from === "map")) &&
    params.from !== "qr"
      ? `&completedEventKey=${encodeURIComponent(params.eventKey)}`
      : "";
  const query =
    `scoreUpdated=true&addedScore=${safeScore}` +
    `&scoreNonce=${encodeURIComponent(makeScoreNonce())}${completedEventParam}`;
  if (params.exitUrl) {
    return `${params.exitUrl}${params.exitUrl.includes("?") ? "&" : "?"}${query}`;
  }
  return params.from === "map" ? `/map?${query}` : "/qr";
}

export async function submitGameScore(params: {
  score: number;
  eventKey: string;
  userId: string;
  nickname: string;
  source: string;
}): Promise<void> {
  if (!params.eventKey) {
    return;
  }
  try {
    const storedDeviceId = window.localStorage.getItem(AUTH_DEVICE_STORAGE_KEY)?.trim() ?? "";
    const storedNickname = window.localStorage.getItem(AUTH_NICKNAME_STORAGE_KEY)?.trim() ?? "";
    const resolvedUserId = params.userId.trim();
    const resolvedNickname = params.nickname.trim() || storedNickname;
    const response = await fetch("/api/updatescore", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        score: Math.max(0, Math.trunc(params.score)),
        eventKey: params.eventKey,
        userId: resolvedUserId || undefined,
        nickname: resolvedNickname || undefined,
        deviceId: storedDeviceId || undefined,
        source: params.source,
      }),
    });
    if (!response.ok) {
      console.error("[game-score] updatescore failed", {
        status: response.status,
        source: params.source,
        eventKey: params.eventKey,
      });
    }
  } catch (error) {
    console.error("[game-score] updatescore request error", {
      source: params.source,
      eventKey: params.eventKey,
      error,
    });
  }
}

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

export type EventEntryCheck = "ok" | "visited" | "blocked" | "login";

export type CastleEntryStatus = "ok" | "login" | "disabled" | "cooldown";

export interface CastleEntryResult {
  status: CastleEntryStatus;
  cooldownUntil: number | null;
  dailyCapped: boolean;
}

/**
 * 성 이벤트 판별 (클라이언트용. 서버의 territory-gate.isCastleEventKey와 동일 규칙.
 * game-score는 prisma를 import하지 않으므로 별도 정의한다).
 */
export function isCastleEventKey(eventKey: string): boolean {
  return eventKey.trim().startsWith("castle-");
}

/**
 * 성 진입 판정. check-visited의 성 분기(territoryDisabled/cooldownUntil)를 해석한다.
 * 네트워크 오류 시 "ok" (서버가 최종 판정. checkEventEntry와 동일한 fail-open 규칙).
 */
export async function checkCastleEntry(eventKey: string): Promise<CastleEntryResult> {
  const idle: CastleEntryResult = { status: "ok", cooldownUntil: null, dailyCapped: false };
  if (!eventKey) {
    return idle;
  }
  try {
    const res = await fetch(`/api/check-visited?eventkey=${encodeURIComponent(eventKey)}`);
    if (res.status === 401) {
      return { status: "login", cooldownUntil: null, dailyCapped: false };
    }
    if (!res.ok) {
      return idle;
    }
    const data = (await res.json()) as {
      territoryDisabled?: unknown;
      cooldownUntil?: unknown;
      dailyCapped?: unknown;
    };
    if (data.territoryDisabled === true) {
      return { status: "disabled", cooldownUntil: null, dailyCapped: false };
    }
    const dailyCapped = data.dailyCapped === true;
    const cooldownUntil =
      typeof data.cooldownUntil === "number" && Number.isFinite(data.cooldownUntil)
        ? data.cooldownUntil
        : null;
    if (cooldownUntil !== null && cooldownUntil > Date.now()) {
      return { status: "cooldown", cooldownUntil, dailyCapped };
    }
    return idle;
  } catch {
    return idle;
  }
}

/** 공성 출제 중복 제외용 문제 해시 (짧은 base36). */
export function hashSiegeQuestion(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** 공성 시도 answer 포맷. Phase 2 resolve가 성공 횟수를 집계한다. */
export function buildSiegeAnswer(
  outcome: "hit" | "miss" | "giveup",
  questionHash: string,
): string {
  return `siege:${outcome}:${questionHash}`.slice(0, 120);
}

export async function checkEventEntry(eventKey: string): Promise<EventEntryCheck> {
  if (!eventKey) {
    return "ok";
  }
  try {
    const res = await fetch(`/api/check-visited?eventkey=${encodeURIComponent(eventKey)}`);
    if (res.status === 401) {
      return "login";
    }
    if (!res.ok) {
      return "ok";
    }
    const data = (await res.json()) as { visited?: unknown; expectedGame?: unknown };
    if (data.visited === true) {
      return "visited";
    }
    const expectedGame =
      typeof data.expectedGame === "string" && data.expectedGame.trim().length > 0
        ? data.expectedGame.trim()
        : null;
    if (expectedGame === null || typeof window === "undefined") {
      return "ok";
    }
    const currentPath = window.location.pathname.startsWith("/quiz")
      ? "/quiz"
      : window.location.pathname;
    if (currentPath !== expectedGame) {
      return "blocked";
    }
    return "ok";
  } catch {
    return "ok";
  }
}
