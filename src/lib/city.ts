import { createRouteSampler } from "@/lib/route-sampler";

// 영주성 내정 (순수 모듈: 서버·화면 공용). React/Next/Prisma import 금지.
//
// - 자원: 금(MissionUser.score, 옛 영향력) + 석재·나무·철광석(TerritoryCity.data.res)
// - 건물: 본관이 다른 건물 레벨 상한. 생산 건물은 시간당 자원 생산(lazy 정산).
// - 연구: 학당 레벨까지 기술 레벨.
// - 병력: 보병·궁병·기병·마법. 군사 건물에서 훈련 → 예비 병력 → 지휘관(영주·부대)에 배치.
// - 자원지: 약 1km 격자 칸마다 0~2곳, 6시간마다 새로 생성(결정적). 일꾼 부대를 보내 채집.

export type ResourceKind = "gold" | "stone" | "wood" | "iron";
export const RESOURCE_KINDS: readonly ResourceKind[] = ["gold", "stone", "wood", "iron"];
export const RESOURCE_LABEL: Readonly<Record<ResourceKind, string>> = {
  gold: "금",
  stone: "석재",
  wood: "나무",
  iron: "철광석",
};

export type Cost = Partial<Record<ResourceKind, number>>;

export type TroopKind = "infantry" | "archer" | "cavalry" | "mage";
export const TROOP_KINDS: readonly TroopKind[] = ["infantry", "archer", "cavalry", "mage"];
export const TROOP_LABEL: Readonly<Record<TroopKind, string>> = {
  infantry: "보병",
  archer: "궁병",
  cavalry: "기병",
  mage: "마법병",
};
export type TroopCounts = Record<TroopKind, number>;
export const emptyTroops = (): TroopCounts => ({ infantry: 0, archer: 0, cavalry: 0, mage: 0 });
export const troopTotal = (t: Partial<TroopCounts> | null | undefined): number =>
  t ? TROOP_KINDS.reduce((s, k) => s + Math.max(0, Math.floor(t[k] ?? 0)), 0) : 0;

// ── 건물 ────────────────────────────────────────────────────────────────

export type BuildingKey =
  | "keep"
  | "sawmill"
  | "quarry"
  | "forge"
  | "mint"
  | "storehouse"
  | "academy"
  | "barracks"
  | "range"
  | "stable"
  | "tower"
  | "camp"
  | "wall";

export type BuildingCategory = "core" | "production" | "research" | "military";

export interface BuildingDef {
  key: BuildingKey;
  name: string;
  category: BuildingCategory;
  desc: string;
  /** 1레벨 업그레이드 비용 (레벨마다 ×1.55) */
  baseCost: Cost;
  /** 1레벨 업그레이드 시간(초) (레벨마다 ×1.6) */
  baseSec: number;
  /** 생산 건물: 생산 자원 */
  produces?: ResourceKind;
  /** 군사 건물: 훈련 병종 */
  trains?: TroopKind;
}

export const MAX_BUILDING_LEVEL = 10;

