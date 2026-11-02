import { createHash } from "node:crypto";

import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prismadb";
import {
  UNIT_GARRISON_COOLDOWN_BONUS_SEC,
  loadUnits,
} from "@/lib/units";
import {
  SIEGE_COOLDOWN_SEC,
  getUserMissionKey,
  isCastleEventKey,
  isTerritoryEnabled,
  territoryDisabledResponse,
} from "@/lib/territory-gate";

export { SIEGE_COOLDOWN_SEC, isCastleEventKey, territoryDisabledResponse };

// ---------------------------------------------------------------------------
// 상수 (기획 확정안)
// ---------------------------------------------------------------------------

export type CastleClass = "slave" | "commoner" | "knight" | "noble" | "lord";

const CLASS_ORDER: Record<CastleClass, number> = {
  slave: 0,
  commoner: 1,
  knight: 2,
  noble: 3,
  lord: 4,
};

export const INFLUENCE_CAP = 5000;
export const LORD_CASTLE_COST = 500;
export const NOBLE_HP_UNIT_COST = 200;
export const TRANSFER_COST = 100;
export const UNIT_TRAINING_COST = 50;
export const GATE_REPAIR_COST = 100; // 성문(난이도) 변경 비용 — Phase 5

export const LORD_CASTLE_HP = 5;
export const NOBLE_CASTLE_MIN_HP = 2;
export const NOBLE_CASTLE_MAX_HP = 3;

export const LORD_CASTLE_CAP_PER_DONG = 1;
export const NOBLE_CASTLE_CAP_PER_DONG = 3;
export const NOBLE_CASTLE_PER_USER = 1;

export const CASTLE_MEMBER_CAP: Record<"lord" | "noble", number> = {
  lord: 30,
  noble: 15,
};

export const OWN_CASTLE_CAP: Record<CastleClass, number> = {
  slave: 0,
  commoner: 0,
  knight: 3,
  noble: 5,
  lord: 7,
};

export const JOIN_RADIUS_M = 100;
export const CASTLE_MIN_SEPARATION_M = 200;
export const NOBLE_DIST_MIN_M = 500;
export const NOBLE_DIST_MAX_M = 2000;
export const TRANSFER_COOLDOWN_DAYS = 30;
export const JOIN_APPROVAL_EXPIRE_HOURS = 48;
export const INACTIVITY_DEMOTE_DAYS = 7;
export const CONQUEST_INFLUENCE_SHARE = 0.2;

// 시즌: 4주. 시작일은 운영 확정 전까지 상수.
export const SEASON_START_MS = Date.parse("2026-11-02T00:00:00+09:00");
export const SEASON_MS = 28 * 24 * 3600 * 1000;

export function currentSeasonId(now = Date.now()): number {
  if (!Number.isFinite(SEASON_START_MS)) {
    return 1;
  }
  return Math.max(1, Math.floor((now - SEASON_START_MS) / SEASON_MS) + 1);
}

// ---------------------------------------------------------------------------
// 트랜잭션/락
// ---------------------------------------------------------------------------

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const toLockStatus = (value: unknown): number => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return 0;
};

/** updatescore와 동일한 GET_LOCK 패턴. fn 내부는 전부 tx로 수행한다. */
export async function withNamedLock<T>(name: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const lockKey = createHash("sha1").update(name).digest("hex");
  return prisma.$transaction(
    async (tx) => {
      const lockResult = await tx.$queryRaw<Array<{ locked: number | null }>>`
        SELECT GET_LOCK(${lockKey}, 5) AS locked
      `;
      if (toLockStatus(lockResult[0]?.locked) !== 1) {
        throw new Error("territory lock acquire failed");
      }
      try {
        return await fn(tx as Tx);
      } finally {
        await tx.$queryRaw`SELECT RELEASE_LOCK(${lockKey})`;
      }
    },
    { maxWait: 10000, timeout: 20000 },
  );
}

