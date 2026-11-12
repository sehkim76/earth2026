import { readFileSync } from "node:fs";
import { join } from "node:path";
import prisma from "@/lib/prismadb";
import type { TerritoryNeutralUnit } from "@/generated/prisma/client";
import { withNamedLock } from "@/lib/territory";
import {
  dongBboxServer,
  ensureDongBoundary,
  ensureDongRaster,
  hasDongGrids,
  isInDongServer,
  isWalkableServer,
  setRasterBaseUrl,
  snapToWalkableServer,
} from "@/lib/server-walkable";
import { NEUTRAL_PATH_SNAP_MAX_M, neutralPositionAt, projectOntoPath } from "@/lib/neutral-leg";
import { findServerRoute, setGraphBaseUrl } from "@/lib/server-graph";
import { mapConcurrent } from "@/lib/map-concurrent";

/** 래스터·그래프 기준 URL (API 라우트에서 요청 origin으로 설정). */
export const setNeutralRasterBaseUrl = (origin: string): void => {
  setRasterBaseUrl(origin);
  setGraphBaseUrl(origin);
};

/** 중립 부대 규칙: 5분마다 1기 스폰, 시속 4km 배회. 상한은 이동가능면적 비례 (좌2동=20기 기준, 최대 50기). */
export const NEUTRAL_UNIT_PER_DONG_CAP = 20;
const REFERENCE_DONG = "71637012B36687171546688";
const REFERENCE_DONG_CAP = 10;
const NEUTRAL_UNIT_MAX_PER_DONG = 25;
import dongWalkableArea from "../../public/boundaries/dong-walkable-area.json" assert { type: "json" };

// 중립성(동사무소 등) 위치 — 스폰 기준점용. key의 동 ID와 래스터 동 ID는 동일 체계다.
import korOffices from "../../public/boundaries/kor_offices.json" assert { type: "json" };

let officesByDong: Map<string, Array<{ lat: number; lon: number }>> | null = null;
const getOfficesInDong = (dong: string): Array<{ lat: number; lon: number }> => {
  if (!officesByDong) {
    const map = new Map<string, Array<{ lat: number; lon: number }>>();
    const rows = korOffices as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const key = typeof row.key === "string" ? row.key : "";
      const id = key.startsWith("neutral-") ? key.slice("neutral-".length) : "";
      const lat = typeof row.lat === "number" ? row.lat : NaN;
      const lon = typeof row.lon === "number" ? row.lon : NaN;
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      const list = map.get(id);
      if (list) {
        list.push({ lat, lon });
      } else {
        map.set(id, [{ lat, lon }]);
      }
    }
    officesByDong = map;
  }
  return officesByDong.get(dong) ?? [];
};

const dongCapCache = new Map<string, number>();
/** 동별 상한: 좌2동 20기를 기준 이동가능면적 비례, 상한 50기. */
export const capForDong = (dong: string): number => {
  const cached = dongCapCache.get(dong);
  if (cached !== undefined) {
    return cached;
  }
  const areas = dongWalkableArea as unknown as Record<string, unknown>;
  const refArea = Number(areas[REFERENCE_DONG]);
  const area = Number(areas[dong]);
  let cap = REFERENCE_DONG_CAP;
  if (Number.isFinite(refArea) && refArea > 0 && Number.isFinite(area) && area >= 0) {
    cap = Math.round((REFERENCE_DONG_CAP * area) / refArea);
  }
  cap = Math.max(1, Math.min(NEUTRAL_UNIT_MAX_PER_DONG, cap));
  dongCapCache.set(dong, cap);
  return cap;
};
export const NEUTRAL_UNIT_SPAWN_INTERVAL_MS = 5 * 60 * 1000;
export const NEUTRAL_UNIT_SPEED_MPS = 4000 / 3600;
const SPAWN_RADIUS_M = 200;
const WANDER_RADIUS_M = 350;
export const NEUTRAL_UNIT_NAME_PREFIX = "무법자";

export interface NeutralUnitView {
  id: number;
  dong: string;
  lat: number;
  lon: number;
  fromLat: number;
  fromLon: number;
  destLat: number;
  destLon: number;
  startedAt: number;
  endsAt: number;
  moving: boolean;
  quizKey: string;
  quizTitle: string;
  /** 저장 경로 (없으면 직선 다리). */
  path?: Array<{ lat: number; lon: number }> | null;
  /** 현재 다리 목적지가 놓인 경로 구간의 끝 정점 인덱스 (구간 = path[pathIdx-1] → path[pathIdx]). */
  pathIdx: number;
}

// quiz_titles.json: { "Quiz/xxx.json": "제목" } — 검증된 풀(quiz_pool.json) 우선, 없으면 전체에서.
// quiz_pool.json은 scripts/audit-quiz-pool.mjs로 재생성 (출제 불가 135개 제외됨).
let quizPool: Array<{ key: string; title: string }> | null = null;
const loadQuizPool = (): Array<{ key: string; title: string }> => {
  if (quizPool) {
    return quizPool;
  }
  try {
    const rawPool = readFileSync(join(process.cwd(), "public/boundaries/quiz_pool.json"), "utf-8");
    const parsed = JSON.parse(rawPool) as unknown;
    if (Array.isArray(parsed)) {
      const next = parsed.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const row = entry as Record<string, unknown>;
        return typeof row.key === "string" && typeof row.title === "string" && row.key.length > 0
          ? [{ key: row.key, title: row.title }]
          : [];
      });
      if (next.length > 0) {
        quizPool = next;
        return quizPool;
      }
    }
  } catch {
    // 폴백: 전체 타이틀
  }
  try {
    const raw = readFileSync(join(process.cwd(), "public/boundaries/quiz_titles.json"), "utf-8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    // 출제 가능한 CSV + 단일 문항 JSON (퀴즈 페이지와 동일 조건).
    const next = Object.entries(record).flatMap(([key, title]) =>
      typeof title === "string" && title.length > 0 && /^Quiz\/[^/]+\.(csv|json)$/i.test(key)
        ? [{ key, title }]
        : [],
    );
    quizPool = next.length > 0 ? next : [];
  } catch {
    quizPool = [];
  }
  return quizPool;
};