export const BUILDINGS: readonly BuildingDef[] = [
  { key: "keep", name: "본관", category: "core", desc: "영주성의 중심. 다른 건물은 본관 레벨까지만 올릴 수 있고, 지휘관 병력 상한과 모든 병력의 체력이 늘어납니다.", baseCost: { wood: 300, stone: 300, gold: 100 }, baseSec: 90 },
  { key: "wall", name: "성벽", category: "core", desc: "영주성을 두른 성벽. 본거지 영주성을 지킬 때 수비 지휘관의 체력·공격력이 늘어납니다. 목책 → 토성 → 석성으로 바뀝니다.", baseCost: { stone: 260, wood: 160 }, baseSec: 75 },
  { key: "storehouse", name: "창고", category: "core", desc: "석재·나무·철광석을 쌓아 둘 수 있는 양이 늘어납니다.", baseCost: { wood: 200, stone: 150 }, baseSec: 60 },
  { key: "camp", name: "일꾼 막사", category: "core", desc: "자원지로 보낼 수 있는 일꾼 부대 수와 한 번에 나르는 양이 늘어납니다.", baseCost: { wood: 180, stone: 120 }, baseSec: 60 },
  { key: "sawmill", name: "벌목장", category: "production", desc: "시간마다 나무를 생산합니다.", baseCost: { wood: 100, stone: 120 }, baseSec: 45, produces: "wood" },
  { key: "quarry", name: "채석장", category: "production", desc: "시간마다 석재를 생산합니다.", baseCost: { wood: 140, stone: 80 }, baseSec: 45, produces: "stone" },
  { key: "forge", name: "제철소", category: "production", desc: "시간마다 철광석을 생산하고, 무기를 벼려 모든 병력의 공격력이 늘어납니다.", baseCost: { wood: 160, stone: 160 }, baseSec: 60, produces: "iron" },
  { key: "mint", name: "주조소", category: "production", desc: "시간마다 금을 주조합니다.", baseCost: { wood: 200, stone: 200, iron: 80 }, baseSec: 75, produces: "gold" },
  { key: "academy", name: "학당", category: "research", desc: "기술을 연구합니다. 학당 레벨까지 기술 레벨을 올릴 수 있습니다.", baseCost: { wood: 250, stone: 250, gold: 80 }, baseSec: 90 },
  { key: "barracks", name: "병영", category: "military", desc: "보병을 훈련합니다. 레벨이 오르면 한 번에 더 많이, 더 빨리 훈련하고 보병이 강해집니다.", baseCost: { wood: 200, stone: 150 }, baseSec: 60, trains: "infantry" },
  { key: "range", name: "궁술장", category: "military", desc: "궁병을 훈련합니다. 레벨이 오르면 궁병이 강해집니다.", baseCost: { wood: 240, stone: 120 }, baseSec: 60, trains: "archer" },
  { key: "stable", name: "마구간", category: "military", desc: "기병을 훈련합니다. 레벨이 오르면 기병이 강해집니다.", baseCost: { wood: 220, stone: 160, iron: 60 }, baseSec: 75, trains: "cavalry" },
  { key: "tower", name: "마탑", category: "military", desc: "마법병을 훈련합니다. 레벨이 오르면 마법병이 강해집니다.", baseCost: { stone: 260, iron: 80, gold: 60 }, baseSec: 90, trains: "mage" },
];
export const BUILDING_BY_KEY: Readonly<Record<BuildingKey, BuildingDef>> = Object.fromEntries(
  BUILDINGS.map((b) => [b.key, b]),
) as Record<BuildingKey, BuildingDef>;
export const isBuildingKey = (v: unknown): v is BuildingKey => typeof v === "string" && v in BUILDING_BY_KEY;

const scaleCost = (base: Cost, mult: number): Cost => {
  const out: Cost = {};
  for (const k of RESOURCE_KINDS) {
    const v = base[k];
    if (v) out[k] = Math.round((v * mult) / 10) * 10;
  }
  return out;
};

/** level → level+1 업그레이드 비용 */
export function upgradeCost(key: BuildingKey, level: number): Cost {
  return scaleCost(BUILDING_BY_KEY[key].baseCost, Math.pow(1.55, Math.max(0, level)));
}

/** level → level+1 업그레이드 시간(ms). 상한 2시간. */
export function upgradeMs(key: BuildingKey, level: number): number {
  return Math.min(2 * 3600_000, Math.round(BUILDING_BY_KEY[key].baseSec * Math.pow(1.6, Math.max(0, level)) * 1000));
}

// ── 연구 ────────────────────────────────────────────────────────────────

