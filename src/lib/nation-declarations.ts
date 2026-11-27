import { proclamationLock, ratify, VOTING_PERIOD_MS, votingClosed } from "@/lib/nation-ratification";
import prisma from "@/lib/prismadb";
import { dongBboxServer, isInDongServer } from "@/lib/server-walkable";
import { currentSeasonId, parseCastleMeta, withNamedLock } from "@/lib/territory";

export class DeclarationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function proposeNation(userId: string, missionKey: string, castleKey: string, name: string): Promise<void> {
  const seasonId = currentSeasonId();
  await withNamedLock(proclamationLock(missionKey, seasonId), async tx => {
    const events = await tx.aRMissionEvent.findMany({
      where: { ARMissionKey: missionKey, EventKey: { startsWith: "castle-" } },
      select: { EventKey: true, string_param1: true },
    });
    const castles = events.map(e => ({ key: e.EventKey, meta: parseCastleMeta(e.string_param1) }))
      .filter(c => c.meta?.seasonId === seasonId && c.meta.status === "active");
    const castle = castles.find(c => c.key === castleKey)?.meta;
    if (!castle || castle.owner !== userId) throw new DeclarationError(403, "자신이 보유한 성에서 선포할 수 있습니다.");
    const dong = castle.dong;
    const active = await tx.territoryDeclaration.findFirst({
      where: { missionKey, seasonId, dong, status: { in: ["pending", "approved"] } },
    });
    if (active) throw new DeclarationError(409, active.status === "pending" ? "이미 이 지역에서 동의를 받고 있습니다." : "이미 국가가 선포된 지역입니다.");
    const bounds = dongBboxServer(dong);
    if (!bounds) throw new DeclarationError(503, "행정동 경계를 확인할 수 없어 선포를 보류했습니다. 다시 시도해 주세요.");
    const owners = castles.filter(c => c.meta?.dong === dong).flatMap(c => c.meta?.owner ? [c.meta.owner] : []);
    const residents = await tx.missionUser.findMany({
      where: { ARMissionKey: missionKey, OR: [
        { userId: { in: owners } },
        { lat: { gte: bounds.minLat, lte: bounds.maxLat }, lon: { gte: bounds.minLon, lte: bounds.maxLon } },
      ] },
      select: { userId: true, lat: true, lon: true },
    });
    const ownerIds = new Set(owners);
    const voters = residents.filter(r => ownerIds.has(r.userId) ||
      (r.lat !== null && r.lon !== null && isInDongServer(dong, Number(r.lat), Number(r.lon))));
    if (!voters.some(v => v.userId === userId)) throw new DeclarationError(409, "현재 미션 소속을 확인해 주세요.");
    const proposal = await tx.territoryDeclaration.create({ data: {
      missionKey, seasonId, dong, castleKey, proposerId: userId, name,
      votes: { create: voters.map(v => ({ userId: v.userId, consent: v.userId === userId ? true : null })) },
    } });
    if (voters.length === 1) await ratify(tx, proposal.id);
  });
}

export async function voteOnNation(userId: string, missionKey: string, id: string, consent: boolean): Promise<void> {
  const seasonId = currentSeasonId();
  const expired = await withNamedLock(proclamationLock(missionKey, seasonId), async tx => {
    const vote = await tx.territoryDeclarationVote.findUnique({
      where: { declarationId_userId: { declarationId: id, userId } }, include: { declaration: true },
    });
    if (!vote || vote.declaration.missionKey !== missionKey || vote.declaration.seasonId !== seasonId)
      throw new DeclarationError(404, "응답할 수 있는 선포가 없습니다.");
    if (vote.consent === consent) return false;
    if (vote.declaration.status === "pending" && votingClosed(vote.declaration.createdAt)) {
      await ratify(tx, id);
      return true;
    }
    if (vote.declaration.status !== "pending" || vote.consent !== null)
      throw new DeclarationError(409, "이미 응답했거나 투표가 끝났습니다.");
    await tx.territoryDeclarationVote.update({
      where: { declarationId_userId: { declarationId: id, userId } }, data: { consent },
    });
    if (consent) await ratify(tx, id);
    else await tx.territoryDeclaration.update({ where: { id }, data: { status: "rejected" } });
    return false;
  });
  if (expired) throw new DeclarationError(409, "24시간의 응답 기한이 지났습니다.");
}

export async function declarationInbox(userId: string, missionKey: string) {
  const where = { missionKey, seasonId: currentSeasonId(), votes: { some: { userId } } };
  const select = {
    id: true, createdAt: true, name: true, dong: true, castleKey: true, proposerId: true, status: true,
    votes: { where: { userId }, select: { consent: true } },
    _count: { select: { votes: { where: { consent: true } } } },
  } as const;
  const [current, rejected] = await Promise.all([
    prisma.territoryDeclaration.findMany({ where: { ...where, status: { in: ["pending", "approved"] } }, select, orderBy: { createdAt: "desc" } }),
    prisma.territoryDeclaration.findMany({ where: { ...where, status: "rejected" }, select, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  const proposals = [...current, ...rejected];
  if (!proposals.length) return [];
  const [counts, gps, players] = await Promise.all([
    prisma.territoryDeclarationVote.groupBy({ by: ["declarationId"], where: { declarationId: { in: proposals.map(p => p.id) } }, _count: true }),
    prisma.aRMissionGPS.findMany({ where: { ARMissionKey: missionKey, EventKey: { in: proposals.map(p => p.castleKey) } }, select: { EventKey: true, locationname: true } }),
    prisma.missionUser.findMany({ where: { userId: { in: proposals.map(p => p.proposerId) } }, select: { userId: true, nickname: true } }),
  ]);
  const totals = new Map(counts.map(c => [c.declarationId, c._count]));
  const castles = new Map(gps.map(c => [c.EventKey, c.locationname]));
  const names = new Map(players.map(p => [p.userId, p.nickname]));
  return proposals.map(p => ({
    id: p.id, name: p.name, deadline: p.createdAt.getTime() + VOTING_PERIOD_MS, castleName: castles.get(p.castleKey) || p.castleKey,
    proposer: names.get(p.proposerId) || "영주", mine: p.proposerId === userId,
    status: p.status, consent: p.votes[0]?.consent ?? null, agreed: p._count.votes, total: totals.get(p.id) ?? 0,
  }));
}
