// 영주성 내정 서버 연결부. 서버 전용.
// 잠금: city:<userId> (성 상태만 다룬다). 다른 사용자 잠금과 함께 잡을 땐 사용자 잠금 → city 순서.

import prisma from "@/lib/prismadb";
import { findServerRoute } from "@/lib/server-graph";
import { listCommanders, toJsonObject } from "@/lib/battle-server";
import type { CommanderListItem } from "@/lib/battle";
import {
  BUILDING_BY_KEY,
  GOLD_CAP,
  MAX_BUILDING_LEVEL,
  MAX_TECH_LEVEL,
  TECH_BY_KEY,
  TROOP_COST,
  TROOP_KINDS,
  TROOP_LABEL,
  BUILDINGS,
  canPayNonGold,
  commanderTroopCap,
  distanceM,
  emptyTroops,
  gatherLoad,
  gatherParties,
  gatherRatePerSec,
  multiplyCost,
  newCityState,
  nodeById,
  nodeEpoch,
  parseCityState,
  pathLengthM,
  truncatePath,
  payNonGold,
  researchCost,
  researchMs,
  settleCity,
  trainBatchMax,
  troopBonus,
  troopTotal,
  troopTrainMs,
  upgradeCost,
  upgradeMs,
  workerSpeedMps,
  type BuildingKey,
  type CityState,
  type Cost,
  type TechKey,
  type TroopCounts,
  type TroopKind,
} from "@/lib/city";
import {
  currentSeasonId,
  getInfluence,
  parseCastleMeta,
  parseLatLon,
  spendInfluence,
  withNamedLock,
  type Tx,
} from "@/lib/territory";

/** 일꾼을 보낼 수 있는 최대 거리 (영주성 기준 직선) */
export const GATHER_MAX_DISTANCE_M = 4000;
/** 도로로 잰 최대 편도 거리 */
export const GATHER_MAX_ROAD_M = 7000;
/** 도로 경로 양끝이 영주성·자원지에서 벗어나도 되는 거리 (도로 스냅 반경) */
const ROUTE_END_TOLERANCE_M = 500;

/** 경로 솎음 (일직선 위 점 제거, 최대 MAX_ROUTE_POINTS점) — 성 데이터 크기를 줄인다. */
const MAX_ROUTE_POINTS = 300;
function thinRoute(points: ReadonlyArray<{ lat: number; lon: number }>): Array<[number, number]> {
  const pts = points.map((p): [number, number] => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]);
  if (pts.length <= 2) return pts;
  const kx = 111320 * Math.cos(((pts[0] as [number, number])[0] * Math.PI) / 180);
  const perp = (p: [number, number], a: [number, number], b: [number, number]): number => {
    const bx = (b[1] - a[1]) * kx;
    const by = (b[0] - a[0]) * 110540;
    const px = (p[1] - a[1]) * kx;
    const py = (p[0] - a[0]) * 110540;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    return Math.hypot(px - bx * t, py - by * t);
  };
  for (const eps of [2, 5, 10, 20, 40]) {
    const keep = new Set<number>([0, pts.length - 1]);
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length > 0) {
      const [s, e] = stack.pop() as [number, number];
      let dmax = 0;
      let imax = -1;
      for (let i = s + 1; i < e; i++) {
        const d = perp(pts[i] as [number, number], pts[s] as [number, number], pts[e] as [number, number]);
        if (d > dmax) {
          dmax = d;
          imax = i;
        }
      }
      if (imax !== -1 && dmax > eps) {
        keep.add(imax);
        stack.push([s, imax], [imax, e]);
      }
    }
    const out = pts.filter((_, i) => keep.has(i));
    if (out.length <= MAX_ROUTE_POINTS) return out;
  }
  const step = Math.ceil(pts.length / MAX_ROUTE_POINTS);
  return pts.filter((_, i) => i === 0 || i === pts.length - 1 || i % step === 0);
}

/**
 * 일꾼 파견 전 도로 경로 찾기 (잠금 밖, 수 초 걸릴 수 있다).
 * 무법자·부대와 같은 서버 도로 그래프를 쓴다. 호출 전 setGraphBaseUrl·setRasterBaseUrl 주입 필요.
 */
