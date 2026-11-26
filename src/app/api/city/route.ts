import { NextResponse } from "next/server";

import { CityError, runCity } from "@/lib/city-server";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

export const dynamic = "force-dynamic";

/** GET /api/city — 내 영주성 내정 상태 (생산·완료 작업·귀환 일꾼을 정산한 뒤). */
export async function GET(): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  try {
    const v = await runCity(userId, ctx.missionKey, null);
    return NextResponse.json({ ok: true, ...v });
  } catch (error) {
    if (error instanceof CityError) {
      return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[city] GET failed", error);
    return NextResponse.json({ ok: false, code: "city_failed" }, { status: 500 });
  }
}
