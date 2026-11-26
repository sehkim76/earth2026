import { NextResponse } from "next/server";

import { ensureMyNation, foundNation } from "@/lib/nations";
import prisma from "@/lib/prismadb";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

/** GET /api/nations — 내 국가 (없으면 1인 국가 자동 생성). */
export async function GET() {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const nation = await ensureMyNation(prisma, userId, ctx.missionKey);
  const members = await prisma.territoryNationMember.findMany({
    where: { nationId: nation.id },
    select: { userId: true, role: true },
  });
  return NextResponse.json({ ok: true, nation: { ...nation, members } });
}

/** POST /api/nations — 정식 국가 선포 { name }. */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim().length < 2) {
    return NextResponse.json({ ok: false, code: "invalid_name" }, { status: 400 });
  }
  try {
    const nation = await foundNation(userId, ctx.missionKey, body.name);
    return NextResponse.json({ ok: true, nation });
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const status = code === "already_in_nation" ? 409 : 400;
    return NextResponse.json({ ok: false, code }, { status });
  }
}
