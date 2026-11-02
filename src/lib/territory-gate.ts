import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";

/**
 * 동 영토전 게이트.
 * MissionTable.hasTerritory = 1인 ARMissionKey 소속 유저에게만 영토 기능을 개방한다.
 * 기본값은 차단(fail-close).
 */
export async function isTerritoryEnabled(missionKey: string): Promise<boolean> {
  const key = missionKey.trim();
  if (!key) {
    return false;
  }
  try {
    const row = await prisma.missionTable.findFirst({
      where: { ARMissionKey: key },
      select: { hasTerritory: true },
    });
    return row?.hasTerritory === true;
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

/** 성 이벤트 prefix. 공성전용 분기(재방문 가드 제외·쿨다운 통제)에 사용한다. */
export const CASTLE_EVENT_PREFIX = "castle-";

/** 성 공성 쿨다운 (초). 1인 1성 기준. */
export const SIEGE_COOLDOWN_SEC = 3600;

/** 공성 시도 기록 prefix (ARMissionUserScore.answer에 `siege:{hit|miss|giveup}:{qhash}`로 적재). */
export const SIEGE_ANSWER_PREFIX = "siege:";

export function isCastleEventKey(eventKey: string): boolean {
  return eventKey.trim().startsWith(CASTLE_EVENT_PREFIX);
}

/** 마지막 공성 시도로부터 남은 쿨다운(초). 기록 없으면 0. */
export async function getSiegeCooldownRemainingSec(
  userId: string,
  castleKey: string,
): Promise<number> {
  if (!userId || !castleKey.trim()) {
    return 0;
  }
  try {
    const last = await prisma.aRMissionUserScore.findFirst({
      where: {
        UserId: userId,
        EventKey: castleKey.trim(),
        answer: { startsWith: SIEGE_ANSWER_PREFIX },
      },
      orderBy: { scoredate: "desc" },
      select: { scoredate: true },
    });
    if (!last?.scoredate) {
      return 0;
    }
    const elapsed = Math.floor((Date.now() - last.scoredate.getTime()) / 1000);
    return Math.max(0, SIEGE_COOLDOWN_SEC - elapsed);
  } catch {
    return 0;
  }
}

/**
 * 사용 예 (API route 선두):
 *   const missionKey = await getUserMissionKey(userId);
 *   if (!(await isTerritoryEnabled(missionKey))) return territoryDisabledResponse();
 */
