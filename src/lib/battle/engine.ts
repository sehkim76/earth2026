// 결정적 전투 엔진.
// - 순수 함수: applyAction 은 입력 상태를 변경하지 않고 새 상태를 돌려준다.
// - 난수는 상태 안의 mulberry32 상태(rng)만 사용한다 (Math.random/Date 금지).
// - 서버 권위: 모든 행동은 여기서 검증된다. 잘못된 행동은 { ok: false } + 상태 불변.

import { SPARE_MANA_ID, getCard } from "./cards";
import { heroPower, makeCommander } from "./commanders";
import type { CommanderSetup } from "./commanders";
import { nextRandom, seedToRng } from "./rng";
import type {
  Action,
  ApplyResult,
  AttackerRef,
  BattleEvent,
  BattleEventBody,
  BattleState,
  CardDef,
  CardInstance,
  Commander,
  Effect,
  EffectTarget,
  Keyword,
  SideIndex,
  SideState,
  Soldier,
  TargetFilter,
  TargetRef,
} from "./types";

export const MAX_MANA = 7;
export const MAX_HAND = 7;
export const MAX_BOARD = 5;
/** 이 턴 수(양측 합산)를 넘기면 무승부 (피로 피해 때문에 실제로는 거의 도달하지 않음) */
export const MAX_TURNS = 60;
/** 여분 마나 등으로 일시적으로 넘을 수 있는 마나 상한 */
const MANA_HARD_CAP = 10;
export const ATTACKER_START_HAND = 3;
export const DEFENDER_START_HAND = 4;

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

export interface BattleSideSetup {
  commander: CommanderSetup;
  /** 카드 id 목록 */
  deck: string[];
}

export interface DefenderModifiers {
  /** 지휘관 체력 보정(%) */
  hpPct?: number;
  /** 병사 공격력 보정(%) — 소환 시 기본 공격력에 적용, 반올림 */
  attackPct?: number;
  /** 시작 방어도 (성 내구도) */
  armor?: number;
  /** 시작 마나 보너스 (성 주인 직접 수비 +1) */
  extraStartMana?: number;
}

export interface CreateBattleOptions {
  seed: number;
  attacker: BattleSideSetup;
  defender: BattleSideSetup & {
    /** 시작부터 필드에 배치되는 병사 카드 id (주둔 부대, 최대 5) */
    startingBoard?: string[];
    modifiers?: DefenderModifiers;
  };
}

interface Ctx {
  s: BattleState;
  events: BattleEvent[];
}

function other(side: SideIndex): SideIndex {
  return side === 0 ? 1 : 0;
}

function emit(ctx: Ctx, body: BattleEventBody): void {
  const ev = { ...body, seq: ctx.s.seq } as BattleEvent;
  ctx.s.seq += 1;
  ctx.events.push(ev);
}

function random(ctx: Ctx): number {
  const r = nextRandom(ctx.s.rng);
  ctx.s.rng = r.rng;
  return r.value;
}

function randomIndex(ctx: Ctx, n: number): number {
  return Math.floor(random(ctx) * n);
}

function emptySide(commander: Commander): SideState {
  return {
    commander,
    deck: [],
    hand: [],
    board: [],
    mana: 0,
    maxMana: 0,
    extraMana: 0,
    fatigue: 0,
    coinUsed: false,
    tacticDiscount: 0,
    attackPct: 0,
    turnsTaken: 0,
    kills: 0,
  };
}

