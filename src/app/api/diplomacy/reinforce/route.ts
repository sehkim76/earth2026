import { NextResponse } from "next/server";

import { approvedNation, getMyNation } from "@/lib/nations";
import { loadUnits, withUnits } from "@/lib/units";
import {
  ensureCastleSeason,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
} from "@/lib/territory";

interface Reinforcement {
  castleKey: string;
  unitId: string;
  lenderUserId: string;
}

function parsePayload(raw: string | null | undefined): Reinforcement[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { reinforcements?: unknown };
    if (!Array.isArray(v?.reinforcements)) return [];
    return (v.reinforcements as unknown[]).filter(
      (r): r is Reinforcement =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { castleKey?: unknown }).castleKey === "string" &&
        typeof (r as { unitId?: unknown }).unitId === "string" &&
        typeof (r as { lenderUserId?: unknown }).lenderUserId === "string",
    );
  } catch {
    return [];
  }
}

/**
 * POST /api/diplomacy/reinforce — 원군 1슬롯 파견/회수.
 * { allianceId, castleKey, unitId, action: "lend" | "recall" }
 * - lend: 동맹 상대 성에 내 부대 1기를 주둔. 성당 1슬롯, 동맹당 최대 3기.
 * - recall: 파견자가 언제든 회수 (동맹 상태 무관).
 */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: { allianceId?: unknown; castleKey?: unknown; unitId?: unknown; action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const allianceId = typeof body.allianceId === "string" ? body.allianceId.trim() : "";
  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const unitId = typeof body.unitId === "string" ? body.unitId.trim() : "";
  const action = body.action === "recall" ? "recall" : "lend";
  if (!allianceId || !castleKey || !unitId) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withNamedLock(`reinforce:${allianceId}:${castleKey}`, async (tx) => {
      const alliance = await tx.territoryDiplomacy.findFirst({
        where: { id: allianceId, missionKey: ctx.missionKey, type: "alliance" },
      });
      if (!alliance) throw new Error("not_found");
      const mine = await getMyNation(tx, userId, ctx.missionKey);

      const me = await tx.missionUser.findUnique({ where: { userId }, select: { data: true } });
      const units = loadUnits(me?.data);
      const unit = units.find((u) => u.id === unitId);
      if (!unit) throw new Error("unit_not_found");

      if (action === "recall") {
        // 회수는 파견자 본인이면 항상 가능.
        if (unit.state !== "garrisoned" || unit.castleKey !== castleKey) throw new Error("not_lent");
        const rest = parsePayload(alliance.payload).filter(
          (r) => !(r.castleKey === castleKey && r.unitId === unitId),
        );
        await tx.territoryDiplomacy.update({
          where: { id: alliance.id },
          data: { payload: JSON.stringify({ reinforcements: rest }).slice(0, 2000) },
        });
        const next = units.map((u) =>
          u.id === unitId
            ? { ...u, state: "field" as const, castleKey: null, lat: u.hq.lat, lon: u.hq.lon, lastMoveAt: Date.now() }
            : u,
        );
        await tx.missionUser.update({ where: { userId }, data: { data: withUnits(me?.data, next) } });
        return { action, unitId, castleKey };
      }

      if (!mine) throw new Error("forbidden");
      // lend
      if (alliance.status !== "active") throw new Error("not_active");
      if (alliance.fromNationId !== mine.id && alliance.toNationId !== mine.id) throw new Error("forbidden");
      if (unit.state !== "field") throw new Error("unit_busy");
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle || castle.meta.status !== "active") throw new Error("castle_not_found");
      // 상대방 국가 소속 성에만 파견 (내 성·내 국가 성은 기존 주둔 이용).
      const holder = castle.meta.owner
        ? await tx.territoryNationMember.findFirst({
            where: { userId: castle.meta.owner, nation: approvedNation(ctx.missionKey) },
            select: { nationId: true },
          })
        : null;
      const allyNationId = alliance.fromNationId === mine.id ? alliance.toNationId : alliance.fromNationId;
      if (!holder || holder.nationId !== allyNationId) throw new Error("not_ally_castle");

      const existing = parsePayload(alliance.payload);
      if (existing.some((r) => r.castleKey === castleKey)) throw new Error("slot_filled");
      if (existing.length >= 3) throw new Error("cap");
      const updated = [...existing, { castleKey, unitId, lenderUserId: userId }];
      await tx.territoryDiplomacy.update({
        where: { id: alliance.id },
        data: { payload: JSON.stringify({ reinforcements: updated }).slice(0, 2000) },
      });
      const next = units.map((u) =>
        u.id === unitId ? { ...u, state: "garrisoned" as const, castleKey } : u,
      );
      await tx.missionUser.update({ where: { userId }, data: { data: withUnits(me?.data, next) } });
      return { action, unitId, castleKey };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "failed";
    const status =
      code === "not_found" || code === "castle_not_found" || code === "unit_not_found"
        ? 404
        : code === "forbidden"
          ? 403
          : code === "slot_filled" || code === "cap" || code === "not_active"
            ? 409
            : 400;
    return NextResponse.json({ ok: false, code }, { status });
  }
}
