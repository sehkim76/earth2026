import { NextResponse } from "next/server";

import { BattleError, healLordForUser } from "@/lib/battle-server";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

export const dynamic = "force-dynamic";

/** POST /api/battle/heal-lord — 영주 부상 즉시 치료. */
export async function POST(): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }
  try {
    const healed = await healLordForUser(userId);
    return NextResponse.json({ ok: true, healed });
  } catch (error) {
    if (error instanceof BattleError) {
      return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[battle/heal-lord] failed", error);
    return NextResponse.json({ ok: false, code: "heal_failed" }, { status: 500 });
  }
}
