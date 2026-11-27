import { NextResponse } from "next/server";

import { RESOURCE_KINDS, type GatherMovement, type VisibleWorker } from "@/lib/city";
import prisma from "@/lib/prismadb";
import { loadUnits, positionAtMoveTarget } from "@/lib/units";
import {
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

async function readVisibleWorkers(userId: string, missionKey: string, now: number): Promise<VisibleWorker[]> {
  const rows = await prisma.$queryRaw<{ nickname: string; job: GatherMovement }[]>`
    SELECT u.nickname, active.job
    FROM "TerritoryCity" c
    JOIN "MissionUser" u ON u."userId" = c."userId" AND u."ARMissionKey" = c."missionKey"
    CROSS JOIN LATERAL jsonb_path_query(
      c.data, '$.gathers[*] ? (@.returnAt > $now)', jsonb_build_object('now', ${now}::bigint)
    ) AS active(job)
    WHERE c."missionKey" = ${missionKey} AND c."userId" <> ${userId}
  `;
  return rows.flatMap(({ nickname, job }) => {
    const { kind, lat, lon, fromLat, fromLon, startedAt, arriveAt, doneAt, returnAt, path } = job;
    const coordinatesAndTimes = [lat, lon, fromLat, fromLon, startedAt, arriveAt, doneAt, returnAt];
    if (!RESOURCE_KINDS.includes(kind) || !coordinatesAndTimes.every(Number.isFinite)) {
      return [];
    }
    const validPath = Array.isArray(path) && path.every((point) =>
      Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
    return [{
      ownerNickname: nickname, kind, lat, lon, fromLat, fromLon, startedAt, arriveAt, doneAt, returnAt,
      path: validPath ? path : undefined,
    }];
  });
}

/** 같은 미션에 배치된 다른 플레이어의 부대와 채집 일꾼. */
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
    const now = Date.now();
    const [rows, workers] = await Promise.all([
      prisma.missionUser.findMany({
        where: { ARMissionKey: ctx.missionKey, userId: { not: userId } },
        select: { userId: true, nickname: true, data: true },
        take: 200,
      }),
      readVisibleWorkers(userId, ctx.missionKey, now),
    ]);
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
            ownerId: row.userId,
            ownerNickname: row.nickname ?? "",
            injuredUntil: unit.injuredUntil ?? null,
            moveTarget: unit.moveTarget,
          };
        }),
    ).slice(0, 200);
    return NextResponse.json({ ok: true, units, workers, serverNow: Date.now() });
  } catch (error) {
    console.error("[units/visible] failed", error);
    return NextResponse.json({ ok: false, code: "units_visible_failed" }, { status: 500 });
  }
}