export const withCastleLock = <T>(castleKey: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withNamedLock(`castle:${castleKey.trim()}`, fn);

// ---------------------------------------------------------------------------
// 세션/게이트
// ---------------------------------------------------------------------------

export async function requireSessionUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id?.trim() ?? "";
  return userId.length > 0 ? userId : null;
}

export async function resolveTerritoryContext(
  userId: string,
): Promise<{ missionKey: string } | null> {
  const missionKey = await getUserMissionKey(userId);
  if (!missionKey) {
    return null;
  }
  if (!(await isTerritoryEnabled(missionKey))) {
    return null;
  }
  return { missionKey };
}

// ---------------------------------------------------------------------------
// 좌표
// ---------------------------------------------------------------------------

export function parseLatLon(raw: string | null | undefined): { lat: number; lon: number } | null {
  if (!raw) {
    return null;
  }
  const matches = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length < 2) {
    return null;
  }
  const lat = Number(matches[0]);
  const lon = Number(matches[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon };
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// 영향력 (MissionUser.score 재활용, atomic)
// ---------------------------------------------------------------------------

export async function getInfluence(db: Tx | typeof prisma, userId: string): Promise<number> {
  const row = await (db as typeof prisma).missionUser.findUnique({
    where: { userId },
    select: { score: true },
  });
  const score = typeof row?.score === "bigint" ? Number(row.score) : Number(row?.score ?? 0);
  return Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0;
}

/** 잔액 부족 시 false (차감 없음). 단일 UPDATE라 원자적이다. */
export async function spendInfluence(
  db: Tx | typeof prisma,
  userId: string,
  amount: number,
): Promise<boolean> {
  const cost = Math.max(0, Math.trunc(amount));
  if (cost <= 0) {
    return true;
  }
  const affected = await (db as typeof prisma).$executeRaw`
    UPDATE MissionUser
    SET score = COALESCE(score, 0) - ${cost}
    WHERE userId = ${userId} AND COALESCE(score, 0) >= ${cost}
  `;
  return Number(affected) === 1;
}

/** 상한(INFLUENCE_CAP)까지만 적립. */
export async function grantInfluence(
  db: Tx | typeof prisma,
  userId: string,
  amount: number,
): Promise<void> {
  const gain = Math.max(0, Math.trunc(amount));
  if (gain <= 0) {
    return;
  }
  await (db as typeof prisma).$executeRaw`
    UPDATE MissionUser
    SET score = LEAST(${INFLUENCE_CAP}, COALESCE(score, 0) + ${gain})
    WHERE userId = ${userId}
  `;
}

/** 잔액이 모자라도 바닥(0)까지 차감한다 (패자 부담금 등). */
export async function loseInfluence(
  db: Tx | typeof prisma,
  userId: string,
  amount: number,
): Promise<void> {
  const loss = Math.max(0, Math.trunc(amount));
  if (loss <= 0) {
    return;
  }
  await (db as typeof prisma).$executeRaw`
    UPDATE MissionUser
    SET score = GREATEST(0, COALESCE(score, 0) - ${loss})
    WHERE userId = ${userId}
  `;
}

// ---------------------------------------------------------------------------
// 계급
// ---------------------------------------------------------------------------

export function normalizeClass(value: unknown): CastleClass {
  if (value === "commoner" || value === "knight" || value === "noble" || value === "lord") {
    return value;
  }
  return "slave";
}

export function classAtLeast(actual: CastleClass, required: CastleClass): boolean {
  return CLASS_ORDER[actual] >= CLASS_ORDER[required];
}

export async function getUserClass(db: Tx | typeof prisma, userId: string): Promise<CastleClass> {
  const row = await (db as typeof prisma).missionTeam.findFirst({
    where: { userId },
    orderBy: { id: "desc" },
    select: { classId: true },
  });
  return normalizeClass(row?.classId);
}

interface UserStats {
  visits: number;
  contribution: number;
  lastActiveAt: number | null;
  duelWins: number;
}

export async function getUserStats(
  db: Tx | typeof prisma,
  userId: string,
  missionKey: string,
): Promise<UserStats> {
  const client = db as typeof prisma;
  const [aggRows, duelRows] = await Promise.all([
    client.$queryRaw<Array<{ visits: bigint | number | null; contribution: bigint | number | null; lastActive: Date | null }>>`
      SELECT COUNT(DISTINCT CASE WHEN COALESCE(s.score, 0) >= 1 THEN TRIM(s.EventKey) END) AS visits,
             COALESCE(SUM(CASE WHEN COALESCE(s.islastscore, 0) = 1 THEN s.score ELSE 0 END), 0) AS contribution,
             MAX(s.scoredate) AS lastActive
      FROM ARMissionUserScore s
      WHERE s.UserId = ${userId}
        AND TRIM(COALESCE(s.ARMissionKey, '')) = ${missionKey}
    `,
    client.$queryRaw<Array<{ wins: bigint | number | null }>>`
      SELECT COUNT(*) AS wins
      FROM ARMissionUserScore s
      WHERE s.UserId = ${userId}
        AND TRIM(COALESCE(s.ARMissionKey, '')) = ${missionKey}
        AND s.answer LIKE ${"duel:win:%"}
    `,
  ]);
  const toNum = (v: bigint | number | null): number => {
    const n = typeof v === "bigint" ? Number(v) : Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    visits: Math.trunc(toNum(aggRows[0]?.visits ?? 0)),
    contribution: Math.trunc(toNum(aggRows[0]?.contribution ?? 0)),
    lastActiveAt: aggRows[0]?.lastActive instanceof Date ? aggRows[0].lastActive.getTime() : null,
    duelWins: Math.trunc(toNum(duelRows[0]?.wins ?? 0)),
  };
}

export async function countOwnedCastles(
  db: Tx | typeof prisma,
  userId: string,
  missionKey: string,
): Promise<number> {
  const rows = await (db as typeof prisma).aRMissionEvent.findMany({
    where: { ARMissionKey: missionKey, EventKey: { startsWith: "castle-" } },
    select: { string_param1: true },
  });
  let count = 0;
  for (const row of rows) {
    if (parseCastleMeta(row.string_param1)?.owner === userId) {
      count += 1;
    }
  }
  return count;
}

/**
 * Lazy 승급/강등. 액션 시점에 호출한다.
 * - commoner: 방문 3 + 공헌 300 / knight: 점령 1 + 공헌 1000 (결투 3승은 Phase 6 조임 예정)
 * - noble: 공헌 5000 + (점령 3 or 상위 10%)
 * - lord는 정복 경로로만付与, 여기서는 유지조건(보유 1+) 미달 시 noble로
 * - 7일 무활동 시 1단계 강등 (slave 제외)
 */
export async function refreshUserClass(
  db: Tx | typeof prisma,
  userId: string,
  missionKey: string,
): Promise<CastleClass> {
  const client = db as typeof prisma;
  const current = await getUserClass(client, userId);
  const stats = await getUserStats(client, userId, missionKey);
  const owned = await countOwnedCastles(client, userId, missionKey);

  let next: CastleClass = current;

  const inactive =
    stats.lastActiveAt !== null &&
    Date.now() - stats.lastActiveAt > INACTIVITY_DEMOTE_DAYS * 24 * 3600 * 1000;
  if (inactive && current !== "slave") {
    const order: CastleClass[] = ["slave", "commoner", "knight", "noble", "lord"];
    next = order[Math.max(0, CLASS_ORDER[current] - 1)];
  } else if (current === "slave" && stats.visits >= 3 && stats.contribution >= 300) {
    next = "commoner";
  } else if (
    (current === "commoner" || current === "slave") &&
    owned >= 1 &&
    stats.contribution >= 1000
  ) {
    next = "knight";
  } else if (
    (current === "knight" || current === "commoner") &&
    stats.contribution >= 5000 &&
    (owned >= 3 || (await isTopContributor(client, userId, missionKey)))
  ) {
    next = "noble";
  }

  // 유지조건
  if (next === "noble" && owned < 1) {
    next = "knight";
  }
  if (next === "lord" && owned < 1) {
    next = "noble";
  }

  if (next !== current) {
    await client.missionTeam.updateMany({
      where: { userId },
      data: { classId: next },
    });
  }
  return next;
}

async function isTopContributor(
  db: typeof prisma,
  userId: string,
  missionKey: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ userId: string | null; c: bigint | number | null }>>`
    SELECT s.UserId AS userId, COALESCE(SUM(CASE WHEN COALESCE(s.islastscore, 0) = 1 THEN s.score ELSE 0 END), 0) AS c
    FROM ARMissionUserScore s
    WHERE TRIM(COALESCE(s.ARMissionKey, '')) = ${missionKey}
    GROUP BY s.UserId
  `;
  const mine = rows.find((r) => r.userId === userId);
  const myScore = Number(mine?.c ?? 0);
  if (!Number.isFinite(myScore) || myScore <= 0 || rows.length === 0) {
    return false;
  }
  const rank = rows.filter((r) => Number(r.c ?? 0) > myScore).length + 1;
  return rank <= Math.max(1, Math.ceil(rows.length * 0.1));
}