export async function planGatherRoute(userId: string, missionKey: string, nodeId: string): Promise<Array<[number, number]>> {
  const now = Date.now();
  const home = await findHomeCastle(prisma, userId, missionKey);
  if (!home) throw new CityError("no_home", 409, "먼저 영주성을 세우세요.");
  const node = nodeById(nodeId, now);
  if (!node) throw new CityError("gone", 404, "자원지가 사라졌습니다.");
  const dist = distanceM(home, node);
  if (dist > GATHER_MAX_DISTANCE_M) {
    throw new CityError("too_far", 400, `영주성에서 너무 멉니다 (${(dist / 1000).toFixed(1)}km, 최대 ${GATHER_MAX_DISTANCE_M / 1000}km).`);
  }
  const result = await findServerRoute(home.lat, home.lon, node.lat, node.lon);
  if (!result.ok || result.path.length < 2) {
    throw new CityError("no_road", 409, "자원지까지 가는 길을 찾지 못했습니다.");
  }
  return thinRoute(result.path);
}

export class CityError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HomeCastle {
  castleKey: string;
  name: string;
  lat: number;
  lon: number;
}

/** 내 영주성 (이번 시즌, 가장 먼저 세운 것). 없으면 null. */
export async function findHomeCastle(db: Tx | typeof prisma, userId: string, missionKey: string): Promise<HomeCastle | null> {
  const client = db as typeof prisma;
  const seasonId = currentSeasonId();
  const events = await client.aRMissionEvent.findMany({
    where: { ARMissionKey: missionKey, EventKey: { startsWith: "castle-" } },
    select: { EventKey: true, string_param1: true },
  });
  const mine = events
    .map((e) => ({ key: e.EventKey ?? "", meta: parseCastleMeta(e.string_param1) }))
    .filter((c) => c.key && c.meta && c.meta.owner === userId && c.meta.kind === "lord" && c.meta.seasonId === seasonId)
    .sort((a, b) => String(a.meta?.createdAt ?? "").localeCompare(String(b.meta?.createdAt ?? "")));
  const first = mine[0];
  if (!first) return null;
  const gps = await client.aRMissionGPS.findFirst({
    where: { ARMissionKey: missionKey, EventKey: first.key },
    select: { location: true, locationname: true },
  });
  const pos = parseLatLon(gps?.location ?? "");
  if (!pos) return null;
  return { castleKey: first.key, name: gps?.locationname ?? first.key, lat: pos.lat, lon: pos.lon };
}

async function loadCityRow(tx: Tx, userId: string, missionKey: string, now: number): Promise<CityState> {
  const row = await tx.territoryCity.findUnique({ where: { userId } });
  if (!row) {
    const state = newCityState(now);
    await tx.territoryCity.create({ data: { userId, missionKey, data: state as unknown as object } });
    return state;
  }
  return parseCityState(row.data, now);
}

async function saveCityRow(tx: Tx, userId: string, state: CityState, now: number): Promise<void> {
  // 지난 시대 자원지 기록은 지운다
  const epoch = nodeEpoch(now);
  for (const id of Object.keys(state.nodeUsed)) {
    if (Number(id.split(":")[2]) !== epoch) delete state.nodeUsed[id];
  }
  await tx.territoryCity.update({ where: { userId }, data: { data: state as unknown as object, updatedAt: new Date(now) } });
}

async function grantGold(tx: Tx, userId: string, amount: number): Promise<void> {
  const gain = Math.max(0, Math.trunc(amount));
  if (gain <= 0) return;
  await tx.$executeRaw`
    UPDATE "MissionUser"
    SET score = LEAST(${GOLD_CAP}, COALESCE(score, 0) + ${gain})
    WHERE "userId" = ${userId}
  `;
}

/** 지휘관 목록 (병력 상한 계산용) */
async function commanderList(tx: Tx, userId: string, now: number): Promise<CommanderListItem[]> {
  const row = await tx.missionUser.findUnique({ where: { userId }, select: { data: true, nickname: true } });
  return row ? listCommanders(toJsonObject(row.data), row.nickname, now) : [];
}

/** 사라진 지휘관(전사·해산)의 배치 병력은 예비로 돌린다 */
function reconcileAssigned(state: CityState, validIds: Set<string>): void {
  for (const [id, troops] of Object.entries(state.assigned)) {
    if (validIds.has(id)) continue;
    for (const k of TROOP_KINDS) state.reserve[k] += troops[k];
    delete state.assigned[id];
  }
}

export interface CityView {
  now: number;
  home: HomeCastle | null;
  gold: number;
  state: CityState;
  commanders: Array<{ id: string; name: string; kind: string; level: number; state: string; troops: TroopCounts; cap: number }>;
  events: string[];
}

