import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  DUEL_DAILY_CAP,
  DUEL_DEFENSE_MULT,
  DUEL_TENURE_BONUS,
  castleAgeDays,
  classAtLeast,
  ensureCastleSeason,
  haversineM,
  readBestScores,
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
  type Tx,
} from "@/lib/territory";

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type ChallengeBody = {
  castleKey?: unknown;
  lat?: unknown;
  lon?: unknown;
};

/**
 * 비동기 결투 신청 (약탈전. 영토 이전 없음).
 * - 기사 이상, 유주성, 도전자는 성 500m 이내 GPS
 * - 1인 1일 3회
 * - 신청 후 미니게임 플레이 → duel-resolve로 결산
 */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: ChallengeBody;
  try {
    body = (await request.json()) as ChallengeBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const lat = parseNumber(body.lat);
  const lon = parseNumber(body.lon);
  if (!castleKey || lat === null || lon === null) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  const klass = await refreshUserClass(prisma, userId, ctx.missionKey);
  if (!classAtLeast(klass, "knight")) {
    return NextResponse.json({ ok: false, code: "class_ineligible" }, { status: 403 });
  }

  try {
    const result = await withNamedLock(`duel:${userId}`, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.status !== "active") {
        throw new Error("castle_pending");
      }
      if (!castle.meta.owner || castle.meta.owner === userId) {
        throw new Error("no_defender");
      }
      if (haversineM(lat, lon, castle.lat, castle.lon) > 500) {
        throw new Error("out_of_range");
      }

      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const challenges = await tx.prefabInstanceTable.count({
        where: {
          ARMissionKey: ctx.missionKey,
          userId,
          string_param1: "duel-challenge",
          LastOpTime: { gte: since },
        },
      });
      if (challenges >= DUEL_DAILY_CAP) {
        throw new Error("daily_cap");
      }

      const battleId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await tx.prefabInstanceTable.create({
        data: {
          ARMissionKey: ctx.missionKey,
          PrefabEventId: castleKey,
          userId,
          InstanceId: battleId,
          LastOpTime: new Date(),
          string_param1: "duel-challenge",
          string_param2: castle.meta.owner,
          string_param3: "",
          string_param4: "",
          string_param5: "",
          string_param6: "",
        },
      });

      // 수비력 미리보기: 수비자 직전 7일 전 종목 최고
      const bests = await readBestScores(tx, castle.meta.owner, ctx.missionKey, Date.now() - 7 * 24 * 3600 * 1000);
      const top = bests.sort((a, b) => b.score - a.score)[0] ?? null;
      const tenure = castleAgeDays(castle) >= 3 ? DUEL_TENURE_BONUS : 0;
      return {
        battleId,
        defensePreview:
          top !== null
            ? {
                eventKey: top.eventKey,
                power: Math.floor(top.score / 1000) * DUEL_DEFENSE_MULT + tenure,
              }
            : null,
      };
    });

    return NextResponse.json({ ok: true, castleKey, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      ["castle_not_found", "castle_pending", "no_defender", "out_of_range", "daily_cap"].includes(
        error.message,
      )
        ? error.message
        : "challenge_failed";
    const status =
      code === "castle_not_found"
        ? 404
        : code === "no_defender"
          ? 409
          : code === "daily_cap"
            ? 429
            : 400;
    if (code === "challenge_failed") {
      console.error("[territory/challenge] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
