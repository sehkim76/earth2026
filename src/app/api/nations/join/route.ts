import { NextResponse } from "next/server";

import { getMyNation } from "@/lib/nations";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse, withNamedLock } from "@/lib/territory";

/** POST /api/nations/join — { nationId }로 이적 (1인 국가는 자동 정리). */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { nationId?: unknown };
  try {
    body = (await request.json()) as { nationId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const nationId = typeof body.nationId === "string" ? body.nationId.trim() : "";
  if (!nationId) return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });

  try {
    const result = await withNamedLock(`nation-join:${userId}`, async (tx) => {
      const target = await tx.territoryNation.findFirst({
        where: { id: nationId, missionKey: ctx.missionKey },
        select: { id: true, name: true },
      });
      if (!target) throw new Error("not_found");
      const current = await getMyNation(tx, userId, ctx.missionKey);
      if (current?.id === target.id) throw new Error("already_member");
      if (current) {
        await tx.territoryNationMember.deleteMany({ where: { nationId: current.id, userId } });
        const left = await tx.territoryNationMember.count({ where: { nationId: current.id } });
        if (left === 0) {
          await tx.territoryDiplomacy.deleteMany({
            where: { missionKey: ctx.missionKey, OR: [{ fromNationId: current.id }, { toNationId: current.id }] },
          });
          await tx.territoryNation.delete({ where: { id: current.id } });
        }
      }
      await tx.territoryNationMember.create({ data: { nationId: target.id, userId, role: "member" } });
      return target;
    });
    return NextResponse.json({ ok: true, nation: result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const status = code === "not_found" ? 404 : code === "already_member" ? 409 : 400;
    return NextResponse.json({ ok: false, code }, { status });
  }
}
