import { acquirePgLock } from "@/lib/pg-advisory-lock";

import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prismadb";
import { levelFromXp } from "@/lib/battle/commanders";
import { recordConquest } from "@/lib/records";
import {
  UNIT_GARRISON_COOLDOWN_BONUS_SEC,
  loadUnits,
  withUnits,
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

/** 금 상한 (옛 영향력 상한 5000 → 성 내정 도입으로 확대) */
export const INFLUENCE_CAP = 200_000;
export const LORD_CASTLE_COST = 500;
export const NOBLE_HP_UNIT_COST = 200;
export const TRANSFER_COST = 100;
export const UNIT_TRAINING_COST = 50;

export const LORD_CASTLE_HP = 5;
export const NOBLE_CASTLE_MIN_HP = 2;
export const NOBLE_CASTLE_MAX_HP = 3;

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

/** pg_advisory_xact_lock 기반 이름 락. fn 내부는 전부 tx로 수행한다. */
export async function withNamedLock<T>(name: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await acquirePgLock(tx, name);
      return fn(tx as Tx);
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
// 금 (옛 영향력, MissionUser.score 재활용, atomic). 함수 이름은 호환을 위해 유지.
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
    UPDATE "MissionUser"
    SET score = COALESCE(score, 0) - ${cost}
    WHERE "userId" = ${userId} AND COALESCE(score, 0) >= ${cost}
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
    UPDATE "MissionUser"
    SET score = LEAST(${INFLUENCE_CAP}, COALESCE(score, 0) + ${gain})
    WHERE "userId" = ${userId}
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
    UPDATE "MissionUser"
    SET score = GREATEST(0, COALESCE(score, 0) - ${loss})
    WHERE "userId" = ${userId}
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
  /** 모든 지휘관(영주·부대)의 전투 승리 합계 */
  wins: number;
  /** 지휘관 중 최고 레벨 (전투 기록이 없으면 1) */
  maxCommanderLevel: number;
  lastActiveAt: number | null;
}

/** MissionUser.data.commanders(카드 전투 지휘관 성장 기록)에서 승리 합계·최고 레벨을 읽는다. */
export function readBattleProgress(data: unknown): { wins: number; maxCommanderLevel: number; lastBattleAt: number | null } {
  let wins = 0;
  let maxCommanderLevel = 1;
  let lastBattleAt: number | null = null;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const commanders = record.commanders;
    if (commanders && typeof commanders === "object" && !Array.isArray(commanders)) {
      for (const value of Object.values(commanders as Record<string, unknown>)) {
        if (!value || typeof value !== "object") {
          continue;
        }
        const entry = value as { wins?: unknown; xp?: unknown };
        if (typeof entry.wins === "number" && Number.isFinite(entry.wins)) {
          wins += Math.max(0, Math.floor(entry.wins));
        }
        if (typeof entry.xp === "number" && Number.isFinite(entry.xp)) {
          maxCommanderLevel = Math.max(maxCommanderLevel, levelFromXp(Math.max(0, entry.xp)));
        }
      }
    }
    if (typeof record.lastBattleAt === "number" && Number.isFinite(record.lastBattleAt)) {
      lastBattleAt = record.lastBattleAt;
    }
  }
  return { wins, maxCommanderLevel, lastBattleAt };
}

export async function getUserStats(
  db: Tx | typeof prisma,
  userId: string,
  missionKey: string,
): Promise<UserStats> {
  const client = db as typeof prisma;
  // 활동 시각: 점수 기록(공성·수비·이적 기록 등)과 마지막 전투 중 늦은 쪽.
  const [aggRows, userRow] = await Promise.all([
    client.$queryRaw<Array<{ lastActive: Date | null }>>`
      SELECT MAX(s.scoredate) AS "lastActive"
      FROM "ARMissionUserScore" s
      WHERE s."UserId" = ${userId}
        AND TRIM(COALESCE(s."ARMissionKey", '')) = ${missionKey}
    `,
    client.missionUser.findUnique({ where: { userId }, select: { data: true } }),
  ]);
  const progress = readBattleProgress(userRow?.data);
  const scoreActive = aggRows[0]?.lastActive instanceof Date ? aggRows[0].lastActive.getTime() : null;
  const lastActiveAt =
    scoreActive === null ? progress.lastBattleAt : progress.lastBattleAt === null ? scoreActive : Math.max(scoreActive, progress.lastBattleAt);
  return {
    wins: progress.wins,
    maxCommanderLevel: progress.maxCommanderLevel,
    lastActiveAt,
  };
}

