/** 이동가능영역 데이터 영속 캐시 (IndexedDB).
 *
 * 배포 파일이 `max-age=0`(매번 재검증)이라 리로드 때마다 전 파일을 다시 받아야 해서,
 * 구움 래스터·인덱스를 IDB에 두고 먼저 그린다. 데이터는 빌드타임에만 바뀌므로
 * 버전 게이트(`WALKABLE_DATA_VERSION`)로만 무효화하고,平时 재검증은 하지 않는다.
 * IDB 불가(시크릿 모드 등)면 조용히 네트워크로 폴백한다.
 */

/** 구움 포맷이 바뀌면 올린다 (bake 스크립트·디코더와 함께). */
export const WALKABLE_DATA_VERSION = "o1";

const DB_NAME = "armission-walkable";
const DB_VERSION = 1;
const RASTER_STORE = "raster";
const META_STORE = "meta";

type RasterEntry = {
  v: string;
  json: string;
};

const openDb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RASTER_STORE)) {
          db.createObjectStore(RASTER_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
      };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => resolve(null);
      request.onblocked = (): void => resolve(null);
    } catch {
      resolve(null);
    }
  });

let dbPromise: Promise<IDBDatabase | null> | null = null;
const getDb = (): Promise<IDBDatabase | null> => {
  if (!dbPromise) {
    dbPromise = openDb();
  }
  return dbPromise;
};

/** IDB 요청이 영원히 안 끝나도 5초 안에 풀리게 한다. */
export const withIdbTimeout = <T>(task: Promise<T>): Promise<T | null> =>
  new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });

const readStore = (store: string, key: string): Promise<unknown | null> =>
  getDb().then(
    (db) =>
      new Promise<unknown | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(store, "readonly");
          const request = tx.objectStore(store).get(key);
          request.onsuccess = (): void => resolve(request.result ?? null);
          request.onerror = (): void => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );

const writeStore = (store: string, key: string, value: unknown): Promise<void> =>
  getDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) {
          resolve();
          return;
        }
        // 쓰기가 영원히 안 끝나도 5초 안에 풀리게 한다.
        const timer = setTimeout(() => resolve(), 5000);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        try {
          const tx = db.transaction(store, "readwrite");
          tx.objectStore(store).put(value, key);
          tx.oncomplete = (): void => done();
          tx.onerror = (): void => done();
          tx.onabort = (): void => done();
        } catch {
          done();
        }
      }),
  );

/** 타임아웃 fetch (교착 방지 — 실패는 null 취급하고 계속 간다). */
export const fetchWithTimeout = async (
  url: string,
  timeoutMs = 15000,
  init?: RequestInit,
): Promise<Response | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...(init ?? {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};

/** 전역 fetch 동시 실행 상한 (콜드 스타트 폭주 방지 — CDN·메인스레드 보호). */
let activeFetches = 0;
const fetchWaiters: Array<() => void> = [];
const MAX_CONCURRENT_FETCHES = 4;
export const queuedFetch = async (
  url: string,
  timeoutMs = 15000,
  init?: RequestInit,
): Promise<Response | null> => {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    await new Promise<void>((resolve) => {
      fetchWaiters.push(resolve);
    });
  }
  activeFetches += 1;
  try {
    return await fetchWithTimeout(url, timeoutMs, init);
  } finally {
    activeFetches -= 1;
    const next = fetchWaiters.shift();
    if (next) {
      next();
    }
  }
};

/** 구움 래스터 JSON 읽기 (버전 일치 시). */
export const readCachedRaster = async (dongId: string): Promise<unknown | null> => {
  try {
    const entry = (await withIdbTimeout(readStore(RASTER_STORE, dongId))) as RasterEntry | null;
    if (!entry || typeof entry !== "object" || entry.v !== WALKABLE_DATA_VERSION) {
      return null;
    }
    return typeof entry.json === "string" ? (JSON.parse(entry.json) as unknown) : null;
  } catch {
    return null;
  }
};

/** 구움 래스터 JSON 저장 (원문 그대로). */
export const writeCachedRaster = (dongId: string, rawText: string): Promise<void> =>
  writeStore(RASTER_STORE, dongId, { v: WALKABLE_DATA_VERSION, json: rawText } satisfies RasterEntry);

/** 도로 그래프 JSON 읽기 (래스터와 같은 스토어, 키 접두사 분리). */
export const readCachedGraph = async (dongId: string): Promise<unknown | null> => {
  try {
    const entry = (await withIdbTimeout(readStore(RASTER_STORE, `graph:${dongId}`))) as RasterEntry | null;
    if (!entry || typeof entry !== "object" || entry.v !== WALKABLE_DATA_VERSION) {
      return null;
    }
    return typeof entry.json === "string" ? (JSON.parse(entry.json) as unknown) : null;
  } catch {
    return null;
  }
};

/** 도로 그래프 JSON 저장 (원문 그대로). */
export const writeCachedGraph = (dongId: string, rawText: string): Promise<void> =>
  writeStore(RASTER_STORE, `graph:${dongId}`, { v: WALKABLE_DATA_VERSION, json: rawText } satisfies RasterEntry);

/** 인덱스/adjacent 읽기. */
export const readCachedMeta = async (key: string): Promise<unknown | null> => {
  try {
    const entry = (await readStore(META_STORE, key)) as { v: string; json: string } | null;
    if (!entry || entry.v !== WALKABLE_DATA_VERSION || typeof entry.json !== "string") {
      return null;
    }
    return JSON.parse(entry.json) as unknown;
  } catch {
    return null;
  }
};

/** 인덱스/adjacent 저장. */
export const writeCachedMeta = (key: string, value: unknown): Promise<void> => {
  try {
    return writeStore(META_STORE, key, { v: WALKABLE_DATA_VERSION, json: JSON.stringify(value) });
  } catch {
    return Promise.resolve();
  }
};