function view(
  now: number,
  home: HomeCastle | null,
  gold: number,
  state: CityState,
  commanders: CommanderListItem[],
  events: string[],
): CityView {
  return {
    now,
    home,
    gold,
    state,
    commanders: commanders
      .filter((c) => c.state !== "dead")
      .map((c) => ({
        id: c.id,
        name: c.id === "lord" ? `영주 ${c.name}` : c.name,
        kind: c.kind,
        level: c.level,
        state: c.state,
        troops: state.assigned[c.id] ?? emptyTroops(),
        cap: commanderTroopCap(state.buildings.keep, c.level),
      })),
    events,
  };
}

export type CityAction =
  | { type: "upgrade"; building: BuildingKey }
  | { type: "research"; tech: TechKey }
  | { type: "train"; troop: TroopKind; count: number }
  | { type: "assign"; commanderId: string; troops: TroopCounts }
  | { type: "gather"; nodeId: string; route?: Array<[number, number]> }
  | { type: "recall"; gatherId: string };

/** 잠금 안에서 정산 → (행동) → 저장. 행동이 없으면 조회. */
export async function runCity(userId: string, missionKey: string, action: CityAction | null): Promise<CityView> {
  return withNamedLock(`city:${userId}`, async (tx) => {
    const now = Date.now();
    const loaded = await loadCityRow(tx, userId, missionKey, now);
    const settled = settleCity(loaded, now);
    const state = settled.state;
    await grantGold(tx, userId, settled.goldGain);
    const home = await findHomeCastle(tx, userId, missionKey);
    const commanders = await commanderList(tx, userId, now);
    reconcileAssigned(state, new Set(commanders.filter((c) => c.state !== "dead").map((c) => c.id)));
    const events = [...settled.events];

    if (action) {
      if (!home && action.type !== "assign") {
        throw new CityError("no_home", 409, "먼저 영주성을 세우세요.");
      }
      const goldCost = applyAction(state, action, now, home, commanders, events);
      if (goldCost > 0) {
        const ok = await spendInfluence(tx, userId, goldCost);
        // 금이 모자라면 트랜잭션 전체를 되돌린다 (석재 등 차감도 저장 전이라 함께 취소)
        if (!ok) throw new CityError("funds", 402, "금이 부족합니다.");
      }
    }
    await saveCityRow(tx, userId, state, now);
    const gold = await getInfluence(tx, userId);
    return view(now, home, gold, state, commanders, events);
  });
}

/** 금 외 자원을 차감하고, 낼 금을 돌려준다 (금은 호출 측이 트랜잭션 안에서 차감). */
function charge(state: CityState, cost: Cost): number {
  if (!canPayNonGold(state, cost)) throw new CityError("funds", 402, "자원이 부족합니다.");
  payNonGold(state, cost);
  return cost.gold ?? 0;
}

