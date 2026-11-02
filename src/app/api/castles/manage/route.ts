import { NextResponse } from "next/server";

import {
  GATE_REPAIR_COST,
  ensureCastleSeason,
  parseCastleSettings,
  requireSessionUserId,
  resolveTerritoryContext,
  spendInfluence,
  territoryDisabledResponse,
  withCastleLock,
  type Tx,
} from "@/lib/territory";

type ManageBody = {
  castleKey?: unknown;
  difficulty?: unknown;
  joinMode?: unknown;
};

/**
 * 성 관리 (W6용). 성 주인만 가능.
 * - difficulty: 성문 난이도 범위 변경 (100 소모)
 * - joinMode: auto/manual 전환 (무료)
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

  let body: ManageBody;
  try {
    body = (await request.json()) as ManageBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const joinMode = body.joinMode === "auto" || body.joinMode === "manual" ? body.joinMode : null;
  const difficulty = Array.isArray(body.difficulty)
    ? body.difficulty.map(Number)
    : null;
  if (!castleKey || (joinMode === null && difficulty === null)) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  if (
    difficulty !== null &&
    !(
      difficulty.length >= 2 &&
      difficulty.every((n) => Number.isFinite(n) && n >= 1 && n <= 5)
    )
  ) {
    return NextResponse.json({ ok: false, code: "invalid_difficulty" }, { status: 400 });
  }

  try {
    const result = await withCastleLock(castleKey, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.owner !== userId) {
        throw new Error("not_owner");
      }

      const row = await tx.aRMissionEvent.findFirst({
        where: { EventKey: castleKey, ARMissionKey: ctx.missionKey },
        select: { string_param2: true },
      });
      const settings = parseCastleSettings(row?.string_param2);
      let changed = false;

      if (difficulty !== null) {
        const lo = Math.max(1, Math.min(5, Math.trunc(difficulty[0])));
        const hi = Math.max(1, Math.min(5, Math.trunc(difficulty[1])));
        const next: [number, number] = [Math.min(lo, hi), Math.max(lo, hi)];
        if (next[0] !== settings.difficulty[0] || next[1] !== settings.difficulty[1]) {
          const paid = await spendInfluence(tx, userId, GATE_REPAIR_COST);
          if (!paid) {
            throw new Error("funds");
          }
          settings.difficulty = next;
          changed = true;
        }
      }
      if (joinMode !== null && joinMode !== settings.joinMode) {
        settings.joinMode = joinMode;
        changed = true;
      }

      if (changed) {
        await tx.aRMissionEvent.updateMany({
          where: { EventKey: castleKey, ARMissionKey: ctx.missionKey },
          data: { string_param2: JSON.stringify(settings).slice(0, 1200) },
        });
      }
      return { difficulty: settings.difficulty, joinMode: settings.joinMode, changed };
    });
    return NextResponse.json({ ok: true, castleKey, ...result });
  } catch (error) {
    const code =
      error instanceof Error && ["castle_not_found", "not_owner", "funds"].includes(error.message)
        ? error.message
        : "manage_failed";
    const status =
      code === "castle_not_found" ? 404 : code === "not_owner" ? 403 : code === "funds" ? 402 : 500;
    if (code === "manage_failed") {
      console.error("[castles/manage] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
