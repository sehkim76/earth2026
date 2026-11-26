import { NextResponse } from "next/server";

import { canAttack, ensureMyNation, siegeGain } from "@/lib/nations";
import prisma from "@/lib/prismadb";
import {
  clearSiegeGauges,
  conquerCastle,
  ensureCastleSeason,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
} from "@/lib/territory";

/** GET /api/siege?castleKey= — 해당 성의 국가별 게이지. */
export async function GET(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const castleKey = new URL(request.url).searchParams.get("castleKey")?.trim() ?? "";
  if (!castleKey) return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  const rows = await prisma.territorySiege.findMany({ where: { missionKey: ctx.missionKey, castleKey } });
  return NextResponse.json({ ok: true, castleKey, gauges: rows });
}

/** POST /api/siege/report — { castleKey, won } 승리/패배 기여 적립. 100 도달 시 정복. */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { castleKey?: unknown; won?: unknown };
  try {
    body = (await request.json()) as { castleKey?: unknown; won?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const won = body.won;
  if (!castleKey || typeof won !== "boolean") {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  try {
    const result = await withNamedLock(`siege:${ctx.missionKey}:${castleKey}`, async (tx) => {
      const mine = await ensureMyNation(tx, userId, ctx.missionKey);
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) throw new Error("castle_not_found");
      if (castle.meta.status !== "active") throw new Error("castle_pending");
      if (castle.meta.owner === userId) throw new Error("own_castle");

      // 수비 측 국가를 찾아 외교 게이트 검사 (국가 없으면 중립 → 공격 가능).
      if (castle.meta.owner) {
        const defender = await tx.territoryNationMember.findFirst({
          where: { userId: castle.meta.owner, nation: { missionKey: ctx.missionKey } },
          select: { nationId: true },
        });
        if (defender && defender.nationId !== mine.id) {
          const gate = await canAttack(tx, ctx.missionKey, mine.id, defender.nationId);
          if (!gate.ok) throw new Error(`blocked:${gate.reason}`);
        }
      }

      // 패배해도 절반 기여(하한 +5).
      const gain = siegeGain(mine.isSolo, won);
      const existing = await tx.territorySiege.findUnique({
        where: { missionKey_castleKey_attackerNationId: { missionKey: ctx.missionKey, castleKey, attackerNationId: mine.id } },
      });
      const next = Math.min(100, (existing?.gauge ?? 0) + gain);
      await tx.territorySiege.upsert({
        where: { missionKey_castleKey_attackerNationId: { missionKey: ctx.missionKey, castleKey, attackerNationId: mine.id } },
        create: { missionKey: ctx.missionKey, castleKey, attackerNationId: mine.id, gauge: next },
        update: { gauge: next },
      });
      if (next < 100) {
        return { gauge: next, conquered: false, nationId: mine.id, solo: mine.isSolo };
      }
      const conquered = await conquerCastle(tx, ctx.missionKey, castle, userId);
      await clearSiegeGauges(tx, ctx.missionKey, castleKey);
      return { gauge: next, conquered: true, nationId: mine.id, solo: mine.isSolo, prevOwner: conquered.prevOwner };
    });
    return NextResponse.json({ ok: true, castleKey, ...result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const status =
      code === "castle_not_found"
        ? 404
        : code === "castle_pending" || code === "own_castle" || code.startsWith("blocked:")
          ? 409
          : 400;
    return NextResponse.json({ ok: false, code }, { status });
  }
}