export type TechKey = "husbandry" | "gathering" | "drill" | "armor" | "marching";
export interface TechDef {
  key: TechKey;
  name: string;
  desc: string;
  /** 레벨당 효과(%) */
  perLevel: number;
  baseCost: Cost;
  baseSec: number;
}
export const MAX_TECH_LEVEL = 5;
export const TECHS: readonly TechDef[] = [
  { key: "husbandry", name: "생산 개량", desc: "건물 자원 생산량", perLevel: 8, baseCost: { wood: 200, stone: 200, gold: 60 }, baseSec: 120 },
  { key: "gathering", name: "채집술", desc: "일꾼 채집 속도", perLevel: 10, baseCost: { wood: 250, iron: 80 }, baseSec: 120 },
  { key: "marching", name: "길잡이", desc: "일꾼 이동 속도", perLevel: 10, baseCost: { wood: 200, stone: 120 }, baseSec: 100 },
  { key: "drill", name: "무예 단련", desc: "병력 공격력", perLevel: 5, baseCost: { iron: 200, gold: 100 }, baseSec: 150 },
  { key: "armor", name: "갑주 제작", desc: "병력 체력", perLevel: 5, baseCost: { iron: 220, stone: 150 }, baseSec: 150 },
];
export const TECH_BY_KEY: Readonly<Record<TechKey, TechDef>> = Object.fromEntries(TECHS.map((t) => [t.key, t])) as Record<
  TechKey,
  TechDef
>;
export const isTechKey = (v: unknown): v is TechKey => typeof v === "string" && v in TECH_BY_KEY;
export function researchCost(key: TechKey, level: number): Cost {
  return scaleCost(TECH_BY_KEY[key].baseCost, Math.pow(1.8, Math.max(0, level)));
}
export function researchMs(key: TechKey, level: number): number {
  return Math.min(3 * 3600_000, Math.round(TECH_BY_KEY[key].baseSec * Math.pow(1.7, Math.max(0, level)) * 1000));
}

// ── 병력 훈련 ───────────────────────────────────────────────────────────

/** 병사 1명 훈련 비용 */
export const TROOP_COST: Readonly<Record<TroopKind, Cost>> = {
  infantry: { wood: 6, iron: 4, gold: 1 },
  archer: { wood: 10, iron: 2, gold: 1 },
  cavalry: { wood: 5, iron: 9, gold: 2 },
  mage: { stone: 6, iron: 4, gold: 4 },
};
/** 병사 1명 훈련 시간(ms) — 군사 건물 레벨마다 10% 빨라짐 */
export function troopTrainMs(kind: TroopKind, buildingLevel: number): number {
  const base = kind === "infantry" ? 3000 : kind === "archer" ? 3500 : kind === "cavalry" ? 4500 : 5000;
  return Math.round(base * Math.pow(0.9, Math.max(0, buildingLevel - 1)));
}
/** 한 번에 훈련할 수 있는 최대 인원 */
export const trainBatchMax = (buildingLevel: number): number => Math.max(0, buildingLevel) * 30;

/** 지휘관 1명이 이끌 수 있는 병력 상한: 본관·지휘관 레벨에 따라 */
export function commanderTroopCap(keepLevel: number, commanderLevel: number): number {
  return 60 + Math.max(0, keepLevel - 1) * 30 + Math.max(0, commanderLevel - 1) * 20;
}

/** 병사 1명이 지휘관 칸에 더하는 체력·공격력 */
const TROOP_HP: Readonly<Record<TroopKind, number>> = { infantry: 0.12, archer: 0.07, cavalry: 0.1, mage: 0.06 };
const TROOP_ATK: Readonly<Record<TroopKind, number>> = { infantry: 0.02, archer: 0.035, cavalry: 0.033, mage: 0.045 };

