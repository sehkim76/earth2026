// 카드 전투 엔진 공용 타입.
// 모든 상태는 JSON 직렬화 가능해야 한다 (Battle 테이블에 그대로 저장).
// 이 디렉터리의 파일은 React/Next/Prisma 를 import 하지 않는다.

/** 0 = 공격자(선공), 1 = 수비자(후공) */
export type SideIndex = 0 | 1;

export type CommanderKind =
  | "lord"
  | "infantry"
  | "archer"
  | "cavalry"
  | "mage"
  | "outlaw"
  | "garrison";

/** 카드 계열: 병종 4개 + 공용 */
export type CardClass = "infantry" | "archer" | "cavalry" | "mage" | "neutral";

/** 병사(하수인) / 전술(일회성) / 장비(지휘관 무기) */
export type CardType = "soldier" | "tactic" | "equipment";

/**
 * 키워드
 * - guard  수호: 적은 수호 병사부터 공격해야 한다
 * - rush   기습: 낸 턴에 바로 (무엇이든) 공격 가능
 * - shield 결계: 첫 피해 1회 무효
 * - ranged 원거리: 공격할 때 반격 피해를 받지 않는다
 * 출진(onPlay)·유훈(onDeath)은 키워드가 아니라 카드 효과 슬롯으로 표현한다.
 */
export type Keyword = "guard" | "rush" | "shield" | "ranged";

/** 'chosen' 대상을 고를 때의 조건 */
export type TargetFilter =
  | "anyCharacter"
  | "enemyCharacter"
  | "enemySoldier"
  | "friendlySoldier"
  | "friendlyCharacter"
  | "anySoldier";

/** 효과가 적용될 대상 (효과 소유자 기준) */
export type EffectTarget =
  | "chosen"
  | "self"
  | "ownCommander"
  | "enemyCommander"
  | "allEnemySoldiers"
  | "allEnemies"
  | "allFriendlySoldiers"
  | "otherFriendlySoldiers"
  | "allSoldiers"
  | "randomEnemy"
  | "randomEnemySoldier"
  | "randomOtherFriendlySoldier";

/** 데이터 기반 효과 DSL */
export type Effect =
  | { kind: "damage"; amount: number; target: EffectTarget }
  | { kind: "heal"; amount: number; target: EffectTarget }
  | { kind: "buff"; attack: number; health: number; target: EffectTarget }
  | { kind: "giveKeyword"; keyword: Keyword; target: EffectTarget }
  /** 이번 턴에만 기습 (턴 종료 시 해제) */
  | { kind: "rushThisTurn"; target: EffectTarget }
  | { kind: "summon"; cardId: string; count: number }
  | { kind: "draw"; count: number }
  | { kind: "armor"; amount: number }
  /** 이번 턴 사용 가능한 마나 증가 (여분 마나) */
  | { kind: "gainMana"; amount: number }
  /** 다음 전술 카드 비용 감소 (누적, 전술 1장 사용 시 소멸) */
  | { kind: "tacticDiscount"; amount: number };

export interface CardDef {
  id: string;
  /** 표시 이름 (한국어) */
  name: string;
  cost: number;
  type: CardType;
  cardClass: CardClass;
  /** 병사: 공격력 / 장비: 지휘관 공격력 */
  attack?: number;
  /** 병사 체력 */
  health?: number;
  /** 장비 내구도 (지휘관 공격 1회당 -1) */
  durability?: number;
  keywords: Keyword[];
  /** 효과에 'chosen' 이 있으면 대상 조건 */
  targetFilter?: TargetFilter;
  /** 병사: 출진 / 전술: 사용 효과 / 장비: 장착 시 효과 */
  onPlay?: Effect[];
  /** 유훈 (병사가 죽을 때) */
  onDeath?: Effect[];
  /** 카드 설명 문구 */
  text: string;
  /** 그림(스프라이트) 조회 키 */
  artKey: string;
  /** 소환 전용 토큰 (덱·보관함에 들어가지 않음) */
  token?: boolean;
}

/** 덱/손패의 카드 한 장. 불변 객체로 취급한다. */
export interface CardInstance {
  iid: number;
  cardId: string;
}

/** 필드 위의 병사 */
export interface Soldier {
  iid: number;
  cardId: string;
  attack: number;
  health: number;
  maxHealth: number;
  keywords: Keyword[];
  /** 이번 턴에 소환됨 (기습 없으면 공격 불가) */
  summonedThisTurn: boolean;
  /** 지휘관 능력 등으로 이번 턴에만 받은 기습 */
  rushThisTurn: boolean;
  attacksThisTurn: number;
}

export interface Weapon {
  cardId: string;
  attack: number;
  durability: number;
}

