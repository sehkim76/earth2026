import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import { loadUnits, positionAtMoveTarget } from "@/lib/units";
import {
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/** 다른 플레이어의 배치된 부대 (지도 표시용). 본인 제외, field/garrisoned만. */
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
    const rows = await prisma.missionUser.findMany({
      where: { ARMissionKey: ctx.missionKey, userId: { not: userId } },
      select: { userId: true, nickname: true, data: true },
      take: 200,
    });
    const now = Date.now();
    const units = rows.flatMap((row) =>
      loadUnits(row.data)
        .filter((unit) => unit.state === "field" || unit.state === "garrisoned")
        .filter(
          (unit) =>
            Number.isFinite(unit.lat) &&
            Number.isFinite(unit.lon) &&
            Math.abs(unit.lat) <= 90 &&
            Math.abs(unit.lon) <= 180,
        )
        .map((unit) => {
          // 서버 권위 보간 위치 (쓰기 없이 계산만 — 만료 정산은 소유자 조회 시).
          const live =
            unit.moveTarget && unit.moveTarget.endsAt > now
              ? positionAtMoveTarget(unit.moveTarget, now)
              : unit.moveTarget && unit.moveTarget.endsAt <= now
                ? { lat: unit.moveTarget.lat, lon: unit.moveTarget.lon }
                : null;
          return {
            id: unit.id,
            name: unit.name,
            lat: live ? live.lat : unit.lat,
            lon: live ? live.lon : unit.lon,
            state: unit.state,
            ownerNickname: row.nickname ?? "",
            moveTarget: unit.moveTarget,
          };
        }),
    ).slice(0, 200);
    return NextResponse.json({ ok: true, units });
  } catch (error) {
    console.error("[units/visible] failed", error);
    return NextResponse.json({ ok: false, code: "units_visible_failed" }, { status: 500 });
  }
}
