// PublicBattleView 위에서 쓰는 화면용 규칙:
// - 이벤트를 하나씩 반영해 연출 중간 상태를 만드는 축약 리듀서 (최종 상태는 서버 view 로 덮어쓴다)
// - 대상·공격 가능 여부 표시 (서버가 최종 검증한다)
// - 로그 문구

import {
  COMMANDER_KIND_LABEL,
  HIDDEN_CARD_ID,
  MAX_BOARD,
  commanderCanAttack,
  getCard,
  heroPower,
  isCardId,
  soldierCanAttack,
} from "@/lib/battle";
import type {
  BattleEvent,
  CardDef,
  CardInstance,
  Keyword,
  PublicBattleView,
  PublicSide,
  SideIndex,
  Soldier,
  TargetFilter,
  TargetRef,
} from "@/lib/battle";

export const PLAYER: SideIndex = 0;
export const ENEMY: SideIndex = 1;

export const KEYWORD_LABEL: Readonly<Record<Keyword, string>> = {
  guard: "수호",
  rush: "기습",
  shield: "결계",
  ranged: "원거리",
};

export function safeCard(cardId: string): CardDef | null {
  return isCardId(cardId) ? getCard(cardId) : null;
}

export function refKey(ref: TargetRef): string {
  return ref.kind === "commander" ? `cmd-${ref.side}` : `sol-${ref.iid}`;
}

export function refEq(a: TargetRef, b: TargetRef): boolean {
  if (a.kind === "commander" && b.kind === "commander") return a.side === b.side;
  if (a.kind === "soldier" && b.kind === "soldier") return a.side === b.side && a.iid === b.iid;
  return false;
}

// ---------------------------------------------------------------------------
// 축약 리듀서
// ---------------------------------------------------------------------------

function cloneSide(s: PublicSide): PublicSide {
  return {
    ...s,
    commander: { ...s.commander, weapon: s.commander.weapon ? { ...s.commander.weapon } : null },
    board: s.board.map((b) => ({ ...b, keywords: b.keywords.slice() })),
    hand: s.hand ? s.hand.slice() : null,
  };
}

export function cloneView(v: PublicBattleView): PublicBattleView {
  return { ...v, sides: [cloneSide(v.sides[0]), cloneSide(v.sides[1])] };
}

function findSol(v: PublicBattleView, ref: TargetRef): Soldier | undefined {
  if (ref.kind !== "soldier") return undefined;
  return v.sides[ref.side].board.find((b) => b.iid === ref.iid);
}