export interface Commander {
  id: string;
  kind: CommanderKind;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  armor: number;
  /** 지휘관 공격력 (= 장비 공격력, 없으면 0) */
  attack: number;
  weapon: Weapon | null;
  powerUsedThisTurn: boolean;
  attacksThisTurn: number;
}

export interface SideState {
  commander: Commander;
  deck: CardInstance[];
  hand: CardInstance[];
  /** 최대 5 */
  board: Soldier[];
  mana: number;
  /** 최대 7 */
  maxMana: number;
  /** 시작 마나 보너스 (성 주인이 직접 수비 등) */
  extraMana: number;
  /** 다음 피로 피해량 - 1 (누적) */
  fatigue: number;
  /** 여분 마나 카드를 썼는지 */
  coinUsed: boolean;
  /** 다음 전술 카드 비용 감소량 */
  tacticDiscount: number;
  /** 이 진영이 소환하는 병사 공격력 보정(%) */
  attackPct: number;
  /** 지금까지 진행한 자기 턴 수 */
  turnsTaken: number;
  /** 이 진영이 처치한 적 병사 수 (경험치 계산용) */
  kills: number;
}

/** 캐릭터(지휘관 또는 병사) 참조 */
export type TargetRef =
  | { kind: "commander"; side: SideIndex }
  | { kind: "soldier"; side: SideIndex; iid: number };

/** 공격 주체 (행동하는 진영 기준) */
export type AttackerRef = { kind: "commander" } | { kind: "soldier"; iid: number };

export type GameOverReason = "commander-defeated" | "concede" | "turn-limit";

/** 연출용 이벤트 (seq 제외 본문) */
export type BattleEventBody =
  | { type: "turn-start"; side: SideIndex; turn: number; mana: number; maxMana: number }
  | { type: "turn-end"; side: SideIndex; turn: number }
  | { type: "draw"; side: SideIndex; iid: number; cardId: string }
  | { type: "burn"; side: SideIndex; iid: number; cardId: string }
  | { type: "fatigue"; side: SideIndex; damage: number }
  | { type: "play"; side: SideIndex; iid: number; cardId: string; cost: number; target?: TargetRef }
  | {
      type: "summon";
      side: SideIndex;
      iid: number;
      cardId: string;
      pos: number;
      attack: number;
      health: number;
    }
  | { type: "equip"; side: SideIndex; cardId: string; attack: number; durability: number }
  | { type: "weapon-break"; side: SideIndex; cardId: string }
  | { type: "attack"; side: SideIndex; attacker: TargetRef; target: TargetRef }
  | {
      type: "damage";
      target: TargetRef;
      amount: number;
      armorAbsorbed: number;
      hpAfter: number;
    }
  | { type: "shield-break"; target: TargetRef }
  | { type: "heal"; target: TargetRef; amount: number; hpAfter: number }
  | { type: "armor"; side: SideIndex; amount: number; total: number }
  | { type: "buff"; target: TargetRef; attack: number; health: number }
  | { type: "keyword"; target: TargetRef; keyword: Keyword | "rushThisTurn" }
  | {
      type: "keyword-trigger";
      side: SideIndex;
      iid: number;
      cardId: string;
      trigger: "onPlay" | "onDeath";
    }
  | { type: "hero-power"; side: SideIndex; kind: CommanderKind; target?: TargetRef }
  | { type: "mana"; side: SideIndex; amount: number; mana: number }
  | { type: "discount"; side: SideIndex; amount: number; total: number }
  | { type: "death"; side: SideIndex; iid: number; cardId: string }
  | { type: "game-over"; winner: SideIndex | "draw"; reason: GameOverReason };

export type BattleEvent = BattleEventBody & { seq: number };

export interface BattleState {
  version: 1;
  seed: number;
  /** mulberry32 내부 상태 (uint32) */
  rng: number;
  /** 전체 턴 번호 (양측 합산, 1부터) */
  turn: number;
  activeSide: SideIndex;
  sides: [SideState, SideState];
  /** 다음 카드 인스턴스 id */
  nextIid: number;
  /** 다음 이벤트 일련번호 */
  seq: number;
  /** 누적 이벤트 기록 (연출·리플레이용) */
  log: BattleEvent[];
  winner: SideIndex | "draw" | null;
  endReason: GameOverReason | null;
}

export type Action =
  | { type: "playCard"; iid: number; target?: TargetRef; boardPos?: number }
  | { type: "attack"; attacker: AttackerRef; target: TargetRef }
  | { type: "heroPower"; target?: TargetRef }
  | { type: "endTurn" }
  | { type: "concede" };

export type ApplyResult =
  | { ok: true; state: BattleState; events: BattleEvent[] }
  | { ok: false; error: string };
