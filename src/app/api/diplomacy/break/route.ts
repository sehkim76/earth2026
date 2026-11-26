import { NextResponse } from "next/server";

import { ensureMyNation } from "@/lib/nations";
import {
  clearAllianceReinforcements,
  getInfluence,
  loseInfluence,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
} from "@/lib/territory";

/** POST /api/diplomacy/break — { diplomacyId } 파기. 리더만, 파기 측 영향력 -20%. */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { diplomacyId?: unknown };
  try {
    body = (await request.json()) as { diplomacyId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const diplomacyId = typeof body.diplomacyId === "string" ? body.diplomacyId.trim() : "";
  if (!diplomacyId) return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });

  try {
    const result = await withNamedLock(`diplomacy:${diplomacyId}`, async (tx) => {
      const mine = await ensureMyNation(tx, userId, ctx.missionKey);
      if (mine.myRole !== "leader") throw new Error("forbidden");
      const row = await tx.territoryDiplomacy.findFirst({
        where: { id: diplomacyId, missionKey: ctx.missionKey, status: "active" },
      });
      if (!row) throw new Error("not_found");
      if (row.fromNationId !== mine.id && row.toNationId !== mine.id) throw new Error("forbidden");

      // 배신 페널티: 파기 측(요청자) 영향력 -20% (원군은 귀환).
      const current = await getInfluence(tx, userId);
      const penalty = Math.floor(current * 0.2);
      if (penalty > 0) await loseInfluence(tx, userId, penalty);
      if (row.type === "alliance") await clearAllianceReinforcements(tx, row.id);
      const updated = await tx.territoryDiplomacy.update({
        where: { id: row.id },
        data: { status: "broken", decidedAt: new Date() },
      });
      return { diplomacy: updated, penalty };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const status = code === "not_found" ? 404 : code === "forbidden" ? 403 : 400;
    return NextResponse.json({ ok: false, code }, { status });
  }
}
