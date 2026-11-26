// 카드 전투 서버 연결부 (2단계: 무법자 전투). 서버 전용.
//
// 구조
// - 순수 함수(앞부분): MissionUser.data JSON 객체를 받아 새 객체를 돌려준다. DB 없이 시험 가능.
// - DB 래퍼(뒷부분): `unit:${userId}` 이름 락(부대 라우트와 같은 락) 트랜잭션 안에서
//   data 를 읽고 → 순수 함수 → 다시 쓴다. data 의 다른 키(units/servants/mapSettings 등)는 보존한다.
//
// 저장 위치 (스키마 변경 없음)
// - data.battle       진행 중 전투 1개 (StoredBattle, BattleState.log 는 [] 로 비워 저장)
// - data.lastBattle   방금 끝난 전투 요약 (응답 유실 대비, GET current 가 한 번 돌려주고 지운다)
// - data.commanders   지휘관 성장: { [commanderId]: { xp, kind, wins, battles } } ("lord" = 영주)
// - data.cardCollection 카드 보관함: { [cardId]: count }
// - data.lordInjuredUntil 영주 부상 해제 시각(ms) / 부대 부상은 units[].injuredUntil
//
// 무법자 붙잡기: 전투 시작 시 /api/neutral-units/hold 와 같은 방식으로 현재 위치에 고정하고
// (legEndsAt 을 10분 뒤로), 사용하지 않는 quizKey 열에 "battle:<userId>:<battleId>:<만료ms>"
// 표식을 남겨 다른 사용자가 동시에 같은 무법자와 싸우지 못하게 한다. 행동 요청마다 필요하면 연장한다.

import { randomInt } from "node:crypto";

import {
  COLLECTIBLE_CARDS,
  MAX_LEVEL,
  OUTLAW_PRESETS,
  applyAction,
  battleXp,
  chooseAiTurn,
  createBattle,
  deckSizeForLevel,
  levelFromXp,
  redactEvents,
  starterDeck,
  toPublicSides,
  xpForLevel,
} from "@/lib/battle";
import type {
  Action,
  AttackerRef,
  BattleCommanderInfo,
  BattleEvent,
  BattleResponse,
  BattleResult,
  BattleState,
  BattleTargetInfo,
  CommanderKind,
  CommanderListItem,
  CommandersResponse,
  PublicBattleView,
  StarterDeckKey,
  TargetRef,
} from "@/lib/battle";
import { effectiveOutlawTier, outlawTierForId } from "@/lib/battle/outlaw";
import { nextRandom, seedToRng } from "@/lib/battle/rng";
import { NEUTRAL_PATH_SNAP_MAX_M, neutralPositionAt, projectOntoPath } from "@/lib/neutral-leg";
import { acquirePgLock } from "@/lib/pg-advisory-lock";
import prisma from "@/lib/prismadb";
import { withNamedLock } from "@/lib/territory";
import type { Tx } from "@/lib/territory";
import { isUnitInjured, loadUnits, positionAtMoveTarget, withUnits } from "@/lib/units";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 플레이어 한 턴 제한 */
export const TURN_MS = 45_000;
/** 네트워크 지연 유예 (마감 후 이만큼은 자동 턴 종료하지 않는다) */
export const TURN_GRACE_MS = 3_000;
/** 지휘관 ↔ 무법자 최대 거리 */
export const BATTLE_PROXIMITY_M = 150;
/** 영주 위치(하트비트) 허용 지연 */
export const LORD_POSITION_STALE_MS = 120_000;
/** 패배 부상 시간 */
/** 패배 부상 시간 (30분) */
export const INJURY_MS = 30 * 60_000;
/** 전투 중 무법자 고정 시간 (요청마다 연장) */
export const OUTLAW_HOLD_MS = 10 * 60_000;
/** 고정 남은 시간이 이보다 적으면 연장한다 */
const OUTLAW_HOLD_REFRESH_BELOW_MS = 3 * 60_000;
/** 끝난 전투 요약 보관 시간 */
export const LAST_BATTLE_KEEP_MS = 10 * 60_000;
const CLAIM_PREFIX = "battle:";

const UNIT_KINDS: ReadonlyArray<CommanderKind> = ["infantry", "archer", "cavalry", "mage"];

// ---------------------------------------------------------------------------
// 공용 타입
// ---------------------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class BattleError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

export interface StoredBattle {
  id: string;
  /** log 는 항상 [] 로 저장한다 */
  state: BattleState;
  commanderId: string;
  commanderKind: CommanderKind;
  target: BattleTargetInfo;
  /** 무법자가 속한 동 코드 (락 이름 `neutral:<dong>` 용) */
  targetDong: string | null;
  /** 플레이어(0번) 턴 마감 시각(ms) */
  turnDeadline: number;
  startedAt: number;
}

export interface StoredLastBattle {
  id: string;
  finishedAt: number;
  view: PublicBattleView;
}

export interface CommanderProgress {
  xp: number;
  kind: CommanderKind;
  wins: number;
  battles: number;
}

