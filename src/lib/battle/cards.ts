// 첫 카드 세트 (24장) + 토큰 + 시작 덱 / 무법자 덱 / 성 기본 수비대 덱.
// 이름·문구는 모두 이 게임 세계관(영주·성·부대·병종·무법자) 고유의 것이다.

import type { CardClass, CardDef } from "./types";

/** 여분 마나 카드 id (후공 보정, 덱에는 넣지 않는다) */
export const SPARE_MANA_ID = "spare_mana";

const CARD_LIST: CardDef[] = [
  // ---------------------------------------------------------------- 공용 (8)
  {
    id: "recruit_spear",
    name: "견습 창병",
    cost: 1,
    type: "soldier",
    cardClass: "neutral",
    attack: 1,
    health: 2,
    keywords: [],
    text: "",
    artKey: "soldier-recruit-spear",
  },
  {
    id: "field_medic",
    name: "야전 치료",
    cost: 1,
    type: "tactic",
    cardClass: "neutral",
    keywords: [],
    targetFilter: "friendlyCharacter",
    onPlay: [
      { kind: "heal", amount: 3, target: "chosen" },
      { kind: "draw", count: 1 },
    ],
    text: "아군 하나의 체력을 3 회복하고 카드 1장을 뽑는다.",
    artKey: "tactic-field-medic",
  },
  {
    id: "beacon_runner",
    name: "봉화 전령",
    cost: 2,
    type: "soldier",
    cardClass: "neutral",
    attack: 2,
    health: 1,
    keywords: [],
    onPlay: [{ kind: "draw", count: 1 }],
    text: "출진: 카드 1장을 뽑는다.",
    artKey: "soldier-beacon-runner",
  },
  {
    id: "war_council",
    name: "군막 회의",
    cost: 3,
    type: "tactic",
    cardClass: "neutral",
    keywords: [],
    onPlay: [{ kind: "draw", count: 2 }],
    text: "카드 2장을 뽑는다.",
    artKey: "tactic-war-council",
  },
  {
    id: "conscriptor",
    name: "징집관",
    cost: 3,
    type: "soldier",
    cardClass: "neutral",
    attack: 2,
    health: 3,
    keywords: [],
    onDeath: [{ kind: "summon", cardId: "militia", count: 2 }],
    text: "유훈: 민병(공격력 1·체력 1) 2기를 불러낸다.",
    artKey: "soldier-conscriptor",
  },
  {
    id: "fort_captain",
    name: "성채 수비대장",
    cost: 4,
    type: "soldier",
    cardClass: "neutral",
    attack: 3,
    health: 5,
    keywords: ["guard"],
    text: "수호",
    artKey: "soldier-fort-captain",
  },
  {
    id: "veteran_centurion",
    name: "노련한 백부장",
    cost: 5,
    type: "soldier",
    cardClass: "neutral",
    attack: 4,
    health: 5,
    keywords: [],
    onPlay: [{ kind: "buff", attack: 1, health: 1, target: "otherFriendlySoldiers" }],
    text: "출진: 다른 아군 병사 모두 공격력 +1, 체력 +1.",
    artKey: "soldier-veteran-centurion",
  },
  {
    id: "royal_guardian",
    name: "왕성 근위기사",
    cost: 7,
    type: "soldier",
    cardClass: "neutral",
    attack: 6,
    health: 7,
    keywords: ["guard", "shield"],
    text: "수호, 결계",
    artKey: "soldier-royal-guardian",
  },

  // ---------------------------------------------------------------- 보병 (4)
  {
    id: "shield_bearer",
    name: "방패병",
    cost: 2,
    type: "soldier",
    cardClass: "infantry",
    attack: 2,
    health: 3,
    keywords: ["guard"],
    text: "수호",
    artKey: "soldier-shield-bearer",
  },
  {
    id: "pike_wall",
    name: "장창 방진",
    cost: 2,
    type: "tactic",
    cardClass: "infantry",
    keywords: [],
    targetFilter: "friendlySoldier",
    onPlay: [
      { kind: "buff", attack: 1, health: 2, target: "chosen" },
      { kind: "giveKeyword", keyword: "guard", target: "chosen" },
    ],
    text: "아군 병사 하나에게 공격력 +1, 체력 +2와 수호를 준다.",
    artKey: "tactic-pike-wall",
  },
  {
    id: "battle_axe",
    name: "전투 도끼",
    cost: 3,
    type: "equipment",
    cardClass: "infantry",
    attack: 3,
    durability: 2,
    keywords: [],
    text: "내 지휘관이 무기를 든다: 공격력 3, 2번 공격 가능.",
    artKey: "equip-battle-axe",
  },
  {
    id: "old_veteran",
    name: "백전 노장",
    cost: 6,
    type: "soldier",
    cardClass: "infantry",
    attack: 5,
    health: 6,
    keywords: ["guard"],
    onPlay: [{ kind: "armor", amount: 3 }],
    text: "수호. 출진: 지휘관 방어도 +3.",
    artKey: "soldier-old-veteran",
  },

  // ---------------------------------------------------------------- 궁병 (4)
  {
    id: "novice_archer",
    name: "견습 궁수",
    cost: 2,
    type: "soldier",
    cardClass: "archer",
    attack: 2,
    health: 2,
    keywords: ["ranged"],
    onDeath: [{ kind: "damage", amount: 1, target: "randomEnemy" }],
    text: "원거리. 유훈: 무작위 적에게 1 피해.",
    artKey: "soldier-novice-archer",
  },
  {
    id: "fire_arrow",
    name: "불화살",
    cost: 2,
    type: "tactic",
    cardClass: "archer",
    keywords: [],
    targetFilter: "enemyCharacter",
    onPlay: [{ kind: "damage", amount: 3, target: "chosen" }],
    text: "적 하나에게 3 피해.",
    artKey: "tactic-fire-arrow",
  },
  {
    id: "marksman",
    name: "명사수",
    cost: 4,
    type: "soldier",
    cardClass: "archer",
    attack: 3,
    health: 2,
    keywords: ["ranged"],
    targetFilter: "enemyCharacter",
    onPlay: [{ kind: "damage", amount: 2, target: "chosen" }],
    text: "원거리. 출진: 적 하나에게 2 피해.",
    artKey: "soldier-marksman",
  },
  {
    id: "arrow_storm",
    name: "화살비",
    cost: 4,
    type: "tactic",
    cardClass: "archer",
    keywords: [],
    onPlay: [
      { kind: "damage", amount: 2, target: "allEnemySoldiers" },
      { kind: "damage", amount: 2, target: "enemyCommander" },
    ],
    text: "모든 적 병사와 적 지휘관에게 2 피해.",
    artKey: "tactic-arrow-storm",
  },

  // ---------------------------------------------------------------- 기병 (4)
  {
    id: "scout_rider",
    name: "정찰 기병",
    cost: 2,
    type: "soldier",
    cardClass: "cavalry",
    attack: 2,
    health: 2,
    keywords: ["rush"],
    text: "기습",
    artKey: "soldier-scout-rider",
  },
  {
    id: "spur_on",
    name: "박차",
    cost: 1,
    type: "tactic",
    cardClass: "cavalry",
    keywords: [],
    targetFilter: "friendlySoldier",
    onPlay: [
      { kind: "buff", attack: 2, health: 1, target: "chosen" },
      { kind: "giveKeyword", keyword: "rush", target: "chosen" },
    ],
    text: "아군 병사 하나에게 공격력 +2, 체력 +1과 기습을 준다.",
    artKey: "tactic-spur-on",
  },
  {
    id: "cavalry_lance",
    name: "기병 장창",
    cost: 2,
    type: "equipment",
    cardClass: "cavalry",
    attack: 2,
    durability: 2,
    keywords: [],
    text: "내 지휘관이 무기를 든다: 공격력 2, 2번 공격 가능.",
    artKey: "equip-cavalry-lance",
  },
  {
    id: "charge_knight",
    name: "돌격 기사",
    cost: 5,
    type: "soldier",
    cardClass: "cavalry",
    attack: 5,
    health: 5,
    keywords: ["rush"],
    text: "기습",
    artKey: "soldier-charge-knight",
  },

  // ---------------------------------------------------------------- 마법 (4)
  {
    id: "mana_bolt",
    name: "마력 탄환",
    cost: 1,
    type: "tactic",
    cardClass: "mage",
    keywords: [],
    targetFilter: "enemyCharacter",
    onPlay: [{ kind: "damage", amount: 2, target: "chosen" }],
    text: "적 하나에게 2 피해.",
    artKey: "tactic-mana-bolt",
  },
  {
    id: "ward_weaver",
    name: "결계 술사",
    cost: 3,
    type: "soldier",
    cardClass: "mage",
    attack: 3,
    health: 3,
    keywords: ["shield"],
    onPlay: [{ kind: "giveKeyword", keyword: "shield", target: "randomOtherFriendlySoldier" }],
    text: "결계. 출진: 무작위 다른 아군 병사 하나에게 결계를 준다.",
    artKey: "soldier-ward-weaver",
  },
  {
    id: "thunder_net",
    name: "벼락 그물",
    cost: 3,
    type: "tactic",
    cardClass: "mage",
    keywords: [],
    onPlay: [{ kind: "damage", amount: 2, target: "allEnemySoldiers" }],
    text: "모든 적 병사에게 2 피해.",
    artKey: "tactic-thunder-net",
  },
  {
    id: "elder_sorcerer",
    name: "원로 마도사",
    cost: 6,
    type: "soldier",
    cardClass: "mage",
    attack: 4,
    health: 5,
    keywords: [],
    targetFilter: "enemyCharacter",
    onPlay: [{ kind: "damage", amount: 4, target: "chosen" }],
    text: "출진: 적 하나에게 4 피해.",
    artKey: "soldier-elder-sorcerer",
  },

  // ---------------------------------------------------------------- 토큰
  {
    id: "militia",
    name: "민병",
    cost: 1,
    type: "soldier",
    cardClass: "neutral",
    attack: 1,
    health: 1,
    keywords: [],
    text: "",
    artKey: "soldier-militia",
    token: true,
  },
  {
    id: "outlaw_thug",
    name: "무법자 졸개",
    cost: 1,
    type: "soldier",
    cardClass: "neutral",
    attack: 1,
    health: 1,
    keywords: [],
    text: "",
    artKey: "soldier-outlaw-thug",
    token: true,
  },
  {
    id: SPARE_MANA_ID,
    name: "여분 마나",
    cost: 0,
    type: "tactic",
    cardClass: "neutral",
    keywords: [],
    onPlay: [{ kind: "gainMana", amount: 1 }],
    text: "이번 턴에만 마나 +1.",
    artKey: "tactic-spare-mana",
    token: true,
  },
];

