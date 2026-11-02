import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  NOBLE_CASTLE_CAP_PER_DONG,
  currentSeasonId,
  ensureCastleSeason,
  parseCastleMeta,
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  serializeCastleMeta,
  territoryDisabledResponse,
  withCastleLock,
  type Tx,
} from "@/lib/territory";

type AppointBody = {
  castleKey?: unknown;
  targetUserId?: unknown;
  action?: unknown;
};

/**
 * 귀족 임명/해임 + 귀족성 승인. 영주성 주체인 영주만 가능.
 * - appoint: 기사+ 대상을 귀족으로 (동당 귀족성 3 상한)
 * - dismiss: 귀족을 기사로 + 해당 귀족성 중립화 (24h 보호는 Phase 5 지도 로그와 함께)
 * - approve_castle: 승인대기 귀족성을 현역화 (castleKey=귀족성 키, target 불필요)
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

  let body: AppointBody;
  try {
    body = (await request.json()) as AppointBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
  const action =
    body.action === "appoint" || body.action === "dismiss" || body.action === "approve_castle"
      ? body.action
      : null;
  if (!castleKey || !action || (action !== "approve_castle" && (!targetUserId || targetUserId === userId))) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withCastleLock(castleKey, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }

      // 귀족성 승인: 같은 동의 영주성 주인이 승인한다
      if (action === "approve_castle") {
        if (castle.meta.kind !== "noble" || castle.meta.status !== "pending") {
          throw new Error("not_pending");
        }
        const seasonId = currentSeasonId();
        const events = await tx.aRMissionEvent.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { string_param1: true },
        });
        const isDongLord = events.some((e) => {
          const meta = parseCastleMeta(e.string_param1);
          return (
            meta &&
            meta.kind === "lord" &&
            meta.dong === castle.meta.dong &&
            meta.seasonId === seasonId &&
            meta.owner === userId
          );
        });
        if (!isDongLord) {
          throw new Error("not_lord");
        }
        const active = { ...castle.meta, status: "active" as const };
        await tx.aRMissionEvent.updateMany({
          where: { EventKey: castleKey, ARMissionKey: ctx.missionKey },
          data: { string_param1: serializeCastleMeta(active) },
        });
        return { approved_castle: true as const };
      }

      if (castle.meta.kind !== "lord" || castle.meta.owner !== userId) {
        throw new Error("not_lord");
      }

      const targetClass = await refreshUserClass(prisma, targetUserId, ctx.missionKey);

      if (action === "appoint") {
        if (targetClass !== "knight" && targetClass !== "noble") {
          throw new Error("target_ineligible");
        }
        if (targetClass === "noble") {
          return { appointed: true as const, already: true as const };
        }
        const seasonId = currentSeasonId();
        const events = await tx.aRMissionEvent.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { string_param1: true },
        });
        const nobleCount = events.filter((e) => {
          const meta = parseCastleMeta(e.string_param1);
          return meta && meta.kind === "noble" && meta.dong === castle.meta.dong && meta.seasonId === seasonId;
        }).length;
        if (nobleCount >= NOBLE_CASTLE_CAP_PER_DONG) {
          throw new Error("limit");
        }
        const updated = await tx.missionTeam.updateMany({
          where: { userId: targetUserId },
          data: { classId: "noble" },
        });
        if (updated.count === 0) {
          throw new Error("target_no_membership");
        }
        return { appointed: true as const, already: false as const };
      }

      // dismiss
      if (targetClass !== "noble") {
        throw new Error("target_not_noble");
      }
      await tx.missionTeam.updateMany({
        where: { userId: targetUserId },
        data: { classId: "knight" },
      });
      // 해당 귀족성 중립화
      const seasonId = currentSeasonId();
      const events = await tx.aRMissionEvent.findMany({
        where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
        select: { EventKey: true, string_param1: true },
      });
      for (const e of events) {
        const meta = parseCastleMeta(e.string_param1);
        if (
          meta &&
          meta.kind === "noble" &&
          meta.dong === castle.meta.dong &&
          meta.seasonId === seasonId &&
          meta.owner === targetUserId
        ) {
          const neutralized = { ...meta, owner: null, hp: meta.maxHp, garrison: 0, status: "active" as const };
          await tx.aRMissionEvent.updateMany({
            where: { EventKey: e.EventKey ?? "", ARMissionKey: ctx.missionKey },
            data: { int_param1: neutralized.maxHp, string_param1: serializeCastleMeta(neutralized) },
          });
        }
      }
      return { dismissed: true as const };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "castle_not_found",
        "not_lord",
        "not_pending",
        "target_ineligible",
        "target_no_membership",
        "target_not_noble",
        "limit",
      ].includes(error.message)
        ? error.message
        : "appoint_failed";
    const status =
      code === "castle_not_found" ? 404 : code === "not_lord" || code === "limit" ? 403 : 400;
    if (code === "appoint_failed") {
      console.error("[castles/appoint] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