/** 새 전투 상태. 공격자(0)의 첫 턴이 시작된 상태로 돌려준다. */
export function createBattle(opts: CreateBattleOptions): BattleState {
  const atkCmd = makeCommander(opts.attacker.commander);
  const defCmd = makeCommander(opts.defender.commander);
  const mods = opts.defender.modifiers ?? {};
  if (mods.hpPct) {
    defCmd.maxHp = Math.max(1, Math.round(defCmd.maxHp * (1 + mods.hpPct / 100)));
    defCmd.hp = defCmd.maxHp;
  }
  if (mods.armor) defCmd.armor = Math.max(0, Math.floor(mods.armor));

  const s: BattleState = {
    version: 1,
    seed: opts.seed,
    rng: seedToRng(opts.seed),
    turn: 1,
    activeSide: 0,
    sides: [emptySide(atkCmd), emptySide(defCmd)],
    nextIid: 1,
    seq: 0,
    log: [],
    winner: null,
    endReason: null,
  };
  s.sides[1].attackPct = mods.attackPct ?? 0;
  s.sides[1].extraMana = Math.max(0, Math.floor(mods.extraStartMana ?? 0));

  const ctx: Ctx = { s, events: [] };
  const setups: [BattleSideSetup, BattleSideSetup] = [opts.attacker, opts.defender];
  for (const side of [0, 1] as const) {
    const deck: CardInstance[] = setups[side].deck.map((cardId) => {
      getCard(cardId); // 알 수 없는 id 면 예외
      return { iid: s.nextIid++, cardId };
    });
    // Fisher-Yates
    for (let i = deck.length - 1; i > 0; i--) {
      const j = randomIndex(ctx, i + 1);
      const t = deck[i];
      deck[i] = deck[j];
      deck[j] = t;
    }
    s.sides[side].deck = deck;
  }

  // 주둔 부대: 시작부터 필드에 배치
  for (const cardId of (opts.defender.startingBoard ?? []).slice(0, MAX_BOARD)) {
    const def = getCard(cardId);
    if (def.type !== "soldier") throw new Error(`주둔 카드는 병사여야 함: ${cardId}`);
    const sol = summonSoldier(ctx, 1, cardId, undefined);
    if (sol) sol.summonedThisTurn = false;
  }

  drawCards(ctx, 0, ATTACKER_START_HAND);
  drawCards(ctx, 1, DEFENDER_START_HAND);
  // 후공 보정: 여분 마나 카드
  const coin: CardInstance = { iid: s.nextIid++, cardId: SPARE_MANA_ID };
  s.sides[1].hand.push(coin);
  emit(ctx, { type: "draw", side: 1, iid: coin.iid, cardId: coin.cardId });

  startTurn(ctx, 0);
  s.log = ctx.events;
  return s;
}

// ---------------------------------------------------------------------------
// 복제
// ---------------------------------------------------------------------------

function cloneSide(sd: SideState): SideState {
  return {
    ...sd,
    commander: { ...sd.commander, weapon: sd.commander.weapon ? { ...sd.commander.weapon } : null },
    // CardInstance 는 불변이라 얕은 복사로 충분
    deck: sd.deck.slice(),
    hand: sd.hand.slice(),
    board: sd.board.map((b) => ({ ...b, keywords: b.keywords.slice() })),
  };
}

/** log 는 참조만 유지한 채 나머지를 깊은 복사 */
function cloneState(s: BattleState): BattleState {
  return { ...s, sides: [cloneSide(s.sides[0]), cloneSide(s.sides[1])] };
}

// ---------------------------------------------------------------------------
// 조회 도우미 (읽기 전용)
// ---------------------------------------------------------------------------

export function findSoldier(s: BattleState, side: SideIndex, iid: number): Soldier | undefined {
  return s.sides[side].board.find((b) => b.iid === iid);
}

function hasKeyword(sol: Soldier, kw: Keyword): boolean {
  return sol.keywords.includes(kw);
}

function alive(sol: Soldier): boolean {
  return sol.health > 0;
}

/** 손패 카드의 실제 비용 (마력 수확 할인 반영) */
export function effectiveCost(s: BattleState, side: SideIndex, card: CardInstance): number {
  const def = getCard(card.cardId);
  if (def.type === "tactic") return Math.max(0, def.cost - s.sides[side].tacticDiscount);
  return def.cost;
}

function refEquals(a: TargetRef, b: TargetRef): boolean {
  if (a.kind === "commander" && b.kind === "commander") return a.side === b.side;
  if (a.kind === "soldier" && b.kind === "soldier") return a.side === b.side && a.iid === b.iid;
  return false;
}

