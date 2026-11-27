import { approvedNation } from "@/lib/nations";
import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import { getNationRankings, getUserRankings } from "@/lib/records";
import { currentSeasonId, requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

/** GET /api/rankings?scope=user|nation&limit= — 시즌 랭킹. */
export async function GET(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const params = new URL(request.url).searchParams;
  const scope = params.get("scope") === "nation" ? "nation" : "user";
  const limit = Math.max(1, Math.min(50, Number(params.get("limit") ?? 20) || 20));
  const seasonId = currentSeasonId();
  const myNation = await prisma.territoryNationMember.findFirst({
    where: { userId, nation: approvedNation(ctx.missionKey, seasonId) },
    select: { nationId: true },
  });
  const myNationId = myNation?.nationId ?? null;
  if (scope === "nation") {
    // 전체를 계산해 내 국가 순위도 함께 낸다 (국가 수는 많지 않다).
    const all = await getNationRankings(prisma, ctx.missionKey, seasonId, 50);
    const myIdx = myNationId ? all.findIndex((r) => r.nationId === myNationId) : -1;
    return NextResponse.json({
      ok: true,
      scope,
      seasonId,
      rows: all.slice(0, limit),
      myNationId,
      me: myIdx >= 0 ? { rank: myIdx + 1, row: all[myIdx] } : null,
    });
  }
  const rows = await getUserRankings(prisma, ctx.missionKey, seasonId, limit);
  // 내 순위: 순위표 밖이어도 따로 계산 (승리 → 점령 순, 동률은 같은 순위)
  let me: { rank: number; row: (typeof rows)[number] } | null = null;
  const inTop = rows.findIndex((r) => r.userId === userId);
  if (inTop >= 0) {
    me = { rank: inTop + 1, row: rows[inTop] as (typeof rows)[number] };
  } else {
    const rec = await prisma.territorySeasonRecord.findFirst({ where: { missionKey: ctx.missionKey, seasonId, userId } });
    if (rec) {
      const ahead = await prisma.territorySeasonRecord.count({
        where: {
          missionKey: ctx.missionKey,
          seasonId,
          OR: [{ wins: { gt: rec.wins } }, { wins: rec.wins, conquests: { gt: rec.conquests } }],
        },
      });
      const nick = await prisma.missionUser.findUnique({ where: { userId }, select: { nickname: true } });
      const nation = myNationId
        ? await prisma.territoryNation.findUnique({ where: { id: myNationId }, select: { name: true } })
        : null;
      me = {
        rank: ahead + 1,
        row: {
          userId,
          nickname: nick?.nickname ?? "나",
          nationId: myNationId,
          nationName: nation?.name ?? null,
          wins: rec.wins,
          losses: rec.losses,
          outlawWins: rec.outlawWins,
          conquests: rec.conquests,
        },
      };
    }
  }
  return NextResponse.json({ ok: true, scope, seasonId, rows, myUserId: userId, myNationId, me });
}