/** 계급 승급·영주성 창시 조건 (카드 전투 기록 기준). */
export const PROMOTION_RULES = {
  commoner: { wins: 3, level: 2 },
  knight: { wins: 10, castles: 1 },
  noble: { wins: 30, level: 5, castles: 3 },
  /** 동 최초 영주성 창시: 평민 이상 + 승리 */
  foundLordCastle: { wins: 5 },
} as const;

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
 * Lazy 승급/강등. 액션 시점에 호출한다. 조건은 카드 전투 기록 기준 (PROMOTION_RULES).
 * - commoner: 승리 3 + 지휘관 2레벨 / knight: 성 1 + 승리 10
 * - noble: 승리 30 + 지휘관 5레벨 + (성 3 or 승리 상위 10%)
 * - lord는 정복 경로로만 부여, 여기서는 유지조건(보유 1+) 미달 시 noble로
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
  } else if (
    current === "slave" &&
    stats.wins >= PROMOTION_RULES.commoner.wins &&
    stats.maxCommanderLevel >= PROMOTION_RULES.commoner.level
  ) {
    next = "commoner";
  } else if (
    current === "commoner" &&
    owned >= PROMOTION_RULES.knight.castles &&
    stats.wins >= PROMOTION_RULES.knight.wins
  ) {
    next = "knight";
  } else if (
    current === "knight" &&
    stats.wins >= PROMOTION_RULES.noble.wins &&
    stats.maxCommanderLevel >= PROMOTION_RULES.noble.level &&
    (owned >= PROMOTION_RULES.noble.castles || (await isTopByWins(client, userId, missionKey, stats.wins)))
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

/** 같은 미션 사용자 중 전투 승리 상위 10% 인지. */
async function isTopByWins(
  db: typeof prisma,
  userId: string,
  missionKey: string,
  myWins: number,
): Promise<boolean> {
  if (myWins <= 0) {
    return false;
  }
  const rows = await db.missionUser.findMany({
    where: { ARMissionKey: missionKey },
    select: { userId: true, data: true },
  });
  if (rows.length === 0) {
    return false;
  }
  const higher = rows.filter((r) => r.userId !== userId && readBattleProgress(r.data).wins > myWins).length;
  return higher + 1 <= Math.max(1, Math.ceil(rows.length * 0.1));
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

/** 성 설정 (string_param2 JSON). 옛 퀴즈 필드(pool/game/difficulty/cutline)는 읽을 때 무시한다. */
export interface CastleSettings {
  joinMode: "auto" | "manual";
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
  };
  if (!raw) {
    return fallback;
  }
  try {
    const v = JSON.parse(raw) as Partial<CastleSettings> | null;
    return {
      joinMode: v?.joinMode === "manual" ? "manual" : "auto",
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
  // 원군 1슬롯: 동맹 원군도 주둔 1명분 쿨다운 연장을 준다.
  const reinforced = castle ? await countReinforced(client, missionKey, castleKey) : 0;
  const total = SIEGE_COOLDOWN_SEC + (garrison + reinforced) * UNIT_GARRISON_COOLDOWN_BONUS_SEC;
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
// 성 데미지 공통 (부대 공성 touch 공용)
// ---------------------------------------------------------------------------

export interface CastleDamageResult {
  hp: number;
  maxHp: number;
  conquered: boolean;
  prevOwner: string | null;
}

/** 정복 시 이전 주인의 해당 성 주둔 부대를 본거지로 자동 귀환시킨다. */
async function returnGarrisonedUnitsHome(tx: Tx, ownerId: string, castleKey: string): Promise<void> {
  const prev = await tx.missionUser.findUnique({
    where: { userId: ownerId },
    select: { data: true },
  });
  const units = loadUnits(prev?.data);
  let changed = false;
  const next = units.map((s) => {
    if (s.state === "garrisoned" && s.castleKey === castleKey) {
      changed = true;
      return {
        ...s,
        state: "field" as const,
        castleKey: null,
        lat: s.hq.lat,
        lon: s.hq.lon,
        lastMoveAt: Date.now(),
      };
    }
    return s;
  });
  if (changed) {
    await tx.missionUser.update({
      where: { userId: ownerId },
      data: { data: withUnits(prev?.data, next) },
    });
  }
}

/** HP 1 차감. 0 도달 시 정복 처리(주둔 부대 귀환 포함)까지 수행한다. 락 보유 상태에서 호출. */
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
  return conquerCastle(tx, missionKey, castle, attackerId);
}

/** 원군 기록 파싱 (동맹 payload JSON). */
function parseReinforcements(raw: string | null | undefined): Array<{ castleKey: string; unitId: string; lenderUserId: string }> {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { reinforcements?: unknown };
    if (!Array.isArray(v?.reinforcements)) return [];
    return v.reinforcements
      .filter(
        (r): r is { castleKey: string; unitId: string; lenderUserId: string } =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as { castleKey?: unknown }).castleKey === "string" &&
          typeof (r as { unitId?: unknown }).unitId === "string" &&
          typeof (r as { lenderUserId?: unknown }).lenderUserId === "string",
      )
      .map((r) => ({ castleKey: r.castleKey, unitId: r.unitId, lenderUserId: r.lenderUserId }));
  } catch {
    return [];
  }
}

/** 정복·할양 시 해당 성의 원군을 본거지로 귀환시키고 기록을 지운다. */
async function returnReinforcedUnitsHome(tx: Tx, missionKey: string, castleKey: string): Promise<void> {
  const rows = await tx.territoryDiplomacy.findMany({
    where: { missionKey, type: "alliance", status: "active" },
    select: { id: true, payload: true },
  });
  for (const row of rows) {
    const all = parseReinforcements(row.payload);
    const mine = all.filter((r) => r.castleKey === castleKey);
    if (mine.length === 0) continue;
    const rest = all.filter((r) => r.castleKey !== castleKey);
    for (const rec of mine) {
      const lender = await tx.missionUser.findUnique({
        where: { userId: rec.lenderUserId },
        select: { data: true },
      });
      const units = loadUnits(lender?.data);
      let changed = false;
      const next = units.map((u) => {
        if (u.id === rec.unitId && u.state === "garrisoned" && u.castleKey === castleKey) {
          changed = true;
          return { ...u, state: "field" as const, castleKey: null, lat: u.hq.lat, lon: u.hq.lon, lastMoveAt: Date.now() };
        }
        return u;
      });
      if (changed) {
        await tx.missionUser.update({
          where: { userId: rec.lenderUserId },
          data: { data: withUnits(lender?.data, next) },
        });
      }
    }
    await tx.territoryDiplomacy.update({
      where: { id: row.id },
      data: { payload: JSON.stringify({ reinforcements: rest }).slice(0, 2000) },
    });
  }
}

/** 동맹 해체·파기 시 원군 전원 귀환 + 기록 초기화. 파기 페널티와 함께 호출. */
export async function clearAllianceReinforcements(tx: Tx, allianceId: string): Promise<void> {
  const row = await tx.territoryDiplomacy.findUnique({ where: { id: allianceId }, select: { payload: true } });
  if (!row) return;
  const all = parseReinforcements(row.payload);
  for (const rec of all) {
    const lender = await tx.missionUser.findUnique({
      where: { userId: rec.lenderUserId },
      select: { data: true },
    });
    const units = loadUnits(lender?.data);
    let changed = false;
    const next = units.map((u) => {
      if (u.id === rec.unitId && u.state === "garrisoned" && u.castleKey === rec.castleKey) {
        changed = true;
        return { ...u, state: "field" as const, castleKey: null, lat: u.hq.lat, lon: u.hq.lon, lastMoveAt: Date.now() };
      }
      return u;
    });
    if (changed) {
      await tx.missionUser.update({
        where: { userId: rec.lenderUserId },
        data: { data: withUnits(lender?.data, next) },
      });
    }
  }
  await tx.territoryDiplomacy.update({
    where: { id: allianceId },
    data: { payload: JSON.stringify({ reinforcements: [] }).slice(0, 2000) },
  });
}

/** 해당 성의 원군 목록 (활성 동맹 한정). 수비 편성 합류용. */
export interface ReinforcementRecord {
  allianceId: string;
  castleKey: string;
  unitId: string;
  lenderUserId: string;
}

export async function listReinforcements(
  db: Tx | typeof prisma,
  missionKey: string,
  castleKey: string,
): Promise<ReinforcementRecord[]> {
  const rows = await (db as typeof prisma).territoryDiplomacy.findMany({
    where: { missionKey, type: "alliance", status: "active" },
    select: { id: true, payload: true },
  });
  const out: ReinforcementRecord[] = [];
  for (const row of rows) {
    for (const r of parseReinforcements(row.payload)) {
      if (r.castleKey === castleKey) out.push({ allianceId: row.id, ...r });
    }
  }
  return out;
}

/** 해당 성에 주둔 중인 원군 수 (공성 쿨다운 가산용). */
export async function countReinforced(db: Tx | typeof prisma, missionKey: string, castleKey: string): Promise<number> {
  const rows = await (db as typeof prisma).territoryDiplomacy.findMany({
    where: { missionKey, type: "alliance", status: "active" },
    select: { payload: true },
  });
  let count = 0;
  for (const row of rows) {
    count += parseReinforcements(row.payload).filter((r) => r.castleKey === castleKey).length;
  }
  return count;
}

/** 해당 성의 모든 공성 게이지 초기화 (정복·시즌 리셋용). */
export async function clearSiegeGauges(tx: Tx, missionKey: string, castleKey: string): Promise<void> {
  await tx.territorySiege.deleteMany({ where: { missionKey, castleKey } });
}

/**
 * 성 정복/할양 본체. 소유권 이전 + 주둔 귀환 + 영향력 배분 + 계급 정산을 수행한다.
 * - 게이지 100 도달, 조공 할양, 기존 HP 공성 모두 이 경로로 수렴한다.
 * - skipShare: 조공처럼 영향력을 별도 이전했을 때 20% 추가 징수를 생략한다.
 */
export async function conquerCastle(
  tx: Tx,
  missionKey: string,
  castle: LoadedCastle,
  attackerId: string,
  opts?: { skipShare?: boolean },
): Promise<CastleDamageResult> {
  const prevOwner = castle.meta.owner;
  if (!opts?.skipShare && prevOwner && prevOwner !== attackerId) {
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
    await returnGarrisonedUnitsHome(tx, prevOwner, castle.castleKey);
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
  await returnReinforcedUnitsHome(tx, missionKey, castle.castleKey);
  // 시즌 전적: 정복 1회 (HP 공성·게이지·조공 공통).
  await recordConquest(tx, missionKey, currentSeasonId(), attackerId);

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