/** 조건에 맞는 살아있는 대상 목록. excludeIid 는 자기 자신 제외용. */
export function listTargets(
  s: BattleState,
  owner: SideIndex,
  filter: TargetFilter,
  excludeIid?: number,
): TargetRef[] {
  const out: TargetRef[] = [];
  const enemy = other(owner);
  const addSoldiers = (side: SideIndex): void => {
    for (const b of s.sides[side].board) {
      if (alive(b) && b.iid !== excludeIid) out.push({ kind: "soldier", side, iid: b.iid });
    }
  };
  switch (filter) {
    case "anyCharacter":
      out.push({ kind: "commander", side: enemy });
      addSoldiers(enemy);
      out.push({ kind: "commander", side: owner });
      addSoldiers(owner);
      break;
    case "enemyCharacter":
      out.push({ kind: "commander", side: enemy });
      addSoldiers(enemy);
      break;
    case "enemySoldier":
      addSoldiers(enemy);
      break;
    case "friendlySoldier":
      addSoldiers(owner);
      break;
    case "friendlyCharacter":
      out.push({ kind: "commander", side: owner });
      addSoldiers(owner);
      break;
    case "anySoldier":
      addSoldiers(enemy);
      addSoldiers(owner);
      break;
  }
  return out;
}

function isValidTarget(
  s: BattleState,
  owner: SideIndex,
  filter: TargetFilter,
  ref: TargetRef,
  excludeIid?: number,
): boolean {
  return listTargets(s, owner, filter, excludeIid).some((t) => refEquals(t, ref));
}

function effectsUseChosen(effects: Effect[] | undefined): boolean {
  return (effects ?? []).some((e) => "target" in e && e.target === "chosen");
}

/** 수호 병사가 있으면 그것만 공격 가능 */
function guardTargets(s: BattleState, defender: SideIndex): Soldier[] {
  return s.sides[defender].board.filter((b) => alive(b) && hasKeyword(b, "guard"));
}

export function soldierCanAttack(sol: Soldier): boolean {
  if (sol.attack <= 0 || sol.attacksThisTurn >= 1 || !alive(sol)) return false;
  if (sol.summonedThisTurn && !hasKeyword(sol, "rush") && !sol.rushThisTurn) return false;
  return true;
}

export function commanderCanAttack(c: Commander): boolean {
  return c.attack > 0 && c.attacksThisTurn < 1 && c.hp > 0;
}

// ---------------------------------------------------------------------------
// 변경 도우미 (ctx.s 를 직접 변경)
// ---------------------------------------------------------------------------

function applyPct(base: number, pct: number): number {
  if (!pct) return base;
  return Math.max(0, Math.round(base * (1 + pct / 100)));
}

function summonSoldier(
  ctx: Ctx,
  side: SideIndex,
  cardId: string,
  pos: number | undefined,
): Soldier | null {
  const sd = ctx.s.sides[side];
  if (sd.board.length >= MAX_BOARD) return null;
  const def = getCard(cardId);
  const sol: Soldier = {
    iid: ctx.s.nextIid++,
    cardId,
    attack: applyPct(def.attack ?? 0, sd.attackPct),
    health: def.health ?? 1,
    maxHealth: def.health ?? 1,
    keywords: def.keywords.slice(),
    summonedThisTurn: true,
    rushThisTurn: false,
    attacksThisTurn: 0,
  };
  const at = pos === undefined ? sd.board.length : Math.max(0, Math.min(sd.board.length, pos));
  sd.board.splice(at, 0, sol);
  emit(ctx, {
    type: "summon",
    side,
    iid: sol.iid,
    cardId,
    pos: at,
    attack: sol.attack,
    health: sol.health,
  });
  return sol;
}

function drawCards(ctx: Ctx, side: SideIndex, n: number): void {
  const sd = ctx.s.sides[side];
  for (let i = 0; i < n; i++) {
    const card = sd.deck.shift();
    if (!card) {
      sd.fatigue += 1;
      emit(ctx, { type: "fatigue", side, damage: sd.fatigue });
      damage(ctx, { kind: "commander", side }, sd.fatigue);
      continue;
    }
    if (sd.hand.length >= MAX_HAND) {
      emit(ctx, { type: "burn", side, iid: card.iid, cardId: card.cardId });
    } else {
      sd.hand.push(card);
      emit(ctx, { type: "draw", side, iid: card.iid, cardId: card.cardId });
    }
  }
}

