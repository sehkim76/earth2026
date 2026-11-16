import { NextResponse } from "next/server";

import type { BattleErrorResponse, CommandersResponse } from "@/lib/battle";
import { BattleError, commandersForUser } from "@/lib/battle-server";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

export const dynamic = "force-dynamic";

/** 지휘관 선택창: 영주 + 내 부대의 레벨·출전 가능 여부·부상 해제 시각. */
export async function GET(): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json<BattleErrorResponse>({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }
  try {
    return NextResponse.json<CommandersResponse>(await commandersForUser(userId));
  } catch (error) {
    if (error instanceof BattleError) {
      return NextResponse.json<BattleErrorResponse>({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[battle/commanders] failed", error);
    return NextResponse.json<BattleErrorResponse>({ ok: false, code: "battle_failed" }, { status: 500 });
  }
}
