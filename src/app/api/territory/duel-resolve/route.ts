import { NextResponse } from "next/server";

import {
  DUEL_CLASS_BONUS,
  DUEL_DEFENSE_MULT,
  DUEL_DEFENSE_REWARD,
  DUEL_LOSS_COST,
  DUEL_LOOT_SHARE,
  DUEL_PRESENCE_BONUS,
  DUEL_ROLL_GRACE_MS,
  DUEL_TENURE_BONUS,
  castleAgeDays,
  classAtLeast,
  ensureCastleSeason,
  getInfluence,
  grantInfluence,
  haversineM,
  loseInfluence,
  readBestScores,
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  spendInfluence,
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

type DuelResolveBody = {
  battleId?: unknown;
  lat?: unknown;
  lon?: unknown;
};

/**
 * 비동기 결투 결산. 신청 이후 플레이한 미니게임 최고 기록을 공격 주사위로 사용한다.
 * - 동일 종목으로 비교 (수비자는 해당 종목 직전 7일 최고)
 * - 승리: 수비 영향력 30% 약탈 / 패배: 공격자 -100, 수비자 공헌 +50
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

  let body: DuelResolveBody;
  try {
    body = (await request.json()) as DuelResolveBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const battleId = typeof body.battleId === "string" ? body.battleId.trim() : "";
  const lat = parseNumber(body.lat);
  const lon = parseNumber(body.lon);
  if (!battleId) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withNamedLock(`duel:${battleId}`, async (tx: Tx) => {
      const challenge = await tx.prefabInstanceTable.findFirst({
        where: {
          ARMissionKey: ctx.missionKey,
          userId,
          InstanceId: battleId,
          string_param1: "duel-challenge",
        },
        select: { PrefabEventId: true, string_param2: true, LastOpTime: true },
      });
      if (!challenge?.PrefabEventId || !challenge.string_param2) {
        throw new Error("invalid_battle");
      }
      if (
        !(challenge.LastOpTime instanceof Date) ||
        Date.now() - challenge.LastOpTime.getTime() > 24 * 3600 * 1000
      ) {
        throw new Error("battle_expired");
      }
      const castleKey = challenge.PrefabEventId;
      const defenderId = challenge.string_param2;

      const resolved = await tx.prefabInstanceTable.findFirst({
        where: {
          ARMissionKey: ctx.missionKey,
          userId,
          InstanceId: battleId,
          string_param1: "duel-resolved",
        },
        select: { id: true },
      });
      if (resolved) {
        throw new Error("already_resolved");
      }

      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle || castle.meta.owner !== defenderId) {
        throw new Error("defender_changed");
      }

      // 공격 주사위: 신청 이후 미니게임 최고 기록
      const attackRolls = await readBestScores(
        tx,
        userId,
        ctx.missionKey,
        challenge.LastOpTime.getTime() - DUEL_ROLL_GRACE_MS,
      );
      const attackRoll = attackRolls.sort((a, b) => b.score - a.score)[0] ?? null;
      if (!attackRoll) {
        throw new Error("no_roll");
      }

      const defenseBests = await readBestScores(
        tx,
        defenderId,
        ctx.missionKey,
        Date.now() - 7 * 24 * 3600 * 1000,
      );
      const defenseRoll = defenseBests.find((b) => b.eventKey === attackRoll.eventKey) ?? null;

      const klass = await refreshUserClass(tx, userId, ctx.missionKey);
      const present =
        lat !== null &&
        lon !== null &&
        haversineM(lat, lon, castle.lat, castle.lon) <= 500;
      const attack =
        Math.floor(attackRoll.score / 1000) +
        (present ? DUEL_PRESENCE_BONUS : 0) +
        (classAtLeast(klass, "noble") ? DUEL_CLASS_BONUS : 0);
      const defense =
        Math.floor((defenseRoll?.score ?? 0) / 1000) * DUEL_DEFENSE_MULT +
        (castleAgeDays(castle) >= 3 ? DUEL_TENURE_BONUS : 0);

      const won = attack > defense;

      await tx.prefabInstanceTable.create({
        data: {
          ARMissionKey: ctx.missionKey,
          PrefabEventId: castleKey,
          userId,
          InstanceId: battleId,
          LastOpTime: new Date(),
          string_param1: "duel-resolved",
          string_param2: defenderId,
          string_param3: won ? "win" : "loss",
          string_param4: "",
          string_param5: "",
          string_param6: "",
        },
      });

      let loot = 0;
      if (won) {
        const defenderInfluence = await getInfluence(tx, defenderId);
        loot = Math.floor(defenderInfluence * DUEL_LOOT_SHARE);
        if (loot > 0 && (await spendInfluence(tx, defenderId, loot))) {
          await grantInfluence(tx, userId, loot);
        } else {
          loot = 0;
        }
        await tx.aRMissionUserScore.create({
          data: {
            UserId: userId,
            EventKey: castleKey,
            ARMissionKey: ctx.missionKey,
            answer: `duel:win:${battleId}`.slice(0, 120),
            score: 0,
            scoredate: new Date(),
            islastscore: 0,
          },
        });
      } else {
        await loseInfluence(tx, userId, DUEL_LOSS_COST);
        await tx.aRMissionUserScore.create({
          data: {
            UserId: defenderId,
            EventKey: castleKey,
            ARMissionKey: ctx.missionKey,
            answer: `duel:defense:${battleId}`.slice(0, 120),
            score: DUEL_DEFENSE_REWARD,
            scoredate: new Date(),
            islastscore: 1,
          },
        });
        await tx.aRMissionUserScore.create({
          data: {
            UserId: userId,
            EventKey: castleKey,
            ARMissionKey: ctx.missionKey,
            answer: `duel:loss:${battleId}`.slice(0, 120),
            score: 0,
            scoredate: new Date(),
            islastscore: 0,
          },
        });
      }

      return {
        won,
        attack,
        defense: Math.round(defense * 10) / 10,
        loot,
        attackEvent: attackRoll.eventKey,
      };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      ["invalid_battle", "battle_expired", "already_resolved", "defender_changed", "no_roll"].includes(
        error.message,
      )
        ? error.message
        : "duel_failed";
    const status = code === "already_resolved" ? 409 : 400;
    if (code === "duel_failed") {
      console.error("[territory/duel-resolve] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
