import { NextResponse } from "next/server";

import { DeclarationError, voteOnNation } from "@/lib/nation-declarations";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

/** 가입 의사도 해당 지역 선포의 유권자·응답 기한 검증을 거친다. */
export async function POST(request: Request): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const body = await request.json().catch(() => null);
  if (typeof body?.declarationId !== "string") {
    return NextResponse.json({ ok: false, message: "성 메뉴에서 국가 선포 요청에 응답해 주세요." }, { status: 409 });
  }
  try {
    await voteOnNation(userId, ctx.missionKey, body.declarationId, true);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof DeclarationError) return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
