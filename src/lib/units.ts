import type { CastleClass } from "@/lib/territory";

/** units 전용 하버사인 (territory.ts와 순환 import 방지). */
function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// 부대 (MissionUser.data.units JSON; legacy data.servants is still supported)
// ---------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type UnitState = "training" | "field" | "garrisoned" | "dead";

export interface UnitHQ {
  lat: number;
  lon: number;
}

/** 진행 중인 이동 지시 (서버 저장, 새로고침·타인 화면에서도 이어진다).
 *  path: 목적지 설정 시 확정된 전체 행군 경로. 서버는 위치를 틱으로 전진시키지 않고
 *  positionAtMoveTarget()으로 시각 기준 결정적 위치를 계산한다 (서버 권위).
 *  구 주문서(path 없음)는 via 경유점 직선 보간으로 fallback한다. */
export interface UnitMoveTarget {
  fromLat: number;
  fromLon: number;
  lat: number;
  lon: number;
  startedAt: number;
  endsAt: number;
  via: Array<{ lat: number; lon: number }> | null;
  path: Array<{ lat: number; lon: number }> | null;
}

export interface Unit {
  id: string;
  name: string;
  lat: number;
  lon: number;
  state: UnitState;
  hq: UnitHQ;
  castleKey: string | null;
  reviveAt: number | null;
  lastMoveAt: number;
  trainingCompleteAt?: number | null;
  moveTarget: UnitMoveTarget | null;
}

interface UnitRecord {
  id: unknown;
  name: unknown;
  lat: unknown;
  lon: unknown;
  state: unknown;
  hq: unknown;
  castleKey: unknown;
  reviveAt: unknown;
  lastMoveAt: unknown;
  trainingCompleteAt: unknown;
  moveTarget: unknown;
}

export const UNIT_RECALL_RADIUS_M = 3000;
export const UNIT_SPEED_MPS = 10 / 3.6; // 10km/h
export const UNIT_IDLE_STOP_MIN = 10;

export const UNIT_CAP_BY_CLASS: Record<CastleClass, number> = {
  slave: 0,
  commoner: 1,
  knight: 2,
  noble: 3,
  lord: 5,
};

/** 본체 최근 7일 최고점 대비 부대 전투력 비율 */
export const UNIT_POWER_BY_CLASS: Record<CastleClass, number> = {
  slave: 0,
  commoner: 0.3,
  knight: 0.4,
  noble: 0.5,
  lord: 0.5,
};

export const UNIT_GARRISON_CAP_PER_CASTLE = 3;
export const UNIT_GARRISON_DEFENSE_EACH = 2;
export const UNIT_GARRISON_COOLDOWN_BONUS_SEC = 900; // 주둔 1명당 공성 쿨다운 연장
export const UNIT_REVIVE_HOURS = 24;
export const UNIT_REVIVE_PAID_COST = 100;
export const UNIT_TRAINING_DURATION_MS = 30 * 60 * 1000;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function normalizeMoveTarget(v: unknown): UnitMoveTarget | null {
  if (typeof v !== "object" || v === null) {
    return null;
  }
  const r = v as Record<string, unknown>;
  if (
    !isFiniteNumber(r.fromLat) ||
    !isFiniteNumber(r.fromLon) ||
    !isFiniteNumber(r.lat) ||
    !isFiniteNumber(r.lon) ||
    !isFiniteNumber(r.startedAt) ||
    !isFiniteNumber(r.endsAt)
  ) {
    return null;
  }
  const via = Array.isArray(r.via)
    ? r.via
        .filter(
          (point: unknown): point is { lat: number; lon: number } =>
            typeof point === "object" &&
            point !== null &&
            isFiniteNumber((point as { lat?: unknown }).lat) &&
            isFiniteNumber((point as { lon?: unknown }).lon),
        )
        .slice(0, 200)
        .map((point) => ({ lat: point.lat, lon: point.lon }))
    : null;
  // 확정 행군 경로 (신 주문서). 점 개수 상한 2000.
  const path = Array.isArray(r.path)
    ? r.path
        .filter(
          (point: unknown): point is { lat: number; lon: number } =>
            typeof point === "object" &&
            point !== null &&
            isFiniteNumber((point as { lat?: unknown }).lat) &&
            isFiniteNumber((point as { lon?: unknown }).lon),
        )
        .slice(0, 2000)
        .map((point) => ({ lat: point.lat, lon: point.lon }))
    : null;
  return {
    fromLat: r.fromLat,
    fromLon: r.fromLon,
    lat: r.lat,
    lon: r.lon,
    startedAt: r.startedAt,
    endsAt: r.endsAt,
    via,
    path: path && path.length > 0 ? path : null,
  };
}

function isValidUnit(v: unknown): v is UnitRecord {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    isFiniteNumber(r.lat) &&
    isFiniteNumber(r.lon) &&
    (r.state === "training" || r.state === "field" || r.state === "garrisoned" || r.state === "dead") &&
    typeof r.hq === "object" &&
    r.hq !== null &&
    isFiniteNumber((r.hq as Record<string, unknown>).lat) &&
    isFiniteNumber((r.hq as Record<string, unknown>).lon) &&
    isFiniteNumber(r.lastMoveAt)
  );
}