/** 이벤트 하나를 반영한 새 view (입력 불변) */
export function applyEventToView(view: PublicBattleView, ev: BattleEvent): PublicBattleView {
  const v = cloneView(view);
  switch (ev.type) {
    case "turn-start": {
      const sd = v.sides[ev.side];
      v.activeSide = ev.side;
      v.turn = ev.turn;
      sd.mana = ev.mana;
      sd.maxMana = ev.maxMana;
      sd.commander.powerUsedThisTurn = false;
      sd.commander.attacksThisTurn = 0;
      for (const b of sd.board) {
        b.attacksThisTurn = 0;
        b.summonedThisTurn = false;
        b.rushThisTurn = false;
      }
      break;
    }
    case "turn-end": {
      for (const b of v.sides[ev.side].board) b.rushThisTurn = false;
      break;
    }
    case "draw": {
      const sd = v.sides[ev.side];
      sd.deckCount = Math.max(0, sd.deckCount - (ev.cardId === "spare_mana" ? 0 : 1));
      if (sd.hand && ev.cardId !== HIDDEN_CARD_ID) {
        if (!sd.hand.some((c) => c.iid === ev.iid)) sd.hand.push({ iid: ev.iid, cardId: ev.cardId });
      }
      sd.handCount += 1;
      break;
    }
    case "burn": {
      const sd = v.sides[ev.side];
      sd.deckCount = Math.max(0, sd.deckCount - 1);
      break;
    }
    case "play": {
      const sd = v.sides[ev.side];
      if (sd.hand) sd.hand = sd.hand.filter((c) => c.iid !== ev.iid);
      sd.handCount = Math.max(0, sd.handCount - 1);
      sd.mana = Math.max(0, sd.mana - ev.cost);
      const def = safeCard(ev.cardId);
      if (def?.type === "tactic" && sd.tacticDiscount > 0 && def.cost > 0) sd.tacticDiscount = 0;
      break;
    }
    case "summon": {
      const sd = v.sides[ev.side];
      const def = safeCard(ev.cardId);
      const sol: Soldier = {
        iid: ev.iid,
        cardId: ev.cardId,
        attack: ev.attack,
        health: ev.health,
        maxHealth: ev.health,
        keywords: def ? def.keywords.slice() : [],
        summonedThisTurn: true,
        rushThisTurn: false,
        attacksThisTurn: 0,
      };
      if (!sd.board.some((b) => b.iid === ev.iid)) {
        sd.board.splice(Math.max(0, Math.min(sd.board.length, ev.pos)), 0, sol);
      }
      break;
    }
    case "equip": {
      const c = v.sides[ev.side].commander;
      c.weapon = { cardId: ev.cardId, attack: ev.attack, durability: ev.durability };
      c.attack = ev.attack;
      break;
    }
    case "weapon-break": {
      const c = v.sides[ev.side].commander;
      if (c.weapon && c.weapon.cardId === ev.cardId) {
        c.weapon = null;
        c.attack = 0;
      }
      break;
    }
    case "attack": {
      if (ev.attacker.kind === "commander") {
        const c = v.sides[ev.attacker.side].commander;
        c.attacksThisTurn += 1;
        if (c.weapon) c.weapon.durability = Math.max(0, c.weapon.durability - 1);
      } else {
        const s = findSol(v, ev.attacker);
        if (s) s.attacksThisTurn += 1;
      }
      break;
    }
    case "damage": {
      if (ev.target.kind === "commander") {
        const c = v.sides[ev.target.side].commander;
        c.armor = Math.max(0, c.armor - ev.armorAbsorbed);
        c.hp = ev.hpAfter;
      } else {
        const s = findSol(v, ev.target);
        if (s) s.health = ev.hpAfter;
      }
      break;
    }
    case "shield-break": {
      const s = findSol(v, ev.target);
      if (s) s.keywords = s.keywords.filter((k) => k !== "shield");
      break;
    }
    case "heal": {
      if (ev.target.kind === "commander") v.sides[ev.target.side].commander.hp = ev.hpAfter;
      else {
        const s = findSol(v, ev.target);
        if (s) s.health = ev.hpAfter;
      }
      break;
    }
    case "armor":
      v.sides[ev.side].commander.armor = ev.total;
      break;
    case "buff": {
      const s = findSol(v, ev.target);
      if (s) {
        s.attack = Math.max(0, s.attack + ev.attack);
        s.health += ev.health;
        s.maxHealth += ev.health;
      }
      break;
    }
    case "keyword": {
      const s = findSol(v, ev.target);
      if (s) {
        if (ev.keyword === "rushThisTurn") s.rushThisTurn = true;
        else if (!s.keywords.includes(ev.keyword)) s.keywords.push(ev.keyword);
      }
      break;
    }
    case "hero-power": {
      const sd = v.sides[ev.side];
      sd.commander.powerUsedThisTurn = true;
      sd.mana = Math.max(0, sd.mana - heroPower(sd.commander.kind, sd.commander.level).cost);
      break;
    }
    case "mana":
      v.sides[ev.side].mana = ev.mana;
      break;
    case "discount":
      v.sides[ev.side].tacticDiscount = ev.total;
      break;
    case "death": {
      const sd = v.sides[ev.side];
      sd.board = sd.board.filter((b) => b.iid !== ev.iid);
      break;
    }
    case "game-over":
      v.winner = ev.winner;
      v.endReason = ev.reason;
      break;
    case "fatigue":
    case "keyword-trigger":
      break;
  }
  return v;
}

// ---------------------------------------------------------------------------
// 대상·행동 가능 여부
// ---------------------------------------------------------------------------

export function cardNeedsTarget(def: CardDef): boolean {
  return def.targetFilter !== undefined && (def.onPlay ?? []).some((e) => "target" in e && e.target === "chosen");
}

export function viewTargets(v: PublicBattleView, owner: SideIndex, filter: TargetFilter): TargetRef[] {
  const enemy: SideIndex = owner === 0 ? 1 : 0;
  const out: TargetRef[] = [];
  const add = (side: SideIndex): void => {
    for (const b of v.sides[side].board) if (b.health > 0) out.push({ kind: "soldier", side, iid: b.iid });
  };
  switch (filter) {
    case "anyCharacter":
      out.push({ kind: "commander", side: enemy });
      add(enemy);
      out.push({ kind: "commander", side: owner });
      add(owner);
      break;
    case "enemyCharacter":
      out.push({ kind: "commander", side: enemy });
      add(enemy);
      break;
    case "enemySoldier":
      add(enemy);
      break;
    case "friendlySoldier":
      add(owner);
      break;
    case "friendlyCharacter":
      out.push({ kind: "commander", side: owner });
      add(owner);
      break;
    case "anySoldier":
      add(enemy);
      add(owner);
      break;
  }
  return out;
}

export function cardCost(v: PublicBattleView, side: SideIndex, card: CardInstance): number {
  const def = safeCard(card.cardId);
  if (!def) return 99;
  if (def.type === "tactic") return Math.max(0, def.cost - v.sides[side].tacticDiscount);
  return def.cost;
}

export function isMyTurn(v: PublicBattleView): boolean {
  return v.winner === null && v.activeSide === PLAYER;
}