/** 상태 변경 + 검증. 낼 금을 돌려준다. */
function applyAction(
  state: CityState,
  action: CityAction,
  now: number,
  home: HomeCastle | null,
  commanders: CommanderListItem[],
  events: string[],
): number {
  switch (action.type) {
    case "upgrade": {
      const def = BUILDING_BY_KEY[action.building];
      if (state.build) throw new CityError("busy", 409, "이미 건설 중인 건물이 있습니다.");
      const lv = state.buildings[action.building];
      if (lv >= MAX_BUILDING_LEVEL) throw new CityError("max", 409, "최고 레벨입니다.");
      if (action.building !== "keep" && lv + 1 > state.buildings.keep) {
        throw new CityError("keep", 409, `본관 레벨(${state.buildings.keep})을 넘을 수 없습니다.`);
      }
      const gold = charge(state, upgradeCost(action.building, lv));
      state.build = { key: action.building, toLevel: lv + 1, startedAt: now, endsAt: now + upgradeMs(action.building, lv) };
      events.push(`${def.name} ${lv === 0 ? "건설" : "업그레이드"} 시작`);
      return gold;
    }
    case "research": {
      const def = TECH_BY_KEY[action.tech];
      if (state.research) throw new CityError("busy", 409, "이미 진행 중인 연구가 있습니다.");
      const lv = state.tech[action.tech];
      if (lv >= MAX_TECH_LEVEL) throw new CityError("max", 409, "최고 레벨입니다.");
      if (lv + 1 > state.buildings.academy) throw new CityError("academy", 409, `학당 레벨(${state.buildings.academy})까지만 연구할 수 있습니다.`);
      const gold = charge(state, researchCost(action.tech, lv));
      state.research = { key: action.tech, toLevel: lv + 1, startedAt: now, endsAt: now + researchMs(action.tech, lv) };
      events.push(`${def.name} 연구 시작`);
      return gold;
    }
    case "train": {
      const building = BUILDINGS.find((b) => b.trains === action.troop);
      const lv = building ? state.buildings[building.key] : 0;
      if (!building || lv <= 0) throw new CityError("no_building", 409, "훈련 건물이 없습니다.");
      if (state.training[action.troop]) throw new CityError("busy", 409, "이미 훈련 중입니다.");
      const count = Math.floor(action.count);
      if (!(count >= 1 && count <= trainBatchMax(lv))) throw new CityError("invalid", 400, `한 번에 1~${trainBatchMax(lv)}명까지 훈련할 수 있습니다.`);
      const gold = charge(state, multiplyCost(TROOP_COST[action.troop], count));
      state.training[action.troop] = { kind: action.troop, count, startedAt: now, endsAt: now + troopTrainMs(action.troop, lv) * count };
      events.push(`${TROOP_LABEL[action.troop]} ${count}명 훈련 시작`);
      return gold;
    }
    case "assign": {
      const cmd = commanders.find((c) => c.id === action.commanderId && c.state !== "dead");
      if (!cmd) throw new CityError("invalid", 404, "지휘관을 찾을 수 없습니다.");
      const want = emptyTroops();
      for (const k of TROOP_KINDS) want[k] = Math.max(0, Math.floor(action.troops[k] ?? 0));
      const cap = commanderTroopCap(state.buildings.keep, cmd.level);
      if (troopTotal(want) > cap) throw new CityError("cap", 400, `이 지휘관은 최대 ${cap}명까지 이끌 수 있습니다.`);
      const cur = state.assigned[cmd.id] ?? emptyTroops();
      for (const k of TROOP_KINDS) {
        const delta = want[k] - cur[k];
        if (delta > state.reserve[k]) throw new CityError("reserve", 400, `예비 ${TROOP_LABEL[k]}이(가) 부족합니다.`);
      }
      for (const k of TROOP_KINDS) state.reserve[k] -= want[k] - cur[k];
      if (troopTotal(want) === 0) delete state.assigned[cmd.id];
      else state.assigned[cmd.id] = want;
      events.push(`${cmd.id === "lord" ? "영주" : cmd.name} 병력 ${troopTotal(want)}명 배치`);
      return 0;
    }
    case "gather": {
      if (!home) throw new CityError("no_home", 409, "먼저 영주성을 세우세요.");
      if (state.gathers.length >= gatherParties(state.buildings.camp)) {
        throw new CityError("parties", 409, "보낼 수 있는 일꾼 부대가 없습니다. 일꾼 막사를 올리세요.");
      }
      const node = nodeById(action.nodeId, now);
      if (!node) throw new CityError("gone", 404, "자원지가 사라졌습니다.");
      if (state.gathers.some((g) => g.nodeId === node.id)) throw new CityError("busy", 409, "이미 일꾼이 가 있는 자원지입니다.");
      const remain = node.amount - (state.nodeUsed[node.id] ?? 0);
      if (remain <= 0) throw new CityError("empty", 409, "다 캐낸 자원지입니다.");
      const dist = distanceM(home, node);
      if (dist > GATHER_MAX_DISTANCE_M) {
        throw new CityError("too_far", 400, `영주성에서 너무 멉니다 (${(dist / 1000).toFixed(1)}km, 최대 ${GATHER_MAX_DISTANCE_M / 1000}km).`);
      }
      // 일꾼은 도로로만 다닌다: 잠금 밖에서 찾은 도로 경로가 영주성·자원지 양끝에 닿는지 확인한다.
      const route = action.route;
      if (!route || route.length < 2) throw new CityError("no_road", 409, "자원지까지 가는 길을 찾지 못했습니다.");
      const head = route[0] as [number, number];
      const tail = route[route.length - 1] as [number, number];
      if (
        distanceM(home, { lat: head[0], lon: head[1] }) > ROUTE_END_TOLERANCE_M ||
        distanceM(node, { lat: tail[0], lon: tail[1] }) > ROUTE_END_TOLERANCE_M
      ) {
        throw new CityError("no_road", 409, "자원지 근처에 길이 없습니다.");
      }
      const roadM = pathLengthM(route);
      if (roadM > GATHER_MAX_ROAD_M) {
        throw new CityError("too_far", 400, `길로 ${(roadM / 1000).toFixed(1)}km라 너무 멉니다 (최대 ${GATHER_MAX_ROAD_M / 1000}km).`);
      }
      const travelMs = Math.round((roadM / workerSpeedMps(state)) * 1000);
      const load = Math.min(gatherLoad(state.buildings.camp), remain);
      const gatherMs = Math.round((load / gatherRatePerSec(state)) * 1000);
      state.nodeUsed[node.id] = (state.nodeUsed[node.id] ?? 0) + load;
      const arriveAt = now + travelMs;
      const doneAt = arriveAt + gatherMs;
      state.gathers.push({
        id: `g${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
        nodeId: node.id,
        kind: node.kind,
        // 채집 지점 = 자원지 옆 도로 끝
        lat: tail[0],
        lon: tail[1],
        fromLat: head[0],
        fromLon: head[1],
        startedAt: now,
        arriveAt,
        doneAt,
        returnAt: doneAt + travelMs,
        amount: load,
        path: route,
      });
      events.push("일꾼 부대 출발");
      return 0;
    }
    case "recall": {
      const g = state.gathers.find((x) => x.id === action.gatherId);
      if (!g) throw new CityError("invalid", 404, "일꾼 부대를 찾을 수 없습니다.");
      if (now >= g.doneAt) return 0; // 이미 돌아오는 중
      const rate = gatherRatePerSec(state);
      let carried = 0;
      let backMs: number;
      if (now < g.arriveAt) {
        backMs = now - g.startedAt;
        // 가는 길에 돌아서면 지금 위치에서 온 길을 되짚어 돌아온다
        const t = (now - g.startedAt) / Math.max(1, g.arriveAt - g.startedAt);
        if (g.path && g.path.length >= 2) {
          g.path = truncatePath(g.path, pathLengthM(g.path) * t);
          const end = g.path[g.path.length - 1] as [number, number];
          g.lat = end[0];
          g.lon = end[1];
        } else {
          g.lat = g.fromLat + (g.lat - g.fromLat) * t;
          g.lon = g.fromLon + (g.lon - g.fromLon) * t;
        }
      } else {
        carried = Math.min(g.amount, Math.floor(((now - g.arriveAt) / 1000) * rate));
        backMs = g.arriveAt - g.startedAt;
      }
      state.nodeUsed[g.nodeId] = Math.max(0, (state.nodeUsed[g.nodeId] ?? 0) - (g.amount - carried));
      g.amount = carried;
      g.doneAt = now;
      g.arriveAt = Math.min(g.arriveAt, now);
      g.returnAt = now + backMs;
      g.recalled = true;
      events.push("일꾼 부대 귀환 명령");
      return 0;
    }
  }
}

/** 전투용: 지휘관별 병력 보정 (잠금 없이 읽기). 성 데이터가 없으면 빈 값. */
export async function readTroopBonuses(
  db: Tx | typeof prisma,
  userId: string,
): Promise<{ troops: Record<string, TroopCounts>; bonus: Record<string, { hp: number; atk: number }>; wallLevel: number }> {
  const row = await (db as typeof prisma).territoryCity.findUnique({ where: { userId }, select: { data: true } });
  if (!row) return { troops: {}, bonus: {}, wallLevel: 0 };
  const state = parseCityState(row.data, Date.now());
  const bonus: Record<string, { hp: number; atk: number }> = {};
  for (const [id, t] of Object.entries(state.assigned)) bonus[id] = troopBonus(t, state.tech, state.buildings);
  return { troops: state.assigned, bonus, wallLevel: state.buildings.wall };
}

/** 전투 손실 반영 (지휘관별 잃은 병력). 지금 배치된 병력에서 뺀다. */
export async function applyTroopLosses(userId: string, losses: Record<string, TroopCounts>): Promise<void> {
  const ids = Object.keys(losses).filter((id) => troopTotal(losses[id]) > 0);
  if (ids.length === 0) return;
  await withNamedLock(`city:${userId}`, async (tx) => {
    const row = await tx.territoryCity.findUnique({ where: { userId }, select: { data: true } });
    if (!row) return;
    const now = Date.now();
    const state = parseCityState(row.data, now);
    for (const id of ids) {
      const cur = state.assigned[id];
      const lost = losses[id];
      if (!cur || !lost) continue;
      for (const k of TROOP_KINDS) cur[k] = Math.max(0, cur[k] - lost[k]);
      if (troopTotal(cur) === 0) delete state.assigned[id];
    }
    await tx.territoryCity.update({ where: { userId }, data: { data: state as unknown as object, updatedAt: new Date(now) } });
  });
}