const pickQuiz = (): { key: string; title: string } => {
  const pool = loadQuizPool();
  if (pool.length === 0) {
    return { key: "", title: "" };
  }
  return pool[Math.floor(Math.random() * pool.length)];
};

const offsetLatLon = (lat: number, lon: number, maxM: number): { lat: number; lon: number } => {
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * maxM;
  const dLat = (dist * Math.cos(angle)) / 110540;
  const dLon = (dist * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
};

/**
 * 도로 위 + 동 경계 안 스냅 (경계 데이터 없으면 도로 조건만, 둘 다 없으면 null).
 */
const snapInDong = async (
  dong: string,
  lat: number,
  lon: number,
  radiusM: number,
): Promise<{ lat: number; lon: number } | null> => {
  await ensureDongBoundary();
  const snapped = await snapToWalkableServer(dong, lat, lon, radiusM);
  if (!snapped) {
    return null;
  }
  if (isInDongServer(dong, snapped.lat, snapped.lon) === false) {
    return null;
  }
  return snapped;
};

/**
 * 목적지 선정 (규칙 4): 동 bbox 안에서 임의 지점 20곳을 도로 위로 스냅해,
 * 다른 무법자들의 현 위치와 가장 먼 곳을 목적지로 삼는다. 동 안으로만 잡는다.
 */
const pickFarthestDest = async (
  dong: string,
  others: Array<{ lat: number; lon: number }>,
  avoid?: { lat: number; lon: number },
): Promise<Array<{ lat: number; lon: number }>> => {
  await ensureDongBoundary();
  try {
    await ensureDongRaster(dong);
  } catch {
    // 로드 실패해도 계속한다.
  }
  const bbox = dongBboxServer(dong);
  if (!bbox) {
    return [];
  }
  const scored: Array<{ dest: { lat: number; lon: number }; sep: number }> = [];
  for (let i = 0; i < 30; i += 1) {
    const raw = {
      lat: bbox.minLat + Math.random() * (bbox.maxLat - bbox.minLat),
      lon: bbox.minLon + Math.random() * (bbox.maxLon - bbox.minLon),
    };
    const dest = await snapInDong(dong, raw.lat, raw.lon, 300);
    if (!dest) {
      continue;
    }
    // 현재 위치(도착점) 근처(250m)는 제외한다 — 온 길 되돌아가기 방지.
    if (avoid && distM(dest.lat, dest.lon, avoid.lat, avoid.lon) < 250) {
      continue;
    }
    let sep = Number.POSITIVE_INFINITY;
    for (const o of others) {
      const d = distM(dest.lat, dest.lon, o.lat, o.lon);
      if (d < sep) {
        sep = d;
      }
    }
    if (sep === Number.POSITIVE_INFINITY) {
      sep = 10000;
    }
    scored.push({ dest, sep });
  }
  // 먼 순 상위 5개 (경로 실패 시 다음 후보로 재시도용).
  scored.sort((a, b) => b.sep - a.sep);
  return scored.slice(0, 5).map((s) => s.dest);
};

/** 후보 목적지들을 서로 멀리 떨어뜨린다 (같은 구석 몰림 방지). sep 내림차순 입력, minSep 이상 간격으로 추린다. */
const spreadGoals = (
  goals: Array<{ lat: number; lon: number }>,
  minSepM = 300,
): Array<{ lat: number; lon: number }> => {
  const out: Array<{ lat: number; lon: number }> = [];
  for (const g of goals) {
    if (out.every((o) => distM(g.lat, g.lon, o.lat, o.lon) >= minSepM)) {
      out.push(g);
    }
  }
  return out.length > 0 ? out : goals.slice(0, 1);
};

/** 순서 섞기 (같은 폴링에 동시 계획한 개체들이 같은 1순위로 몰리는 현상 방지). */
const shuffleGoals = <T,>(arr: Array<T>): Array<T> => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i] as T;
    a[i] = a[j] as T;
    a[j] = t;
  }
  return a;
};

/** 다른 부대들의 저장 경로와 겹치는 후보를 제외한다 (일렬종대 방지). */
const filterAwayFromPaths = (
  goals: Array<{ lat: number; lon: number }>,
  ownPath: Array<{ lat: number; lon: number }> | null,
  otherPaths: Array<Array<{ lat: number; lon: number }>>,
  radiusM = 300,
): Array<{ lat: number; lon: number }> => {
  const nearOwn = (g: { lat: number; lon: number }): boolean =>
    !!ownPath && ownPath.length >= 2 && ownPath.some((p) => distM(g.lat, g.lon, p.lat, p.lon) < radiusM);
  const nearOther = (g: { lat: number; lon: number }): boolean =>
    otherPaths.some((path) => path.some((p) => distM(g.lat, g.lon, p.lat, p.lon) < radiusM));
  const away = goals.filter((g) => !nearOwn(g) && !nearOther(g));
  return away.length > 0 ? away : goals;
};

const otherStoredPaths = (
  rows: TerritoryNeutralUnit[],
  parsePath: PathParser,
  excludeId?: number,
): Array<Array<{ lat: number; lon: number }>> => {
  const out: Array<Array<{ lat: number; lon: number }>> = [];
  for (const o of rows) {
    if (o.id === excludeId || !o.path) {
      continue;
    }
    const p = parsePath(o.path);
    if (p && p.length >= 2) {
      out.push(p);
    }
  }
  return out;
};


