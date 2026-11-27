import { NextResponse } from "next/server";

import { DeclarationError, declarationInbox, proposeNation, voteOnNation } from "@/lib/nation-declarations";
import { settleExpiredDeclarations } from "@/lib/nation-ratification";
import { getMyNation } from "@/lib/nations";
import prisma from "@/lib/prismadb";
import { ensureDongBoundary, setRasterBaseUrl } from "@/lib/server-walkable";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

export async function GET(): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  try {
    await settleExpiredDeclarations(ctx.missionKey);
    const [nation, declarations] = await Promise.all([
      getMyNation(prisma, userId, ctx.missionKey), declarationInbox(userId, ctx.missionKey),
    ]);
    const members = nation ? await prisma.territoryNationMember.findMany({
      where: { nationId: nation.id }, select: { userId: true, role: true },
    }) : [];
    return NextResponse.json({ ok: true, nation: nation ? { ...nation, members } : null, declarations });
  } catch (error) {
    console.error("[nation-inbox]", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const body = await request.json().catch(() => null);
  try {
    if (body?.action === "vote" && typeof body.id === "string" && typeof body.consent === "boolean") {
      await voteOnNation(userId, ctx.missionKey, body.id, body.consent);
    } else if (body?.action === "propose" && typeof body.castleKey === "string" && typeof body.name === "string") {
      const name = body.name.trim();
      if (name.length < 2 || name.length > 30) throw new DeclarationError(400, "국호를 2~30자로 입력해 주세요.");
      setRasterBaseUrl(new URL(request.url).origin);
      await ensureDongBoundary();
      await proposeNation(userId, ctx.missionKey, body.castleKey, name);
    } else throw new DeclarationError(400, "선포 또는 투표 내용을 확인해 주세요.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof DeclarationError) return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
    console.error("[nation-declaration]", error);
    return NextResponse.json({ ok: false, message: "국가 선포 내용을 저장하지 못했습니다." }, { status: 500 });
  }
}
