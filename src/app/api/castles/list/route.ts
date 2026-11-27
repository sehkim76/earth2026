import { NextResponse } from "next/server";

import { approvedNation } from "@/lib/nations";
import prisma from "@/lib/prismadb";
import {
  currentSeasonId,
  parseCastleMeta,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/** 미션의 이번 시즌 성 목록 (지도 마커 종류·손상 표시 구분용). */
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
    const [events, gpsRows, regions] = await Promise.all([
      prisma.aRMissionEvent.findMany({
        where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
        select: { EventKey: true, string_param1: true },
      }),
      prisma.aRMissionGPS.findMany({
        where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
        select: { EventKey: true, locationname: true },
      }),
      prisma.territoryDeclaration.findMany({
        where: { missionKey: ctx.missionKey, seasonId, status: "approved" },
        select: { dong: true, nationId: true, name: true },
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
    // 성 내정은 영주당 하나이며, 가장 먼저 세운 영주성이 본성이다.
    const homes = new Map<string, string>();
    for (const { key, meta } of [...parsed].sort((a, b) =>
      String(a.meta.createdAt ?? "").localeCompare(String(b.meta.createdAt ?? "")) || a.key.localeCompare(b.key))) {
      if (meta.kind === "lord" && meta.owner && !homes.has(meta.owner)) homes.set(meta.owner, key);
    }
    const cityRows = homes.size ? await prisma.$queryRaw<{ userId: string; keep: string | null; build: { key?: string; endsAt?: number; toLevel?: number } | null }[]>`
      SELECT "userId", data #>> '{buildings,keep}' AS keep, data -> 'build' AS build
      FROM "TerritoryCity" WHERE "missionKey" = ${ctx.missionKey}
    ` : [];
    const keepByCastle = new Map<string, number>();
    const now = Date.now();
    for (const row of cityRows) {
      const key = homes.get(row.userId);
      if (key) keepByCastle.set(key, row.build?.key === "keep" && Number(row.build.endsAt) <= now ?
        Number(row.build.toLevel) : Number(row.keep) || 1);
    }
    const nickRows =
      ownerIds.size > 0
        ? await prisma.missionUser.findMany({
            where: { userId: { in: [...ownerIds] } },
            select: { userId: true, nickname: true },
          })
        : [];
    const nickById = new Map(nickRows.map((row) => [row.userId, row.nickname ?? ""]));

    // 국가·외교·공성 게이지 (지도 국가별 색칠·게이지 표시용). 실패해도 성 목록은 낸다.
    type Relation = "mine" | "alliance" | "nap" | "war" | "none";
    const nationByUser = new Map<string, { id: string; name: string; solo: boolean }>();
    const relationByNation = new Map<string, Relation>();
    const siegeByCastle = new Map<string, { gauge: number; mine: number }>();
    let myNationId: string | null = null;
    try {
      const seasonFilter = approvedNation(ctx.missionKey, seasonId);
      const memberRows = await prisma.territoryNationMember.findMany({
        where: { userId: { in: [...ownerIds, userId] }, nation: seasonFilter },
        select: { userId: true, nation: { select: { id: true, name: true, _count: { select: { members: true } } } } },
      });
      for (const row of memberRows) {
        nationByUser.set(row.userId, { id: row.nation.id, name: row.nation.name, solo: row.nation._count.members <= 1 });
      }
      myNationId = nationByUser.get(userId)?.id ?? null;
      if (myNationId) {
        relationByNation.set(myNationId, "mine");
        const now = new Date();
        const rels = await prisma.territoryDiplomacy.findMany({
          where: {
            missionKey: ctx.missionKey,
            status: "active",
            type: { in: ["alliance", "nap", "war"] },
            OR: [{ fromNationId: myNationId }, { toNationId: myNationId }],
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
          },
          orderBy: { createdAt: "asc" },
          select: { fromNationId: true, toNationId: true, type: true },
        });
        // 최근 관계가 이전 관계를 덮는다 (canAttack과 같은 기준).
        for (const rel of rels) {
          const other = rel.fromNationId === myNationId ? rel.toNationId : rel.fromNationId;
          relationByNation.set(other, rel.type as Relation);
        }
      }
      const sieges = await prisma.territorySiege.findMany({
        where: { missionKey: ctx.missionKey, gauge: { gt: 0 } },
        select: { castleKey: true, attackerNationId: true, gauge: true },
      });
      for (const sg of sieges) {
        const cur = siegeByCastle.get(sg.castleKey) ?? { gauge: 0, mine: 0 };
        cur.gauge = Math.max(cur.gauge, sg.gauge);
        if (sg.attackerNationId === (myNationId ?? `solo:${userId}`)) cur.mine = sg.gauge;
        siegeByCastle.set(sg.castleKey, cur);
      }
    } catch {
      // 국가 정보 없이 진행
    }
    for (const { key, meta } of parsed) {
      castles.push({
        castleKey: key,
        kind: meta.kind,
        keepLevel: keepByCastle.get(key) ?? 1,
        name: nameByKey.get(key) ?? key,
        owner: meta.owner,
        ownerNickname: meta.owner ? (nickById.get(meta.owner) ?? "") : "",
        dong: meta.dong,
        hp: meta.hp,
        maxHp: meta.maxHp,
        mine: meta.owner === userId,
        nationId: meta.owner ? (nationByUser.get(meta.owner)?.id ?? null) : null,
        nationName: meta.owner ? (nationByUser.get(meta.owner)?.name ?? null) : null,
        nationSolo: meta.owner ? (nationByUser.get(meta.owner)?.solo ?? true) : true,
        relation: (() => {
          const nid = meta.owner ? nationByUser.get(meta.owner)?.id : undefined;
          if (meta.owner === userId) return "mine";
          return nid ? (relationByNation.get(nid) ?? "none") : "none";
        })(),
        siegeGauge: siegeByCastle.get(key)?.gauge ?? 0,
        mySiegeGauge: siegeByCastle.get(key)?.mine ?? 0,
        availableForTraining: meta.owner === userId && meta.status === "active",
      });
    }
    return NextResponse.json({ ok: true, castles, myNationId, regions: regions.map(r => ({
      dong: r.dong, id: r.nationId, name: r.name, relation: relationByNation.get(r.nationId ?? "") ?? "none",
    })) });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
