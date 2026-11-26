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
  if (scope === "nation") {
    const rows = await getNationRankings(prisma, ctx.missionKey, seasonId, limit);
    return NextResponse.json({ ok: true, scope, seasonId, rows });
  }
  const rows = await getUserRankings(prisma, ctx.missionKey, seasonId, limit);
  return NextResponse.json({ ok: true, scope, seasonId, rows });
}