export interface ResolvedCommander {
  id: string;
  kind: CommanderKind;
  name: string;
  level: number;
  lat: number;
  lon: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function toJsonObject(data: unknown): JsonObject {
  return isRecord(data) ? { ...(data as JsonObject) } : {};
}

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// data 읽기
// ---------------------------------------------------------------------------

export function readActiveBattle(data: JsonObject): StoredBattle | null {
  const raw = data.battle;
  if (!isRecord(raw)) return null;
  const state = raw.state;
  if (
    typeof raw.id !== "string" ||
    typeof raw.commanderId !== "string" ||
    !isRecord(state) ||
    state.version !== 1 ||
    !Array.isArray(state.sides) ||
    !isRecord(raw.target) ||
    !isFiniteNumber(raw.turnDeadline)
  ) {
    return null;
  }
  return raw as unknown as StoredBattle;
}

export function readLastBattle(data: JsonObject): StoredLastBattle | null {
  const raw = data.lastBattle;
  if (!isRecord(raw) || typeof raw.id !== "string" || !isFiniteNumber(raw.finishedAt) || !isRecord(raw.view)) {
    return null;
  }
  return raw as unknown as StoredLastBattle;
}

const isCommanderKind = (v: unknown): v is CommanderKind =>
  v === "lord" ||
  v === "infantry" ||
  v === "archer" ||
  v === "cavalry" ||
  v === "mage" ||
  v === "outlaw" ||
  v === "garrison";

export function readCommanders(data: JsonObject): Record<string, CommanderProgress> {
  const raw = data.commanders;
  const out: Record<string, CommanderProgress> = {};
  if (!isRecord(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    out[id] = {
      xp: isFiniteNumber(v.xp) ? Math.max(0, Math.floor(v.xp)) : 0,
      kind: isCommanderKind(v.kind) ? v.kind : id === "lord" ? "lord" : "infantry",
      wins: isFiniteNumber(v.wins) ? Math.max(0, Math.floor(v.wins)) : 0,
      battles: isFiniteNumber(v.battles) ? Math.max(0, Math.floor(v.battles)) : 0,
    };
  }
  return out;
}

export function readCardCollection(data: JsonObject): Record<string, number> {
  const raw = data.cardCollection;
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (isFiniteNumber(v) && v > 0) out[id] = Math.floor(v);
  }
  return out;
}

export function commanderInfo(id: string, name: string, xp: number): BattleCommanderInfo {
  const level = levelFromXp(xp);
  return {
    id,
    name,
    level,
    xp,
    levelXpStart: xpForLevel(level),
    nextLevelXp: level >= MAX_LEVEL ? null : xpForLevel(level + 1),
  };
}

// ---------------------------------------------------------------------------
// 지휘관 확인 (순수)
// ---------------------------------------------------------------------------

export interface LordSnapshot {
  nickname: string | null;
  lat: number | null;
  lon: number | null;
  /** location_updated_at (ms) */
  updatedAt: number | null;
}

/** 지휘관 가능 여부·위치·레벨. 불가하면 BattleError. */
export function resolveCommander(
  data: JsonObject,
  commanderId: string,
  lord: LordSnapshot,
  now: number,
): ResolvedCommander {
  const progress = readCommanders(data)[commanderId];
  const level = levelFromXp(progress?.xp ?? 0);
  if (commanderId === "lord") {
    const injuredUntil = data.lordInjuredUntil;
    if (isFiniteNumber(injuredUntil) && injuredUntil > now) {
      throw new BattleError("injured", 409, "영주가 부상 중입니다.");
    }
    if (
      lord.lat === null ||
      lord.lon === null ||
      lord.updatedAt === null ||
      now - lord.updatedAt > LORD_POSITION_STALE_MS
    ) {
      throw new BattleError("location_stale", 400, "현재 위치를 확인할 수 없습니다.");
    }
    return {
      id: "lord",
      kind: "lord",
      name: lord.nickname?.trim() || "영주",
      level,
      lat: lord.lat,
      lon: lord.lon,
    };
  }
  const unit = loadUnits(data).find((u) => u.id === commanderId);
  if (!unit) {
    throw new BattleError("commander_unavailable", 404, "부대를 찾을 수 없습니다.");
  }
  if (unit.state !== "field") {
    throw new BattleError("commander_unavailable", 400, "출전할 수 없는 부대입니다.");
  }
  if (isUnitInjured(unit, now)) {
    throw new BattleError("injured", 409, "부대가 부상 중입니다.");
  }
  const pos = unit.moveTarget ? positionAtMoveTarget(unit.moveTarget, now) : { lat: unit.lat, lon: unit.lon };
  const kind = progress && UNIT_KINDS.includes(progress.kind) ? progress.kind : "infantry";
  return { id: unit.id, kind, name: unit.name, level, lat: pos.lat, lon: pos.lon };
}

// ---------------------------------------------------------------------------
// 무법자 (순수)
// ---------------------------------------------------------------------------

// 무법자 등급 계산은 화면과 공유하도록 @/lib/battle/outlaw 로 옮겼다.
export { outlawTierForId } from "@/lib/battle/outlaw";

export interface OutlawRowLike {
  id: number;
  dong: string;
  lat: number;
  lon: number;
  destLat: number;
  destLon: number;
  legStartedAt: bigint | number;
  legEndsAt: bigint | number;
  path: string | null;
  pathIdx: number;
  quizKey: string;
}

export function parseNeutralPath(raw: string | null): Array<{ lat: number; lon: number }> | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const pts: Array<{ lat: number; lon: number }> = [];
    for (const p of arr) {
      if (!isRecord(p) || !isFiniteNumber(p.lat) || !isFiniteNumber(p.lon)) return null;
      pts.push({ lat: p.lat, lon: p.lon });
    }
    return pts;
  } catch {
    return null;
  }
}

/** 무법자 현재 위치 (경로 보간) + 경로 위로 붙인 pathIdx — hold 라우트와 같은 계산 */
export function outlawPositionAt(row: OutlawRowLike, now: number): { lat: number; lon: number; pathIdx: number } {
  const path = parseNeutralPath(row.path);
  const pos = neutralPositionAt(
    {
      fromLat: row.lat,
      fromLon: row.lon,
      destLat: row.destLat,
      destLon: row.destLon,
      startedAt: Number(row.legStartedAt),
      endsAt: Number(row.legEndsAt),
      path,
      pathIdx: row.pathIdx,
    },
    now,
  );
  let pathIdx = row.pathIdx;
  let lat = pos.lat;
  let lon = pos.lon;
  const onPath = projectOntoPath(lat, lon, path, row.pathIdx >= 1 ? row.pathIdx - 1 : null);
  if (onPath && onPath.distM > 1 && onPath.distM <= NEUTRAL_PATH_SNAP_MAX_M) {
    lat = onPath.lat;
    lon = onPath.lon;
    pathIdx = onPath.pathIdx;
  }
  return { lat, lon, pathIdx };
}

export interface OutlawClaim {
  userId: string;
  battleId: string;
  until: number;
}

export function makeClaim(c: OutlawClaim): string {
  return `${CLAIM_PREFIX}${c.userId}:${c.battleId}:${c.until}`.slice(0, 255);
}