// ---------------------------------------------------------------------------
// 성 메타/설정
// ---------------------------------------------------------------------------

export type CastleKind = "lord" | "noble";

export interface CastleMeta {
  owner: string | null;
  kind: CastleKind;
  dong: string;
  hp: number;
  maxHp: number;
  garrison: number;
  siegeWins: number;
  seasonId: number;
  status: "active" | "pending";
  createdAt: string;
}

export interface CastleSettings {
  joinMode: "auto" | "manual";
  pool: string | null;
  game: string | null;
  difficulty: [number, number];
  cutline: number;
}

export function parseCastleMeta(raw: string | null | undefined): CastleMeta | null {
  if (!raw) {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<CastleMeta>;
    if (v.kind !== "lord" && v.kind !== "noble") {
      return null;
    }
    if (typeof v.dong !== "string" || v.dong.trim().length === 0) {
      return null;
    }
    const hp = Math.max(0, Math.trunc(Number(v.hp)));
    const maxHp = Math.max(1, Math.trunc(Number(v.maxHp)));
    return {
      owner: typeof v.owner === "string" && v.owner.trim() ? v.owner : null,
      kind: v.kind,
      dong: v.dong.trim(),
      hp: Math.min(hp, maxHp),
      maxHp,
      garrison: Math.max(0, Math.trunc(Number(v.garrison ?? 0))),
      siegeWins: Math.max(0, Math.trunc(Number(v.siegeWins ?? 0))),
      seasonId: Math.max(1, Math.trunc(Number(v.seasonId ?? currentSeasonId()))),
      status: v.status === "pending" ? "pending" : "active",
      createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function serializeCastleMeta(meta: CastleMeta): string {
  return JSON.stringify(meta).slice(0, 1200);
}

export function parseCastleSettings(raw: string | null | undefined): CastleSettings {
  const fallback: CastleSettings = {
    joinMode: "auto",
    pool: null,
    game: null,
    difficulty: [1, 3],
    cutline: 30,
  };
  if (!raw) {
    return fallback;
  }
  try {
    const v = JSON.parse(raw) as Partial<CastleSettings>;
    const diff = Array.isArray(v.difficulty) ? v.difficulty.map(Number) : [];
    return {
      joinMode: v.joinMode === "manual" ? "manual" : "auto",
      pool: typeof v.pool === "string" && v.pool.trim() ? v.pool.trim() : null,
      game: typeof v.game === "string" && v.game.trim() ? v.game.trim() : null,
      difficulty:
        diff.length >= 2 && diff.every((n) => Number.isFinite(n))
          ? [Math.max(1, Math.min(5, Math.trunc(diff[0]))), Math.max(1, Math.min(5, Math.trunc(diff[1])))]
          : fallback.difficulty,
      cutline:
        Number.isFinite(Number(v.cutline)) && Number(v.cutline) > 0
          ? Math.trunc(Number(v.cutline))
          : fallback.cutline,
    };
  } catch {
    return fallback;
  }
}

export interface LoadedCastle {
  castleKey: string;
  lat: number;
  lon: number;
  name: string;
  hpMirrored: number;
  meta: CastleMeta;
  settings: CastleSettings;
}

export async function loadCastle(
  db: Tx | typeof prisma,
  castleKey: string,
  missionKey: string,
): Promise<LoadedCastle | null> {
  const client = db as typeof prisma;
  const key = castleKey.trim();
  if (!isCastleEventKey(key)) {
    return null;
  }
  const [gps, event] = await Promise.all([
    client.aRMissionGPS.findFirst({
      where: { EventKey: key, ARMissionKey: missionKey },
    }),
    client.aRMissionEvent.findFirst({
      where: { EventKey: key, ARMissionKey: missionKey },
    }),
  ]);
  if (!gps || !event) {
    return null;
  }
  const meta = parseCastleMeta(event.string_param1);
  if (!meta) {
    return null;
  }
  const coords = parseLatLon(gps.location);
  if (!coords) {
    return null;
  }
  return {
    castleKey: key,
    lat: coords.lat,
    lon: coords.lon,
    name: gps.locationname?.trim() || key,
    hpMirrored: event.int_param1 ?? meta.hp,
    meta,
    settings: parseCastleSettings(event.string_param2),
  };
}

/** 시즌이 바뀌면 중립화(주인 해제·HP 복구). 조회 시점에 lazy 수행한다. */
export async function ensureCastleSeason(
  tx: Tx,
  castleKey: string,
  missionKey: string,
): Promise<LoadedCastle | null> {
  const castle = await loadCastle(tx, castleKey, missionKey);
  if (!castle) {
    return null;
  }
  const seasonId = currentSeasonId();
  if (castle.meta.seasonId === seasonId) {
    return castle;
  }
  const reset: CastleMeta = {
    ...castle.meta,
    owner: null,
    hp: castle.meta.maxHp,
    garrison: 0,
    siegeWins: 0,
    seasonId,
    status: "active",
  };
  await tx.aRMissionEvent.updateMany({
    where: { EventKey: castleKey, ARMissionKey: missionKey },
    data: { int_param1: reset.maxHp, string_param1: serializeCastleMeta(reset) },
  });
  return { ...castle, meta: reset, hpMirrored: reset.maxHp };
}

// ---------------------------------------------------------------------------
// 공성 쿨다운/상한 (주둔 보너스 포함)
// ---------------------------------------------------------------------------

export const SIEGE_DAILY_CAP = 5;

async function countGarrisoned(
  db: Tx | typeof prisma,
  ownerId: string | null,
  castleKey: string,
): Promise<number> {
  if (!ownerId) {
    return 0;
  }
  const owner = await (db as typeof prisma).missionUser.findUnique({
    where: { userId: ownerId },
    select: { data: true },
  });
  const units = loadUnits(owner?.data);
  return units.filter((s) => s.state === "garrisoned" && s.castleKey === castleKey).length;
}

/** 쿨다운 잔여(초) = 기본 1h + 주둔 1명당 15분. GPS·부대 합산 기준. */
export async function getSiegeCooldownRemainingSecTx(
  db: Tx | typeof prisma,
  userId: string,
  castleKey: string,
  missionKey: string,
): Promise<number> {
  if (!userId || !castleKey.trim()) {
    return 0;
  }
  const client = db as typeof prisma;
  const last = await client.aRMissionUserScore.findFirst({
    where: {
      UserId: userId,
      EventKey: castleKey.trim(),
      answer: { startsWith: "siege:" },
    },
    orderBy: { scoredate: "desc" },
    select: { scoredate: true },
  });
  if (!last?.scoredate) {
    return 0;
  }
  const castle = await loadCastle(client, castleKey, missionKey);
  const garrison = castle ? await countGarrisoned(client, castle.meta.owner, castleKey) : 0;
  const total = SIEGE_COOLDOWN_SEC + garrison * UNIT_GARRISON_COOLDOWN_BONUS_SEC;
  const elapsed = Math.floor((Date.now() - last.scoredate.getTime()) / 1000);
  return Math.max(0, total - elapsed);
}

/** 24h 공성 시도 횟수 (hit/miss/touch/giveup 합산). */
export async function getSiegeAttemptsLast24h(
  tx: Tx | typeof prisma,
  userId: string,
  castleKey: string,
): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  return (tx as typeof prisma).aRMissionUserScore.count({
    where: {
      UserId: userId,
      EventKey: castleKey.trim(),
      answer: { startsWith: "siege:" },
      scoredate: { gte: since },
    },
  });
}

// ---------------------------------------------------------------------------
// 입성 공통 (join route + 부대 join action 공용)
// ---------------------------------------------------------------------------

export async function performJoin(
  tx: Tx,
  missionKey: string,
  userId: string,
  klass: CastleClass,
  castle: LoadedCastle,
  opts: { transfer: boolean; fromCastle: string | null },
): Promise<{ pending: boolean }> {
  if (opts.fromCastle) {
    const lastMove = await tx.aRMissionUserScore.findFirst({
      where: {
        UserId: userId,
        ARMissionKey: missionKey,
        answer: { startsWith: "moved:" },
      },
      orderBy: { scoredate: "desc" },
      select: { scoredate: true },
    });
    if (
      lastMove?.scoredate instanceof Date &&
      Date.now() - lastMove.scoredate.getTime() < TRANSFER_COOLDOWN_DAYS * 24 * 3600 * 1000
    ) {
      throw new Error("transfer_cooldown");
    }
    const paid = await spendInfluence(tx, userId, TRANSFER_COST);
    if (!paid) {
      throw new Error("funds");
    }
  }

  const members = await tx.missionTeam.findMany({
    where: { teamId: castle.castleKey },
    select: { Features: true },
  });
  const active = members.filter(
    (m) => !(typeof m.Features === "string" && m.Features.startsWith("join-pending:")),
  ).length;
  if (active >= CASTLE_MEMBER_CAP[castle.meta.kind]) {
    throw new Error("capacity");
  }

  const existing = await tx.missionTeam.findFirst({
    where: { userId },
    select: { id: true },
  });

  if (castle.settings.joinMode === "manual" && castle.meta.owner !== userId && !opts.fromCastle) {
    const stamp = `join-pending:${Date.now()}`;
    if (existing) {
      await tx.missionTeam.updateMany({ where: { userId }, data: { Features: stamp } });
    } else {
      await tx.missionTeam.create({
        data: {
          ARMissionKey: missionKey,
          userId,
          teamId: castle.castleKey,
          classId: klass,
          Features: stamp,
        },
      });
    }
    return { pending: true };
  }

  if (existing) {
    await tx.missionTeam.updateMany({
      where: { userId },
      data: { teamId: castle.castleKey, classId: klass, Features: "" },
    });
  } else {
    await tx.missionTeam.create({
      data: {
        ARMissionKey: missionKey,
        userId,
        teamId: castle.castleKey,
        classId: klass,
        Features: "",
      },
    });
  }

  if (opts.fromCastle) {
    await tx.aRMissionUserScore.create({
      data: {
        UserId: userId,
        EventKey: castle.castleKey,
        ARMissionKey: missionKey,
        answer: `moved:${opts.fromCastle}->${castle.castleKey}`.slice(0, 255),
        score: 0,
        scoredate: new Date(),
        islastscore: 0,
      },
    });
  }

  return { pending: false };
}

// ---------------------------------------------------------------------------
// 성 데미지 공통 (quiz resolve + 부대 touch 공용)
// ---------------------------------------------------------------------------

export interface CastleDamageResult {
  hp: number;
  maxHp: number;
  conquered: boolean;
  prevOwner: string | null;
}

/** HP 1 차감. 0 도달 시 정복 처리까지 수행한다. 락 보유 상태에서 호출. */
export async function applyCastleDamage(
  tx: Tx,
  missionKey: string,
  castle: LoadedCastle,
  attackerId: string,
): Promise<CastleDamageResult> {
  const nextHp = Math.max(0, castle.meta.hp - 1);
  if (nextHp > 0) {
    const meta = { ...castle.meta, hp: nextHp };
    await tx.aRMissionEvent.updateMany({
      where: { EventKey: castle.castleKey, ARMissionKey: missionKey },
      data: { int_param1: nextHp, string_param1: serializeCastleMeta(meta) },
    });
    return { hp: nextHp, maxHp: meta.maxHp, conquered: false, prevOwner: castle.meta.owner };
  }

  const prevOwner = castle.meta.owner;
  if (prevOwner && prevOwner !== attackerId) {
    const defenderInfluence = await getInfluence(tx, prevOwner);
    const share = Math.floor(defenderInfluence * CONQUEST_INFLUENCE_SHARE);
    if (share > 0 && (await spendInfluence(tx, prevOwner, share))) {
      await grantInfluence(tx, attackerId, share);
    }
  }

  const meta = {
    ...castle.meta,
    owner: attackerId,
    hp: castle.meta.maxHp,
    garrison: 0,
    siegeWins: 0,
    seasonId: currentSeasonId(),
    status: "active" as const,
  };
  await tx.aRMissionEvent.updateMany({
    where: { EventKey: castle.castleKey, ARMissionKey: missionKey },
    data: { int_param1: meta.maxHp, string_param1: serializeCastleMeta(meta) },
  });

  if (prevOwner && prevOwner !== attackerId) {
    const prevOwned = await countOwnedCastles(tx, prevOwner, missionKey);
    const prevRow = await tx.missionTeam.findFirst({
      where: { userId: prevOwner },
      select: { classId: true },
    });
    if (prevOwned === 0 && prevRow?.classId === "lord") {
      await tx.missionTeam.updateMany({
        where: { userId: prevOwner },
        data: { classId: "noble" },
      });
    }
    await tx.missionTeam.updateMany({
      where: { teamId: castle.castleKey, classId: "noble", userId: { not: attackerId } },
      data: { classId: "knight" },
    });
  }

  const attackerClass = await getUserClass(tx, attackerId);
  const granted: CastleClass =
    castle.meta.kind === "lord" ? "lord" : classAtLeast(attackerClass, "noble") ? attackerClass : "noble";
  const attackerRow = await tx.missionTeam.findFirst({
    where: { userId: attackerId },
    select: { id: true },
  });
  if (attackerRow) {
    await tx.missionTeam.updateMany({
      where: { userId: attackerId },
      data: { teamId: castle.castleKey, classId: granted, Features: "" },
    });
  } else {
    await tx.missionTeam.create({
      data: {
        ARMissionKey: missionKey,
        userId: attackerId,
        teamId: castle.castleKey,
        classId: granted,
        Features: "",
      },
    });
  }

  return { hp: meta.maxHp, maxHp: meta.maxHp, conquered: true, prevOwner };
}

/**
 * 부대 공성 터치. 3타=1데미지. 호출당 최대 1데미지까지 적용하고
 * 나머지는 누적된다 (다음 touch에서 정산).
 */
export async function applyUnitTouch(
  tx: Tx,
  missionKey: string,
  castle: LoadedCastle,
  attackerId: string,
  unitId: string,
): Promise<CastleDamageResult & { touches: number }> {
  await tx.aRMissionUserScore.create({
    data: {
      UserId: attackerId,
      EventKey: castle.castleKey,
      ARMissionKey: missionKey,
      answer: `siege:touch:${unitId}`.slice(0, 120),
      score: 0,
      scoredate: new Date(),
      islastscore: 0,
    },
  });
  const touches = await tx.aRMissionUserScore.count({
    where: {
      UserId: attackerId,
      EventKey: castle.castleKey,
      ARMissionKey: missionKey,
      answer: { startsWith: "siege:touch:" },
    },
  });
  const applied = await tx.prefabInstanceTable.count({
    where: {
      ARMissionKey: missionKey,
      PrefabEventId: castle.castleKey,
      userId: attackerId,
      string_param1: "siege-touch-applied",
    },
  });
  let result: CastleDamageResult = {
    hp: castle.meta.hp,
    maxHp: castle.meta.maxHp,
    conquered: false,
    prevOwner: castle.meta.owner,
  };
  if (Math.floor(touches / 3) > applied) {
    result = await applyCastleDamage(tx, missionKey, castle, attackerId);
    await tx.prefabInstanceTable.create({
      data: {
        ARMissionKey: missionKey,
        PrefabEventId: castle.castleKey,
        userId: attackerId,
        InstanceId: `touch-${touches}`,
        LastOpTime: new Date(),
        string_param1: "siege-touch-applied",
        string_param2: "",
        string_param3: "",
        string_param4: "",
        string_param5: "",
        string_param6: "",
      },
    });
  }
  return { ...result, touches };
}

// ---------------------------------------------------------------------------
// 결투 전력 (유령 방어)
// ---------------------------------------------------------------------------

export interface DuelBest {
  eventKey: string;
  score: number;
}

/** 미니게임 순수 기록 (answer IS NULL 행) 의 기간별 이벤트 최고점. */
export async function readBestScores(
  db: Tx | typeof prisma,
  userId: string,
  missionKey: string,
  sinceMs: number,
): Promise<DuelBest[]> {
  const since = new Date(sinceMs);
  const rows = await (db as typeof prisma).$queryRaw<
    Array<{ ek: string | null; m: bigint | number | null }>
  >`
    SELECT TRIM(s.EventKey) AS ek, MAX(s.score) AS m
    FROM ARMissionUserScore s
    WHERE s.UserId = ${userId}
      AND TRIM(COALESCE(s.ARMissionKey, '')) = ${missionKey}
      AND s.scoredate >= ${since}
      AND TRIM(COALESCE(s.EventKey, '')) NOT LIKE 'castle-%'
      AND s.answer IS NULL
    GROUP BY ek
  `;
  return rows.flatMap((r) => {
    const score = typeof r.m === "bigint" ? Number(r.m) : Number(r.m ?? 0);
    if (!r.ek || !Number.isFinite(score) || score <= 0) {
      return [];
    }
    return [{ eventKey: r.ek, score: Math.trunc(score) }];
  });
}

export function castleAgeDays(castle: LoadedCastle, now = Date.now()): number {
  const created = Date.parse(castle.meta.createdAt);
  if (!Number.isFinite(created)) {
    return 0;
  }
  return Math.max(0, (now - created) / (24 * 3600 * 1000));
}

// 결투 (약탈전) 수치
export const DUEL_DAILY_CAP = 3;
export const DUEL_BATTLE_WINDOW_MS = 24 * 3600 * 1000;
export const DUEL_PRESENCE_BONUS = 10;
export const DUEL_CLASS_BONUS = 10;
export const DUEL_DEFENSE_MULT = 1.1;
export const DUEL_TENURE_BONUS = 10;
export const DUEL_LOSS_COST = 100;
export const DUEL_DEFENSE_REWARD = 50;
export const DUEL_LOOT_SHARE = 0.3;
/**
 * 공격 주사위 그레이스 (5분). 앱 시계와 DB 시계가 어긋나도
 * 신청 직후 기록이 탈락하지 않게 한다. 신청 5분 전 기록까지 인정.
 */
export const DUEL_ROLL_GRACE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 수확 (일일 정산 lazy)
// ---------------------------------------------------------------------------

export const HARVEST_BASE = 100;
export const HARVEST_SHARE = 0.3;

/** 동 버프. 운영이 직접 편집한다 (기본 1.0). 상업 2.0 / 요새 1.0 */
export const DONG_BUFFS: Record<string, number> = {
  // 예: "11260105": 2.0,
};

export const CLASS_HARVEST_MULT: Record<CastleClass, number> = {
  slave: 0,
  commoner: 1.0,
  knight: 1.0,
  noble: 1.2,
  lord: 1.5,
};
