/**
 * 서버 통합 그래프 라우팅 (2계층).
 * L1: index bbox + adjacency로 경로 주변 동 집합 선정.
 * L2: 해당 동 그래프만 HTTP 로드 후 기존 searchGraphs로 스티칭 + A*.
 * fs 직접 참조 금지 (public 전체가 람다에 포함되면 262MB 제한 초과) — HTTP + 메모리 캐시.
 */

import { gunzipSync } from "zlib";

import { Prisma } from "@/generated/prisma/client";
import { createComponentSnapper, parseGraphData, searchGraphs, type ComponentSnapper, type GraphData } from "@/lib/walkable-graph";
import { ensureDongRaster, isWalkableServer } from "@/lib/server-walkable";
import prisma from "@/lib/prismadb";

let graphBaseUrl = "";
const graphMemCache = new Map<string, GraphData | null>();
const GRAPH_MEM_LIMIT = 400;

let indexCache: Record<string, [number, number, number, number]> | null = null;
let adjacencyCache: Record<string, string[]> | null = null;

const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const kx = 111320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  return Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 110540);
};

/** 현 bbox와 겹치는 동 id 목록 (물 횡단 검사용). */
const dongsInBbox = (minLat: number, minLon: number, maxLat: number, maxLon: number): string[] => {
  if (!indexCache) {
    return [];
  }
  const out: string[] = [];
  for (const [dong, bbox] of Object.entries(indexCache)) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      continue;
    }
    const [dMinLon, dMinLat, dMaxLon, dMaxLat] = bbox as [number, number, number, number];
    if (dMaxLon < minLon || dMinLon > maxLon || dMaxLat < minLat || dMinLat > maxLat) {
      continue;
    }
    out.push(dong);
  }
  return out;
};

/** 현 판정: "water" = 확정 비도로, "unknown" = 전부 미로드, "ok" = 통과. */
const chordWaterCheck = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  dongs: string[]
): "water" | "unknown" | "ok" => {
  const kx = 111320 * Math.cos((a.lat * Math.PI) / 180);
  const total = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
  const steps = Math.max(1, Math.ceil(total / 10));
  let seen = false;
  for (let s = 0; s <= steps; s += 1) {
    const lat = a.lat + ((b.lat - a.lat) * s) / steps;
    const lon = a.lon + ((b.lon - a.lon) * s) / steps;
    for (const dong of dongs) {
      const v = isWalkableServer(dong, lat, lon);
      if (v === false) {
        return "water";
      }
      if (v === true) {
        seen = true;
      }
    }
  }
  return seen ? "ok" : "unknown";
};

/**
 * 물 인식 RDP 솎음. 기하 오차 내 점도 제거 후 현이 물을 밟으면 유지한다.
 * 래스터가 필요하므로 호출 전 setRasterBaseUrl이 주입돼 있어야 한다.
 */