export function loadUnits(data: unknown): Unit[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const dataRecord = data as Record<string, unknown>;
  const raw = Array.isArray(dataRecord.units) ? dataRecord.units : dataRecord.servants;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isValidUnit).map((s): Unit => {
    return {
      id: s.id as string,
      name: s.name as string,
      lat: s.lat as number,
      lon: s.lon as number,
      state: s.state as Unit["state"],
      hq: s.hq as UnitHQ,
      castleKey: typeof s.castleKey === "string" ? s.castleKey : null,
      reviveAt: isFiniteNumber(s.reviveAt) ? s.reviveAt : null,
      lastMoveAt: s.lastMoveAt as number,
      trainingCompleteAt: isFiniteNumber(s.trainingCompleteAt) ? s.trainingCompleteAt : null,
      moveTarget: normalizeMoveTarget(s.moveTarget),
    };
  });
}

export function withUnits(
  data: unknown,
  units: Unit[],
): { [key: string]: JsonValue } {
  const base: { [key: string]: JsonValue } =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as { [key: string]: JsonValue }) }
      : {};
  base.units = units as unknown as JsonValue;
  base.servants = units as unknown as JsonValue;
  return base;
}

export function makeUnitId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.floor(Math.random() * 36 ** 6).toString(36);
  return `s-${timePart}${randomPart}`.slice(0, 24);
}

export function activeUnits(units: Unit[]): Unit[] {
  return units.filter((s) => s.state !== "dead");
}

// ---------------------------------------------------------------------------
// 서버 권위 위치 계산: 주문 + 시각 → 결정적 위치 (DB 전진 쓰기 불필요)
// ---------------------------------------------------------------------------

/** 주문의 이동 폴리선 (path 우선, 없으면 via 경유점, 그것도 없으면 직선). */
export function movePolyline(target: UnitMoveTarget): Array<{ lat: number; lon: number }> {
  const line: Array<{ lat: number; lon: number }> = [{ lat: target.fromLat, lon: target.fromLon }];
  const mid = target.path && target.path.length > 0 ? target.path : (target.via ?? []);
  for (const p of mid) {
    const last = line[line.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lon - p.lon) < 1e-9) {
      continue;
    }
    line.push({ lat: p.lat, lon: p.lon });
  }
  const last = line[line.length - 1];
  if (!last || Math.abs(last.lat - target.lat) >= 1e-9 || Math.abs(last.lon - target.lon) >= 1e-9) {
    line.push({ lat: target.lat, lon: target.lon });
  }
  return line;
}

/** 주문 시각 기준 위치. now >= endsAt면 목적지. 이동 중이면 {lat, lon, arrived:false}. */
export function positionAtMoveTarget(
  target: UnitMoveTarget,
  now: number,
): { lat: number; lon: number; arrived: boolean } {
  if (now >= target.endsAt) {
    return { lat: target.lat, lon: target.lon, arrived: true };
  }
  const elapsedSec = Math.max(0, (now - target.startedAt) / 1000);
  if (elapsedSec <= 0) {
    return { lat: target.fromLat, lon: target.fromLon, arrived: false };
  }
  const line = movePolyline(target);
  const totalSec = Math.max(1, (target.endsAt - target.startedAt) / 1000);
  // 전체 소요시간을 폴리선 길이에 비례 배분 (등속 이동).
  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    const len = distM(a.lat, a.lon, b.lat, b.lon);
    segLens.push(len);
    totalLen += len;
  }
  if (totalLen <= 0) {
    return { lat: target.lat, lon: target.lon, arrived: true };
  }
  let travel = Math.min(totalLen, (elapsedSec / totalSec) * totalLen);
  for (let i = 1; i < line.length; i += 1) {
    const segLen = segLens[i - 1] ?? 0;
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    if (travel <= segLen) {
      const t = segLen <= 0 ? 1 : travel / segLen;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, arrived: false };
    }
    travel -= segLen;
  }
  return { lat: target.lat, lon: target.lon, arrived: true };
}

/** 만료 주문서 정산 (서버 권위). null = 정산 불필요.
 *  path 주문서는 정확히 도착, 구 주문서는 500m 규칙(연장)으로 하위호환. */
export function settleExpiredMoveTarget(
  target: UnitMoveTarget,
  storedLat: number,
  storedLon: number,
  now: number,
): { lat: number; lon: number; lastMoveAt: number; moveTarget: UnitMoveTarget | null } | null {
  if (!target || now < target.endsAt) {
    return null;
  }
  if (target.path && target.path.length > 0) {
    return { lat: target.lat, lon: target.lon, lastMoveAt: now, moveTarget: null };
  }
  const remaining = distM(storedLat, storedLon, target.lat, target.lon);
  if (remaining < 500) {
    return { lat: target.lat, lon: target.lon, lastMoveAt: now, moveTarget: null };
  }
  return {
    lat: storedLat,
    lon: storedLon,
    lastMoveAt: now,
    moveTarget: {
      ...target,
      endsAt: now + Math.max(60000, (remaining / UNIT_SPEED_MPS) * 1000),
    },
  };
}
/** 경로 길이(m). 주문 검증용 (소요시간 하한 산정). */
export function movePathLengthM(target: Pick<UnitMoveTarget, "fromLat" | "fromLon" | "lat" | "lon" | "via" | "path">): number {
  const line = movePolyline(target as UnitMoveTarget);
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    total += distM(a.lat, a.lon, b.lat, b.lon);
  }
  return total;
}
