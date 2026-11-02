import { NextResponse } from "next/server";

import {
  activeUnits,
  loadUnits,
  makeUnitId,
  UNIT_CAP_BY_CLASS,
  UNIT_TRAINING_DURATION_MS,
  withUnits,
  type Unit,
} from "@/lib/units";
import {
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  spendInfluence,
  ensureCastleSeason,
  territoryDisabledResponse,
  UNIT_TRAINING_COST,
  withNamedLock,
} from "@/lib/territory";
import { setRasterBaseUrl, snapToWalkableServer } from "@/lib/server-walkable";

type TrainingBody = {
  name?: unknown;
  castleKey?: unknown;
};

export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: TrainingBody;
  try {
    body = (await request.json()) as TrainingBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim().slice(0, 255) : "";
  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim().slice(0, 12)
    : "부대";
  if (!castleKey) {
    return NextResponse.json({ ok: false, code: "training_castle_required" }, { status: 400 });
  }

  try {
    const unit = await withNamedLock(`unit:${userId}`, async (tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.owner !== userId) {
        throw new Error("training_castle_not_owned");
      }
      if (castle.meta.status !== "active") {
        throw new Error("training_castle_unavailable");
      }

      const unitClass = await refreshUserClass(tx, userId, ctx.missionKey);
      const cap = UNIT_CAP_BY_CLASS[unitClass];
      if (cap <= 0) {
        throw new Error("class_ineligible");
      }

      const row = await tx.missionUser.findUnique({
        where: { userId },
        select: { data: true },
      });
      const units = loadUnits(row?.data);
      if (units.some((candidate) => candidate.state === "training")) {
        throw new Error("training_active");
      }
      if (activeUnits(units).length >= cap) {
        throw new Error("unit_full");
      }
      if (!(await spendInfluence(tx, userId, UNIT_TRAINING_COST))) {
        throw new Error("funds");
      }

      const now = Date.now();
      // 생성 위치 보정: 성 좌표가 이동가능영역 밖이면 가장 가까운 이동가능영역 위로.
      // (영토전 전용 경로이므로 영토전에만 적용된다. 실패 시 성 좌표 그대로 둔다.)
      let spawnLat = castle.lat;
      let spawnLon = castle.lon;
      try {
        setRasterBaseUrl(new URL(request.url).origin);
        const snapped = await snapToWalkableServer(castle.meta.dong, castle.lat, castle.lon, 500);
        if (snapped) {
          spawnLat = snapped.lat;
          spawnLon = snapped.lon;
        }
      } catch {
        // 스냅 실패해도 훈련은 계속한다.
      }
      const nextUnit: Unit = {
        id: makeUnitId(),
        name,
        lat: spawnLat,
        lon: spawnLon,
        state: "training",
        hq: { lat: spawnLat, lon: spawnLon },
        castleKey,
        reviveAt: null,
        lastMoveAt: now,
        trainingCompleteAt: now + UNIT_TRAINING_DURATION_MS,
        moveTarget: null,
      };
      await tx.missionUser.update({
        where: { userId },
        data: { data: withUnits(row?.data, [...units, nextUnit]) },
      });
      return nextUnit;
    });

    return NextResponse.json({
      ok: true,
      unit,
      trainingCompleteAt: unit.trainingCompleteAt,
      servant: unit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = [
      "class_ineligible",
      "training_active",
      "unit_full",
      "funds",
      "castle_not_found",
      "training_castle_not_owned",
      "training_castle_unavailable",
    ].includes(message)
      ? message
      : "training_failed";
    const status =
      code === "funds"
        ? 402
        : code === "unit_full" || code === "training_active"
          ? 409
          : code === "class_ineligible" || code === "training_castle_not_owned"
            ? 403
            : code === "castle_not_found" || code === "training_castle_required"
              ? 400
              : code === "training_castle_unavailable"
                ? 409
                : 500;
    if (status === 500) {
      console.error("[units/train] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
