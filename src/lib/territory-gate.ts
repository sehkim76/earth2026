import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";

/**
 * 동 영토전 게이트.
 * MissionTable.hasTerritory = 1인 ARMissionKey 소속 유저에게만 영토 기능을 개방한다.
 * 기본값은 차단(fail-close).
 */
// 미션별 영토 개방 여부 캐시 (컨테이너 메모리, 30초 TTL).
// hasTerritory 토글은 최대 30초 늦게 반영된다. 조회 실패는 캐시하지 않는다.
const TERRITORY_GATE_TTL_MS = 30_000;
const TERRITORY_GATE_CACHE_MAX = 256;
const territoryGateCache = new Map<string, { enabled: boolean; expiresAt: number }>();

export async function isTerritoryEnabled(missionKey: string): Promise<boolean> {
  const key = missionKey.trim();
  if (!key) {
    return false;
  }
  const now = Date.now();
  const cached = territoryGateCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.enabled;
  }
  try {
    const row = await prisma.missionTable.findFirst({
      where: { ARMissionKey: key },
      select: { hasTerritory: true },
    });
    const enabled = row?.hasTerritory === true;
    territoryGateCache.delete(key);
    territoryGateCache.set(key, { enabled, expiresAt: now + TERRITORY_GATE_TTL_MS });
    if (territoryGateCache.size > TERRITORY_GATE_CACHE_MAX) {
      const oldest = territoryGateCache.keys().next();
      if (!oldest.done) {
        territoryGateCache.delete(oldest.value);
      }
    }
    return enabled;
  } catch {
    return false;
  }
}

export async function getUserMissionKey(userId: string): Promise<string> {
  if (!userId) {
    return "";
  }
  try {
    const user = await prisma.missionUser.findUnique({
      where: { userId },
      select: { ARMissionKey: true },
    });
    return typeof user?.ARMissionKey === "string" ? user.ARMissionKey.trim() : "";
  } catch {
    return "";
  }
}

/** 미지원 미션용 403 응답. 신규 영토 API는 선두에서 requireTerritory로 가드한다. */
export function territoryDisabledResponse(): NextResponse {
  return NextResponse.json({ ok: false, code: "territory_disabled" }, { status: 403 });
}

/** 성 이벤트 prefix. 성 식별(EventKey가 castle-로 시작)에 사용한다. */
export const CASTLE_EVENT_PREFIX = "castle-";

/** 성 공성 쿨다운 (초). 1인 1성 기준. */
export const SIEGE_COOLDOWN_SEC = 3600;

export function isCastleEventKey(eventKey: string): boolean {
  return eventKey.trim().startsWith(CASTLE_EVENT_PREFIX);
}

/**
 * 사용 예 (API route 선두):
 *   const missionKey = await getUserMissionKey(userId);
 *   if (!(await isTerritoryEnabled(missionKey))) return territoryDisabledResponse();
 */