/** path JSON 파싱 (실패 시 null). */
const parseStoredPath = (raw: string | null): Array<{ lat: number; lon: number }> | null => {
  if (!raw) {
    return null;
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length < 2) {
      return null;
    }
    const pts: Array<{ lat: number; lon: number }> = [];
    for (const p of arr) {
      if (typeof p !== "object" || p === null) {
        return null;
      }
      const { lat, lon } = p as { lat?: unknown; lon?: unknown };
      if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }
      pts.push({ lat, lon });
    }
    return pts;
  } catch {
    return null;
  }
};

type StoredPath = Array<{ lat: number; lon: number }>;
type PathParser = (raw: string | null) => StoredPath | null;

/**
 * 요청 단위 path 파서: 같은 원문 문자열은 한 번만 JSON.parse 한다.
 * (계획 단계에서 개체마다 다른 모든 행의 경로를 다시 파싱하던 O(n²) 비용 제거)
 * 반환 배열은 여러 곳에서 공유되므로 호출자는 변경하지 않는다 (읽기 전용).
 */
const makePathParser = (): PathParser => {
  const memo = new Map<string, StoredPath | null>();
  return (raw: string | null): StoredPath | null => {
    if (!raw) {
      return null;
    }
    const hit = memo.get(raw);
    if (hit !== undefined) {
      return hit;
    }
    const parsed = parseStoredPath(raw);
    memo.set(raw, parsed);
    return parsed;
  };
};

/**
 * 경로 설정 (규칙 3: 부대 이동 경로 알고리즘 = 서버 findServerRoute 그대로).
 * 동 밖으로 나가는 부분은 잘라 동 안에서만 이동한다 (규칙 2).
 * 실패 시 null (대기).
 */
const routeInDong = async (
  dong: string,
  fromLat: number,
  fromLon: number,
  destLat: number,
  destLon: number,
  unitId?: number,
): Promise<Array<{ lat: number; lon: number }> | null> => {
  // 클리핑 판정 전 래스터 로드 (미로드 null 통과로 바깥 경로가 생기는 것 방지).
  try {
    await ensureDongRaster(dong);
  } catch {
    // 로드 실패해도 계속한다.
  }
  const result = await findServerRoute(fromLat, fromLon, destLat, destLon);
  if (!result.ok || result.path.length < 2) {
    console.debug(
      `[neutral] routefail id=${unitId ?? "-"} from=(${fromLat.toFixed(5)},${fromLon.toFixed(5)}) to=(${destLat.toFixed(5)},${destLon.toFixed(5)}) reason=${result.ok ? "short" : result.reason}`,
    );
    return null;
  }
  // 동 안 클리핑: 앞에서부터 동 안인 점만 유지한다.
  // 데이터 없음(null)은 실패로 취급한다 (fail-closed: 래스터 미로드 시 바깥 경로 방지).
  // 단, 경계 도로를 따라 동 밖으로 잠깐(80m 미만) 나갔다 들어오는 경우는 허용한다.
  // 그런 구간에서 경로 전체를 버리면 새 목적지 찾기가 매번 실패한다.
  const clipped: Array<{ lat: number; lon: number }> = [];
  let clipBreak = "";
  let excursion: Array<{ lat: number; lon: number }> = [];
  let excursionM = 0;
  const flushExcursion = (): void => {
    // 복귀 시 이탈 구간 전체를 유지한다 (도로 위이므로 보행 가능).
    for (const ep of excursion) {
      clipped.push(ep);
    }
    excursion = [];
    excursionM = 0;
  };
  for (const p of result.path) {
    const inDong = isInDongServer(dong, p.lat, p.lon);
    if (inDong !== true) {
      // 동 경계 데이터 없음(null)도 이탈로 취급한다 (fail-closed).
      const prev = excursion.length > 0 ? excursion[excursion.length - 1] : clipped[clipped.length - 1];
      if (prev) {
        excursionM += distM(prev.lat, prev.lon, p.lat, p.lon);
      }
      excursion.push(p);
      if (excursionM >= 80) {
        clipBreak = "out_of_dong";
        break;
      }
      continue;
    }
    if (isWalkableServer(dong, p.lat, p.lon) !== true) {
      clipBreak = "unwalkable";
      break;
    }
    if (excursion.length > 0) {
      flushExcursion();
    }
    clipped.push(p);
  }
  if (clipped.length < 2) {
    console.debug(
      "[neutral] clipfail id=" + (unitId ?? "-") + " path=" + result.path.length + " kept=" + clipped.length + " at=" + clipBreak,
    );
    return null;
  }
  return clipped;
};

/** path 위 현재 위치에서 stepM 앞 점을 다음 다리 목적지로 삼는다.
 * 다리 자체는 직선 보간이라 짧게 끊어야 도로를 벗어나지 않는다. */
