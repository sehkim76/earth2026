// 클라이언트에 보내는 전투 공개 형식과 API 계약.
// 서버는 상대(AI) 손패·덱 내용과 난수 상태를 숨겨서 보낸다.

import type {
  Action,
  BattleEvent,
  BattleState,
  CardInstance,
  Commander,
  GameOverReason,
  SideIndex,
  Soldier,
} from "./types";

/** 한 진영의 공개 정보. 내 진영이면 hand가 채워지고, 상대면 handCount만 있다. */
export interface PublicSide {
  commander: Commander;
  board: Soldier[];
  hand: CardInstance[] | null;
  handCount: number;
  deckCount: number;
  mana: number;
  maxMana: number;
  fatigue: number;
  tacticDiscount: number;
  attackPct: number;
}

/** 전투 대상 (지도 위 상대). 2단계는 무법자만. */
export interface BattleTargetInfo {
  type: "outlaw" | "castle";
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 무법자 난이도(1~3) 등 표시용 */
  tier?: number;
}

/** 내 지휘관 정보 (경험치 막대 표시용) */
export interface BattleCommanderInfo {
  /** "lord" 또는 부대 id */
  id: string;
  name: string;
  level: number;
  xp: number;
  /** 현재 레벨 시작 누적 경험치 */
  levelXpStart: number;
  /** 다음 레벨 누적 경험치 (최대 레벨이면 null) */
  nextLevelXp: number | null;
}

export interface BattleResult {
  winner: SideIndex | "draw";
  reason: GameOverReason;
  /** 플레이어(0번 진영) 기준 승리 여부 */
  victory: boolean;
  xpGained: number;
  commanderBefore: BattleCommanderInfo;
  commanderAfter: BattleCommanderInfo;
  levelUp: boolean;
  /** 보상으로 얻은 카드 id 목록 */
  cardRewards: string[];
  /** 패배 시 부상 해제 시각(ms). 없으면 null */
  injuredUntil: number | null;
}

export interface PublicBattleView {
  battleId: string;
  /** 플레이어는 항상 0번 진영(공격자) */
  viewerSide: SideIndex;
  turn: number;
  activeSide: SideIndex;
  /** 현재 턴 마감 시각(ms, 서버 기준). 지나면 서버가 턴을 자동 종료한다. */
  turnDeadline: number;
  sides: [PublicSide, PublicSide];
  winner: SideIndex | "draw" | null;
  endReason: GameOverReason | null;
  target: BattleTargetInfo;
  commander: BattleCommanderInfo;
  result: BattleResult | null;
}

// ---- API 계약 -------------------------------------------------------------
// POST /api/battle/start   StartBattleRequest  → BattleResponse
// POST /api/battle/action  BattleActionRequest → BattleResponse
// GET  /api/battle/current                     → BattleResponse (battle: null 가능)
// 오류: { ok: false, code: string, message?: string } (HTTP 4xx)

export interface StartBattleRequest {
  targetType: "outlaw";
  targetId: string;
  /** "lord" 또는 부대 id */
  commanderId: string;
}

export interface BattleActionRequest {
  battleId: string;
  action: Action;
}

export interface BattleResponse {
  ok: true;
  battle: PublicBattleView | null;
  /** 이번 요청으로 생긴 이벤트 (플레이어 행동 + 이어진 AI 턴). 상대 카드 정보는 가려져 있다. */
  events: BattleEvent[];
}

export interface BattleErrorResponse {
  ok: false;
  code: string;
  message?: string;
}

/** 가려진 카드 id (상대가 뽑은 카드 등) */
export const HIDDEN_CARD_ID = "hidden";

const toPublicSide = (state: BattleState, side: SideIndex, viewer: SideIndex): PublicSide => {
  const s = state.sides[side];
  return {
    commander: s.commander,
    board: s.board,
    hand: side === viewer ? s.hand : null,
    handCount: s.hand.length,
    deckCount: s.deck.length,
    mana: s.mana,
    maxMana: s.maxMana,
    fatigue: s.fatigue,
    tacticDiscount: s.tacticDiscount,
    attackPct: s.attackPct,
  };
};

export const toPublicSides = (state: BattleState, viewer: SideIndex): [PublicSide, PublicSide] => [
  toPublicSide(state, 0, viewer),
  toPublicSide(state, 1, viewer),
];

/**
 * 상대 진영의 뽑기·버림(손패가 가득 차 태워짐)은 카드 id를 가린다.
 * 상대가 실제로 낸 카드(play/summon/equip)는 공개 정보라 그대로 둔다.
 */
export const redactEvents = (events: BattleEvent[], viewer: SideIndex): BattleEvent[] =>
  events.map((event) => {
    if (event.type === "draw" && event.side !== viewer) {
      return { ...event, cardId: HIDDEN_CARD_ID };
    }
    return event;
  });
