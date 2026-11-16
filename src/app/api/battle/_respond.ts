import { NextResponse } from "next/server";

import { BattleError } from "@/lib/battle-server";
import type { BattleErrorResponse, BattleResponse } from "@/lib/battle";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

/** 전투 라우트 공통: 로그인·영토전 확인 → 처리 → { ok:false, code, message } 오류 형식 */
export async function handleBattleRequest(
  label: string,
  run: (userId: string) => Promise<BattleResponse>,
): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json<BattleErrorResponse>({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }
  try {
    const res = await run(userId);
    return NextResponse.json<BattleResponse>(res);
  } catch (error) {
    if (error instanceof BattleError) {
      return NextResponse.json<BattleErrorResponse>(
        { ok: false, code: error.code, message: error.message },
        { status: error.status },
      );
    }
    console.error(`[battle/${label}] failed`, error);
    return NextResponse.json<BattleErrorResponse>(
      { ok: false, code: "battle_failed", message: "전투 처리 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