const LEG_STEP_M = 150;
const nextLegDest = (
  path: Array<{ lat: number; lon: number }>,
  curLat: number,
  curLon: number,
  fromIdx = 0,
): { dest: { lat: number; lon: number }; idx: number } | null => {
  const kx = 111320 * Math.cos((curLat * Math.PI) / 180);
  // fromIdx 이전으로는 돌아가지 않는다 (역행 방지).
  let bestIdx = Math.min(fromIdx, path.length - 1);
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let i = fromIdx; i < path.length; i += 1) {
    const p = path[i] as { lat: number; lon: number };
    const d2 = ((p.lon - curLon) * kx) ** 2 + ((p.lat - curLat) * 110540) ** 2;
    // 10m 안 동점이면 더 앞선 인덱스를 택한다 (루프 구간 역행 방지).
    if (d2 < bestD2 - 100 || (Math.abs(d2 - bestD2) <= 100 && i > bestIdx)) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  let acc = 0;
  for (let i = bestIdx + 1; i < path.length; i += 1) {
    const a = path[i - 1] as { lat: number; lon: number };
    const b = path[i] as { lat: number; lon: number };
    const segLen = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
    acc += segLen;
    // 꺾이는 점이 있으면 다리를 거기서 끊는다 (코너 숏컷 방지).
    // 직선 구간은 LEG_STEP_M까지 길게 유지한다.
    const c = path[i + 1] as { lat: number; lon: number } | undefined;
    if (c) {
      const v1x = (b.lon - a.lon) * kx;
      const v1y = (b.lat - a.lat) * 110540;
      const v2x = (c.lon - b.lon) * kx;
      const v2y = (c.lat - b.lat) * 110540;
      const n1 = Math.hypot(v1x, v1y);
      const n2 = Math.hypot(v2x, v2y);
      if (n1 > 0 && n2 > 0) {
        const cosA = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
        if (Math.acos(cosA) >= (30 * Math.PI) / 180) {
          if (distM(curLat, curLon, b.lat, b.lon) >= 20) {
            return { dest: { lat: b.lat, lon: b.lon }, idx: i };
          }
        }
      }
    }
    if (acc >= LEG_STEP_M) {
      // 정확히 LEG_STEP_M 지점으로 보간한다 (점 간격이 넓어도 다리를 짧게).
      const back = Math.max(0, acc - LEG_STEP_M);
      const t = segLen <= 0 ? 1 : Math.max(0, Math.min(1, 1 - back / segLen));
      const cand = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      // 경로가 루프백해 후보가 제자리(20m 안)면 스킵하고 더 앞을 탐색한다.
      // 그대로 반환하면 10초짜리 제자리 다리가 무한 반복된다.
      // idx는 후보가 속한 구간 끝(i)으로 전진시킨다. bestIdx 그대로 두면
      // pathIdx가 갱신되지 않아 다음 다리에서 오래된 구간으로 역행한다.
      if (distM(curLat, curLon, cand.lat, cand.lon) >= 20) {
        return { dest: cand, idx: i };
      }
    }
  }
  const last = path[path.length - 1] as { lat: number; lon: number };
  // 최종 목적지 근처(20m)면 도착으로 본다.
  if (distM(curLat, curLon, last.lat, last.lon) < 20) {
    return null;
  }
  return { dest: last, idx: path.length - 1 };
};

// 발자국 100m 셀 (동별 분산 배회용).
const TRAIL_CELL_M = 100;
const trailCellOf = (lat: number, lon: number): { gx: number; gy: number } => ({
  gx: Math.floor((lat * 110540) / TRAIL_CELL_M),
  gy: Math.floor((lon * 111320 * Math.cos((lat * Math.PI) / 180)) / TRAIL_CELL_M),
});
const trailKeyOf = (lat: number, lon: number): string => {
  const c = trailCellOf(lat, lon);
  return `${c.gx},${c.gy}`;
};

const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** DB 행의 현재 위치: 저장 경로를 따라 보간한다 (화면 애니메이션과 동일 수식). */
const rowPositionAt = (
  r: TerritoryNeutralUnit,
  now: number,
  parsePath: PathParser,
): { lat: number; lon: number; arrived: boolean } =>
  neutralPositionAt(
    {
      fromLat: r.lat,
      fromLon: r.lon,
      destLat: r.destLat,
      destLon: r.destLon,
      startedAt: Number(r.legStartedAt),
      endsAt: Number(r.legEndsAt),
      path: parsePath(r.path),
      pathIdx: r.pathIdx,
    },
    now,
  );

/**
 * 해당 동의 중립 부대를 조회한다. 부 side-effect:
 * - 5기 미만 + 마지막 생성 후 5분 경과 시 1기 스폰 (요청자 근처 200m, 랜덤 퀴즈 부착)
 * - 도착한 다리는 다음 배회 다리로 연결한다 (서버 권위, 쓰기 없음이 원칙이나 다리 연결만 갱신)
 * 전국 동시 처리가 아니라 "폴링하는 플레이어가 있는 동"만 처리하므로 비용이 한정된다.
 *
 * 라우팅(HTTP·수십 초 가능)은 락 밖에서 계획하고, 락 안에서는 검증+적용만 한다.
 * 라우팅을 락 안에서 하면 락 점유(20초 tx 타임아웃 초과)가 연쇄 500을 만든다.
 */
interface NeutralLegPlan {
  baseLat: number;
  baseLon: number;
  destLat: number;
  destLon: number;
  pathJson: string | null;
  pathIdx: number;
  waitMs: number;
  legMs: number;
  expectLegEndsAt: bigint;
}

interface NeutralSpawnPlan {
  at: { lat: number; lon: number };
  dest: { lat: number; lon: number };
  pathJson: string | null;
  /** 첫 다리 목적지가 놓인 구간의 끝 정점 인덱스. */
  pathIdx: number;
  quizKey: string;
  quizTitle: string;
}

/** 계획 단계 공유 컨텍스트 (스냅샷 기준, 읽기 전용). */
interface NeutralPlanContext {
  parsePath: PathParser;
  /** 스냅샷 행의 현재 위치 (행 id별 1회 계산). */
  positionOf: (r: TerritoryNeutralUnit) => { lat: number; lon: number; arrived: boolean };
}

/** 스냅샷(계획 중 변경되지 않음) 기준 컨텍스트를 만든다. */
const makePlanContext = (now: number): NeutralPlanContext => {
  const parsePath = makePathParser();
  const positions = new Map<number, { lat: number; lon: number; arrived: boolean }>();
  return {
    parsePath,
    positionOf: (r) => {
      const hit = positions.get(r.id);
      if (hit) {
        return hit;
      }
      const pos = rowPositionAt(r, now, parsePath);
      positions.set(r.id, pos);
      return pos;
    },
  };
};

