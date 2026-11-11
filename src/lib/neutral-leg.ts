import { positionAtMoveTarget } from "@/lib/units";

/**
 * 무법자 다리(leg) 기하 — 클라이언트 애니메이션과 서버 위치 계산이 같은 식을 쓰도록 공유한다.
 * 다리는 저장 경로(path) 위를 따라 걷는다. 출발→목적지 직선 보간을 쓰면 꺾인 길에서
 * 코너를 가로질러 이동가능영역 밖(숲·건물) 위치가 나온다.
 */

const kxOf = (lat: number): number => 111320 * Math.cos((lat * Math.PI) / 180);

/** 근거리 거리(m) 근사 (등장방형). */
const approxDistM = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
  Math.hypot((bLon - aLon) * kxOf((aLat + bLat) / 2), (bLat - aLat) * 110540);

/**
 * 무법자 이동 구간 추출: 저장된 전체 경로 중 현재 다리(from→dest)에 해당하는
 * 부분만 잘라낸다. 정점이 아닌 구간(segment) 기준으로 가장 가까운 점을 찾아
 * 다리 중간 보간점이 정점에서 멀어도 경로 위로 인식한다.
 * (반환값은 [from, ...경로..., dest] 순서의 폴리선이다.)
 */
export const neutralLegSubpath = (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  path: Array<{ lat: number; lon: number }> | null | undefined,
  pathIdx?: number | null,
): Array<{ lat: number; lon: number }> => {
  const fallback = [{ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }];
  if (!Array.isArray(path) || path.length === 0) {
    return fallback;
  }
  const isPt = (p: { lat: number; lon: number } | undefined): p is { lat: number; lon: number } =>
    !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  /** 점에서 구간 a→b까지의 최단거리(m). b가 없으면 정점 a까지의 거리. */
  const distToSeg = (lat: number, lon: number, i: number): number => {
    const a = path[i];
    if (!isPt(a)) {
      return Number.POSITIVE_INFINITY;
    }
    const b = path[i + 1];
    const kx = kxOf(a.lat);
    if (!isPt(b)) {
      return Math.hypot((lon - a.lon) * kx, (lat - a.lat) * 110540);
    }
    const dx = (b.lon - a.lon) * kx;
    const dy = (b.lat - a.lat) * 110540;
    const len2 = dx * dx + dy * dy;
    const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((lon - a.lon) * kx * dx + (lat - a.lat) * 110540 * dy) / len2));
    return Math.hypot((a.lon + (b.lon - a.lon) * t - lon) * kx, (a.lat + (b.lat - a.lat) * t - lat) * 110540);
  };
  // 서버 진행 인덱스: 목적지는 구간 path[pathIdx-1] → path[pathIdx] 위에 있다.
  // 같은 길을 두 번 지나는 경로(왕복·루프)에서 엉뚱한 회차를 잡지 않도록
  // 목적지 구간을 고정하고, 출발 구간은 그 이전에서만 찾는다.
  const knownEndSeg =
    typeof pathIdx === "number" &&
    Number.isInteger(pathIdx) &&
    pathIdx >= 1 &&
    pathIdx < path.length &&
    distToSeg(toLat, toLon, pathIdx - 1) <= 5
      ? pathIdx - 1
      : null;
  // 출발점이 놓인 구간 (정점이 아닌 구간까지의 최단거리 기준, 동거리면 목적지에 가까운 뒤쪽 구간).
  let bestSeg = -1;
  let bestD = Number.POSITIVE_INFINITY;
  const fromSearchEnd = knownEndSeg ?? path.length - 1;
  for (let i = 0; i <= fromSearchEnd; i += 1) {
    const d = distToSeg(fromLat, fromLon, i);
    if (d < bestD - 0.5 || (knownEndSeg !== null && Math.abs(d - bestD) <= 0.5)) {
      bestD = Math.min(d, bestD);
      bestSeg = i;
    }
  }
  if (bestSeg < 0) {
    return fallback;
  }
  // 시작점이 경로에서 너무 멀면(잔재 경로) 직선으로 폴백한다.
  if (!(bestD <= 100)) {
    return fallback;
  }
  // 목적지가 놓인 구간 (서버 인덱스가 있으면 그대로, 없으면 출발 구간 이후에서 동거리면 앞선 구간).
  let endSeg = knownEndSeg ?? bestSeg;
  if (knownEndSeg === null) {
    let bd = Number.POSITIVE_INFINITY;
    for (let i = bestSeg; i < path.length; i += 1) {
      const d = distToSeg(toLat, toLon, i);
      if (d < bd - 0.5) {
        bd = d;
        endSeg = i;
      }
    }
  }
  // 출발점·목적지는 대개 구간 "중간"에 있다. 출발 구간의 시작 정점(bestSeg)이나
  // 목적지 구간의 끝 정점(endSeg+1)을 넣으면 뒤로 갔다가 되돌아오는 역주행이 생기므로
  // 그 사이 정점(bestSeg+1 .. endSeg)만 잇는다.
  const sub: Array<{ lat: number; lon: number }> = [{ lat: fromLat, lon: fromLon }];
  for (let i = bestSeg + 1; i <= endSeg; i += 1) {
    const p = path[i];
    if (!isPt(p)) {
      continue;
    }
    const last = sub[sub.length - 1];
    if (last && approxDistM(last.lat, last.lon, p.lat, p.lon) < 1) {
      continue;
    }
    sub.push({ lat: p.lat, lon: p.lon });
  }
  const last = sub[sub.length - 1];
  if (!last || approxDistM(last.lat, last.lon, toLat, toLon) >= 1) {
    sub.push({ lat: toLat, lon: toLon });
  }
  return sub.length >= 2 ? sub : fallback;
};