/** 병종별 훈련 건물 */
export const TROOP_BUILDING: Readonly<Record<TroopKind, "barracks" | "range" | "stable" | "tower">> = { infantry: "barracks", archer: "range", cavalry: "stable", mage: "tower" };
/** 훈련 건물 레벨당 그 병종 체력·공격력 +% */
export const TROOP_BUILDING_PCT = 4;
/** 본관 레벨당 (Lv.1 넘는 만큼) 모든 병력 체력 +% */
export const KEEP_HP_PCT = 2;
/** 제철소 레벨당 모든 병력 공격력 +% */
export const FORGE_ATK_PCT = 2;

type BonusBuildings = Partial<Pick<Record<BuildingKey, number>, "keep" | "forge" | "barracks" | "range" | "stable" | "tower">>;

/** 병력 → 지휘관 칸 추가 체력·공격력 (연구·건물 보정 포함) */
export function troopBonus(
  troops: Partial<TroopCounts> | null | undefined,
  tech?: { drill?: number; armor?: number },
  buildings?: BonusBuildings,
): { hp: number; atk: number } {
  if (!troops) return { hp: 0, atk: 0 };
  let hp = 0;
  let atk = 0;
  for (const k of TROOP_KINDS) {
    const n = Math.max(0, Math.floor(troops[k] ?? 0));
    const kindMult = 1 + ((buildings?.[TROOP_BUILDING[k]] ?? 0) * TROOP_BUILDING_PCT) / 100;
    hp += n * TROOP_HP[k] * kindMult;
    atk += n * TROOP_ATK[k] * kindMult;
  }
  hp *= 1 + ((tech?.armor ?? 0) * TECH_BY_KEY.armor.perLevel) / 100 + (Math.max(0, (buildings?.keep ?? 1) - 1) * KEEP_HP_PCT) / 100;
  atk *= 1 + ((tech?.drill ?? 0) * TECH_BY_KEY.drill.perLevel) / 100 + ((buildings?.forge ?? 0) * FORGE_ATK_PCT) / 100;
  return { hp: Math.round(hp), atk: Math.round(atk) };
}

/** 성벽: 본거지 수비 지휘관 한 칸에 더하는 체력·공격력 */
export function wallDefense(wallLevel: number): { hp: number; atk: number } {
  const lv = Math.max(0, Math.floor(wallLevel));
  return { hp: lv * 3, atk: Math.floor(lv / 2) };
}

/** 성벽 모양 단계 */
export const wallStage = (lv: number): "palisade" | "earth" | "stone" | "grand" =>
  lv <= 3 ? "palisade" : lv <= 6 ? "earth" : lv <= 9 ? "stone" : "grand";

/**
 * 전투 뒤 병력 손실: 쓰러진 칸은 50%, 살아남은 칸은 입은 피해 비율의 30%.
 * 종류별로 같은 비율로 줄인다.
 */
export function troopsAfterBattle(troops: TroopCounts, hpRatioLost: number, died: boolean): TroopCounts {
  const lossRatio = died ? 0.5 : Math.max(0, Math.min(1, hpRatioLost)) * 0.3;
  const out = emptyTroops();
  for (const k of TROOP_KINDS) {
    out[k] = Math.max(0, Math.floor(troops[k] - Math.ceil(troops[k] * lossRatio)));
  }
  return out;
}

/** 전투 뒤 잃은 병력 (종류별) */
export function troopLosses(troops: TroopCounts, hpRatioLost: number, died: boolean): TroopCounts {
  const after = troopsAfterBattle(troops, hpRatioLost, died);
  const out = emptyTroops();
  for (const k of TROOP_KINDS) out[k] = Math.max(0, troops[k] - after[k]);
  return out;
}

// ── 상태 ───────────────────────────────────────────────────────────────

