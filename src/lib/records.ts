import type prisma from "@/lib/prismadb";
import type { Tx } from "@/lib/territory";

// ---------------------------------------------------------------------------
// 시즌 전적 (개인 단위 기록, 국가 랭킹은 구성원 합산)
// ---------------------------------------------------------------------------

export interface BattleRecordInput {
  missionKey: string;
  seasonId: number;
  userId: string;
  won: boolean;
  outlaw: boolean;
}

type Db = Tx | typeof prisma;

/** 오토배틀 1판 기록 (승/패 + 무법자 승리). upsert 원자적이라 락 불필요. */
export async function recordBattleResult(db: Db, input: BattleRecordInput): Promise<void> {
  const client = db as typeof prisma;
  await client.territorySeasonRecord.upsert({
    where: {
      missionKey_seasonId_userId: { missionKey: input.missionKey, seasonId: input.seasonId, userId: input.userId },
    },
    create: {
      missionKey: input.missionKey,
      seasonId: input.seasonId,
      userId: input.userId,
      wins: input.won ? 1 : 0,
      losses: input.won ? 0 : 1,
      outlawWins: input.won && input.outlaw ? 1 : 0,
      conquests: 0,
    },
    update: {
      wins: { increment: input.won ? 1 : 0 },
      losses: { increment: input.won ? 0 : 1 },
      outlawWins: { increment: input.won && input.outlaw ? 1 : 0 },
      updatedAt: new Date(),
    },
  });
}

/** 정복 1회 기록 (conquerCastle 정복 경로에서 호출). */
export async function recordConquest(db: Db, missionKey: string, seasonId: number, userId: string): Promise<void> {
  const client = db as typeof prisma;
  await client.territorySeasonRecord.upsert({
    where: { missionKey_seasonId_userId: { missionKey, seasonId, userId } },
    create: { missionKey, seasonId, userId, wins: 0, losses: 0, outlawWins: 0, conquests: 1 },
    update: { conquests: { increment: 1 }, updatedAt: new Date() },
  });
}

export interface UserRankingRow {
  userId: string;
  nickname: string;
  nationId: string | null;
  nationName: string | null;
  wins: number;
  losses: number;
  outlawWins: number;
  conquests: number;
}

export interface NationRankingRow {
  nationId: string;
  nationName: string;
  memberCount: number;
  wins: number;
  losses: number;
  outlawWins: number;
  conquests: number;
}

/** 개인 랭킹 (승리 순). */
export async function getUserRankings(
  db: Db,
  missionKey: string,
  seasonId: number,
  limit: number,
): Promise<UserRankingRow[]> {
  const client = db as typeof prisma;
  const records = await client.territorySeasonRecord.findMany({
    where: { missionKey, seasonId },
    orderBy: [{ wins: "desc" }, { conquests: "desc" }],
    take: Math.max(1, Math.min(50, limit)),
  });
  if (records.length === 0) return [];
  const userIds = records.map((r) => r.userId);
  const [users, memberships] = await Promise.all([
    client.missionUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, nickname: true } }),
    client.territoryNationMember.findMany({
      where: { userId: { in: userIds }, nation: { missionKey, seasonId } },
      select: { userId: true, nationId: true, nation: { select: { name: true } } },
    }),
  ]);
  const nameById = new Map(users.map((u) => [u.userId, u.nickname]));
  const nationByUser = new Map(memberships.map((m) => [m.userId, { id: m.nationId, name: m.nation.name }]));
  return records.map((r) => {
    const nation = nationByUser.get(r.userId) ?? null;
    return {
      userId: r.userId,
      nickname: nameById.get(r.userId) ?? "무명",
      nationId: nation?.id ?? null,
      nationName: nation?.name ?? null,
      wins: r.wins,
      losses: r.losses,
      outlawWins: r.outlawWins,
      conquests: r.conquests,
    };
  });
}

/** 국가 랭킹 (구성원 합산, 승리 순). */
export async function getNationRankings(
  db: Db,
  missionKey: string,
  seasonId: number,
  limit: number,
): Promise<NationRankingRow[]> {
  const client = db as typeof prisma;
  const [nations, records] = await Promise.all([
    client.territoryNation.findMany({
      where: { missionKey, seasonId },
      select: { id: true, name: true, members: { select: { userId: true } } },
    }),
    client.territorySeasonRecord.findMany({ where: { missionKey, seasonId } }),
  ]);
  const byUser = new Map(records.map((r) => [r.userId, r]));
  const rows: NationRankingRow[] = nations.map((n) => {
    let wins = 0;
    let losses = 0;
    let outlawWins = 0;
    let conquests = 0;
    for (const m of n.members) {
      const r = byUser.get(m.userId);
      if (!r) continue;
      wins += r.wins;
      losses += r.losses;
      outlawWins += r.outlawWins;
      conquests += r.conquests;
    }
    return { nationId: n.id, nationName: n.name, memberCount: n.members.length, wins, losses, outlawWins, conquests };
  });
  rows.sort((a, b) => b.wins - a.wins || b.conquests - a.conquests);
  return rows.slice(0, Math.max(1, Math.min(50, limit)));
}
