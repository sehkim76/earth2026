import { NextResponse } from "next/server";

import { startBattleForUser } from "@/lib/battle-server";

import { handleBattleRequest, readJsonBody } from "@/app/api/battle/_respond";

/** 무법자 전투 시작 (StartBattleRequest → BattleResponse). 진행 중 전투가 있으면 그것을 돌려준다. */
export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJsonBody(request);
  return handleBattleRequest("start", (userId) => startBattleForUser(userId, body));
}
