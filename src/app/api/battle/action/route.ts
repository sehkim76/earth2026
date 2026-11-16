import { NextResponse } from "next/server";

import { actForUser } from "@/lib/battle-server";

import { handleBattleRequest, readJsonBody } from "@/app/api/battle/_respond";

/** 플레이어 행동 (BattleActionRequest → BattleResponse). 턴 종료면 AI 턴까지 처리한다. */
export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJsonBody(request);
  return handleBattleRequest("action", (userId) => actForUser(userId, body));
}
