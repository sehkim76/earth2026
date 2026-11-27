// 무법자 난이도 (순수, 서버·화면 공용).
// 지도 패널과 지휘관 선택창이 서버와 같은 등급을 보여 주도록 한곳에서 계산한다.

import type { OutlawTier } from "./cards";
import { nextRandom, seedToRng } from "./rng";

/** 등급 이름 (OUTLAW_PRESETS 이름과 맞춘다) */
export const OUTLAW_TIER_LABEL: Readonly<Record<OutlawTier, string>> = {
  1: "아기 멧돼지",
  2: "아기곰",
  3: "아기 호랑이",
};

/** 등급 별 표시 */
export const OUTLAW_TIER_STARS: Readonly<Record<OutlawTier, string>> = {
  1: "★",
  2: "★★",
  3: "★★★",
};

/** 이 레벨 이하 지휘관은 무법자 등급을 한 단계 낮춰 싸운다 (견습 보정). */
export const NOVICE_COMMANDER_MAX_LEVEL = 2;

/** 무법자 id → 기본 등급 (가중치 60/30/10, 결정적) */
export function outlawTierForId(id: number): OutlawTier {
  const v = nextRandom(seedToRng((Math.imul(id, 2654435761) ^ 0x71a3) >>> 0)).value;
  return v < 0.6 ? 1 : v < 0.9 ? 2 : 3;
}

/** 지휘관 레벨을 반영한 실제 상대 등급 (저레벨 견습 보정) */
export function effectiveOutlawTier(baseTier: OutlawTier, commanderLevel: number): OutlawTier {
  if (commanderLevel <= NOVICE_COMMANDER_MAX_LEVEL && baseTier > 1) {
    return (baseTier - 1) as OutlawTier;
  }
  return baseTier;
}
