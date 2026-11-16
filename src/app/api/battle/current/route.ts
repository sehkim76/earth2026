import { NextResponse } from "next/server";

import { currentForUser } from "@/lib/battle-server";

import { handleBattleRequest } from "@/app/api/battle/_respond";

export const dynamic = "force-dynamic";

/** 진행 중 전투 (없으면 battle: null, 방금 끝난 전투는 한 번 돌려준다). */
export async function GET(): Promise<NextResponse> {
  return handleBattleRequest("current", (userId) => currentForUser(userId));
}