export interface BuildJob {
  key: BuildingKey;
  toLevel: number;
  startedAt: number;
  endsAt: number;
}
export interface ResearchJob {
  key: TechKey;
  toLevel: number;
  startedAt: number;
  endsAt: number;
}
export interface TrainJob {
  kind: TroopKind;
  count: number;
  startedAt: number;
  endsAt: number;
}
export interface GatherMovement {
  /** 자유 이동은 목적지에서 다음 명령을 기다린다. 기존 채집 기록은 이 값이 없다. */
  order?: "move";
  kind: ResourceKind;
  lat: number;
  lon: number;
  /** 출발 위치 (영주성) */
  fromLat: number;
  fromLon: number;
  startedAt: number;
  arriveAt: number;
  doneAt: number;
  returnAt: number;
  /** 도로 경로 [lat, lon][] (영주성 → 채집 지점). 없으면 직선 (옛 데이터) */
  path?: Array<[number, number]>;
}

export interface GatherJob extends GatherMovement {
  slot?: number;
  /** 영주성에서 현재 이동 명령의 출발점까지 밟은 길. */
  homeTrail?: Array<[number, number]>;
  id: string;
  nodeId: string;
  /** 실어 오는 양 (회수하면 채집한 만큼으로 줄어든다) */
  amount: number;
  recalled?: boolean;
}

export interface VisibleWorker extends GatherMovement {
  id: string;
  ownerNickname: string;
}

export const CITY_SIEGE_DURATION_MS = 20 * 60_000;

export interface CitySiege {
  castleKey: string;
  at: number;
  by: string;
  defended: boolean | null;
  conquered: boolean;
}

export interface CityState {
  v: 1;
  res: { stone: number; wood: number; iron: number };
  buildings: Record<BuildingKey, number>;
  tech: Record<TechKey, number>;
  build: BuildJob | null;
  research: ResearchJob | null;
  training: Partial<Record<TroopKind, TrainJob>>;
  reserve: TroopCounts;
  /** 지휘관별 배치 병력 ("lord" 또는 부대 id) */
  assigned: Record<string, TroopCounts>;
  gathers: GatherJob[];
  /** 자원지별 내가 채집한 양 (자원지 id → 양). 시대가 바뀌면 지운다. */
  nodeUsed: Record<string, number>;
  /** 마지막 생산 정산 시각 */
  settledAt: number;
  /** 아직 지급하지 않은 금 소수점 */
  goldAcc: number;
  siege?: CitySiege;
}

