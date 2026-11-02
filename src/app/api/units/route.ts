import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  UNIT_CAP_BY_CLASS,
  loadUnits,
  positionAtMoveTarget,
  settleExpiredMoveTarget,
  withUnits,
} from "@/lib/units";
import {
  getUserClass,
  loadCastle,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
} from "@/lib/territory";
import { setRasterBaseUrl, snapToWalkableServer } from "@/lib/server-walkable";

/** 부대 목록 조회 (클라 동기화용). 쓰기 경로는 act/dispatch/garrison만 사용한다. */
export async function GET(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  const [klass, units] = await Promise.all([
    getUserClass(prisma, userId),
    withNamedLock(`unit:${userId}`, async (tx) => {
      const row = await tx.missionUser.findUnique({
        where: { userId },
        select: { data: true },
      });
      const units = loadUnits(row?.data);
      const now = Date.now();
      let changed = false;
      const updatedUnits = [];
      for (const unit of units) {
        if (
          unit.state === "training" &&
          typeof unit.trainingCompleteAt === "number" &&
          unit.trainingCompleteAt <= now
        ) {
          changed = true;
          // 완료 전환 시 생성 위치 보정: 이동가능영역 밖이면 가장 가까운 위로.
          // (영토전 조회 경로이므로 영토전에만 적용된다. 실패 시 기존 좌표 유지.)
          let lat = unit.lat;
          let lon = unit.lon;
          let hq = unit.hq;
          if (unit.castleKey) {
            try {
              const castle = await loadCastle(tx, unit.castleKey, ctx.missionKey);
              if (castle) {
                setRasterBaseUrl(new URL(request.url).origin);
                const snapped = await snapToWalkableServer(castle.meta.dong, castle.lat, castle.lon, 500);
                if (snapped) {
                  lat = snapped.lat;
                  lon = snapped.lon;
                  hq = { lat: snapped.lat, lon: snapped.lon };
                }
              }
            } catch {
              // 스냅 실패해도 전환은 계속한다.
            }
          }
          updatedUnits.push({ ...unit, state: "field" as const, castleKey: null, trainingCompleteAt: null, lat, lon, hq });
          continue;
        }
        // 목적지 반경 제한은 폐지했다.
        // 서버 권위: 만료 주문서는 경로 기준으로 확정한다 (path 주문서는 정확히 도착).
        if (unit.moveTarget && unit.moveTarget.endsAt <= now) {
          const settled = settleExpiredMoveTarget(unit.moveTarget, unit.lat, unit.lon, now);
          if (settled) {
            changed = true;
            updatedUnits.push({
              ...unit,
              lat: settled.lat,
              lon: settled.lon,
              lastMoveAt: settled.lastMoveAt,
              moveTarget: settled.moveTarget,
            });
            continue;
          }
          updatedUnits.push(unit);
          continue;
        }
        updatedUnits.push(unit);
      }
      if (changed) {
        await tx.missionUser.update({
          where: { userId },
          data: { data: withUnits(row?.data, updatedUnits) },
        });
      }
      return updatedUnits;
    }),
  ]);

  const unitList = units.map((s) => {
    // 이동 중이면 서버 권위 보간 위치를 반환한다 (클라 재계산 불필요).
    const live =
      s.moveTarget && s.moveTarget.endsAt > Date.now()
        ? positionAtMoveTarget(s.moveTarget, Date.now())
        : null;
    return {
      id: s.id,
      name: s.name,
      lat: live ? live.lat : s.lat,
      lon: live ? live.lon : s.lon,
      state: s.state,
      castleKey: s.castleKey,
      reviveAt: s.reviveAt,
      trainingCompleteAt: s.trainingCompleteAt ?? null,
      moveTarget: s.moveTarget,
    };
  });

  return NextResponse.json({
    ok: true,
    cap: UNIT_CAP_BY_CLASS[klass],
    units: unitList,
    servants: unitList,
  });
}
