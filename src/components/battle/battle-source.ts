// 전투 화면의 데이터 공급원 인터페이스.
// 서버(API) 공급원과 브라우저 안 엔진(데모) 공급원이 같은 모양을 따른다.

import type { Action, BattleEvent, PublicBattleView } from "@/lib/battle";

export type BattleCallResult =
  | { ok: true; battle: PublicBattleView | null; events: BattleEvent[] }
  | { ok: false; code: string; message: string };

export interface BattleSource {
  /** 플레이어 행동 하나를 보내고 (이어진 AI 턴 포함) 결과를 받는다. */
  act(battleId: string, action: Action): Promise<BattleCallResult>;
  /** 현재 상태를 다시 받는다 (턴 시간 초과 처리 포함). */
  refresh(): Promise<BattleCallResult>;
  /** 턴 마감 비교용 현재 시각(ms). */
  now(): number;
}
