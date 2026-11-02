import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  currentSeasonId,
  parseCastleMeta,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/** 미션의 이번 시즌 성 목록 (지도 마커 종류 구분용). */
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
    const seasonId = currentSeasonId();
    const [events, gpsRows] = await Promise.all([
      prisma.aRMissionEvent.findMany({
        where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
        select: { EventKey: true, string_param1: true },
      }),
      prisma.aRMissionGPS.findMany({
        where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
        select: { EventKey: true, locationname: true },
      }),
    ]);
    const nameByKey = new Map(
      gpsRows.map((row) => [row.EventKey ?? "", row.locationname ?? ""])
    );
    const castles = [];
    const ownerIds = new Set<string>();
    const parsed: Array<{ key: string; meta: NonNullable<ReturnType<typeof parseCastleMeta>> }> = [];
    for (const event of events) {
      const key = event.EventKey ?? "";
      if (!key) {
        continue;
      }
      const meta = parseCastleMeta(event.string_param1);
      if (!meta || meta.seasonId !== seasonId) {
        continue;
      }
      parsed.push({ key, meta });
      if (meta.owner) {
        ownerIds.add(meta.owner);
      }
    }
    const nickRows =
      ownerIds.size > 0
        ? await prisma.missionUser.findMany({
            where: { userId: { in: [...ownerIds] } },
            select: { userId: true, nickname: true },
          })
        : [];
    const nickById = new Map(nickRows.map((row) => [row.userId, row.nickname ?? ""]));
    for (const { key, meta } of parsed) {
      castles.push({
        castleKey: key,
        kind: meta.kind,
        name: nameByKey.get(key) ?? key,
        owner: meta.owner,
        ownerNickname: meta.owner ? (nickById.get(meta.owner) ?? "") : "",
        dong: meta.dong,
        mine: meta.owner === userId,
        availableForTraining: meta.owner === userId && meta.status === "active",
      });
    }
    return NextResponse.json({ ok: true, castles });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
