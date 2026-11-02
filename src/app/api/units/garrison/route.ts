import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  UNIT_GARRISON_CAP_PER_CASTLE,
  loadUnits,
  withUnits,
} from "@/lib/units";
import {
  JOIN_RADIUS_M,
  classAtLeast,
  ensureCastleSeason,
  getUserClass,
  haversineM,
  requireSessionUserId,
  resolveTerritoryContext,
  serializeCastleMeta,
  territoryDisabledResponse,
  withNamedLock,
  type Tx,
} from "@/lib/territory";

type GarrisonBody = {
  unitId?: unknown;
  servantId?: unknown;
  castleKey?: unknown;
  mode?: unknown;
};

/**
 * 부대 주둔. 귀족 이상 + 자기 성에만. 주둔 중 조작 불가.
 * 주둔 1명당 성 방어 +2 (상한 +6, 3명) + 공성 쿨다운 +15분.
 */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: GarrisonBody;
  try {
    body = (await request.json()) as GarrisonBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const requestedUnitId = typeof body.unitId === "string" ? body.unitId : body.servantId;
  const unitId = typeof requestedUnitId === "string" ? requestedUnitId.trim() : "";
  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const mode = body.mode === "in" || body.mode === "out" ? body.mode : null;
  if (!unitId || !castleKey || !mode) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  const klass = await getUserClass(prisma, userId);
  if (!classAtLeast(klass, "noble")) {
    return NextResponse.json({ ok: false, code: "class_ineligible" }, { status: 403 });
  }

  try {
    const result = await withNamedLock(`unit:${userId}`, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.owner !== userId) {
        throw new Error("not_owner");
      }

      const row = await tx.missionUser.findUnique({
        where: { userId },
        select: { data: true },
      });
      const units = loadUnits(row?.data);
      const unit = units.find((s) => s.id === unitId);
      if (!unit) {
        throw new Error("unit_not_found");
      }
      if (unit.state === "dead") {
        throw new Error("unit_dead");
      }

      if (mode === "in") {
        if (unit.state === "garrisoned") {
          throw new Error("already_garrisoned");
        }
        if (haversineM(unit.lat, unit.lon, castle.lat, castle.lon) > JOIN_RADIUS_M) {
          throw new Error("out_of_range");
        }
        const garrisoned = units.filter(
          (s) => s.state === "garrisoned" && s.castleKey === castleKey,
        ).length;
        if (garrisoned >= UNIT_GARRISON_CAP_PER_CASTLE) {
          throw new Error("garrison_full");
        }
        const next = units.map((s) =>
          s.id === unitId
            ? { ...s, state: "garrisoned" as const, castleKey, lastMoveAt: Date.now() }
            : s,
        );
        await tx.missionUser.update({
          where: { userId },
          data: { data: withUnits(row?.data, next) },
        });
        const meta = { ...castle.meta, garrison: garrisoned + 1 };
        await tx.aRMissionEvent.updateMany({
          where: { EventKey: castleKey, ARMissionKey: ctx.missionKey },
          data: { string_param1: serializeCastleMeta(meta) },
        });
        return { mode, garrison: garrisoned + 1 };
      }

      if (unit.state !== "garrisoned" || unit.castleKey !== castleKey) {
        throw new Error("not_garrisoned");
      }
      const next = units.map((s) =>
        s.id === unitId
          ? {
              ...s,
              state: "field" as const,
              castleKey: null,
              lat: castle.lat,
              lon: castle.lon,
              lastMoveAt: Date.now(),
            }
          : s,
      );
      await tx.missionUser.update({
        where: { userId },
        data: { data: withUnits(row?.data, next) },
      });
      const garrisoned = next.filter(
        (s) => s.state === "garrisoned" && s.castleKey === castleKey,
      ).length;
      const meta = { ...castle.meta, garrison: garrisoned };
      await tx.aRMissionEvent.updateMany({
        where: { EventKey: castleKey, ARMissionKey: ctx.missionKey },
        data: { string_param1: serializeCastleMeta(meta) },
      });
      return { mode, garrison: garrisoned };
    });

    return NextResponse.json({ ok: true, unitId, servantId: unitId, castleKey, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "castle_not_found",
        "not_owner",
        "unit_not_found",
        "unit_dead",
        "already_garrisoned",
        "not_garrisoned",
        "out_of_range",
        "garrison_full",
      ].includes(error.message)
        ? error.message
        : "garrison_failed";
    const status =
      code === "castle_not_found" || code === "unit_not_found"
        ? 404
        : code === "not_owner"
          ? 403
          : code === "garrison_full" || code === "already_garrisoned"
            ? 409
            : 400;
    if (code === "garrison_failed") {
      console.error("[units/garrison] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