const neutralOthersOf = (
  rows: TerritoryNeutralUnit[],
  ctx: NeutralPlanContext,
  excludeId?: number,
): Array<{ lat: number; lon: number }> =>
  rows
    .filter((r) => r.id !== excludeId)
    .map((r) => {
      const pos = ctx.positionOf(r);
      return { lat: pos.lat, lon: pos.lon };
    });

/** 락 밖에서 실행: 도착한 다리의 다음 다리 계획을 세운다 (라우팅 포함, DB 쓰기 없음). */
const planNeutralLeg = async (
  r: TerritoryNeutralUnit,
  rows: TerritoryNeutralUnit[],
  dong: string,
  ctx: NeutralPlanContext,
): Promise<NeutralLegPlan> => {
  const anchorLat = r.anchorLat;
  const anchorLon = r.anchorLon;
  let baseLat = r.destLat;
  let baseLon = r.destLon;
  // 경로 밖(과거 직선 보간 고정분)에 멈춘 개체는 저장 경로 위로 되돌린 뒤 이어서 걷는다.
  // 그대로 두면 아래 이동가능 검사에 걸려 스폰 앵커로 순간이동하거나 경로 밖에서 출발한다.
  {
    const onPath = projectOntoPath(
      baseLat,
      baseLon,
      ctx.parsePath(r.path),
      typeof r.pathIdx === "number" && r.pathIdx >= 1 ? r.pathIdx - 1 : null,
    );
    if (onPath && onPath.distM > 1 && onPath.distM <= NEUTRAL_PATH_SNAP_MAX_M) {
      console.debug(`[neutral] base snapped to path id=${r.id} off=${onPath.distM.toFixed(1)}m`);
      baseLat = onPath.lat;
      baseLon = onPath.lon;
    }
  }
  if (
    isWalkableServer(dong, baseLat, baseLon) === false ||
    isInDongServer(dong, baseLat, baseLon) === false
  ) {
    const fixed = await snapInDong(dong, anchorLat, anchorLon, WANDER_RADIUS_M);
    if (fixed) {
      baseLat = fixed.lat;
      baseLon = fixed.lon;
    }
  }
  // 저장 경로 위를 전진한다. 이전 다리 목적지 이후부터 탐색해 역행을 막는다.
  console.debug(
    `[neutral] arrived id=${r.id} base=(${baseLat.toFixed(5)},${baseLon.toFixed(5)}) prevDest=(${r.destLat.toFixed(5)},${r.destLon.toFixed(5)}) hasPath=${r.path ? r.path.length : 0}`,
  );
  let storedPath = ctx.parsePath(r.path);
  // 저장 경로 재검증 (fail-closed): 과거에 저장된 불량 경로(래스터 미로드 시 통과분,
  // 구버전 미클리핑분)가 있으면 버리고 새로 계획한다.
  if (storedPath) {
    // 판정 불가(래스터 미로드)면 기존 경로를 유지하고 다음 폴링에서 재시도한다.
    // 판정 가능하면 fail-closed로 재검증한다.
    let gridsReady = false;
    try {
      gridsReady = (await ensureDongRaster(dong)) && hasDongGrids(dong);
    } catch {
      gridsReady = false;
    }
    if (gridsReady) {
      let staleBreak = "";
      for (let vi = 0; vi < storedPath.length; vi += 1) {
        const vp = storedPath[vi] as { lat: number; lon: number };
        if (isInDongServer(dong, vp.lat, vp.lon) !== true) {
          staleBreak = "out_of_dong";
          break;
        }
        if (isWalkableServer(dong, vp.lat, vp.lon) !== true) {
          staleBreak = "unwalkable";
          break;
        }
      }
      if (!staleBreak) {
        // 연속성 검사: 저장 경로와 현재 기점 사이가 너무 멀면
        // 이전 위치의 잔재이므로 버리고 기점에서 새로 계획한다.
        // 정점 간 거리가 아니라 구간(segment)까지의 최단거리로 본다
        // (다리 중간 보간점은 정점에서 멀어도 경로 위이므로).
        let nearest = Number.POSITIVE_INFINITY;
        const pts = storedPath as Array<{ lat: number; lon: number }>;
        for (let i = 0; i < pts.length; i += 1) {
          const p = pts[i];
          if (!p) {
            continue;
          }
          const d0 = distM(baseLat, baseLon, p.lat, p.lon);
          if (d0 < nearest) {
            nearest = d0;
          }
          const q = pts[i + 1];
          if (!q) {
            continue;
          }
          const kx1 = 111320 * Math.cos((p.lat * Math.PI) / 180);
          const dx = (q.lon - p.lon) * kx1;
          const dy = (q.lat - p.lat) * 110540;
          const len2 = dx * dx + dy * dy;
          const proj = ((baseLon - p.lon) * kx1 * dx + (baseLat - p.lat) * 110540 * dy) / (len2 <= 0 ? 1 : len2);
          const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, proj));
          const cx = p.lon + (q.lon - p.lon) * t - baseLon;
          const cy = p.lat + (q.lat - p.lat) * t - baseLat;
          const d = Math.hypot(cx * kx1, cy * 110540);
          if (d < nearest) {
            nearest = d;
          }
        }
        if (!(nearest <= 30)) {
          staleBreak = "discontinuous";
        }
      }
      if (staleBreak) {
        console.debug(`[neutral] stale path dropped id=${r.id} at=${staleBreak}`);
        storedPath = null;
      }
    }
  }
  // DB에 저장된 진행 인덱스를 하한으로 쓴다.
  // 지리적 근접만으로는 루프 구간에서 이전 구간으로 역행한다.
  let fromIdx = typeof r.pathIdx === "number" ? r.pathIdx : 0;
  if (storedPath) {
    const kx = 111320 * Math.cos((baseLat * Math.PI) / 180);
    let bestD2 = Number.POSITIVE_INFINITY;
    let bestI = fromIdx;
    for (let i = fromIdx; i < storedPath.length; i += 1) {
      const pt = storedPath[i] as { lat: number; lon: number };
      const d2 = ((pt.lon - r.destLon) * kx) ** 2 + ((pt.lat - r.destLat) * 110540) ** 2;
      // 10m 안 동점이면 더 앞선 인덱스를 택한다 (루프 구간에서 이미 걸은 쪽으로 역행 방지).
      if (d2 < bestD2 - 100 || (Math.abs(d2 - bestD2) <= 100 && i > bestI)) {
        bestD2 = d2;
        bestI = i;
      }
    }
    fromIdx = bestI;
  }
  let finalLeg = storedPath ? nextLegDest(storedPath, baseLat, baseLon, fromIdx) : null;
  let pathIdx = fromIdx;
  let finalDest = finalLeg ? finalLeg.dest : null;
  if (finalLeg) {
    pathIdx = finalLeg.idx;
  }
  let pathJson: string | null = r.path;
  if (!finalDest) {
    // 최종 목적지 도착(또는 경로 없음): 새 목적지 + 새 경로.
    // 후보 순서대로 경로 성공할 때까지 시도한다.
    // 방금 걸은 경로 300m 안 후보는 제외한다 (왔던 길 루프백 방지).
    let goals = await pickFarthestDest(dong, neutralOthersOf(rows, ctx, r.id), { lat: baseLat, lon: baseLon });
    if (goals.length > 1) {
      // 방금 걸은 경로 300m 안 후보는 제외한다 (왔던 길 루프백 방지).
      // 다른 개체의 저장 경로 300m 안도 제외한다 (일렬종대 방지).
      goals = filterAwayFromPaths(goals, storedPath, otherStoredPaths(rows, ctx.parsePath, r.id));
    }
    // 후보끼리 500m 이상 떨어뜨리고 순서를 섞는다.
    // (같은 구석 1순위로 몰리는 현상 + 동시 계획 개체들의 동조 방지 → 동 전역 배회)
    goals = shuffleGoals(spreadGoals(goals));
    console.debug(
      `[neutral] newgoal id=${r.id} goals=${goals.length}`,
    );
    let fresh: Array<{ lat: number; lon: number }> | null = null;
    for (const goal of goals) {
      fresh = await routeInDong(dong, baseLat, baseLon, goal.lat, goal.lon, r.id);
      if (fresh && fresh.length >= 2) {
        break;
      }
      fresh = null;
    }
    // 원거리 후보가 전부 실패하면 근거리(100~500m 링) 폴백: 제자리 고착 방지.
    // base 자체 스냅은 제자리(50m 안)가 돼 버리므로 링 위 임의점을 스냅한다.
    if (!fresh) {
      for (let t = 0; t < 8 && !fresh; t += 1) {
        const ang = Math.random() * Math.PI * 2;
        const d = 150 + Math.random() * 350;
        const cand = {
          lat: baseLat + (d / 111320) * Math.sin(ang),
          lon: baseLon + (d / (111320 * Math.cos((baseLat * Math.PI) / 180))) * Math.cos(ang),
        };
        const near = await snapInDong(dong, cand.lat, cand.lon, 200);
        // 전반 4회는旧 경로 150m 안 후보를 건너뛴다 (왔던 길 역행 방지).
        // 후반 4회는 막다른길 탈출을 위해 되돌아가기도 허용한다.
        if (
          near &&
          t < 4 &&
          storedPath &&
          storedPath.length >= 2 &&
          storedPath.some((sp) => distM(near.lat, near.lon, sp.lat, sp.lon) < 150)
        ) {
          continue;
        }
        if (near && distM(baseLat, baseLon, near.lat, near.lon) > 50) {
          console.debug(`[neutral] neargoal id=${r.id}`);
          const routed = await routeInDong(dong, baseLat, baseLon, near.lat, near.lon, r.id);
          if (routed && routed.length >= 2) {
            fresh = routed;
          }
        }
      }
    }
    console.debug(`[neutral] newroute id=${r.id} pts=${fresh ? fresh.length : 0}`);
    if (fresh && fresh.length >= 2) {
      storedPath = fresh;
      pathJson = JSON.stringify(fresh);
      pathIdx = 0;
      finalLeg = nextLegDest(fresh, baseLat, baseLon);
      finalDest = finalLeg ? finalLeg.dest : null;
      if (finalLeg) {
        pathIdx = finalLeg.idx;
      }
    } else {
      // 전부 실패: 동 경계 구석에 갇힌 상태. 스폰 앵커 근처로 재배치한다.
      const fixed = await snapInDong(dong, anchorLat, anchorLon, WANDER_RADIUS_M);
      if (fixed) {
        console.debug(`[neutral] relocate id=${r.id}`);
        baseLat = fixed.lat;
        baseLon = fixed.lon;
        storedPath = null;
        pathJson = null;
        pathIdx = 0;
      } else {
        // 재배치마저 실패하면旧 경로를 버리고 제자리 대기한다.
        // 旧 경로를 유지하면 다음 다리에서 역방향으로 되돌아간다.
        storedPath = null;
        pathJson = null;
        pathIdx = 0;
      }
    }
  }
  const dest = finalDest ?? { lat: baseLat, lon: baseLon };
  const waitMs = finalDest ? 0 : 60_000;
  const legMs = Math.max(
    10_000,
    (distM(baseLat, baseLon, dest.lat, dest.lon) / NEUTRAL_UNIT_SPEED_MPS) * 1000,
  );
  return {
    baseLat,
    baseLon,
    destLat: dest.lat,
    destLon: dest.lon,
    pathJson,
    pathIdx,
    waitMs,
    legMs,
    expectLegEndsAt: r.legEndsAt,
  };
};