/** quizKey 의 전투 표식. userId 에 ':' 가 있어도 되도록 뒤에서부터 자른다. */
export function parseClaim(raw: string | null | undefined): OutlawClaim | null {
  if (!raw || !raw.startsWith(CLAIM_PREFIX)) return null;
  const body = raw.slice(CLAIM_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  const until = Number(body.slice(lastColon + 1));
  const rest = body.slice(0, lastColon);
  const mid = rest.lastIndexOf(":");
  if (lastColon < 0 || mid < 0 || !Number.isFinite(until)) return null;
  return { userId: rest.slice(0, mid), battleId: rest.slice(mid + 1), until };
}

/** 다른 사용자가 아직 유효하게 붙잡고 있는가 */
export function claimedByOther(raw: string | null | undefined, userId: string, now: number): boolean {
  const c = parseClaim(raw);
  return !!c && c.userId !== userId && c.until > now;
}

// ---------------------------------------------------------------------------
// 전투 생성·진행 (순수)
// ---------------------------------------------------------------------------

export function makeBattleId(): string {
  return `b-${Date.now().toString(36)}${randomInt(0, 36 ** 6).toString(36)}`;
}

export function makeBattleSeed(): number {
  return randomInt(0, 2 ** 31 - 1);
}

function starterKeyFor(kind: CommanderKind): StarterDeckKey {
  return kind === "lord" || kind === "archer" || kind === "cavalry" || kind === "mage" ? kind : "infantry";
}

export interface OutlawTargetInput {
  id: number;
  dong: string;
  lat: number;
  lon: number;
}

/** 무법자 전투 생성. events = 시작 뽑기 등 (상대 카드 가림) */
export function startOutlawBattle(input: {
  battleId: string;
  seed: number;
  now: number;
  commander: Pick<ResolvedCommander, "id" | "kind" | "name" | "level">;
  outlaw: OutlawTargetInput;
}): { battle: StoredBattle; events: BattleEvent[] } {
  const { commander, outlaw } = input;
  // 저레벨 지휘관은 한 단계 낮은 무법자와 싸운다 (견습 보정).
  const tier = effectiveOutlawTier(outlawTierForId(outlaw.id), commander.level);
  const preset = OUTLAW_PRESETS[tier];
  const state = createBattle({
    seed: input.seed,
    attacker: {
      commander: { id: commander.id, kind: commander.kind, name: commander.name, level: commander.level },
      deck: starterDeck(starterKeyFor(commander.kind), deckSizeForLevel(commander.level)),
    },
    defender: {
      commander: { id: `outlaw-${outlaw.id}`, kind: "outlaw", name: preset.name, level: preset.level, maxHp: preset.hp },
      deck: preset.deck,
    },
  });
  const events = redactEvents(state.log, 0);
  return {
    battle: {
      id: input.battleId,
      state: { ...state, log: [] },
      commanderId: commander.id,
      commanderKind: commander.kind,
      target: { type: "outlaw", id: String(outlaw.id), name: preset.name, lat: outlaw.lat, lon: outlaw.lon, tier },
      targetDong: outlaw.dong,
      turnDeadline: input.now + TURN_MS,
      startedAt: input.now,
    },
    events,
  };
}

/** 다른 영주의 부대·영주 공격 전투 생성. 수비 지휘관은 상대의 병종·레벨·시작 덱으로 서버 AI가 대신 싸운다. */
export function startPlayerBattle(input: {
  battleId: string;
  seed: number;
  now: number;
  commander: Pick<ResolvedCommander, "id" | "kind" | "name" | "level">;
  defender: ResolvedCommander;
  ownerId: string;
  ownerName: string | null;
}): { battle: StoredBattle; events: BattleEvent[] } {
  const { commander, defender } = input;
  const isLord = defender.id === "lord";
  const displayName = isLord ? `영주 ${defender.name}` : defender.name;
  const state = createBattle({
    seed: input.seed,
    attacker: {
      commander: { id: commander.id, kind: commander.kind, name: commander.name, level: commander.level },
      deck: starterDeck(starterKeyFor(commander.kind), deckSizeForLevel(commander.level)),
    },
    defender: {
      commander: { id: `pvp-${defender.id}`, kind: defender.kind, name: displayName, level: defender.level },
      deck: starterDeck(starterKeyFor(defender.kind), deckSizeForLevel(defender.level)),
    },
  });
  const events = redactEvents(state.log, 0);
  return {
    battle: {
      id: input.battleId,
      state: { ...state, log: [] },
      commanderId: commander.id,
      commanderKind: commander.kind,
      target: {
        type: isLord ? "lord" : "unit",
        id: defender.id,
        ownerId: input.ownerId,
        name: isLord || !input.ownerName ? displayName : `${input.ownerName}의 ${defender.name}`,
        lat: defender.lat,
        lon: defender.lon,
      },
      targetDong: null,
      turnDeadline: input.now + TURN_MS,
      startedAt: input.now,
    },
    events,
  };
}

/**
 * 끝난 대인 전투를 수비 측 data 에 반영: 수비 지휘관 전적·경험치, 지면 부상 30분.
 * 수비 지휘관이 그 사이 사라졌으면(해산 등) 전적만 남기지 않는다.
 */
export function settleDefender(data: JsonObject, battle: StoredBattle, now: number): { data: JsonObject; injuredUntil: number | null } {
  const state = battle.state;
  if (state.winner === null) throw new Error("settleDefender: 끝나지 않은 전투");
  const defenderId = battle.target.id;
  const defenderWon = state.winner === 1;
  let out: JsonObject = { ...data };
  if (defenderId !== "lord" && !loadUnits(out).some((u) => u.id === defenderId)) {
    return { data: out, injuredUntil: null };
  }
  const commanders = readCommanders(out);
  const prev: CommanderProgress = commanders[defenderId] ?? {
    xp: 0,
    kind: defenderId === "lord" ? "lord" : "infantry",
    wins: 0,
    battles: 0,
  };
  commanders[defenderId] = {
    xp: prev.xp + battleXp({ won: defenderWon, kills: state.sides[1].kills, vsOutlaw: false }),
    kind: prev.kind,
    wins: prev.wins + (defenderWon ? 1 : 0),
    battles: prev.battles + 1,
  };
  out.commanders = commanders as unknown as JsonValue;
  // 공격자가 이겼을 때만 수비 지휘관 부상 (공격자 항복·시간 초과 패배는 수비 승리).
  const injuredUntil = state.winner === 0 ? now + INJURY_MS : null;
  if (injuredUntil !== null) {
    if (defenderId === "lord") {
      out.lordInjuredUntil = injuredUntil;
    } else {
      out = withUnits(
        out,
        loadUnits(out).map((u) => (u.id === defenderId ? { ...u, injuredUntil } : u)),
      );
    }
  }
  return { data: out, injuredUntil };
}

/** AI(1번) 한 턴. 잘못된 행동이 나오면 멈추고 턴 종료를 강제한다. */
export function runAiTurn(start: BattleState): { state: BattleState; events: BattleEvent[] } {
  let state = start;
  const events: BattleEvent[] = [];
  if (state.winner !== null || state.activeSide !== 1) return { state, events };
  const actions = chooseAiTurn({ ...state, log: [] }, 1);
  for (const a of actions) {
    if (state.winner !== null || state.activeSide !== 1) break;
    const r = applyAction(state, 1, a);
    if (!r.ok) {
      console.warn(`[battle] AI 행동 거부: ${r.error}`, a);
      break;
    }
    state = r.state;
    events.push(...r.events);
  }
  if (state.winner === null && state.activeSide === 1) {
    const r = applyAction(state, 1, { type: "endTurn" });
    if (r.ok) {
      state = r.state;
      events.push(...r.events);
    }
  }
  return { state, events };
}

export interface AdvanceResult {
  battle: StoredBattle;
  /** 공개용(가림 처리 전) 이벤트 */
  events: BattleEvent[];
  /** 요청한 행동을 적용했는가 (시간 초과로 턴이 넘어갔으면 false) */
  applied: boolean;
  /** 상태가 바뀌었는가 (저장 필요) */
  changed: boolean;
}

/**
 * 시간 초과 처리 + (있으면) 플레이어 행동 적용 + 이어진 AI 턴.
 * 시간 초과로 턴이 넘어간 요청은 행동(항복 제외)을 버리고 그 결과만 돌려준다.
 */
export function advanceBattle(battle: StoredBattle, action: Action | null, now: number): AdvanceResult {
  let state: BattleState = { ...battle.state, log: [] };
  let deadline = battle.turnDeadline;
  const events: BattleEvent[] = [];
  let changed = false;
  let timedOut = false;

  const afterPlayer = (): void => {
    if (state.winner === null && state.activeSide === 1) {
      const ai = runAiTurn(state);
      state = ai.state;
      events.push(...ai.events);
      deadline = now + TURN_MS;
    }
  };

  if (state.winner === null) {
    // 비정상 저장(AI 차례) 복구
    if (state.activeSide === 1) {
      afterPlayer();
      changed = true;
    } else if (now > deadline + TURN_GRACE_MS) {
      const r = applyAction(state, 0, { type: "endTurn" });
      if (r.ok) {
        state = r.state;
        events.push(...r.events);
        afterPlayer();
        changed = true;
        timedOut = true;
      }
    }
  }

  let applied = false;
  if (action && (!timedOut || action.type === "concede")) {
    if (state.winner !== null) {
      if (!changed) throw new BattleError("battle_over", 409, "이미 끝난 전투입니다.");
    } else {
      if (action.type !== "concede" && state.activeSide !== 0) {
        throw new BattleError("not_your_turn", 409, "상대 차례입니다.");
      }
      const r = applyAction(state, 0, action);
      if (!r.ok) throw new BattleError("invalid_action", 400, r.error);
      state = r.state;
      events.push(...r.events);
      applied = true;
      changed = true;
      afterPlayer();
    }
  }

  return {
    battle: { ...battle, state: { ...state, log: [] }, turnDeadline: deadline },
    events,
    applied,
    changed,
  };
}

// ---------------------------------------------------------------------------
// 종료 정산 (순수)
// ---------------------------------------------------------------------------

/** 보상 카드: 지휘관 병종 카드 + 공용 카드 중 하나 (영주는 전체). 전투 시드로 결정. */
export function pickRewardCard(seed: number, kind: CommanderKind): string {
  const pool = COLLECTIBLE_CARDS.filter(
    (c) => kind === "lord" || c.cardClass === "neutral" || c.cardClass === kind,
  );
  const v = nextRandom(seedToRng((seed ^ 0x5eed5eed) >>> 0)).value;
  return pool[Math.floor(v * pool.length)]?.id ?? pool[0].id;
}

/** 끝난 전투를 data 에 반영 (경험치·보관함·부상). data.battle 은 지운다. */
export function settleBattle(data: JsonObject, battle: StoredBattle, now: number): { data: JsonObject; result: BattleResult } {
  const state = battle.state;
  if (state.winner === null) throw new Error("settleBattle: 끝나지 않은 전투");
  const winner = state.winner;
  const victory = winner === 0;
  const name = state.sides[0].commander.name;

  const xpGained = battleXp({ won: victory, kills: state.sides[0].kills, vsOutlaw: battle.target.type === "outlaw" });
  const commanders = readCommanders(data);
  const prev: CommanderProgress = commanders[battle.commanderId] ?? {
    xp: 0,
    kind: battle.commanderKind,
    wins: 0,
    battles: 0,
  };
  const next: CommanderProgress = {
    xp: prev.xp + xpGained,
    kind: prev.kind,
    wins: prev.wins + (victory ? 1 : 0),
    battles: prev.battles + 1,
  };
  commanders[battle.commanderId] = next;
  const before = commanderInfo(battle.commanderId, name, prev.xp);
  const after = commanderInfo(battle.commanderId, name, next.xp);

  // lastBattleAt: 계급 승급의 무활동 강등 판정에 쓰는 마지막 전투 시각.
  let out: JsonObject = { ...data, commanders: commanders as unknown as JsonValue, lastBattleAt: now };

  const cardRewards: string[] = [];
  if (victory) {
    const card = pickRewardCard(state.seed, battle.commanderKind);
    const collection = readCardCollection(data);
    collection[card] = (collection[card] ?? 0) + 1;
    out.cardCollection = collection;
    cardRewards.push(card);
  }

  // 패배(항복 포함) = 부상 30분. 무승부는 부상 없음.
  const injuredUntil = winner === 1 ? now + INJURY_MS : null;
  if (injuredUntil !== null) {
    if (battle.commanderId === "lord") {
      out.lordInjuredUntil = injuredUntil;
    } else {
      const units = loadUnits(out);
      if (units.some((u) => u.id === battle.commanderId)) {
        out = withUnits(
          out,
          units.map((u) => (u.id === battle.commanderId ? { ...u, injuredUntil } : u)),
        );
      }
    }
  }

  delete out.battle;
  return {
    data: out,
    result: {
      winner,
      reason: state.endReason ?? "commander-defeated",
      victory,
      xpGained,
      commanderBefore: before,
      commanderAfter: after,
      levelUp: after.level > before.level,
      cardRewards,
      injuredUntil,
    },
  };
}

// ---------------------------------------------------------------------------
// 공개 형식 (순수)
// ---------------------------------------------------------------------------

export function buildView(battle: StoredBattle, data: JsonObject, result: BattleResult | null): PublicBattleView {
  const s = battle.state;
  const xp = readCommanders(data)[battle.commanderId]?.xp ?? 0;
  return {
    battleId: battle.id,
    viewerSide: 0,
    turn: s.turn,
    activeSide: s.activeSide,
    turnDeadline: battle.turnDeadline,
    sides: toPublicSides(s, 0),
    winner: s.winner,
    endReason: s.endReason,
    target: battle.target,
    commander: result ? result.commanderAfter : commanderInfo(battle.commanderId, s.sides[0].commander.name, xp),
    result,
  };
}

export interface StepResult {
  data: JsonObject;
  changed: boolean;
  view: PublicBattleView;
  events: BattleEvent[];
  /** 이번 요청에서 끝났으면 그 전투 (무법자 처리용) */
  finished: StoredBattle | null;
}

/**
 * 진행 중 전투 한 단계 (action=null 이면 시간 초과만 처리).
 * keepLast: 끝났을 때 data.lastBattle 에 요약을 남길지 (응답 유실 대비).
 */
export function stepBattle(
  data: JsonObject,
  battle: StoredBattle,
  action: Action | null,
  now: number,
  keepLast: boolean,
): StepResult {
  const adv = advanceBattle(battle, action, now);
  const events = redactEvents(adv.events, 0);
  if (adv.battle.state.winner !== null) {
    const settled = settleBattle(data, adv.battle, now);
    const view = buildView(adv.battle, settled.data, settled.result);
    const out = settled.data;
    if (keepLast) {
      out.lastBattle = { id: adv.battle.id, finishedAt: now, view } as unknown as JsonValue;
    } else {
      delete out.lastBattle;
    }
    return { data: out, changed: true, view, events, finished: adv.battle };
  }
  const out: JsonObject = adv.changed ? { ...data, battle: adv.battle as unknown as JsonValue } : data;
  return { data: out, changed: adv.changed, view: buildView(adv.battle, out, null), events, finished: null };
}

/** GET current: 진행 중 전투 → 그대로(시간 초과 처리), 없으면 최근 끝난 전투 1회 */
export function currentBattle(
  data: JsonObject,
  now: number,
): { data: JsonObject; changed: boolean; view: PublicBattleView | null; events: BattleEvent[]; finished: StoredBattle | null } {
  const battle = readActiveBattle(data);
  if (battle) return stepBattle(data, battle, null, now, false);
  const last = readLastBattle(data);
  if (!last) return { data, changed: false, view: null, events: [], finished: null };
  const out = { ...data };
  delete out.lastBattle;
  return { data: out, changed: true, view: now - last.finishedAt <= LAST_BATTLE_KEEP_MS ? last.view : null, events: [], finished: null };
}

// ---------------------------------------------------------------------------
// 요청 본문 검증 (순수)
// ---------------------------------------------------------------------------

function parseTargetRef(v: unknown): TargetRef | null {
  if (!isRecord(v) || (v.side !== 0 && v.side !== 1)) return null;
  if (v.kind === "commander") return { kind: "commander", side: v.side };
  if (v.kind === "soldier" && isInt(v.iid)) return { kind: "soldier", side: v.side, iid: v.iid };
  return null;
}

function parseAttackerRef(v: unknown): AttackerRef | null {
  if (!isRecord(v)) return null;
  if (v.kind === "commander") return { kind: "commander" };
  if (v.kind === "soldier" && isInt(v.iid)) return { kind: "soldier", iid: v.iid };
  return null;
}

/** 클라이언트 행동 JSON → Action (모양이 틀리면 null) */
export function parseAction(v: unknown): Action | null {
  if (!isRecord(v)) return null;
  switch (v.type) {
    case "endTurn":
      return { type: "endTurn" };
    case "concede":
      return { type: "concede" };
    case "playCard": {
      if (!isInt(v.iid)) return null;
      const action: Action = { type: "playCard", iid: v.iid };
      if (v.target !== undefined && v.target !== null) {
        const t = parseTargetRef(v.target);
        if (!t) return null;
        action.target = t;
      }
      if (v.boardPos !== undefined && v.boardPos !== null) {
        if (!isInt(v.boardPos)) return null;
        action.boardPos = v.boardPos;
      }
      return action;
    }
    case "attack": {
      const attacker = parseAttackerRef(v.attacker);
      const target = parseTargetRef(v.target);
      return attacker && target ? { type: "attack", attacker, target } : null;
    }
    case "heroPower": {
      if (v.target === undefined || v.target === null) return { type: "heroPower" };
      const t = parseTargetRef(v.target);
      return t ? { type: "heroPower", target: t } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// DB 래퍼
// ---------------------------------------------------------------------------

async function loadUserData(tx: Tx, userId: string): Promise<JsonObject> {
  const row = await tx.missionUser.findUnique({ where: { userId }, select: { data: true } });
  if (!row) throw new BattleError("not_found", 404, "사용자를 찾을 수 없습니다.");
  return toJsonObject(row.data);
}

async function saveUserData(tx: Tx, userId: string, data: JsonObject): Promise<void> {
  await tx.missionUser.update({ where: { userId }, data: { data } });
}

/**
 * 영주 부상 치료: lordInjuredUntil 을 지운다. 오토배틀 정산과 겹치지 않게 같은 잠금을 쓴다.
 * 부상 중이 아니었으면 false.
 */
export async function healLordForUser(userId: string): Promise<boolean> {
  return withNamedLock(`autobattle:${userId}`, async (tx) => {
    const data = await loadUserData(tx, userId);
    const until = data.lordInjuredUntil;
    if (typeof until !== "number" || until <= Date.now()) {
      if ("lordInjuredUntil" in data) {
        const { lordInjuredUntil: _drop, ...rest } = data;
        void _drop;
        await saveUserData(tx, userId, rest);
      }
      return false;
    }
    const { lordInjuredUntil: _drop, ...rest } = data;
    void _drop;
    await saveUserData(tx, userId, rest);
    return true;
  });
}

/** 무법자를 현재 위치에 고정하고 전투 표식을 남긴다 (neutral 락 안에서 호출). */
async function holdOutlawTx(tx: Tx, row: OutlawRowLike, userId: string, battleId: string, now: number): Promise<void> {
  const pos = outlawPositionAt(row, now);
  await tx.territoryNeutralUnit.update({
    where: { id: row.id },
    data: {
      lat: pos.lat,
      lon: pos.lon,
      destLat: pos.lat,
      destLon: pos.lon,
      pathIdx: pos.pathIdx,
      legStartedAt: BigInt(now),
      legEndsAt: BigInt(now + OUTLAW_HOLD_MS),
      updatedAt: BigInt(now),
      quizKey: makeClaim({ userId, battleId, until: now + OUTLAW_HOLD_MS }),
    },
  });
}

/** 진행 중 전투의 무법자 고정 연장 (필요할 때만 쓰기). */
async function refreshOutlawHold(tx: Tx, userId: string, battle: StoredBattle, now: number): Promise<void> {
  if (battle.target.type !== "outlaw" || !battle.targetDong) return;
  const id = Number(battle.target.id);
  if (!Number.isInteger(id)) return;
  const peek = await tx.territoryNeutralUnit.findUnique({ where: { id } });
  if (!peek) return;
  const claim = parseClaim(peek.quizKey);
  const ours = !!claim && claim.userId === userId && claim.battleId === battle.id;
  const fresh =
    ours &&
    claim.until - now > OUTLAW_HOLD_REFRESH_BELOW_MS &&
    Number(peek.legEndsAt) > now + 60_000 &&
    peek.lat === peek.destLat &&
    peek.lon === peek.destLon;
  if (fresh) return;
  await acquirePgLock(tx, `neutral:${peek.dong.trim()}`);
  const row = await tx.territoryNeutralUnit.findUnique({ where: { id } });
  if (!row || claimedByOther(row.quizKey, userId, now)) return;
  await holdOutlawTx(tx, row, userId, battle.id, now);
}

/** 끝난 전투의 무법자 처리: 승리 → 삭제(다른 사용자가 붙잡고 있으면 남김), 그 외 → 풀어 준다. */
async function resolveOutlawAfterBattle(tx: Tx, userId: string, battle: StoredBattle, now: number): Promise<void> {
  if (battle.target.type !== "outlaw") return;
  const id = Number(battle.target.id);
  if (!Number.isInteger(id)) return;
  const peek = await tx.territoryNeutralUnit.findUnique({ where: { id }, select: { dong: true } });
  if (!peek) return;
  await acquirePgLock(tx, `neutral:${peek.dong.trim()}`);
  const row = await tx.territoryNeutralUnit.findUnique({ where: { id } });
  if (!row) return;
  const victory = battle.state.winner === 0;
  if (victory) {
    if (claimedByOther(row.quizKey, userId, now)) {
      console.log(`[battle] outlaw ${id} 다른 사용자가 전투 중이라 남김 (battle=${battle.id})`);
      return;
    }
    await tx.territoryNeutralUnit.delete({ where: { id } });
    console.log(`[battle] outlaw ${id} 토벌 (user=${userId} battle=${battle.id})`);
    return;
  }
  const claim = parseClaim(row.quizKey);
  if (claim && claim.userId === userId) {
    // hold=false 와 같은 방식: 다리를 지금 끝내 다음 틱부터 다시 배회한다.
    await tx.territoryNeutralUnit.update({
      where: { id },
      data: { quizKey: "", legEndsAt: BigInt(now), updatedAt: BigInt(now) },
    });
  }
}

async function afterStep(tx: Tx, userId: string, step: StepResult, active: StoredBattle | null, now: number): Promise<void> {
  if (step.changed) await saveUserData(tx, userId, step.data);
  if (step.finished) {
    await resolveOutlawAfterBattle(tx, userId, step.finished, now);
  } else if (active) {
    await refreshOutlawHold(tx, userId, active, now);
  }
}

const userLock = (userId: string): string => `unit:${userId}`;

/**
 * 대인 전투가 끝났으면 수비 측에 결과를 반영한다. 공격자 트랜잭션이 끝난 뒤 따로 잠가서
 * 두 사용자 잠금을 한꺼번에 잡지 않는다 (서로 공격할 때 교착 방지).
 */
async function settleDefenderAfter(attackerId: string, finished: StoredBattle | null): Promise<void> {
  if (!finished || (finished.target.type !== "unit" && finished.target.type !== "lord")) return;
  const ownerId = finished.target.ownerId;
  if (!ownerId || ownerId === attackerId) return;
  try {
    await withNamedLock(userLock(ownerId), async (tx) => {
      const now = Date.now();
      const data = await loadUserData(tx, ownerId);
      const settled = settleDefender(data, finished, now);
      await saveUserData(tx, ownerId, settled.data);
      console.log(
        `[battle] defender settled owner=${ownerId} target=${finished.target.id} attacker=${attackerId} battle=${finished.id} winner=${finished.state.winner} injured=${settled.injuredUntil !== null}`,
      );
    });
  } catch (error) {
    console.error(`[battle] defender settle failed battle=${finished.id}`, error);
  }
}

/** 공격할 상대 지휘관 확인 (락 없이 읽기 — 위치·부상 확인용 스냅샷). */
async function resolveDefender(attackerId: string, ownerId: string, targetId: string, now: number): Promise<{ defender: ResolvedCommander; ownerName: string | null }> {
  if (!ownerId || ownerId === attackerId) throw new BattleError("invalid", 400, "공격할 수 없는 대상입니다.");
  const [me, owner] = await Promise.all([
    prisma.missionUser.findUnique({ where: { userId: attackerId }, select: { ARMissionKey: true } }),
    prisma.missionUser.findUnique({
      where: { userId: ownerId },
      select: { ARMissionKey: true, data: true, nickname: true, lat: true, lon: true, location_updated_at: true },
    }),
  ]);
  if (!owner || !me || (owner.ARMissionKey ?? "").trim() !== (me.ARMissionKey ?? "").trim()) {
    throw new BattleError("not_found", 404, "상대를 찾을 수 없습니다.");
  }
  try {
    const defender = resolveCommander(
      toJsonObject(owner.data),
      targetId,
      {
        nickname: owner.nickname,
        lat: owner.lat === null ? null : Number(owner.lat),
        lon: owner.lon === null ? null : Number(owner.lon),
        updatedAt: owner.location_updated_at ? owner.location_updated_at.getTime() : null,
      },
      now,
    );
    return { defender, ownerName: owner.nickname?.trim() || null };
  } catch (error) {
    if (error instanceof BattleError) {
      if (error.code === "injured") throw new BattleError("target_injured", 409, "상대가 부상 중이라 공격할 수 없습니다.");
      throw new BattleError("target_unavailable", 409, "지금은 이 상대를 공격할 수 없습니다.");
    }
    throw error;
  }
}

/** POST /api/battle/start */
export async function startBattleForUser(userId: string, body: unknown): Promise<BattleResponse> {
  const rec = isRecord(body) ? body : {};
  const commanderId = typeof rec.commanderId === "string" ? rec.commanderId.trim() : "";
  const targetType = rec.targetType;
  if (targetType === "unit" || targetType === "lord") {
    const ownerId = typeof rec.targetOwnerId === "string" ? rec.targetOwnerId.trim() : "";
    const targetId = targetType === "lord" ? "lord" : typeof rec.targetId === "string" ? rec.targetId.trim() : "";
    if (!commanderId || !ownerId || !targetId) throw new BattleError("invalid", 400, "잘못된 요청입니다.");
    let finished: StoredBattle | null = null;
    const res = await withNamedLock(userLock(userId), async (tx): Promise<BattleResponse> => {
      const now = Date.now();
      const user = await tx.missionUser.findUnique({
        where: { userId },
        select: { data: true, nickname: true, lat: true, lon: true, location_updated_at: true },
      });
      if (!user) throw new BattleError("not_found", 404, "사용자를 찾을 수 없습니다.");
      const data = toJsonObject(user.data);
      const active = readActiveBattle(data);
      if (active) {
        const step = stepBattle(data, active, null, now, false);
        await afterStep(tx, userId, step, active, now);
        finished = step.finished;
        return { ok: true, battle: step.view, events: step.events };
      }
      const commander = resolveCommander(
        data,
        commanderId,
        {
          nickname: user.nickname,
          lat: user.lat === null ? null : Number(user.lat),
          lon: user.lon === null ? null : Number(user.lon),
          updatedAt: user.location_updated_at ? user.location_updated_at.getTime() : null,
        },
        now,
      );
      const { defender, ownerName } = await resolveDefender(userId, ownerId, targetId, now);
      const dist = distM(commander.lat, commander.lon, defender.lat, defender.lon);
      if (dist > BATTLE_PROXIMITY_M) {
        throw new BattleError("too_far", 400, `상대와 너무 멉니다 (${Math.round(dist)}m, 최대 ${BATTLE_PROXIMITY_M}m).`);
      }
      const battleId = makeBattleId();
      const started = startPlayerBattle({
        battleId,
        seed: makeBattleSeed(),
        now,
        commander,
        defender,
        ownerId,
        ownerName,
      });
      const next: JsonObject = { ...data, battle: started.battle as unknown as JsonValue };
      delete next.lastBattle;
      await saveUserData(tx, userId, next);
      console.log(
        `[battle] start pvp user=${userId} battle=${battleId} commander=${commander.id}(${commander.kind} lv${commander.level}) vs owner=${ownerId} ${defender.id}(${defender.kind} lv${defender.level}) dist=${Math.round(dist)}m`,
      );
      return { ok: true, battle: buildView(started.battle, next, null), events: started.events };
    });
    await settleDefenderAfter(userId, finished);
    return res;
  }

  const outlawId = typeof rec.targetId === "string" || typeof rec.targetId === "number" ? Number(rec.targetId) : NaN;
  if (targetType !== "outlaw" || !commanderId || !Number.isInteger(outlawId)) {
    throw new BattleError("invalid", 400, "잘못된 요청입니다.");
  }

  let finishedEarly: StoredBattle | null = null;
  const outlawRes = await withNamedLock(userLock(userId), async (tx): Promise<BattleResponse> => {
    const now = Date.now();
    const user = await tx.missionUser.findUnique({
      where: { userId },
      select: { data: true, nickname: true, lat: true, lon: true, location_updated_at: true },
    });
    if (!user) throw new BattleError("not_found", 404, "사용자를 찾을 수 없습니다.");
    const data = toJsonObject(user.data);

    // 이미 진행 중이면 그 전투를 돌려준다 (시간 초과는 처리).
    const active = readActiveBattle(data);
    if (active) {
      const step = stepBattle(data, active, null, now, false);
      await afterStep(tx, userId, step, active, now);
      finishedEarly = step.finished;
      return { ok: true, battle: step.view, events: step.events };
    }

    const commander = resolveCommander(
      data,
      commanderId,
      {
        nickname: user.nickname,
        lat: user.lat === null ? null : Number(user.lat),
        lon: user.lon === null ? null : Number(user.lon),
        updatedAt: user.location_updated_at ? user.location_updated_at.getTime() : null,
      },
      now,
    );

    const peek = await tx.territoryNeutralUnit.findUnique({ where: { id: outlawId }, select: { dong: true } });
    if (!peek) throw new BattleError("not_found", 404, "무법자를 찾을 수 없습니다.");
    const dong = peek.dong.trim();
    await acquirePgLock(tx, `neutral:${dong}`);
    const row = await tx.territoryNeutralUnit.findUnique({ where: { id: outlawId } });
    if (!row) throw new BattleError("not_found", 404, "무법자를 찾을 수 없습니다.");
    if (claimedByOther(row.quizKey, userId, now)) {
      throw new BattleError("outlaw_busy", 409, "다른 영주가 이 무법자와 싸우고 있습니다.");
    }
    const pos = outlawPositionAt(row, now);
    const dist = distM(commander.lat, commander.lon, pos.lat, pos.lon);
    if (dist > BATTLE_PROXIMITY_M) {
      throw new BattleError("too_far", 400, `무법자와 너무 멉니다 (${Math.round(dist)}m, 최대 ${BATTLE_PROXIMITY_M}m).`);
    }

    const battleId = makeBattleId();
    const started = startOutlawBattle({
      battleId,
      seed: makeBattleSeed(),
      now,
      commander,
      outlaw: { id: row.id, dong, lat: pos.lat, lon: pos.lon },
    });
    await holdOutlawTx(tx, row, userId, battleId, now);

    const next: JsonObject = { ...data, battle: started.battle as unknown as JsonValue };
    delete next.lastBattle;
    await saveUserData(tx, userId, next);
    console.log(
      `[battle] start user=${userId} battle=${battleId} commander=${commander.id}(${commander.kind} lv${commander.level}) outlaw=${row.id} tier=${started.battle.target.tier} dist=${Math.round(dist)}m`,
    );
    return { ok: true, battle: buildView(started.battle, next, null), events: started.events };
  });
  await settleDefenderAfter(userId, finishedEarly);
  return outlawRes;
}

/** POST /api/battle/action */
export async function actForUser(userId: string, body: unknown): Promise<BattleResponse> {
  const rec = isRecord(body) ? body : {};
  const battleId = typeof rec.battleId === "string" ? rec.battleId : "";
  const action = parseAction(rec.action);
  if (!battleId || !action) throw new BattleError("invalid", 400, "잘못된 요청입니다.");

  let finished: StoredBattle | null = null;
  const res = await withNamedLock(userLock(userId), async (tx): Promise<BattleResponse> => {
    const now = Date.now();
    const data = await loadUserData(tx, userId);
    const active = readActiveBattle(data);
    if (!active || active.id !== battleId) {
      // 끝난 직후 재시도(응답 유실)면 결과를 다시 준다.
      const last = readLastBattle(data);
      if (last && last.id === battleId) return { ok: true, battle: last.view, events: [] };
      throw new BattleError("no_battle", 404, "진행 중인 전투가 없습니다.");
    }
    const step = stepBattle(data, active, action, now, true);
    await afterStep(tx, userId, step, active, now);
    finished = step.finished;
    if (step.finished) {
      const r = step.view.result;
      console.log(
        `[battle] end user=${userId} battle=${active.id} victory=${r?.victory} reason=${r?.reason} xp=+${r?.xpGained} cards=${r?.cardRewards.join(",")}`,
      );
    }
    return { ok: true, battle: step.view, events: step.events };
  });
  await settleDefenderAfter(userId, finished);
  return res;
}

/** GET /api/battle/current */
export async function currentForUser(userId: string): Promise<BattleResponse> {
  let finished: StoredBattle | null = null;
  const res = await withNamedLock(userLock(userId), async (tx): Promise<BattleResponse> => {
    const now = Date.now();
    const data = await loadUserData(tx, userId);
    const active = readActiveBattle(data);
    const cur = currentBattle(data, now);
    if (cur.changed) await saveUserData(tx, userId, cur.data);
    finished = cur.finished;
    if (cur.finished) {
      await resolveOutlawAfterBattle(tx, userId, cur.finished, now);
    } else if (active) {
      await refreshOutlawHold(tx, userId, active, now);
    }
    return { ok: true, battle: cur.view, events: cur.events };
  });
  await settleDefenderAfter(userId, finished);
  return res;
}

/** 지휘관 선택창 목록에 쓰는 순수 계산 (영주 + 부대). */
export function listCommanders(data: JsonObject, nickname: string | null, now: number): CommanderListItem[] {
  const progress = readCommanders(data);
  const lordInjured = isFiniteNumber(data.lordInjuredUntil) && data.lordInjuredUntil > now ? data.lordInjuredUntil : null;
  // 선택 창 정보 표시용 경험치·전적
  const extra = (id: string): Pick<CommanderListItem, "xp" | "levelXpStart" | "nextLevelXp" | "wins" | "battles"> => {
    const p = progress[id];
    const xp = p?.xp ?? 0;
    const level = levelFromXp(xp);
    return {
      xp,
      levelXpStart: xpForLevel(level),
      nextLevelXp: level >= MAX_LEVEL ? null : xpForLevel(level + 1),
      wins: p?.wins ?? 0,
      battles: p?.battles ?? 0,
    };
  };
  const out: CommanderListItem[] = [
    {
      id: "lord",
      name: nickname?.trim() || "영주",
      kind: "lord",
      level: levelFromXp(progress.lord?.xp ?? 0),
      state: "field",
      injuredUntil: lordInjured,
      available: lordInjured === null,
      ...extra("lord"),
    },
  ];
  for (const unit of loadUnits(data)) {
    const p = progress[unit.id];
    const injured = isUnitInjured(unit, now) && isFiniteNumber(unit.injuredUntil) ? unit.injuredUntil : null;
    out.push({
      id: unit.id,
      name: unit.name,
      kind: p && UNIT_KINDS.includes(p.kind) ? p.kind : "infantry",
      level: levelFromXp(p?.xp ?? 0),
      state: unit.state,
      injuredUntil: injured,
      available: unit.state === "field" && injured === null,
      ...extra(unit.id),
    });
  }
  return out;
}

/** GET /api/battle/commanders */
export async function commandersForUser(userId: string): Promise<CommandersResponse> {
  const now = Date.now();
  const row = await prisma.missionUser.findUnique({ where: { userId }, select: { data: true, nickname: true } });
  if (!row) throw new BattleError("not_found", 404, "사용자를 찾을 수 없습니다.");
  return { ok: true, serverNow: now, commanders: listCommanders(toJsonObject(row.data), row.nickname, now) };
}
