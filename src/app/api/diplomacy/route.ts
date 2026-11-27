import { NextResponse } from "next/server";

import {
  approvedNation,
  ALLIANCE_CAP,
  allianceCount,
  canAttack,
  getMyNation,
  expiryFor,
  parseTributePayload,
  type DiplomacyType,
} from "@/lib/nations";
import prisma from "@/lib/prismadb";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

const isDiplomacyType = (v: unknown): v is DiplomacyType =>
  v === "nap" || v === "alliance" || v === "tribute" || v === "war";

/** GET /api/diplomacy — 나와 관련된 외교 목록 (만료 lazy 정산 포함). */
export async function GET() {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const mine = await getMyNation(prisma, userId, ctx.missionKey);
  if (!mine) return NextResponse.json({ ok: true, nationId: null, diplomacy: [] });
  await prisma.territoryDiplomacy.updateMany({
    where: { missionKey: ctx.missionKey, status: "active", expiresAt: { lt: new Date() } },
    data: { status: "expired", decidedAt: new Date() },
  });
  const rows = await prisma.territoryDiplomacy.findMany({
    where: { missionKey: ctx.missionKey, OR: [{ fromNationId: mine.id }, { toNationId: mine.id }] },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({ ok: true, nationId: mine.id, diplomacy: rows });
}

/** POST /api/diplomacy — 제안 { toNationId, type, payload? }. */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { toNationId?: unknown; type?: unknown; payload?: unknown };
  try {
    body = (await request.json()) as { toNationId?: unknown; type?: unknown; payload?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const toNationId = typeof body.toNationId === "string" ? body.toNationId.trim() : "";
  if (!toNationId || !isDiplomacyType(body.type)) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  const type = body.type;

  const mine = await getMyNation(prisma, userId, ctx.missionKey);
  if (!mine) return NextResponse.json({ ok: false, code: "forbidden" }, { status: 403 });
  if (mine.id === toNationId) return NextResponse.json({ ok: false, code: "self" }, { status: 400 });
  const target = await prisma.territoryNation.findFirst({
    where: { id: toNationId, ...approvedNation(ctx.missionKey) },
    select: { id: true },
  });
  if (!target) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  // 리더만 제안 (1인 국가는 본인이 리더라 항상 가능).
  if (mine.myRole !== "leader") return NextResponse.json({ ok: false, code: "forbidden" }, { status: 403 });

  if (type === "alliance") {
    const [a, b] = await Promise.all([
      allianceCount(prisma, ctx.missionKey, mine.id),
      allianceCount(prisma, ctx.missionKey, toNationId),
    ]);
    if (a >= ALLIANCE_CAP || b >= ALLIANCE_CAP) {
      return NextResponse.json({ ok: false, code: "alliance_full" }, { status: 409 });
    }
  }
  if (type === "war" || type === "nap") {
    const gate = await canAttack(prisma, ctx.missionKey, mine.id, toNationId);
    if (type === "war" && !gate.ok) {
      return NextResponse.json({ ok: false, code: "already_blocked", reason: gate.reason }, { status: 409 });
    }
  }
  if (type === "tribute") {
    parseTributePayload(body.payload);
  }

  const row = await prisma.territoryDiplomacy.create({
    data: {
      missionKey: ctx.missionKey,
      fromNationId: mine.id,
      toNationId,
      type,
      status: "pending",
      payload: body.payload === undefined ? null : JSON.stringify(body.payload).slice(0, 2000),
      expiresAt: expiryFor(type),
    },
  });
  return NextResponse.json({ ok: true, diplomacy: row });
}