const rdpThinWaterAware = async (
  points: Array<{ lat: number; lon: number }>,
  epsM: number,
): Promise<Array<{ lat: number; lon: number }>> => {
  if (points.length <= 2) {
    return points;
  }
  const kx = 111320 * Math.cos((points[0]?.lat ?? 36) * Math.PI / 180);
  const perpM = (p: { lat: number; lon: number }, a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
    const bx = (b.lon - a.lon) * kx;
    const by = (b.lat - a.lat) * 110540;
    const len2 = bx * bx + by * by;
    if (len2 === 0) {
      return Math.hypot((p.lon - a.lon) * kx, (p.lat - a.lat) * 110540);
    }
    const t = Math.max(0, Math.min(1, ((p.lon - a.lon) * kx * bx + (p.lat - a.lat) * 110540 * by) / len2));
    return Math.hypot((p.lon - a.lon) * kx - bx * t, (p.lat - a.lat) * 110540 - by * t);
  };
  // RDP 대상 구간의 동 래스터를 미리 로드한다.
  let minLat = 90;
  let minLon = 180;
  let maxLat = -90;
  let maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const rasterDongs = dongsInBbox(minLat, minLon, maxLat, maxLon).slice(0, 400);
  await Promise.all(rasterDongs.map((d) => ensureDongRaster(d)));
  const keep = new Set<number>([0, points.length - 1]);
  let waterKept = 0;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop() as [number, number];
    const a = points[s] as { lat: number; lon: number };
    const b = points[e] as { lat: number; lon: number };
    let dmax = 0;
    let imax = -1;
    for (let i = s + 1; i < e; i += 1) {
      const d = perpM(points[i] as { lat: number; lon: number }, a, b);
      if (d > dmax) {
        dmax = d;
        imax = i;
      }
    }
    if (imax === -1 || dmax <= epsM) {
      // 기하 오차 내 — 제거해도 되는 후보. 물 밟으면 유지한다.
      const segDongs = dongsInBbox(
        Math.min(a.lat, b.lat),
        Math.min(a.lon, b.lon),
        Math.max(a.lat, b.lat),
        Math.max(a.lon, b.lon),
      ).slice(0, 50);
      await Promise.all(segDongs.map((d) => ensureDongRaster(d)));
      const check = chordWaterCheck(a, b, segDongs);
      if (check !== "ok") {
        waterKept += 1;
        keep.add(imax === -1 ? s : imax);
        if (imax !== -1) {
          stack.push([s, imax], [imax, e]);
        }
        continue;
      }
      continue;
    }
    keep.add(imax);
    stack.push([s, imax], [imax, e]);
  }
  console.error(`[server-route] rdp eps=${epsM} in=${points.length} out=${keep.size} waterKept=${waterKept}`);
  return points.filter((_, i) => keep.has(i));
};

/** 라우트 핸들러에서 origin을 주입한다. */
export const setGraphBaseUrl = (origin: string): void => {
  graphBaseUrl = origin.replace(/\/$/, "");
};

const fetchJson = async (url: string): Promise<unknown | null> => {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
};

const ensureIndex = async (): Promise<boolean> => {
  if (indexCache && adjacencyCache) {
    return true;
  }
  if (!graphBaseUrl) {
    return false;
  }
  const [indexData, adjacencyData] = await Promise.all([
    fetchJson(`${graphBaseUrl}/walkable/index.json`),
    fetchJson(`${graphBaseUrl}/walkable/adjacency.json`),
  ]);
  if (!indexData || typeof indexData !== "object" || !adjacencyData || typeof adjacencyData !== "object") {
    return false;
  }
  indexCache = indexData as Record<string, [number, number, number, number]>;
  adjacencyCache = adjacencyData as Record<string, string[]>;
  return true;
};

const loadServerGraphDong = async (dongId: string): Promise<GraphData | null> => {
  const hit = graphMemCache.get(dongId);
  if (hit !== undefined) {
    return hit;
  }
  const found = await loadServerGraphMany([dongId]);
  return found.get(dongId) ?? null;
};

// 동시 라우팅(무법자 계획 병렬화)에서 같은 동 그래프를 중복 조회하지 않도록 진행 중 로드를 공유한다.
const graphInflight = new Map<string, Promise<Map<string, GraphData | null>>>();

/** DB 베이크 우선, 실패 시 HTTP 폴백 (일괄 조회 1회). */
const loadServerGraphMany = async (dongIds: string[]): Promise<Map<string, GraphData | null>> => {
  const out = new Map<string, GraphData | null>();
  const missing = dongIds.filter((id) => {
    const hit = graphMemCache.get(id);
    if (hit !== undefined) {
      out.set(id, hit);
      return false;
    }
    return true;
  });
  if (missing.length === 0) {
    return out;
  }
  const waiting = missing.filter((id) => graphInflight.has(id));
  const toLoad = missing.filter((id) => !graphInflight.has(id));
  if (toLoad.length > 0) {
    const job = fetchServerGraphBatch(toLoad);
    for (const id of toLoad) {
      graphInflight.set(id, job);
    }
    try {
      const loaded = await job;
      for (const [id, g] of loaded) {
        out.set(id, g);
      }
    } finally {
      for (const id of toLoad) {
        if (graphInflight.get(id) === job) {
          graphInflight.delete(id);
        }
      }
    }
  }
  await Promise.all(
    waiting.map(async (id) => {
      const job = graphInflight.get(id);
      const loaded = job ? await job : null;
      out.set(id, loaded?.get(id) ?? graphMemCache.get(id) ?? null);
    }),
  );
  return out;
};