export function canPlayCard(v: PublicBattleView, card: CardInstance): boolean {
  if (!isMyTurn(v)) return false;
  const def = safeCard(card.cardId);
  if (!def) return false;
  const sd = v.sides[PLAYER];
  if (cardCost(v, PLAYER, card) > sd.mana) return false;
  if (def.type === "soldier" && sd.board.length >= MAX_BOARD) return false;
  if (cardNeedsTarget(def) && def.type !== "soldier") {
    return viewTargets(v, PLAYER, def.targetFilter as TargetFilter).length > 0;
  }
  return true;
}

/** 손패 카드의 선택 가능 대상 (없으면 대상 불필요) */
export function cardTargets(v: PublicBattleView, card: CardInstance): TargetRef[] | null {
  const def = safeCard(card.cardId);
  if (!def || !cardNeedsTarget(def)) return null;
  return viewTargets(v, PLAYER, def.targetFilter as TargetFilter);
}

export function attackTargets(v: PublicBattleView): TargetRef[] {
  const enemy = v.sides[ENEMY];
  const guards = enemy.board.filter((b) => b.health > 0 && b.keywords.includes("guard"));
  if (guards.length > 0) return guards.map((g) => ({ kind: "soldier", side: ENEMY, iid: g.iid }));
  return [
    { kind: "commander", side: ENEMY },
    ...enemy.board.filter((b) => b.health > 0).map((b): TargetRef => ({ kind: "soldier", side: ENEMY, iid: b.iid })),
  ];
}

export function soldierReady(v: PublicBattleView, sol: Soldier): boolean {
  return isMyTurn(v) && soldierCanAttack(sol);
}

export function commanderReady(v: PublicBattleView): boolean {
  return isMyTurn(v) && commanderCanAttack(v.sides[PLAYER].commander);
}

export function powerUsable(v: PublicBattleView): boolean {
  if (!isMyTurn(v)) return false;
  const sd = v.sides[PLAYER];
  const c = sd.commander;
  const p = heroPower(c.kind, c.level);
  if (c.powerUsedThisTurn || p.cost > sd.mana) return false;
  if (p.needsBoardSpace && sd.board.length >= MAX_BOARD) return false;
  if (p.targetFilter && viewTargets(v, PLAYER, p.targetFilter).length === 0) return false;
  return true;
}

export function powerTargets(v: PublicBattleView): TargetRef[] | null {
  const c = v.sides[PLAYER].commander;
  const p = heroPower(c.kind, c.level);
  return p.targetFilter ? viewTargets(v, PLAYER, p.targetFilter) : null;
}

/** 할 수 있는 일이 남았는지 (턴 종료 버튼 강조용) */
export function hasAnyMove(v: PublicBattleView): boolean {
  if (!isMyTurn(v)) return false;
  const sd = v.sides[PLAYER];
  if ((sd.hand ?? []).some((c) => canPlayCard(v, c))) return true;
  if (sd.board.some((b) => soldierCanAttack(b))) return true;
  if (commanderCanAttack(sd.commander)) return true;
  return powerUsable(v);
}

// ---------------------------------------------------------------------------
// 로그 문구
// ---------------------------------------------------------------------------

function who(v: PublicBattleView, side: SideIndex): string {
  return side === PLAYER ? "나" : v.sides[ENEMY].commander.name || COMMANDER_KIND_LABEL[v.sides[ENEMY].commander.kind];
}

function refName(v: PublicBattleView, ref: TargetRef): string {
  if (ref.kind === "commander") return ref.side === PLAYER ? "내 지휘관" : "적 지휘관";
  const s = v.sides[ref.side].board.find((b) => b.iid === ref.iid);
  const def = s ? safeCard(s.cardId) : null;
  return def ? `${ref.side === PLAYER ? "" : "적 "}${def.name}` : "병사";
}

/** 로그 한 줄 (없으면 null). v 는 이벤트 반영 전 view. */
export function describeEvent(v: PublicBattleView, ev: BattleEvent): string | null {
  switch (ev.type) {
    case "play": {
      const def = safeCard(ev.cardId);
      if (!def) return null;
      const verb = def.type === "soldier" ? "출진" : def.type === "equipment" ? "장착" : "사용";
      return `${who(v, ev.side)}: ${def.name} ${verb}`;
    }
    case "attack":
      return `${refName(v, ev.attacker)} → ${refName(v, ev.target)} 공격`;
    case "hero-power": {
      const c = v.sides[ev.side].commander;
      return `${who(v, ev.side)}: ${heroPower(c.kind, c.level).name}`;
    }
    case "fatigue":
      return `${who(v, ev.side)}: 덱이 비어 피로 피해 ${ev.damage}`;
    case "burn": {
      const def = safeCard(ev.cardId);
      return `${who(v, ev.side)}: 손패가 가득 차 ${def ? def.name : "카드"} 버림`;
    }
    case "death": {
      const def = safeCard(ev.cardId);
      return def ? `${ev.side === PLAYER ? "" : "적 "}${def.name} 전사` : null;
    }
    case "game-over":
      return ev.winner === "draw" ? "무승부" : ev.winner === PLAYER ? "승리!" : "패배…";
    default:
      return null;
  }
}