/** 락 밖에서 실행: 스폰 계획을 세운다 (라우팅 포함, DB 쓰기 없음). 조건 불충족이면 null. */
const planNeutralSpawn = async (
  rows: TerritoryNeutralUnit[],
  dong: string,
  nearLat: number,
  nearLon: number,
  now: number,
  ctx: NeutralPlanContext,
): Promise<NeutralSpawnPlan | null> => {
  const newest = rows.length > 0 ? rows[rows.length - 1] : null;
  if (
    rows.length >= capForDong(dong) ||
    (newest && now - Number(newest.createdAt) < NEUTRAL_UNIT_SPAWN_INTERVAL_MS)
  ) {
    return null;
  }
  // 스폰 지점: 해당 동의 중립성 중 랜덤 1곳에서 가장 가까운 이동가능영역 위.
  // (중립성 주변 200m에 도로가 없으면 요청 지점 기준으로 폴백한다.)
  const offices = getOfficesInDong(dong);
  const base =
    offices.length > 0
      ? (offices[Math.floor(Math.random() * offices.length)] ?? { lat: nearLat, lon: nearLon })
      : { lat: nearLat, lon: nearLon };
  const at =
    (await snapInDong(dong, base.lat, base.lon, SPAWN_RADIUS_M)) ??
    (offices.length > 0 ? await snapInDong(dong, nearLat, nearLon, SPAWN_RADIUS_M) : null);
  if (!at) {
    return null;
  }
  const quiz = pickQuiz();
  // 목적지: 동 내부에서 모든 무법자와 가장 먼 이동가능영역 (규칙 4).
  // 경로: 부대 이동 알고리즘 그대로 (규칙 3). 후보 순서대로 경로 성공할 때까지 시도한다.
  // 스폰 시에도 기존 부대 경로와 겹치지 않게 + 후보를 분산·셔플한다 (일렬종대 방지).
  const spawnedGoals = shuffleGoals(
    spreadGoals(
      filterAwayFromPaths(
        await pickFarthestDest(dong, neutralOthersOf(rows, ctx)),
        null,
        otherStoredPaths(rows, ctx.parsePath),
      ),
    ),
  );
  let path: Array<{ lat: number; lon: number }> | null = null;
  for (const goal of spawnedGoals) {
    path = await routeInDong(dong, at.lat, at.lon, goal.lat, goal.lon);
    if (path && path.length >= 2) {
      break;
    }
    path = null;
  }
  const firstLeg = path ? nextLegDest(path, at.lat, at.lon) : null;
  const dest = firstLeg ? firstLeg.dest : at;
  return {
    at: { lat: at.lat, lon: at.lon },
    dest: { lat: dest.lat, lon: dest.lon },
    pathJson: path ? JSON.stringify(path) : null,
    pathIdx: firstLeg ? firstLeg.idx : 0,
    quizKey: quiz.key,
    quizTitle: quiz.title.slice(0, 255),
  };
};
/** 출제 가능한 퀴즈 키 형식 (아니면 락 안에서 치유 대상). */
const PLAYABLE_QUIZ_KEY_RE = /^Quiz\/[^/]+\.(csv|json)$/i;