/** 캐시에 없는 동 그래프를 실제로 조회한다 (DB 우선, 실패 시 HTTP). 실패는 null로 채운다. */
const fetchServerGraphBatch = async (missing: string[]): Promise<Map<string, GraphData | null>> => {
  const out = new Map<string, GraphData | null>();
  let dbOk = false;
  try {
    const rows = await prisma.$queryRaw<Array<{ dong: string; data: Uint8Array }>>`
      SELECT dong, data FROM route_dong_graphs WHERE dong IN (${Prisma.join(missing)})`;
    for (const row of rows) {
      try {
        const raw = gunzipSync(Buffer.from(row.data)).toString("utf8");
        graphMemCache.set(row.dong, parseGraphData(JSON.parse(raw) as unknown));
      } catch {
        graphMemCache.set(row.dong, null);
      }
    }
    dbOk = true;
  } catch {
    dbOk = false;
  }
  if (dbOk) {
    for (const id of missing) {
      if (!graphMemCache.has(id)) {
        graphMemCache.set(id, null);
      }
    }
  } else {
    // DB 실패 시 기존 HTTP 방식으로 개별 폴백.
    await Promise.all(
      missing.map(async (id) => {
        let parsed: GraphData | null = null;
        try {
          const res = await fetch(`${graphBaseUrl}/walkable/graph/${encodeURIComponent(id)}.json`, {
            cache: "force-cache",
          });
          if (res.ok) {
            parsed = parseGraphData((await res.json()) as unknown);
          }
        } catch {
          parsed = null;
        }
        graphMemCache.set(id, parsed);
      }),
    );
  }
  while (graphMemCache.size > GRAPH_MEM_LIMIT) {
    const oldest = graphMemCache.keys().next();
    if (oldest.done) {
      break;
    }
    graphMemCache.delete(oldest.value);
  }
  for (const id of missing) {
    out.set(id, graphMemCache.get(id) ?? null);
  }
  return out;
};

/** 점 주변 반경과 겹치는 동 id 목록. */
const dongsNear = (lat: number, lon: number, radiusM: number): string[] => {
  if (!indexCache) {
    return [];
  }
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLon = radiusM / Math.max(1, kx);
  const dLat = radiusM / 110540;
  const out: string[] = [];
  for (const [dong, bbox] of Object.entries(indexCache)) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      continue;
    }
    const [dMinLon, dMinLat, dMaxLon, dMaxLat] = bbox as [number, number, number, number];
    if (dMaxLon < lon - dLon || dMinLon > lon + dLon || dMaxLat < lat - dLat || dMinLat > lat + dLat) {
      continue;
    }
    out.push(dong);
  }
  return out;
};

/** 경로 직선 주변(여유 버퍼) bbox와 겹치는 동 id 목록. */
const corridorDongs = (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  bufferM: number,
): string[] => {
  if (!indexCache) {
    return [];
  }
  const meanLat = (fromLat + toLat) / 2;
  const kx = 111320 * Math.cos((meanLat * Math.PI) / 180);
  const bufLon = bufferM / Math.max(1, kx);
  const bufLat = bufferM / 110540;
  const minLon = Math.min(fromLon, toLon) - bufLon;
  const maxLon = Math.max(fromLon, toLon) + bufLon;
  const minLat = Math.min(fromLat, toLat) - bufLat;
  const maxLat = Math.max(fromLat, toLat) + bufLat;
  const out: string[] = [];
  for (const [dong, bbox] of Object.entries(indexCache)) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      continue;
    }
    const [dMinLon, dMinLat, dMaxLon, dMaxLat] = bbox as [number, number, number, number];
    if (dMaxLon < minLon || dMinLon > maxLon || dMaxLat < minLat || dMinLat > maxLat) {
      continue;
    }
    out.push(dong);
  }
  return out;
};

export type ServerRouteResult =
  | { ok: true; path: Array<{ lat: number; lon: number }>; dongs: number; legs: LegReport[]; totalMs: number }
  | { ok: false; reason: string; legs: LegReport[]; totalMs: number };

