// 지휘관 능치·지휘관 능력·경험치/레벨 규칙.

import type { Commander, CommanderKind, Effect, TargetFilter } from "./types";

export const MAX_LEVEL = 10;
export const BASE_COMMANDER_HP = 20;
export const HP_PER_LEVEL = 2;
export const HERO_POWER_COST = 2;

export const COMMANDER_KIND_LABEL: Readonly<Record<CommanderKind, string>> = {
  lord: "영주",
  infantry: "보병 부대",
  archer: "궁병 부대",
  cavalry: "기병 부대",
  mage: "마법 부대",
  outlaw: "무법자",
  garrison: "성 수비대",
};

function clampLevel(level: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
}

/** 지휘관 최대 체력: 1레벨 20, 레벨당 +2 */
export function commanderMaxHp(level: number): number {
  return BASE_COMMANDER_HP + HP_PER_LEVEL * (clampLevel(level) - 1);
}

/** 지휘관 능력 강화 단계: 3·6·9레벨에 1단계씩 (0~3) */
export function powerTier(level: number): number {
  const lv = clampLevel(level);
  return (lv >= 3 ? 1 : 0) + (lv >= 6 ? 1 : 0) + (lv >= 9 ? 1 : 0);
}

export interface CommanderSetup {
  id: string;
  kind: CommanderKind;
  name: string;
  level: number;
  /** 체력 직접 지정 (무법자처럼 레벨 공식과 다른 체력). 없으면 레벨 공식 */
  maxHp?: number;
}

export function makeCommander(setup: CommanderSetup): Commander {
  const level = clampLevel(setup.level);
  const hp = setup.maxHp !== undefined && setup.maxHp > 0 ? Math.round(setup.maxHp) : commanderMaxHp(level);
  return {
    id: setup.id,
    kind: setup.kind,
    name: setup.name,
    level,
    hp,
    maxHp: hp,
    armor: 0,
    attack: 0,
    weapon: null,
    powerUsedThisTurn: false,
    attacksThisTurn: 0,
  };
}

// ---------------------------------------------------------------------------
// 지휘관 능력 (2마나, 턴당 1회)
// ---------------------------------------------------------------------------

export interface HeroPowerDef {
  name: string;
  text: string;
  cost: number;
  /** 대상이 필요하면 조건 */
  targetFilter?: TargetFilter;
  effects: Effect[];
  /** 소환형 능력: 필드에 빈 칸이 있어야 사용 가능 */
  needsBoardSpace?: boolean;
}

/** 지휘관 종류·레벨별 능력 정의 */
export function heroPower(kind: CommanderKind, level: number): HeroPowerDef {
  const tier = powerTier(level);
  switch (kind) {
    case "lord": {
      // 지휘: +1/+1 → 3레벨 +1/+2 → 6레벨 +2/+2 → 9레벨 +2/+3
      const atk = 1 + Math.floor(tier / 2);
      const hp = 1 + Math.ceil(tier / 2);
      return {
        name: "지휘",
        text: `아군 병사 하나에게 공격력 +${atk}, 체력 +${hp}.`,
        cost: HERO_POWER_COST,
        targetFilter: "friendlySoldier",
        effects: [{ kind: "buff", attack: atk, health: hp, target: "chosen" }],
      };
    }
    case "infantry":
    case "garrison": {
      // 방패 들기 / 성벽 보수: 방어도 +2 (+1/단계)
      const amount = 2 + tier;
      return {
        name: kind === "infantry" ? "방패 들기" : "성벽 보수",
        text: `지휘관 방어도 +${amount}.`,
        cost: HERO_POWER_COST,
        effects: [{ kind: "armor", amount }],
      };
    }
    case "archer": {
      // 조준 사격: 1 피해 → 3레벨 2 → 9레벨 3 (6레벨은 방어도 +1 부가)
      const dmg = 1 + (tier >= 1 ? 1 : 0) + (tier >= 3 ? 1 : 0);
      const effects: Effect[] = [{ kind: "damage", amount: dmg, target: "chosen" }];
      if (tier >= 2) effects.push({ kind: "armor", amount: 1 });
      return {
        name: "조준 사격",
        text: `적 하나에게 ${dmg} 피해.${tier >= 2 ? " 방어도 +1." : ""}`,
        cost: HERO_POWER_COST,
        targetFilter: "enemyCharacter",
        effects,
      };
    }
    case "cavalry": {
      // 돌파: 이번 턴 기습 부여, 강화 단계마다 공격력 +1
      const effects: Effect[] = [{ kind: "rushThisTurn", target: "chosen" }];
      if (tier > 0) effects.push({ kind: "buff", attack: tier, health: 0, target: "chosen" });
      return {
        name: "돌파",
        text: `이번 턴 아군 병사 하나에게 기습${tier > 0 ? `과 공격력 +${tier}` : ""}을 준다.`,
        cost: HERO_POWER_COST,
        targetFilter: "friendlySoldier",
        effects,
      };
    }
    case "mage": {
      // 마력 수확: 다음 전술 -1 → 3레벨 -2, 6레벨 방어도 +1 부가, 9레벨 -3
      const amount = 1 + (tier >= 1 ? 1 : 0) + (tier >= 3 ? 1 : 0);
      const effects: Effect[] = [{ kind: "tacticDiscount", amount }];
      if (tier >= 2) effects.push({ kind: "armor", amount: 1 });
      return {
        name: "마력 수확",
        text: `다음 전술 카드 비용 -${amount}.${tier >= 2 ? " 방어도 +1." : ""}`,
        cost: HERO_POWER_COST,
        effects,
      };
    }
    case "outlaw": {
      // 패거리 호출: 무법자 졸개(1/1) 소환 (강화 없음, 무법자 난이도는 덱·레벨로 조절)
      const effects: Effect[] = [{ kind: "summon", cardId: "outlaw_thug", count: 1 }];
      return {
        name: "패거리 호출",
        text: "무법자 졸개(공격력 1·체력 1)를 불러낸다.",
        cost: HERO_POWER_COST,
        effects,
        needsBoardSpace: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 경험치 / 레벨
// ---------------------------------------------------------------------------

/** level → level+1 에 필요한 경험치 = round(100 × level^1.5) */
export function xpToNextLevel(level: number): number {
  return Math.round(100 * Math.pow(clampLevel(level), 1.5));
}

/** 해당 레벨에 도달하기 위한 누적 경험치 (1레벨 = 0) */
export function xpForLevel(level: number): number {
  const lv = clampLevel(level);
  let total = 0;
  for (let l = 1; l < lv; l++) total += xpToNextLevel(l);
  return total;
}

/** 누적 경험치 → 레벨 (1~10) */
export function levelFromXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

export const XP_AWARD = {
  participate: 10,
  win: 30,
  killPerSoldier: 2,
  outlawWin: 20,
} as const;

export interface BattleXpInput {
  won: boolean;
  /** 처치한 적 병사 수 */
  kills: number;
  /** 무법자 전투인지 */
  vsOutlaw: boolean;
}

/** 한 전투에서 얻는 경험치 */
export function battleXp(input: BattleXpInput): number {
  let xp = XP_AWARD.participate + XP_AWARD.killPerSoldier * Math.max(0, input.kills);
  if (input.won) xp += XP_AWARD.win + (input.vsOutlaw ? XP_AWARD.outlawWin : 0);
  return xp;
}
