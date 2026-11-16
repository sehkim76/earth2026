import { NextResponse } from "next/server";

import {
  ensureCastleSeason,
  parseCastleSettings,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withCastleLock,
  type Tx,
} from "@/lib/territory";

type ManageBody = {
  castleKey?: unknown;
  joinMode?: unknown;
};

/**
 * 성 관리 (W6용). 성 주인만 가능.
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
  if (!castleKey || joinMode === null) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
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

      if (joinMode !== settings.joinMode) {
        settings.joinMode = joinMode;
        changed = true;
      }

      if (changed) {
        await tx.aRMissionEvent.updateMany({
          where: { EventKey: castleKey, ARMissionKey: ctx.missionKey },
          data: { string_param2: JSON.stringify(settings).slice(0, 1200) },
        });
      }
      return { joinMode: settings.joinMode, changed };
    });
    return NextResponse.json({ ok: true, castleKey, ...result });
  } catch (error) {
    const code =
      error instanceof Error && ["castle_not_found", "not_owner"].includes(error.message)
        ? error.message
        : "manage_failed";
    const status =
      code === "castle_not_found" ? 404 : code === "not_owner" ? 403 : 500;
    if (code === "manage_failed") {
      console.error("[castles/manage] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