/** 피해 적용. 실제로 들어간 피해(방어도 포함)를 돌려준다. */
function damage(ctx: Ctx, ref: TargetRef, amount: number): number {
  if (amount <= 0) return 0;
  if (ref.kind === "commander") {
    const c = ctx.s.sides[ref.side].commander;
    const absorbed = Math.min(c.armor, amount);
    c.armor -= absorbed;
    c.hp -= amount - absorbed;
    emit(ctx, { type: "damage", target: ref, amount, armorAbsorbed: absorbed, hpAfter: c.hp });
    return amount;
  }
  const sol = findSoldier(ctx.s, ref.side, ref.iid);
  if (!sol) return 0;
  if (hasKeyword(sol, "shield")) {
    sol.keywords = sol.keywords.filter((k) => k !== "shield");
    emit(ctx, { type: "shield-break", target: ref });
    return 0;
  }
  sol.health -= amount;
  emit(ctx, { type: "damage", target: ref, amount, armorAbsorbed: 0, hpAfter: sol.health });
  return amount;
}

function heal(ctx: Ctx, ref: TargetRef, amount: number): void {
  if (amount <= 0) return;
  if (ref.kind === "commander") {
    const c = ctx.s.sides[ref.side].commander;
    const before = c.hp;
    c.hp = Math.min(c.maxHp, c.hp + amount);
    emit(ctx, { type: "heal", target: ref, amount: c.hp - before, hpAfter: c.hp });
    return;
  }
  const sol = findSoldier(ctx.s, ref.side, ref.iid);
  if (!sol || !alive(sol)) return;
  const before = sol.health;
  sol.health = Math.min(sol.maxHealth, sol.health + amount);
  emit(ctx, { type: "heal", target: ref, amount: sol.health - before, hpAfter: sol.health });
}

function soldierRefs(s: BattleState, side: SideIndex, excludeIid?: number): TargetRef[] {
  return s.sides[side].board
    .filter((b) => alive(b) && b.iid !== excludeIid)
    .map((b) => ({ kind: "soldier", side, iid: b.iid }) as TargetRef);
}

function pickRandom(ctx: Ctx, list: TargetRef[]): TargetRef[] {
  if (list.length === 0) return [];
  return [list[randomIndex(ctx, list.length)]];
}

function resolveTargets(
  ctx: Ctx,
  owner: SideIndex,
  target: EffectTarget,
  chosen: TargetRef | null,
  selfIid: number | null,
): TargetRef[] {
  const s = ctx.s;
  const enemy = other(owner);
  const self = selfIid ?? undefined;
  switch (target) {
    case "chosen":
      return chosen ? [chosen] : [];
    case "self":
      return selfIid !== null && findSoldier(s, owner, selfIid)
        ? [{ kind: "soldier", side: owner, iid: selfIid }]
        : [];
    case "ownCommander":
      return [{ kind: "commander", side: owner }];
    case "enemyCommander":
      return [{ kind: "commander", side: enemy }];
    case "allEnemySoldiers":
      return soldierRefs(s, enemy);
    case "allEnemies":
      return [...soldierRefs(s, enemy), { kind: "commander", side: enemy }];
    case "allFriendlySoldiers":
      return soldierRefs(s, owner);
    case "otherFriendlySoldiers":
      return soldierRefs(s, owner, self);
    case "allSoldiers":
      return [...soldierRefs(s, owner), ...soldierRefs(s, enemy)];
    case "randomEnemy":
      return pickRandom(ctx, [{ kind: "commander", side: enemy }, ...soldierRefs(s, enemy)]);
    case "randomEnemySoldier":
      return pickRandom(ctx, soldierRefs(s, enemy));
    case "randomOtherFriendlySoldier":
      return pickRandom(ctx, soldierRefs(s, owner, self));
  }
}

