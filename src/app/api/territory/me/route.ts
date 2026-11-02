import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import { UNIT_CAP_BY_CLASS, loadUnits } from "@/lib/units";
import {
  countOwnedCastles,
  getInfluence,
  getUserClass,
  getUserStats,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/** 영토전 플레이어 대시 정보 (좌상단 표시용). */
export async function GET() {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  try {
    const [klass, influence, stats, ownedCastles, userRow] = await Promise.all([
      getUserClass(prisma, userId),
      getInfluence(prisma, userId),
      getUserStats(prisma, userId, ctx.missionKey),
      countOwnedCastles(prisma, userId, ctx.missionKey),
      prisma.missionUser.findUnique({ where: { userId }, select: { data: true } }),
    ]);
    const units = loadUnits(userRow?.data);
    const alive = units.filter((s) => s.state !== "dead").length;

    return NextResponse.json({
      ok: true,
      class: klass,
      influence,
      ownedCastles,
      unitsAlive: alive,
      unitCap: UNIT_CAP_BY_CLASS[klass],
      servantsAlive: alive,
      servantCap: UNIT_CAP_BY_CLASS[klass],
      contribution: stats.contribution,
    });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
