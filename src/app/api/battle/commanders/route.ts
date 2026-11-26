import { NextResponse } from "next/server";

import type { BattleErrorResponse, CommandersResponse } from "@/lib/battle";
import prisma from "@/lib/prismadb";
import { BattleError, commandersForUser } from "@/lib/battle-server";
import { troopTotal } from "@/lib/city";
import { readTroopBonuses } from "@/lib/city-server";
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
    const res = await commandersForUser(userId);
    // 배치 병력 보정을 붙인다 (편성 화면·지도 예상 승률)
    try {
      const t = await readTroopBonuses(prisma, userId);
      res.commanders = res.commanders.map((c) => {
        const b = t.bonus[c.id];
        return b ? { ...c, bonusHp: b.hp, bonusAtk: b.atk, troopCount: troopTotal(t.troops[c.id]) } : c;
      });
    } catch {
      // 성 데이터 없이 진행
    }
    return NextResponse.json<CommandersResponse>(res);
  } catch (error) {
    if (error instanceof BattleError) {
      return NextResponse.json<BattleErrorResponse>({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[battle/commanders] failed", error);
    return NextResponse.json<BattleErrorResponse>({ ok: false, code: "battle_failed" }, { status: 500 });
  }
}