export type LegReport = {
  li: number;
  aLat: number;
  aLon: number;
  bLat: number;
  bLon: number;
  dongs: number;
  ms: number;
  hit: boolean;
};

/**
 * 서버 통합 그래프 라우팅. 성공 시 상세 경로, 실패 시 reason.
 * 버퍼를 넓혀 재시도하는 것은 호출자(클라이언트 폴백)가 담당한다.
 */
export const findServerRoute = async (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): Promise<ServerRouteResult> => {
  if (!graphBaseUrl) {
    console.error("[server-route] FAIL reason=no_base_url");
    return { ok: false, reason: "no_base_url", legs: [], totalMs: 0 };
  }
  if (!(await ensureIndex())) {
    console.error("[server-route] FAIL reason=index_load_failed");
    return { ok: false, reason: "index_load_failed", legs: [], totalMs: 0 };
  }
  // 다리별 탐색: 전 구간 한 번에 A*를 돌리면 확장 상한(20만)에 걸려 실패한다.
  // 5km 다리로 나눠 풀고 잇는다 (클라이언트 다구간 체인과 같은 방식).
  const straightM = distM(fromLat, fromLon, toLat, toLon);
  const legCount = Math.min(120, Math.max(1, Math.ceil(straightM / 5000)));
  const legs: Array<{ lat: number; lon: number }> = [];
  for (let i = 1; i < legCount; i += 1) {
    legs.push({
      lat: fromLat + ((toLat - fromLat) * i) / legCount,
      lon: fromLon + ((toLon - fromLon) * i) / legCount,
    });
  }
  // 중간 분할점을 거대 도로망 위로 스냅한다 (산속 직선점 방지, 1km 이내).
  // 최종 목적지는 원본 유지, 중간점만 스냅 실패 시 원본 유지.
  let jointSnapper: ComponentSnapper | null = null;
  let snapperDongs = 0;
  try {
    const snapDongSet = new Set<string>();
    for (const leg of legs) {
      const cur = leg as { lat: number; lon: number };
      for (const d of dongsNear(cur.lat, cur.lon, 1500)) {
        snapDongSet.add(d);
        if (snapDongSet.size >= 600) {
          break;
        }
      }
      if (snapDongSet.size >= 600) {
        break;
      }
    }
    const snapDongs = [...snapDongSet];
    if (snapDongs.length > 0) {
      const snapLoaded = await loadServerGraphMany(snapDongs);
      const snapGraphs = snapDongs.map((d) => snapLoaded.get(d) ?? null);
      // 스티칭 1회로 스내퍼 생성 후 모든 중간점에 재사용한다.
      snapperDongs = snapDongs.length;
      jointSnapper = createComponentSnapper(snapGraphs);
      if (jointSnapper) {
        for (let i = 0; i < legs.length; i += 1) {
          const cur = legs[i] as { lat: number; lon: number };
          const snapped = jointSnapper.snap(cur.lat, cur.lon, 1000);
          if (snapped) {
            legs[i] = snapped;
          }
        }
      }
    }
  } catch {
    // 스냅 실패해도 원본 직선점으로 계속한다.
  }
  const joints = [{ lat: fromLat, lon: fromLon }, ...legs, { lat: toLat, lon: toLon }];
  let full: Array<{ lat: number; lon: number }> = [];
  let dongsUsed = 0;
  const startedAt = Date.now();
  const legReports: LegReport[] = [];
  const finishFail = (reason: string): ServerRouteResult => {
    const totalMs = Date.now() - startedAt;
    console.error(
      `[server-route] FAIL reason=${reason} legs=${joints.length - 1} done=${legReports.filter((l) => l.hit).length} totalMs=${totalMs} ` +
        legReports.map((l) => `#${l.li}:${l.hit ? "ok" : "miss"}/${l.dongs}d/${l.ms}ms`).join(" "),
    );
    return { ok: false, reason, legs: legReports, totalMs };
  };
  // 전체 데드라인 25초 — 초과 시 실패로 돌려 클라이언트 폴백으로 넘긴다.
  const deadline = Date.now() + 25000;
  const searchOnce = async (
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
    steps: string[],
  ): Promise<Array<{ lat: number; lon: number }> | null> => {
    for (const bufferM of [2000, 5000, 12000]) {
      if (Date.now() > deadline) {
        break;
      }
      const candidates = corridorDongs(a.lat, a.lon, b.lat, b.lon, bufferM);
      if (candidates.length === 0) {
        steps.push(`${bufferM}:0dong`);
        continue;
      }
      const targets = candidates.slice(0, 200);
      dongsUsed = Math.max(dongsUsed, targets.length);
      const tLoad = Date.now();
      const loaded = await loadServerGraphMany(targets);
      const loadMs = Date.now() - tLoad;
      const tSearch = Date.now();
      const found = searchGraphs(
        targets.map((d) => loaded.get(d) ?? null),
        a.lat,
        a.lon,
        b.lat,
        b.lon,
        500,
      );
      const searchMs = Date.now() - tSearch;
      steps.push(`${bufferM}:${targets.length}d/load${loadMs}/search${searchMs}`);
      if (found && found.length >= 2) {
        return found;
      }
    }
    return null;
  };
  // 재귀 분할: 긴 다리가 안 풀리면 중점을 찍어 양분 탐색한다 (깊이 2까지).
  const searchSplit = async (
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
    depth: number,
    steps: string[]
  ): Promise<Array<{ lat: number; lon: number }> | null> => {
    const direct = await searchOnce(a, b, steps);
    if (direct || depth <= 0 || Date.now() > deadline) {
      return direct;
    }
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    const first = await searchSplit(a, mid, depth - 1, steps);
    if (!first) {
      return null;
    }
    const second = await searchSplit(mid, b, depth - 1, steps);
    if (!second) {
      return null;
    }
    const joined = [...first];
    for (const pt of second.slice(1)) {
      const last = joined[joined.length - 1];
      if (!last || last.lat !== pt.lat || last.lon !== pt.lon) {
        joined.push(pt);
      }
    }
    return joined;
  };
  const solveLeg = async (
    li: number,
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
  ): Promise<Array<{ lat: number; lon: number }> | null> => {
    const legStart = Date.now();
    const dongs = 0;
    const steps: string[] = [];
    const found = await searchSplit(a, b, 2, steps);
    if (found && found.length >= 2) {
      legReports.push({ li, aLat: a.lat, aLon: a.lon, bLat: b.lat, bLon: b.lon, dongs, ms: Date.now() - legStart, hit: true });
      return found;
    }
    console.error(`[server-route] leg miss li=${li} a=${a.lat.toFixed(4)},${a.lon.toFixed(4)} b=${b.lat.toFixed(4)},${b.lon.toFixed(4)} ${steps.join(" ")}`);
    legReports.push({ li, aLat: a.lat, aLon: a.lon, bLat: b.lat, bLon: b.lon, dongs, ms: Date.now() - legStart, hit: false });
    return null;
  };
  const LEG_BATCH = 16;
  for (let bi = 1; bi < joints.length; bi += LEG_BATCH) {
    if (Date.now() > deadline) {
      return finishFail("timeout");
    }
    const batchEnd = Math.min(joints.length, bi + LEG_BATCH);
    const segs = await Promise.all(
      joints.slice(bi, batchEnd).map((b, offset) => {
        const a = joints[bi - 1 + offset] as { lat: number; lon: number };
        return solveLeg(bi + offset, a, b as { lat: number; lon: number });
      }),
    );
    for (const seg of segs) {
      if (!seg) {
        return finishFail("no_path_leg");
      }
      for (const pt of seg) {
        const last = full[full.length - 1];
        if (!last || last.lat !== pt.lat || last.lon !== pt.lon) {
          full.push(pt);
        }
      }
    }
  }
  if (full.length < 2) {
    return finishFail("no_path");
  }
  // 긴 현 세분화: 노드 간격이 넓으면 직선 표시·행군이 래스터 밖으로 벗어난다.
  // 현 중점을 도로망에 스냅해 쪼갠다 (150m 초과 현, 최대 4회 반복, 총 5000점 상한).
  let refineInfo = `snapper=${jointSnapper ? `ok/${snapperDongs}d` : "null"}`;
  // 세분화용 스내퍼: 긴 현 중점 주변 동으로 별도 구축한다.
  // joints 스내퍼는 중간점 주변만 커버해서 현 중점이 빗나가면 스냅 실패한다.
  let refineSnapper: ComponentSnapper | null = jointSnapper;
  try {
    const need = new Set<string>();
    for (let i = 1; i < full.length && need.size < 300; i += 1) {
      const a = full[i - 1] as { lat: number; lon: number };
      const b = full[i] as { lat: number; lon: number };
      if (distM(a.lat, a.lon, b.lat, b.lon) > 150) {
        const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
        for (const d of dongsNear(mid.lat, mid.lon, 1500)) {
          need.add(d);
          if (need.size >= 300) {
            break;
          }
        }
      }
    }
    const needList = [...need].filter((d) => graphMemCache.get(d) === undefined);
    if (needList.length > 0) {
      const loaded = await loadServerGraphMany(needList);
      const graphs = [...need].map((d) => loaded.get(d) ?? graphMemCache.get(d) ?? null);
      refineSnapper = createComponentSnapper(graphs);
      refineInfo += ` refineGraphs=${graphs.length}`;
    }
  } catch {
    // 실패 시 joints 스내퍼로 계속한다.
  }
  if (refineSnapper) {
    const snapper = refineSnapper;
    for (let pass = 0; pass < 4; pass += 1) {
      if (full.length >= 5000) {
        break;
      }
      let split = false;
      const refined: Array<{ lat: number; lon: number }> = [full[0] as { lat: number; lon: number }];
      for (let i = 1; i < full.length; i += 1) {
        const a = refined[refined.length - 1] as { lat: number; lon: number };
        const b = full[i] as { lat: number; lon: number };
        const len = distM(a.lat, a.lon, b.lat, b.lon);
        if (len > 150 && full.length + refined.length < 9000) {
          const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
          const s = snapper.snap(mid.lat, mid.lon, Math.min(500, len / 2));
          if (s && distM(a.lat, a.lon, s.lat, s.lon) + distM(s.lat, s.lon, b.lat, b.lon) < len * 1.5) {
            // 스냅 현(a→s, s→b)이 확정 비도로를 밟으면 기각한다.
            const segDongs = dongsInBbox(
              Math.min(a.lat, s.lat, b.lat),
              Math.min(a.lon, s.lon, b.lon),
              Math.max(a.lat, s.lat, b.lat),
              Math.max(a.lon, s.lon, b.lon),
            ).slice(0, 50);
            await Promise.all(segDongs.map((d) => ensureDongRaster(d)));
            if (
              chordWaterCheck(a, s, segDongs) !== "water" &&
              chordWaterCheck(s, b, segDongs) !== "water"
            ) {
              refined.push(s);
              split = true;
            }
          }
        }
        refined.push(b);
      }
      full = refined;
      if (!split) {
        break;
      }
    }
    refineInfo += ` before=${full.length}`;
    if (full.length > 5000) {
      // 물 인식 RDP로 줄인다 — 물 밟는 현은 제거하지 않는다.
      // 양끝(출발·도착)은 반드시 유지한다 — 잘리면 끝점 검증에 탈락한다.
      for (const eps of [30, 50, 100]) {
        if (full.length <= 5000) {
          break;
        }
        full = await rdpThinWaterAware(full, eps);
      }
      if (full.length > 5000) {
        const step = Math.ceil(full.length / 5000);
        const cut = full.filter((_, i) => i === 0 || i === full.length - 1 || i % step === 0);
        if (cut.length >= 2) {
          full = cut;
        }
      }
    }
  }
  const totalMs = Date.now() - startedAt;
  console.error(
    `[server-route] OK legs=${joints.length - 1} pts=${full.length} dongsMax=${dongsUsed} totalMs=${totalMs} refine(${refineInfo} after=${full.length})`,
  );
  return { ok: true, path: full, dongs: dongsUsed, legs: legReports, totalMs };
};