function applyEffects(
  ctx: Ctx,
  owner: SideIndex,
  effects: Effect[],
  chosen: TargetRef | null,
  selfIid: number | null,
): void {
  const sd = ctx.s.sides[owner];
  for (const e of effects) {
    switch (e.kind) {
      case "damage":
        for (const t of resolveTargets(ctx, owner, e.target, chosen, selfIid)) damage(ctx, t, e.amount);
        break;
      case "heal":
        for (const t of resolveTargets(ctx, owner, e.target, chosen, selfIid)) heal(ctx, t, e.amount);
        break;
      case "buff":
        for (const t of resolveTargets(ctx, owner, e.target, chosen, selfIid)) {
          if (t.kind !== "soldier") continue;
          const sol = findSoldier(ctx.s, t.side, t.iid);
          if (!sol || !alive(sol)) continue;
          sol.attack = Math.max(0, sol.attack + e.attack);
          sol.health += e.health;
          sol.maxHealth += e.health;
          emit(ctx, { type: "buff", target: t, attack: e.attack, health: e.health });
        }
        break;
      case "giveKeyword":
        for (const t of resolveTargets(ctx, owner, e.target, chosen, selfIid)) {
          if (t.kind !== "soldier") continue;
          const sol = findSoldier(ctx.s, t.side, t.iid);
          if (!sol || !alive(sol)) continue;
          if (!sol.keywords.includes(e.keyword)) sol.keywords.push(e.keyword);
          emit(ctx, { type: "keyword", target: t, keyword: e.keyword });
        }
        break;
      case "rushThisTurn":
        for (const t of resolveTargets(ctx, owner, e.target, chosen, selfIid)) {
          if (t.kind !== "soldier") continue;
          const sol = findSoldier(ctx.s, t.side, t.iid);
          if (!sol || !alive(sol)) continue;
          sol.rushThisTurn = true;
          emit(ctx, { type: "keyword", target: t, keyword: "rushThisTurn" });
        }
        break;
      case "summon":
        for (let i = 0; i < e.count; i++) {
          if (!summonSoldier(ctx, owner, e.cardId, undefined)) break;
        }
        break;
      case "draw":
        drawCards(ctx, owner, e.count);
        break;
      case "armor":
        sd.commander.armor += e.amount;
        emit(ctx, { type: "armor", side: owner, amount: e.amount, total: sd.commander.armor });
        break;
      case "gainMana":
        sd.mana = Math.min(MANA_HARD_CAP, sd.mana + e.amount);
        emit(ctx, { type: "mana", side: owner, amount: e.amount, mana: sd.mana });
        break;
      case "tacticDiscount":
        sd.tacticDiscount += e.amount;
        emit(ctx, { type: "discount", side: owner, amount: e.amount, total: sd.tacticDiscount });
        break;
    }
  }
}

/** 죽은 병사 제거 + 유훈 발동을 반복한 뒤 승패 판정 */
function resolveDeaths(ctx: Ctx): void {
  const s = ctx.s;
  for (let guard = 0; guard < 50; guard++) {
    const order: SideIndex[] = [s.activeSide, other(s.activeSide)];
    const dead: { side: SideIndex; sol: Soldier }[] = [];
    for (const side of order) {
      for (const b of s.sides[side].board) if (!alive(b)) dead.push({ side, sol: b });
    }
    if (dead.length === 0) break;
    for (const { side, sol } of dead) {
      const board = s.sides[side].board;
      const idx = board.indexOf(sol);
      if (idx >= 0) board.splice(idx, 1);
      s.sides[other(side)].kills += 1;
      emit(ctx, { type: "death", side, iid: sol.iid, cardId: sol.cardId });
    }
    for (const { side, sol } of dead) {
      const def = getCard(sol.cardId);
      if (def.onDeath && def.onDeath.length > 0) {
        emit(ctx, { type: "keyword-trigger", side, iid: sol.iid, cardId: sol.cardId, trigger: "onDeath" });
        applyEffects(ctx, side, def.onDeath, null, null);
      }
    }
  }
  checkGameOver(ctx);
}

function checkGameOver(ctx: Ctx): void {
  const s = ctx.s;
  if (s.winner !== null) return;
  const dead0 = s.sides[0].commander.hp <= 0;
  const dead1 = s.sides[1].commander.hp <= 0;
  if (!dead0 && !dead1) return;
  s.winner = dead0 && dead1 ? "draw" : dead0 ? 1 : 0;
  s.endReason = "commander-defeated";
  emit(ctx, { type: "game-over", winner: s.winner, reason: "commander-defeated" });
}

