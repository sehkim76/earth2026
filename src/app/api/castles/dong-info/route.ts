import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  currentSeasonId,
  parseCastleMeta,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

/** 동의 이번 시즌 성 현황 (축성 사전 검증용). */
export async function GET(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  const { searchParams } = new URL(request.url);
  const dongCode = (searchParams.get("dongCode") ?? "").trim().slice(0, 64);
  if (!dongCode) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const seasonId = currentSeasonId();
    const events = await prisma.aRMissionEvent.findMany({
      where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
      select: { EventKey: true, string_param1: true },
    });
    let lordCount = 0;
    let nobleCount = 0;
    for (const event of events) {
      const meta = parseCastleMeta(event.string_param1);
      if (!meta || meta.dong !== dongCode || meta.seasonId !== seasonId) {
        continue;
      }
      if (meta.kind === "lord") {
        lordCount += 1;
      } else {
        nobleCount += 1;
      }
    }
    return NextResponse.json({ ok: true, lordCount, nobleCount });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