export const CARDS: Readonly<Record<string, CardDef>> = Object.fromEntries(
  CARD_LIST.map((c) => [c.id, c]),
);

/** 보관함·덱에 들어갈 수 있는 수집 카드 (토큰 제외, 24장) */
export const COLLECTIBLE_CARDS: readonly CardDef[] = CARD_LIST.filter((c) => !c.token);

export function getCard(id: string): CardDef {
  const c = CARDS[id];
  if (!c) throw new Error(`알 수 없는 카드: ${id}`);
  return c;
}

export function isCardId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CARDS, id);
}

// ---------------------------------------------------------------------------
// 덱
// ---------------------------------------------------------------------------

/** 덱 칸 수: 1레벨 10장 → 5레벨 15장 */
export function deckSizeForLevel(level: number): number {
  return 10 + Math.max(0, Math.min(5, Math.floor(level) - 1));
}

/** 병종 시작 덱 (15장 순서). 앞 10장이 1레벨 덱, 레벨이 오르면 뒤 카드가 차례로 열린다. */
export type StarterDeckKey = Exclude<CardClass, "neutral"> | "lord";

const STARTER_DECK_ORDER: Record<StarterDeckKey, string[]> = {
  infantry: [
    "recruit_spear",
    "recruit_spear",
    "shield_bearer",
    "conscriptor",
    "pike_wall",
    "beacon_runner",
    "battle_axe",
    "conscriptor",
    "fort_captain",
    "old_veteran",
    // 11~15
    "shield_bearer",
    "beacon_runner",
    "field_medic",
    "veteran_centurion",
    "royal_guardian",
  ],
  archer: [
    "novice_archer",
    "novice_archer",
    "fire_arrow",
    "fire_arrow",
    "recruit_spear",
    "beacon_runner",
    "marksman",
    "marksman",
    "fort_captain",
    "arrow_storm",
    // 11~15
    "recruit_spear",
    "conscriptor",
    "war_council",
    "veteran_centurion",
    "fort_captain",
  ],
  cavalry: [
    "scout_rider",
    "scout_rider",
    "spur_on",
    "recruit_spear",
    "recruit_spear",
    "cavalry_lance",
    "beacon_runner",
    "conscriptor",
    "charge_knight",
    "charge_knight",
    // 11~15
    "spur_on",
    "beacon_runner",
    "fort_captain",
    "veteran_centurion",
    "conscriptor",
  ],
  mage: [
    "mana_bolt",
    "mana_bolt",
    "ward_weaver",
    "ward_weaver",
    "recruit_spear",
    "beacon_runner",
    "thunder_net",
    "field_medic",
    "conscriptor",
    "elder_sorcerer",
    // 11~15
    "recruit_spear",
    "war_council",
    "fort_captain",
    "thunder_net",
    "veteran_centurion",
  ],
  lord: [
    "recruit_spear",
    "recruit_spear",
    "shield_bearer",
    "novice_archer",
    "scout_rider",
    "beacon_runner",
    "mana_bolt",
    "conscriptor",
    "fort_captain",
    "veteran_centurion",
    // 11~15
    "beacon_runner",
    "fire_arrow",
    "conscriptor",
    "marksman",
    "royal_guardian",
  ],
};