function startTurn(ctx: Ctx, side: SideIndex): void {
  const s = ctx.s;
  const sd = s.sides[side];
  s.activeSide = side;
  sd.turnsTaken += 1;
  sd.maxMana = Math.min(MAX_MANA, sd.turnsTaken + sd.extraMana);
  sd.mana = sd.maxMana;
  sd.commander.powerUsedThisTurn = false;
  sd.commander.attacksThisTurn = 0;
  for (const b of sd.board) {
    b.attacksThisTurn = 0;
    b.summonedThisTurn = false;
    b.rushThisTurn = false;
  }
  emit(ctx, { type: "turn-start", side, turn: s.turn, mana: sd.mana, maxMana: sd.maxMana });
  // 선공 보정: 전투 첫 턴(선공의 첫 턴)에는 뽑지 않는다
  if (s.turn > 1) drawCards(ctx, side, 1);
  resolveDeaths(ctx);
}

function endTurn(ctx: Ctx): void {
  const s = ctx.s;
  const side = s.activeSide;
  for (const b of s.sides[side].board) b.rushThisTurn = false;
  emit(ctx, { type: "turn-end", side, turn: s.turn });
  if (s.turn >= MAX_TURNS) {
    s.winner = "draw";
    s.endReason = "turn-limit";
    emit(ctx, { type: "game-over", winner: "draw", reason: "turn-limit" });
    return;
  }
  s.turn += 1;
  startTurn(ctx, other(side));
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

/** 행동이 합법이면 null, 아니면 오류 문구 */
export function validateAction(s: BattleState, side: SideIndex, action: Action): string | null {
  if (s.winner !== null) return "이미 끝난 전투";
  if (side !== 0 && side !== 1) return "잘못된 진영";
  if (action.type === "concede") return null;
  if (s.activeSide !== side) return "내 턴이 아님";
  const sd = s.sides[side];
  const enemy = other(side);

  switch (action.type) {
    case "endTurn":
      return null;

    case "playCard": {
      const card = sd.hand.find((c) => c.iid === action.iid);
      if (!card) return "손패에 없는 카드";
      const def = getCard(card.cardId);
      if (effectiveCost(s, side, card) > sd.mana) return "마나 부족";
      if (def.type === "soldier") {
        if (sd.board.length >= MAX_BOARD) return "필드가 가득 참";
        if (action.boardPos !== undefined) {
          if (!Number.isInteger(action.boardPos) || action.boardPos < 0 || action.boardPos > sd.board.length) {
            return "잘못된 배치 위치";
          }
        }
      }
      const needsChosen = def.targetFilter !== undefined && effectsUseChosen(def.onPlay);
      if (!needsChosen) {
        if (action.target) return "대상이 필요 없는 카드";
        return null;
      }
      const filter = def.targetFilter as TargetFilter;
      const candidates = listTargets(s, side, filter);
      if (action.target) {
        if (!candidates.some((t) => refEquals(t, action.target as TargetRef))) return "잘못된 대상";
        return null;
      }
      // 병사의 출진 대상은 후보가 없으면 생략 가능, 전술은 반드시 대상 필요
      if (def.type === "soldier" && candidates.length === 0) return null;
      return "대상을 골라야 함";
    }

    case "attack": {
      const target = action.target;
      if (target.side !== enemy) return "적만 공격 가능";
      const atk = action.attacker;
      if (atk.kind === "commander") {
        if (!commanderCanAttack(sd.commander)) return "지휘관이 공격할 수 없음";
      } else {
        const sol = findSoldier(s, side, atk.iid);
        if (!sol) return "없는 병사";
        if (!soldierCanAttack(sol)) return "이 병사는 지금 공격할 수 없음";
      }
      if (target.kind === "soldier") {
        const t = findSoldier(s, enemy, target.iid);
        if (!t || !alive(t)) return "없는 대상";
      }
      const guards = guardTargets(s, enemy);
      if (guards.length > 0) {
        if (target.kind !== "soldier" || !guards.some((g) => g.iid === target.iid)) {
          return "수호 병사부터 공격해야 함";
        }
      }
      return null;
    }

    case "heroPower": {
      const c = sd.commander;
      if (c.powerUsedThisTurn) return "이번 턴에 이미 사용";
      const power = heroPower(c.kind, c.level);
      if (power.cost > sd.mana) return "마나 부족";
      if (power.needsBoardSpace && sd.board.length >= MAX_BOARD) return "필드가 가득 참";
      if (power.targetFilter) {
        if (!action.target) return "대상을 골라야 함";
        if (!isValidTarget(s, side, power.targetFilter, action.target)) return "잘못된 대상";
      } else if (action.target) {
        return "대상이 필요 없는 능력";
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

function attackerRef(side: SideIndex, a: AttackerRef): TargetRef {
  return a.kind === "commander" ? { kind: "commander", side } : { kind: "soldier", side, iid: a.iid };
}

function doPlayCard(ctx: Ctx, side: SideIndex, action: Extract<Action, { type: "playCard" }>): void {
  const s = ctx.s;
  const sd = s.sides[side];
  const handIdx = sd.hand.findIndex((c) => c.iid === action.iid);
  const card = sd.hand[handIdx];
  const def: CardDef = getCard(card.cardId);
  const cost = effectiveCost(s, side, card);
  sd.mana -= cost;
  if (def.type === "tactic" && sd.tacticDiscount > 0 && def.cost > 0) sd.tacticDiscount = 0;
  sd.hand.splice(handIdx, 1);
  const chosen = action.target ?? null;
  emit(ctx, {
    type: "play",
    side,
    iid: card.iid,
    cardId: card.cardId,
    cost,
    ...(chosen ? { target: chosen } : {}),
  });

  if (def.type === "soldier") {
    const sol = summonSoldier(ctx, side, card.cardId, action.boardPos);
    if (sol && def.onPlay && def.onPlay.length > 0) {
      emit(ctx, { type: "keyword-trigger", side, iid: sol.iid, cardId: sol.cardId, trigger: "onPlay" });
      applyEffects(ctx, side, def.onPlay, chosen, sol.iid);
    }
  } else if (def.type === "tactic") {
    if (card.cardId === SPARE_MANA_ID) sd.coinUsed = true;
    applyEffects(ctx, side, def.onPlay ?? [], chosen, null);
  } else {
    const c = sd.commander;
    if (c.weapon) emit(ctx, { type: "weapon-break", side, cardId: c.weapon.cardId });
    c.weapon = { cardId: def.id, attack: def.attack ?? 0, durability: def.durability ?? 1 };
    c.attack = c.weapon.attack;
    emit(ctx, {
      type: "equip",
      side,
      cardId: def.id,
      attack: c.weapon.attack,
      durability: c.weapon.durability,
    });
    if (def.onPlay) applyEffects(ctx, side, def.onPlay, chosen, null);
  }
}

function doAttack(ctx: Ctx, side: SideIndex, action: Extract<Action, { type: "attack" }>): void {
  const s = ctx.s;
  const sd = s.sides[side];
  const aRef = attackerRef(side, action.attacker);
  const tRef = action.target;
  emit(ctx, { type: "attack", side, attacker: aRef, target: tRef });

  // 공격력은 피해 적용 전에 확정 (동시 교환)
  let atkPower = 0;
  let ranged = false;
  let attackerSol: Soldier | undefined;
  if (action.attacker.kind === "commander") {
    atkPower = sd.commander.attack;
  } else {
    attackerSol = findSoldier(s, side, action.attacker.iid);
    if (attackerSol) {
      atkPower = attackerSol.attack;
      ranged = hasKeyword(attackerSol, "ranged");
    }
  }
  const counter =
    tRef.kind === "soldier" && !ranged ? (findSoldier(s, tRef.side, tRef.iid)?.attack ?? 0) : 0;

  damage(ctx, tRef, atkPower);
  if (counter > 0) damage(ctx, aRef, counter);

  if (attackerSol) {
    attackerSol.attacksThisTurn += 1;
  } else {
    const c = sd.commander;
    c.attacksThisTurn += 1;
    if (c.weapon) {
      c.weapon.durability -= 1;
      if (c.weapon.durability <= 0) {
        emit(ctx, { type: "weapon-break", side, cardId: c.weapon.cardId });
        c.weapon = null;
        c.attack = 0;
      }
    }
  }
}

function doHeroPower(ctx: Ctx, side: SideIndex, action: Extract<Action, { type: "heroPower" }>): void {
  const sd = ctx.s.sides[side];
  const c = sd.commander;
  const power = heroPower(c.kind, c.level);
  sd.mana -= power.cost;
  c.powerUsedThisTurn = true;
  const chosen = action.target ?? null;
  emit(ctx, { type: "hero-power", side, kind: c.kind, ...(chosen ? { target: chosen } : {}) });
  applyEffects(ctx, side, power.effects, chosen, null);
}

/**
 * 행동 적용. 입력 상태는 변경하지 않는다.
 * 성공: { ok: true, state, events } — events 는 이번 행동으로 생긴 이벤트(state.log 에도 누적).
 * 실패: { ok: false, error }.
 */
export function applyAction(state: BattleState, side: SideIndex, action: Action): ApplyResult {
  const err = validateAction(state, side, action);
  if (err) return { ok: false, error: err };

  const ctx: Ctx = { s: cloneState(state), events: [] };
  switch (action.type) {
    case "concede": {
      const winner = other(side);
      ctx.s.winner = winner;
      ctx.s.endReason = "concede";
      emit(ctx, { type: "game-over", winner, reason: "concede" });
      break;
    }
    case "endTurn":
      endTurn(ctx);
      break;
    case "playCard":
      doPlayCard(ctx, side, action);
      resolveDeaths(ctx);
      break;
    case "attack":
      doAttack(ctx, side, action);
      resolveDeaths(ctx);
      break;
    case "heroPower":
      doHeroPower(ctx, side, action);
      resolveDeaths(ctx);
      break;
  }
  ctx.s.log = state.log.length === 0 ? ctx.events : state.log.concat(ctx.events);
  return { ok: true, state: ctx.s, events: ctx.events };
}

// ---------------------------------------------------------------------------
// 합법 행동 목록
// ---------------------------------------------------------------------------

/**
 * 현재 진영이 할 수 있는 행동 전부 (endTurn·concede 포함).
 * 병사 카드는 필드 맨 끝 배치만 나열한다 (배치 위치는 결과에 영향 없음).
 */
export function listLegalActions(s: BattleState, side: SideIndex): Action[] {
  if (s.winner !== null) return [];
  if (s.activeSide !== side) return [{ type: "concede" }];
  const out: Action[] = [];
  const sd = s.sides[side];
  const enemy = other(side);

  // 카드 내기 (같은 카드 id 는 한 번만)
  const seen = new Set<string>();
  for (const card of sd.hand) {
    if (seen.has(card.cardId)) continue;
    seen.add(card.cardId);
    const def = getCard(card.cardId);
    if (effectiveCost(s, side, card) > sd.mana) continue;
    if (def.type === "soldier" && sd.board.length >= MAX_BOARD) continue;
    const needsChosen = def.targetFilter !== undefined && effectsUseChosen(def.onPlay);
    if (!needsChosen) {
      out.push({ type: "playCard", iid: card.iid });
      continue;
    }
    const targets = listTargets(s, side, def.targetFilter as TargetFilter);
    if (targets.length === 0) {
      if (def.type === "soldier") out.push({ type: "playCard", iid: card.iid });
      continue;
    }
    for (const t of targets) out.push({ type: "playCard", iid: card.iid, target: t });
  }

  // 공격
  const guards = guardTargets(s, enemy);
  const attackTargets: TargetRef[] =
    guards.length > 0
      ? guards.map((g) => ({ kind: "soldier", side: enemy, iid: g.iid }) as TargetRef)
      : [
          { kind: "commander", side: enemy },
          ...soldierRefs(s, enemy),
        ];
  const attackers: AttackerRef[] = [];
  for (const b of sd.board) if (soldierCanAttack(b)) attackers.push({ kind: "soldier", iid: b.iid });
  if (commanderCanAttack(sd.commander)) attackers.push({ kind: "commander" });
  for (const a of attackers) {
    for (const t of attackTargets) out.push({ type: "attack", attacker: a, target: t });
  }

  // 지휘관 능력
  const c = sd.commander;
  const power = heroPower(c.kind, c.level);
  if (!c.powerUsedThisTurn && power.cost <= sd.mana && !(power.needsBoardSpace && sd.board.length >= MAX_BOARD)) {
    if (power.targetFilter) {
      for (const t of listTargets(s, side, power.targetFilter)) out.push({ type: "heroPower", target: t });
    } else {
      out.push({ type: "heroPower" });
    }
  }

  out.push({ type: "endTurn" });
  out.push({ type: "concede" });
  return out;
}