/** 무법자 다리 상태 (DB 행 또는 API 응답에서 추린 값). */
export interface NeutralLegState {
  fromLat: number;
  fromLon: number;
  destLat: number;
  destLon: number;
  startedAt: number;
  endsAt: number;
  path: Array<{ lat: number; lon: number }> | null | undefined;
  pathIdx?: number | null;
}

/** 시각 기준 무법자 위치 (저장 경로를 따라 등속 보간). 화면 애니메이션과 같은 결과를 낸다. */
export const neutralPositionAt = (
  leg: NeutralLegState,
  now: number,
): { lat: number; lon: number; arrived: boolean } => {
  if (now >= leg.endsAt || leg.endsAt <= leg.startedAt) {
    return { lat: leg.destLat, lon: leg.destLon, arrived: true };
  }
  const sub = neutralLegSubpath(leg.fromLat, leg.fromLon, leg.destLat, leg.destLon, leg.path, leg.pathIdx);
  return positionAtMoveTarget(
    {
      fromLat: leg.fromLat,
      fromLon: leg.fromLon,
      lat: leg.destLat,
      lon: leg.destLon,
      startedAt: leg.startedAt,
      endsAt: leg.endsAt,
      via: null,
      path: sub,
    },
    now,
  );
};

/**
 * 점을 저장 경로 위 가장 가까운 지점으로 투영한다.
 * maxSeg가 있으면 그 구간(path[maxSeg]→path[maxSeg+1])까지만 찾는다 (루프 경로에서 앞쪽 회차로 점프 방지).
 * 동거리면 뒤쪽 구간을 택한다. 반환 pathIdx는 투영점이 놓인 구간의 끝 정점 인덱스(서버 pathIdx 의미와 같음).
 */
export const projectOntoPath = (
  lat: number,
  lon: number,
  path: Array<{ lat: number; lon: number }> | null | undefined,
  maxSeg?: number | null,
): { lat: number; lon: number; distM: number; pathIdx: number } | null => {
  if (!Array.isArray(path) || path.length < 2) {
    return null;
  }
  const last = typeof maxSeg === "number" && Number.isInteger(maxSeg) ? Math.min(maxSeg, path.length - 2) : path.length - 2;
  let best: { lat: number; lon: number; distM: number; pathIdx: number } | null = null;
  for (let i = 0; i <= last; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) {
      continue;
    }
    const kx = kxOf(a.lat);
    const dx = (b.lon - a.lon) * kx;
    const dy = (b.lat - a.lat) * 110540;
    const len2 = dx * dx + dy * dy;
    const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((lon - a.lon) * kx * dx + (lat - a.lat) * 110540 * dy) / len2));
    const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    const d = Math.hypot((p.lon - lon) * kx, (p.lat - lat) * 110540);
    if (!best || d <= best.distM + 0.5) {
      if (!best || d < best.distM - 0.5 || i + 1 > best.pathIdx) {
        best = { ...p, distM: d, pathIdx: i + 1 };
      }
    }
  }
  return best;
};

/** 경로 밖으로 벗어난 위치를 경로 위로 되돌리는 허용 거리(m). 이보다 멀면 잔재 경로로 보고 손대지 않는다. */
export const NEUTRAL_PATH_SNAP_MAX_M = 40;
