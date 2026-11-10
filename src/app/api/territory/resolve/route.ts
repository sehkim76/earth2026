import { NextResponse } from "next/server";

import { loadUnits, withUnits } from "@/lib/units";
import {
  applyCastleDamage,
  ensureCastleSeason,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withCastleLock,
  type Tx,
} from "@/lib/territory";

const HIT_WINDOW_MS = 15 * 60 * 1000;

type ResolveBody = {
  castleKey?: unknown;
  scoreId?: unknown;
};

/**
 * 공성 1타 판정. 정답 제출(updatescore → scoreId) 직후 호출한다.
 * - scoreId로 해당 hit 1회를 정확히 1번만 적용 (멱등, PrefabInstanceTable 원장)
 * - GET_LOCK(castle) 으로 막타 동시 충돌 원자화
 * - HP 0 → 정복 (applyCastleDamage) + 주둔 부대 자동 귀환
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

  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const scoreId =
    typeof body.scoreId === "number" && Number.isFinite(body.scoreId)
      ? Math.trunc(body.scoreId)
      : null;
  if (!castleKey || scoreId === null) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withCastleLock(castleKey, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.status !== "active") {
        throw new Error("castle_pending");
      }
      if (castle.meta.owner === userId) {
        throw new Error("own_castle");
      }

      // 멱등: 같은 scoreId 재호출은 현재 HP만 반환
      const replay = await tx.prefabInstanceTable.findFirst({
        where: {
          ARMissionKey: ctx.missionKey,
          PrefabEventId: castleKey,
          userId,
          InstanceId: String(scoreId),
          string_param1: "siege-applied",
        },
        select: { id: true },
      });
      if (replay) {
        return { hp: castle.meta.hp, maxHp: castle.meta.maxHp, conquered: false, replay: true };
      }

      // hit 검증: 본인의 siege:hit 행 + 15분 이내
      const hit = await tx.aRMissionUserScore.findFirst({
        where: {
          ScoreId: scoreId,
          UserId: userId,
          EventKey: castleKey,
          ARMissionKey: ctx.missionKey,
          answer: { startsWith: "siege:hit:" },
        },
        select: { scoredate: true },
      });
      if (!hit) {
        throw new Error("invalid_hit");
      }
      if (!(hit.scoredate instanceof Date) || Date.now() - hit.scoredate.getTime() > HIT_WINDOW_MS) {
        throw new Error("stale_hit");
      }

      const damage = await applyCastleDamage(tx, ctx.missionKey, castle, userId);

      await tx.prefabInstanceTable.create({
        data: {
          ARMissionKey: ctx.missionKey,
          PrefabEventId: castleKey,
          userId,
          InstanceId: String(scoreId),
          LastOpTime: new Date(),
          string_param1: "siege-applied",
          string_param2: "",
          string_param3: "",
          string_param4: "",
          string_param5: "",
          string_param6: "",
        },
      });

      // 정복 시 이전 주인의 주둔 부대 자동 귀환
      if (damage.conquered && damage.prevOwner && damage.prevOwner !== userId) {
        const prev = await tx.missionUser.findUnique({
          where: { userId: damage.prevOwner },
          select: { data: true },
        });
        const units = loadUnits(prev?.data);
        let changed = false;
        const next = units.map((s) => {
          if (s.state === "garrisoned" && s.castleKey === castleKey) {
            changed = true;
            return {
              ...s,
              state: "field" as const,
              castleKey: null,
              lat: s.hq.lat,
              lon: s.hq.lon,
              lastMoveAt: Date.now(),
            };
          }
          return s;
        });
        if (changed) {
          await tx.missionUser.update({
            where: { userId: damage.prevOwner },
            data: { data: withUnits(prev?.data, next) },
          });
        }
      }

      return {
        hp: damage.hp,
        maxHp: damage.maxHp,
        conquered: damage.conquered,
        replay: false,
        prevOwner: damage.prevOwner,
      };
    });

    return NextResponse.json({ ok: true, castleKey, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      ["castle_not_found", "castle_pending", "own_castle", "invalid_hit", "stale_hit"].includes(
        error.message,
      )
        ? error.message
        : "resolve_failed";
    const status = code === "castle_not_found" ? 404 : code === "own_castle" ? 403 : 400;
    if (code === "resolve_failed") {
      console.error("[territory/resolve] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
