import prisma from "@/lib/prismadb";
import { currentSeasonId, type Tx } from "@/lib/territory";

// ---------------------------------------------------------------------------
// 동의 절차로 성립한 국가와 외교
// ---------------------------------------------------------------------------

export const ALLIANCE_CAP = 3;
export const NAP_HOURS = 48;
export const WAR_NOTICE_HOURS = 12;
export const SOLO_GAUGE_PER_WIN = 25;
export const NATION_GAUGE_PER_WIN = 15;
export const BETRAY_INFLUENCE_LOSS = 20;

export type DiplomacyType = "nap" | "alliance" | "tribute" | "war";
export type DiplomacyStatus = "pending" | "active" | "rejected" | "expired" | "broken";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface NationSummary {
  id: string;
  name: string;
  leaderUserId: string;
  memberCount: number;
  isSolo: boolean;
  myRole: string | null;
}

export const approvedNation = (missionKey: string, seasonId = currentSeasonId()) => ({
  missionKey, seasonId, declaration: { is: { status: "approved" } },
});

export async function playerTitles(db: Tx | typeof prisma, missionKey: string, userIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!userIds.length) return titles;
  const members = await db.territoryNationMember.findMany({
    where: { userId: { in: userIds }, nation: approvedNation(missionKey) },
    select: { userId: true, role: true },
  });
  for (const member of members) {
    if (titles.get(member.userId) !== "국왕") titles.set(member.userId, member.role === "leader" ? "국왕" : "제후");
  }
  return titles;
}

export async function getMyNation(
  db: Tx | typeof prisma,
  userId: string,
  missionKey: string,
): Promise<NationSummary | null> {
  const client = db as typeof prisma;
  const existing = await client.territoryNationMember.findFirst({
    where: { userId, nation: approvedNation(missionKey) },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
    include: { nation: { include: { _count: { select: { members: true } } } } },
  });
  if (!existing) return null;
  const count = existing.nation._count.members;
  return {
    id: existing.nation.id,
    name: existing.nation.name,
    leaderUserId: existing.nation.leaderUserId,
    memberCount: count,
    isSolo: count <= 1,
    myRole: existing.role,
  };
}

/** 무소속 영주도 개인 공성 게이지를 쌓을 수 있다. */
export async function siegeFaction(db: Tx, userId: string, missionKey: string): Promise<{ id: string; isSolo: boolean }> {
  return (await getMyNation(db, userId, missionKey)) ?? { id: `solo:${userId}`, isSolo: true };
}

/** 유지비: 2개까지 무료, 3개부터 초선형. */
export function upkeepForTerritories(count: number): number {
  if (count <= 2) return 0;
  const extra = count - 2;
  return extra * extra * 50;
}

// ---------------------------------------------------------------------------
// 외교
// ---------------------------------------------------------------------------

/** 두 국가가 서로 공격 가능한가 (동맹/불가침이면 불가). */
export async function canAttack(
  db: Tx | typeof prisma,
  missionKey: string,
  fromNationId: string,
  toNationId: string,
): Promise<{ ok: boolean; reason: string | null }> {
  if (fromNationId === toNationId) return { ok: false, reason: "same_nation" };
  const client = db as typeof prisma;
  const now = new Date();
  const rel = await client.territoryDiplomacy.findFirst({
    where: {
      missionKey,
      status: "active",
      OR: [
        { fromNationId, toNationId },
        { fromNationId: toNationId, toNationId: fromNationId },
      ],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!rel) return { ok: true, reason: null };
  if (rel.type === "alliance" || rel.type === "nap") {
    return { ok: false, reason: rel.type };
  }
  return { ok: true, reason: null };
}

/** 동맹 수 (상한 3개국). */
export async function allianceCount(
  db: Tx | typeof prisma,
  missionKey: string,
  nationId: string,
): Promise<number> {
  const client = db as typeof prisma;
  const now = new Date();
  return client.territoryDiplomacy.count({
    where: {
      missionKey,
      type: "alliance",
      status: "active",
      OR: [{ fromNationId: nationId }, { toNationId: nationId }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  });
}

export function expiryFor(type: DiplomacyType): Date | null {
  const now = Date.now();
  if (type === "nap") return new Date(now + NAP_HOURS * 3600_000);
  if (type === "war") return new Date(now + WAR_NOTICE_HOURS * 3600_000);
  return null;
}

export function parseTributePayload(raw: unknown): { influence?: number; castleKey?: string } {
  if (!isRecord(raw)) return {};
  const out: { influence?: number; castleKey?: string } = {};
  if (typeof raw.influence === "number" && Number.isFinite(raw.influence)) {
    out.influence = Math.max(0, Math.floor(raw.influence));
  }
  if (typeof raw.castleKey === "string" && raw.castleKey.trim()) {
    out.castleKey = raw.castleKey.trim().slice(0, 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 공성 게이지
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 공성 게이지 단가 (적립·정복은 호출 측 트랜잭션에서 수행)
// ---------------------------------------------------------------------------

/** 1회 기여 게이지: 솔로 25 / 국가원 15, 패배는 절반(하한 +5). */
export function siegeGain(solo: boolean, won: boolean): number {
  const base = solo ? SOLO_GAUGE_PER_WIN : NATION_GAUGE_PER_WIN;
  return won ? base : Math.max(5, Math.floor(base / 2));
}
