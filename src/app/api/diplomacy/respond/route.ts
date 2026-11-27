import { NextResponse } from "next/server";

import { approvedNation, ALLIANCE_CAP, allianceCount, getMyNation, parseTributePayload } from "@/lib/nations";
import {
  clearSiegeGauges,
  conquerCastle,
  ensureCastleSeason,
  grantInfluence,
  requireSessionUserId,
  resolveTerritoryContext,
  spendInfluence,
  territoryDisabledResponse,
  withNamedLock,
} from "@/lib/territory";

/** POST /api/diplomacy/respond — { diplomacyId, accept } (받는 측 리더만). */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { diplomacyId?: unknown; accept?: unknown };
  try {
    body = (await request.json()) as { diplomacyId?: unknown; accept?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const diplomacyId = typeof body.diplomacyId === "string" ? body.diplomacyId.trim() : "";
  if (!diplomacyId || typeof body.accept !== "boolean") {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withNamedLock(`diplomacy:${diplomacyId}`, async (tx) => {
      const mine = await getMyNation(tx, userId, ctx.missionKey);
      if (!mine) throw new Error("forbidden");
      if (mine.myRole !== "leader") throw new Error("forbidden");
      const row = await tx.territoryDiplomacy.findFirst({
        where: { id: diplomacyId, missionKey: ctx.missionKey, toNationId: mine.id, status: "pending" },
      });
      if (!row) throw new Error("not_found");

      if (!body.accept) {
        return tx.territoryDiplomacy.update({
          where: { id: row.id },
          data: { status: "rejected", decidedAt: new Date() },
        });
      }

      if (row.type === "alliance") {
        const [a, b] = await Promise.all([
          allianceCount(tx, ctx.missionKey, row.fromNationId),
          allianceCount(tx, ctx.missionKey, row.toNationId),
        ]);
        if (a >= ALLIANCE_CAP || b >= ALLIANCE_CAP) throw new Error("alliance_full");
        return tx.territoryDiplomacy.update({
          where: { id: row.id },
          data: { status: "active", decidedAt: new Date(), payload: JSON.stringify({ reinforcements: [] }) },
        });
      }

      if (row.type === "war") {
        // 선전포고 수락 = 예고 종료 후 전쟁 상태 유지 (만료 없음, 파기·평화로 종료).
        return tx.territoryDiplomacy.update({
          where: { id: row.id },
          data: { status: "active", decidedAt: new Date(), expiresAt: null },
        });
      }

      if (row.type === "tribute") {
        // 조공 이행: 영향력 이전 + 성 할양(지정 시). 제안국(From)이 바친다.
        const tribute = parseTributePayload(row.payload ? safeParse(row.payload) : null);
        const fromNation = await tx.territoryNation.findUnique({
          where: { id: row.fromNationId },
          select: { leaderUserId: true },
        });
        const toNation = await tx.territoryNation.findUnique({
          where: { id: row.toNationId },
          select: { leaderUserId: true },
        });
        if (!fromNation || !toNation) throw new Error("nation_gone");
        if (tribute.influence && tribute.influence > 0) {
          const ok = await spendInfluence(tx, fromNation.leaderUserId, tribute.influence);
          if (!ok) throw new Error("funds");
          await grantInfluence(tx, toNation.leaderUserId, tribute.influence);
        }
        if (tribute.castleKey) {
          const castle = await ensureCastleSeason(tx, tribute.castleKey, ctx.missionKey);
          if (!castle) throw new Error("castle_not_found");
          const holder = await tx.territoryNationMember.findFirst({
            where: { userId: castle.meta.owner ?? "", nation: approvedNation(ctx.missionKey) },
            select: { nationId: true },
          });
          if (!holder || holder.nationId !== row.fromNationId) throw new Error("not_held");
          await conquerCastle(tx, ctx.missionKey, castle, toNation.leaderUserId, { skipShare: true });
          await clearSiegeGauges(tx, ctx.missionKey, tribute.castleKey);
        }
        return tx.territoryDiplomacy.update({
          where: { id: row.id },
          data: { status: "active", decidedAt: new Date() },
        });
      }

      // nap: 그대로 유효화.
      return tx.territoryDiplomacy.update({
        where: { id: row.id },
        data: { status: "active", decidedAt: new Date() },
      });
    });
    return NextResponse.json({ ok: true, diplomacy: result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const status =
      code === "not_found"
        ? 404
        : code === "forbidden"
          ? 403
          : code === "alliance_full"
            ? 409
            : code === "funds"
              ? 402
              : 400;
    if (code === "failed") console.error("[diplomacy] respond failed", error);
    return NextResponse.json({ ok: false, code }, { status });
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

