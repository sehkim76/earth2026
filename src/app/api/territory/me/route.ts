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
    // 카드 전투 패배로 영주가 부상 중이면 해제 시각 (지도 부상 표시용).
    const rawData = userRow?.data;
    const lordInjured =
      rawData && typeof rawData === "object" && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>).lordInjuredUntil
        : null;
    const lordInjuredUntil =
      typeof lordInjured === "number" && Number.isFinite(lordInjured) && lordInjured > Date.now() ? lordInjured : null;

    return NextResponse.json({
      ok: true,
      class: klass,
      influence,
      ownedCastles,
      unitsAlive: alive,
      unitCap: UNIT_CAP_BY_CLASS[klass],
      servantsAlive: alive,
      servantCap: UNIT_CAP_BY_CLASS[klass],
      // 카드 전투 기록 (승급 조건). contribution은 구 화면 호환용으로 승리 수를 넣는다.
      wins: stats.wins,
      maxCommanderLevel: stats.maxCommanderLevel,
      contribution: stats.wins,
      lordInjuredUntil,
      serverNow: Date.now(),
    });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