/** 시작 덱 카드 id 목록 (size: 10~15, 기본 15) */
export function starterDeck(key: StarterDeckKey, size = 15): string[] {
  const order = STARTER_DECK_ORDER[key];
  return order.slice(0, Math.max(1, Math.min(order.length, size)));
}

// ---------------------------------------------------------------------------
// 무법자 AI 덱 (난이도 3단계)
// ---------------------------------------------------------------------------

export type OutlawTier = 1 | 2 | 3;

export interface OutlawPreset {
  tier: OutlawTier;
  name: string;
  /** 무법자 지휘관 레벨 (체력·능력 강화에 반영) */
  level: number;
  deck: string[];
}

export const OUTLAW_PRESETS: Readonly<Record<OutlawTier, OutlawPreset>> = {
  1: {
    tier: 1,
    name: "떠돌이 무법자",
    level: 1,
    deck: [
      "recruit_spear",
      "recruit_spear",
      "beacon_runner",
      "scout_rider",
      "novice_archer",
      "conscriptor",
      "shield_bearer",
      "fort_captain",
      "field_medic",
      "war_council",
    ],
  },
  2: {
    tier: 2,
    name: "무법자 패거리",
    level: 1,
    deck: [
      "recruit_spear",
      "recruit_spear",
      "beacon_runner",
      "scout_rider",
      "novice_archer",
      "fire_arrow",
      "conscriptor",
      "shield_bearer",
      "fort_captain",
      "charge_knight",
    ],
  },
  3: {
    tier: 3,
    name: "무법자 두목",
    level: 2,
    deck: [
      "recruit_spear",
      "beacon_runner",
      "beacon_runner",
      "scout_rider",
      "novice_archer",
      "fire_arrow",
      "mana_bolt",
      "conscriptor",
      "conscriptor",
      "fort_captain",
      "marksman",
      "charge_knight",
    ],
  },
};

// ---------------------------------------------------------------------------
// 성 기본 수비대 (주둔군이 없을 때)
// ---------------------------------------------------------------------------

export const GARRISON_DEFAULT_LEVEL = 1;

export const GARRISON_DEFAULT_DECK: readonly string[] = [
  "recruit_spear",
  "recruit_spear",
  "shield_bearer",
  "shield_bearer",
  "novice_archer",
  "beacon_runner",
  "pike_wall",
  "conscriptor",
  "conscriptor",
  "fort_captain",
  "marksman",
  "field_medic",
];