/** 동 하나에서 동시에 세우는 다리 계획 수 상한. */
const LEG_PLAN_CONCURRENCY = 3;

/** DB 행 → 응답 뷰. */
const toNeutralView = (
  r: TerritoryNeutralUnit,
  pos: { lat: number; lon: number; arrived: boolean },
  parsePath: PathParser,
): NeutralUnitView => ({
  id: r.id,
  dong: r.dong,
  lat: pos.lat,
  lon: pos.lon,
  fromLat: r.lat,
  fromLon: r.lon,
  destLat: r.destLat,
  destLon: r.destLon,
  startedAt: Number(r.legStartedAt),
  endsAt: Number(r.legEndsAt),
  moving: !pos.arrived,
  quizKey: r.quizKey,
  quizTitle: r.quizTitle,
  path: parsePath(r.path),
  pathIdx: r.path ? r.pathIdx : 0,
});

export const listNeutralUnits = async (
  dong: string,
  nearLat: number,
  nearLon: number,
): Promise<NeutralUnitView[]> => {
  const now = Date.now();
  const code = dong.trim();
  if (!code || !Number.isFinite(nearLat) || !Number.isFinite(nearLon)) {
    return [];
  }
  const startedAt = Date.now();
  const logIfSlow = (): void => {
    // 200ms 초과 시에만 서버 로그에 남긴다 (성능 감시용).
    const elapsed = Date.now() - startedAt;
    if (elapsed > 200) {
      console.log(`[perf] neutral slow dong=${code} ${elapsed}ms`);
    }
  };
  // 1단계(락 밖): 스냅샷 조회 + 라우팅 포함 계획 수립.
  const snapshot = await prisma.territoryNeutralUnit.findMany({
    where: { dong: code },
    orderBy: { createdAt: "asc" },
  });
  const ctx = makePlanContext(now);
  // 계획들은 모두 같은 스냅샷만 읽고 서로의 결과에 의존하지 않으므로 동시에 세운다 (상한 3).
  const expired = snapshot.filter((r) => now >= Number(r.legEndsAt));
  const [spawnPlan, legPlanList] = await Promise.all([
    planNeutralSpawn(snapshot, code, nearLat, nearLon, now, ctx),
    mapConcurrent(expired, LEG_PLAN_CONCURRENCY, (r) => planNeutralLeg(r, snapshot, code, ctx)),
  ]);
  const legPlans = new Map<number, NeutralLegPlan>();
  expired.forEach((r, i) => {
    const plan = legPlanList[i];
    if (plan) {
      legPlans.set(r.id, plan);
    }
  });
  // 빠른 경로: 락 안에서 쓸 일이 전혀 없으면(스폰·다리 연결·상한 정리·퀴즈 키 치유 모두 해당 없음)
  // 트랜잭션·advisory lock 없이 스냅샷으로 응답한다. 락 안 경로도 이 경우 쓰기 없이 같은 뷰를 만든다.
  const canSkipLock =
    spawnPlan === null &&
    legPlans.size === 0 &&
    snapshot.length <= capForDong(code) &&
    snapshot.every((r) => PLAYABLE_QUIZ_KEY_RE.test(r.quizKey));
  if (canSkipLock) {
    const views = snapshot.map((r) => toNeutralView(r, ctx.positionOf(r), ctx.parsePath));
    logIfSlow();
    return views;
  }
  // 2단계(락 안): 검증 후 적용만 — 수십 초 걸리던 라우팅이 빠져 락 점유가 ms 단위다.
  return withNamedLock(`neutral:${code}`, async (tx) => {
    const rows = await tx.territoryNeutralUnit.findMany({
      where: { dong: code },
      orderBy: { createdAt: "asc" },
    });
    // 기존 행 중 출제 불가 키(JSON 등)는 playable CSV로 교체한다 (치유 1회성).
    for (const r of rows) {
      if (PLAYABLE_QUIZ_KEY_RE.test(r.quizKey)) {
        continue;
      }
      const quiz = pickQuiz();
      if (!quiz.key) {
        continue;
      }
      await tx.territoryNeutralUnit.update({
        where: { id: r.id },
        data: { quizKey: quiz.key, quizTitle: quiz.title.slice(0, 255), updatedAt: BigInt(now) },
      });
      r.quizKey = quiz.key;
      r.quizTitle = quiz.title.slice(0, 255);
    }
    // 상한 초과분 정리: 상한이 낮아지면 초과 개체를 임의로 삭제한다.
    // 다이얼로그로 일시정지된 개체(보고 있는 개체)는 가능한 한 남긴다.
    const cap = capForDong(code);
    if (rows.length > cap) {
      const isHeld = (r: TerritoryNeutralUnit): boolean =>
        r.lat === r.destLat && r.lon === r.destLon && Number(r.legEndsAt) > now;
      const order = rows
        .map((r) => ({ r, key: (isHeld(r) ? 1 : 0) + Math.random() }))
        .sort((a, b) => a.key - b.key);
      const doomed = new Set(order.slice(0, rows.length - cap).map((o) => o.r.id));
      await tx.territoryNeutralUnit.deleteMany({ where: { id: { in: [...doomed] } } });
      console.log(`[neutral] trimmed dong=${code} removed=${doomed.size} cap=${cap}`);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row && doomed.has(row.id)) {
          rows.splice(i, 1);
        }
      }
    }
    // 스폰: 계획이 있으면 최신 스냅샷 기준으로 재검증 후 생성한다.
    if (spawnPlan) {
      const newest = rows.length > 0 ? rows[rows.length - 1] : null;
      if (
        rows.length < capForDong(code) &&
        (!newest || now - Number(newest.createdAt) >= NEUTRAL_UNIT_SPAWN_INTERVAL_MS)
      ) {
        const legMs = Math.max(
          10_000,
          (distM(spawnPlan.at.lat, spawnPlan.at.lon, spawnPlan.dest.lat, spawnPlan.dest.lon) /
            NEUTRAL_UNIT_SPEED_MPS) *
            1000,
        );
        const created = await tx.territoryNeutralUnit.create({
          data: {
            dong: code,
            anchorLat: spawnPlan.at.lat,
            anchorLon: spawnPlan.at.lon,
            lat: spawnPlan.at.lat,
            lon: spawnPlan.at.lon,
            destLat: spawnPlan.dest.lat,
            destLon: spawnPlan.dest.lon,
            legStartedAt: BigInt(now),
            legEndsAt: BigInt(now + Math.round(legMs)),
            quizKey: spawnPlan.quizKey,
            quizTitle: spawnPlan.quizTitle.slice(0, 255),
            createdAt: BigInt(now),
            updatedAt: BigInt(now),
            path: spawnPlan.pathJson,
            pathIdx: spawnPlan.pathIdx,
          },
        });
        rows.push(created);
      }
    }
    // 배회: 락 밖에서 세운 계획을 검증 후 적용한다.
    // 다른 폴링이 먼저 다리를 연결했으면(legEndsAt 변경) 이번 계획은 버린다.
    for (const r of rows) {
      const plan = legPlans.get(r.id);
      if (!plan || Number(r.legEndsAt) !== Number(plan.expectLegEndsAt)) {
        continue;
      }
      const ended = now + Math.round(plan.legMs) + plan.waitMs;
      await tx.territoryNeutralUnit.update({
        where: { id: r.id },
        data: {
          lat: plan.baseLat,
          lon: plan.baseLon,
          destLat: plan.destLat,
          destLon: plan.destLon,
          legStartedAt: BigInt(now),
          legEndsAt: BigInt(ended),
          updatedAt: BigInt(now),
          path: plan.pathJson,
          pathIdx: plan.pathIdx,
        },
      });
      r.lat = plan.baseLat;
      r.lon = plan.baseLon;
      r.destLat = plan.destLat;
      r.destLon = plan.destLon;
      r.legStartedAt = BigInt(now);
      r.legEndsAt = BigInt(ended);
      r.path = plan.pathJson;
      r.pathIdx = plan.pathIdx;
    }
    // 락 안에서 행이 갱신됐을 수 있으므로 위치는 메모 없이 다시 계산한다 (path 파싱 메모는 원문 키라 안전).
    return rows.map((r) => toNeutralView(r, rowPositionAt(r, now, ctx.parsePath), ctx.parsePath));
  }).finally(logIfSlow);
};