export function newCityState(now: number): CityState {
  const buildings = Object.fromEntries(BUILDINGS.map((b) => [b.key, 0])) as Record<BuildingKey, number>;
  // 시작 건물: 본관·창고·일꾼 막사·생산 3종 1레벨
  buildings.keep = 1;
  buildings.storehouse = 1;
  buildings.camp = 1;
  buildings.sawmill = 1;
  buildings.quarry = 1;
  buildings.forge = 1;
  buildings.wall = 1;
  return {
    v: 1,
    res: { stone: 500, wood: 500, iron: 200 },
    buildings,
    tech: { husbandry: 0, gathering: 0, drill: 0, armor: 0, marching: 0 },
    build: null,
    research: null,
    training: {},
    reserve: emptyTroops(),
    assigned: {},
    gathers: [],
    nodeUsed: {},
    settledAt: now,
    goldAcc: 0,
  };
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const readTroops = (v: unknown): TroopCounts => {
  const out = emptyTroops();
  if (isObj(v)) for (const k of TROOP_KINDS) out[k] = Math.max(0, Math.floor(num(v[k])));
  return out;
};

/** DB JSON → 상태 (모르는 값은 기본값) */
export function parseCityState(raw: unknown, now: number): CityState {
  const base = newCityState(now);
  if (!isObj(raw)) return base;
  const res = isObj(raw.res) ? raw.res : {};
  const b = isObj(raw.buildings) ? raw.buildings : {};
  const t = isObj(raw.tech) ? raw.tech : {};
  const buildings = { ...base.buildings };
  for (const def of BUILDINGS) {
    if (def.key in b) buildings[def.key] = Math.max(0, Math.min(MAX_BUILDING_LEVEL, Math.floor(num(b[def.key]))));
  }
  const tech = { ...base.tech };
  for (const def of TECHS) tech[def.key] = Math.max(0, Math.min(MAX_TECH_LEVEL, Math.floor(num(t[def.key]))));
  const job = <T,>(v: unknown, check: (o: Record<string, unknown>) => boolean): T | null =>
    isObj(v) && check(v) ? (v as unknown as T) : null;
  const training: CityState["training"] = {};
  if (isObj(raw.training)) {
    for (const k of TROOP_KINDS) {
      const j = job<TrainJob>(raw.training[k], (o) => typeof o.endsAt === "number" && typeof o.count === "number");
      if (j) training[k] = j;
    }
  }
  const assigned: Record<string, TroopCounts> = {};
  if (isObj(raw.assigned)) for (const [id, v] of Object.entries(raw.assigned)) assigned[id] = readTroops(v);
  const nodeUsed: Record<string, number> = {};
  if (isObj(raw.nodeUsed)) for (const [id, v] of Object.entries(raw.nodeUsed)) nodeUsed[id] = Math.max(0, num(v));
  const siege = job<CitySiege>(raw.siege, (o) =>
    typeof o.castleKey === "string" && num(o.at) > 0 && typeof o.by === "string" &&
    (typeof o.defended === "boolean" || o.defended === null) && typeof o.conquered === "boolean",
  );
  const gathers = Array.isArray(raw.gathers) ? raw.gathers.filter((g) => isObj(g) && typeof g.returnAt === "number") as unknown as GatherJob[] : [];
  const occupied = new Set(gathers.map(g => g.slot));
  let nextSlot = 0;
  for (const g of gathers) {
    if (g.slot !== undefined) continue;
    while (occupied.has(nextSlot)) nextSlot++;
    g.slot = nextSlot++;
  }
  return {
    v: 1,
    res: { stone: Math.max(0, num(res.stone, base.res.stone)), wood: Math.max(0, num(res.wood, base.res.wood)), iron: Math.max(0, num(res.iron, base.res.iron)) },
    buildings,
    tech,
    build: job<BuildJob>(raw.build, (o) => isBuildingKey(o.key) && typeof o.endsAt === "number"),
    research: job<ResearchJob>(raw.research, (o) => isTechKey(o.key) && typeof o.endsAt === "number"),
    training,
    reserve: readTroops(raw.reserve),
    assigned,
    gathers,
    nodeUsed,
    settledAt: num(raw.settledAt, now),
    goldAcc: Math.max(0, num(raw.goldAcc)),
    ...(siege ? { siege } : {}),
  };
}

/** 창고 상한 (석재·나무·철광석 각각) */
export const storageCap = (storehouseLevel: number): number => 2000 + Math.max(0, storehouseLevel) * 3000;
/** 금 상한 (금은 창고와 별개, 전역 상한) */
export const GOLD_CAP = 200_000;

/** 시간당 생산량 */
export function productionPerHour(state: Pick<CityState, "buildings" | "tech">): Record<ResourceKind, number> {
  const mult = 1 + (state.tech.husbandry * TECH_BY_KEY.husbandry.perLevel) / 100;
  const per = (lv: number, base: number): number => Math.round(lv * base * mult);
  return {
    wood: per(state.buildings.sawmill, 120),
    stone: per(state.buildings.quarry, 100),
    iron: per(state.buildings.forge, 60),
    gold: per(state.buildings.mint, 40),
  };
}

/** 일꾼 부대 수 / 1회 운반량 / 채집 속도(초당) / 이동 속도(m/s) */
export const gatherParties = (campLevel: number): number => 1 + Math.floor(Math.max(0, campLevel) / 3);
export const gatherLoad = (campLevel: number): number => 300 + Math.max(0, campLevel) * 250;
export function gatherRatePerSec(state: Pick<CityState, "tech">): number {
  return 1.5 * (1 + (state.tech.gathering * TECH_BY_KEY.gathering.perLevel) / 100);
}
export function workerSpeedMps(state: Pick<CityState, "tech">): number {
  return 4 * (1 + (state.tech.marching * TECH_BY_KEY.marching.perLevel) / 100);
}

/**
 * 시간 경과 정산: 생산, 완료된 건설·연구·훈련, 귀환한 채집.
 * 금은 MissionUser.score라 따로 돌려준다 (goldGain).
 */
export function settleCity(state: CityState, now: number): { state: CityState; goldGain: number; events: string[] } {
  const s: CityState = structuredClone(state);
  const events: string[] = [];
  let goldGain = 0;
  // 생산은 정산 구간을 건설 완료 시점에서 끊지 않는다 (단순화: 완료 전 레벨로 구간 전체 계산)
  const elapsedH = Math.max(0, now - s.settledAt) / 3600_000;
  if (elapsedH > 0) {
    const rate = productionPerHour(s);
    const cap = storageCap(s.buildings.storehouse);
    for (const k of ["stone", "wood", "iron"] as const) {
      if (s.res[k] < cap) s.res[k] = Math.min(cap, s.res[k] + rate[k] * elapsedH);
    }
    // 금은 정수로만 지급하므로 소수점은 goldAcc에 모아 둔다
    s.goldAcc += rate.gold * elapsedH;
    const whole = Math.floor(s.goldAcc);
    goldGain += whole;
    s.goldAcc -= whole;
  }
  s.settledAt = Math.max(s.settledAt, now);

  if (s.build && s.build.endsAt <= now) {
    s.buildings[s.build.key] = s.build.toLevel;
    events.push(`${BUILDING_BY_KEY[s.build.key].name} Lv.${s.build.toLevel} 완공`);
    s.build = null;
  }
  if (s.research && s.research.endsAt <= now) {
    s.tech[s.research.key] = s.research.toLevel;
    events.push(`${TECH_BY_KEY[s.research.key].name} Lv.${s.research.toLevel} 연구 완료`);
    s.research = null;
  }
  for (const k of TROOP_KINDS) {
    const job = s.training[k];
    if (job && job.endsAt <= now) {
      s.reserve[k] += job.count;
      events.push(`${TROOP_LABEL[k]} ${job.count}명 훈련 완료`);
      delete s.training[k];
    }
  }
  const cap = storageCap(s.buildings.storehouse);
  const keep: GatherJob[] = [];
  for (const g of s.gathers) {
    if (g.returnAt <= now) {
      if (g.kind === "gold") goldGain += Math.floor(g.amount);
      else s.res[g.kind] = Math.min(Math.max(cap, s.res[g.kind]), s.res[g.kind] + g.amount);
      events.push(g.amount > 0 ? `일꾼 귀환: ${RESOURCE_LABEL[g.kind]} +${Math.floor(g.amount)}` : "일꾼이 영주성에 귀환했습니다.");
    } else {
      keep.push(g);
    }
  }
  s.gathers = keep;
  return { state: s, goldGain, events };
}

/** 비용을 낼 수 있는지 (금 제외 자원만 검사, 금은 별도) */
export function canPayNonGold(state: CityState, cost: Cost): boolean {
  return (cost.stone ?? 0) <= state.res.stone + 1e-6 && (cost.wood ?? 0) <= state.res.wood + 1e-6 && (cost.iron ?? 0) <= state.res.iron + 1e-6;
}
export function payNonGold(state: CityState, cost: Cost): void {
  state.res.stone -= cost.stone ?? 0;
  state.res.wood -= cost.wood ?? 0;
  state.res.iron -= cost.iron ?? 0;
}
export function multiplyCost(cost: Cost, n: number): Cost {
  const out: Cost = {};
  for (const k of RESOURCE_KINDS) if (cost[k]) out[k] = Math.ceil((cost[k] as number) * n);
  return out;
}

// ── 자원지 (결정적 생성) ─────────────────────────────────────────────────

/** 격자 칸 크기 (약 1.1km) */
export const NODE_CELL_LAT = 0.01;
export const NODE_CELL_LON = 0.0125;
/** 자원지 재생성 주기 */
export const NODE_EPOCH_MS = 6 * 3600_000;

export interface BankMineView {
  name: string;
  remaining: number;
  available: number;
  respawnAt: number | null;
}

export interface ResourceNode {
  mine?: BankMineView;
  id: string;
  kind: ResourceKind;
  level: 1 | 2 | 3;
  lat: number;
  lon: number;
  /** 총 매장량 */
  amount: number;
  /** 사라지는 시각 (다음 시대 시작) */
  expiresAt: number;
}

export const nodeEpoch = (now: number): number => Math.floor(now / NODE_EPOCH_MS);

export const distanceM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
  Math.hypot((b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 110540);

/** 경로 총 길이(m) */
export function pathLengthM(path: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as readonly [number, number];
    const b = path[i] as readonly [number, number];
    sum += distanceM({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
  }
  return sum;
}

/** 경로 앞에서 d(m) 지점까지 자른 경로 (끝점 = 그 지점) */
export function truncatePath(path: ReadonlyArray<readonly [number, number]>, d: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (path.length === 0) return out;
  const first = path[0] as readonly [number, number];
  out.push([first[0], first[1]]);
  let left = Math.max(0, d);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as readonly [number, number];
    const b = path[i] as readonly [number, number];
    const seg = distanceM({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    if (seg >= left) {
      const t = seg > 0 ? left / seg : 0;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      return out;
    }
    left -= seg;
    out.push([b[0], b[1]]);
  }
  return out;
}

const workerSamplers = new WeakMap<object, ReturnType<typeof createRouteSampler>>();

export type GatherPhaseKind = "going" | "gathering" | "waiting" | "returning";
export const WORKER_PHASE_LABEL: Record<GatherPhaseKind, string> = {
  going: "이동 중", gathering: "채집 중", waiting: "현장 대기", returning: "귀환 중",
};

export function workerCargo(g: Pick<GatherJob, "order" | "doneAt" | "recalled" | "amount" | "arriveAt">, now: number): number {
  if (g.order === "move" || now >= g.doneAt || g.recalled) return g.amount;
  const share = Math.max(0, now - g.arriveAt) / Math.max(1, g.doneAt - g.arriveAt);
  return Math.min(g.amount, Math.floor(g.amount * share));
}

/** 일꾼 부대의 현재 위치·단계 (화면 표시용). 도로 경로가 있으면 경로를 따라 움직인다. */
export function gatherPhase(g: GatherMovement, now: number): { phase: GatherPhaseKind; lat: number; lon: number; dir: 1 | -1 } {
  const key = g.path ?? g;
  let sample = workerSamplers.get(key);
  if (!sample) {
    const points = g.path && g.path.length >= 2 ? g.path.map(([lat, lon]) => ({ lat, lon })) :
      [{ lat: g.fromLat, lon: g.fromLon }, { lat: g.lat, lon: g.lon }];
    sample = createRouteSampler(points, distanceM);
    workerSamplers.set(key, sample);
  }
  if (now < g.arriveAt) {
    const t = (now - g.startedAt) / Math.max(1, g.arriveAt - g.startedAt);
    return { phase: "going", ...sample(t) };
  }
  if (now < g.doneAt) {
    const face = sample(1);
    return { phase: g.order === "move" ? "waiting" : "gathering", lat: g.lat, lon: g.lon, dir: face.dir };
  }
  const t = (now - g.doneAt) / Math.max(1, g.returnAt - g.doneAt);
  const pos = sample(1 - t);
  return { ...pos, phase: "returning", dir: pos.dir === 1 ? -1 : 1 };
}
