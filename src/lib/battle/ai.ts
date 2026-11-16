// 탐욕형 전투 AI (결정적).
// 한 턴 동안: (1) 마무리(치명타) 가능하면 상대 지휘관 집중 (2) 아니면 한 수씩 평가값이
// 가장 많이 오르는 행동을 고르고, 더 오르지 않으면 턴 종료.
// 엔진이 순수 함수라 후보 행동을 실제로 적용해 본 뒤 평가한다.

import { SPARE_MANA_ID, getCard } from "./cards";
import { applyAction, listLegalActions } from "./engine";
import type { Action, BattleState, SideIndex, Soldier } from "./types";

const WIN_SCORE = 1_000_000;
/** 상대 지휘관 체력에 두는 가중치 (>1 이면 공격적) */
const AGGRESSION = 1.3;
/** 한 턴에 고려할 최대 행동 수 (무한 루프 방지) */
const MAX_ACTIONS_PER_TURN = 30;

function other(side: SideIndex): SideIndex {
  return side === 0 ? 1 : 0;
}

/** 체력 가치: 낮을수록 1점의 가치가 커지는 오목 함수 */
function lifeValue(effHp: number): number {
  if (effHp <= 0) return -50;
  return 6 * Math.sqrt(effHp);
}

function soldierValue(b: Soldier): number {
  if (b.health <= 0) return 0;
  let v = 1 + b.attack * 1.1 + b.health * 0.9;
  for (const kw of b.keywords) {
    if (kw === "guard") v += 0.5 + b.health * 0.15;
    else if (kw === "shield") v += 0.5 + b.attack * 0.6;
    else if (kw === "ranged") v += 0.8;
    // 기습은 소환 직후에만 의미가 있으므로 판 위 가치에 더하지 않는다
  }
  return v;
}

/** side 관점 평가값 */
export function evaluate(s: BattleState, side: SideIndex): number {
  if (s.winner === side) return WIN_SCORE;
  if (s.winner === other(side)) return -WIN_SCORE;
  if (s.winner === "draw") return -WIN_SCORE / 2;
  const me = s.sides[side];
  const op = s.sides[other(side)];
  let score = 0;
  score += lifeValue(me.commander.hp + me.commander.armor);
  score -= lifeValue(op.commander.hp + op.commander.armor) * AGGRESSION;
  for (const b of me.board) score += soldierValue(b);
  for (const b of op.board) score -= soldierValue(b);
  // 상대 필드의 공격력은 다음 턴 내 지휘관이 받을 위협
  const opThreat = op.board.reduce((a, b) => a + (b.health > 0 ? b.attack : 0), 0) + op.commander.attack;
  const myEff = me.commander.hp + me.commander.armor;
  if (opThreat >= myEff) score -= 30;
  score += me.hand.filter((c) => c.cardId !== SPARE_MANA_ID).length * 0.9;
  score -= op.hand.length * 0.5;
  if (me.commander.weapon) score += me.commander.weapon.attack * me.commander.weapon.durability * 0.35;
  if (op.commander.weapon) score -= op.commander.weapon.attack * op.commander.weapon.durability * 0.35;
  // 마력 수확 할인: 손에 전술이 있을 때만 가치
  if (me.tacticDiscount > 0) {
    const hasTactic = me.hand.some((c) => getCard(c.cardId).type === "tactic" && c.cardId !== SPARE_MANA_ID);
    score += hasTactic ? Math.min(me.tacticDiscount, 3) * 0.9 : 0.2;
  }
  // 덱이 바닥나면 피로 위험
  if (me.deck.length === 0) score -= 2;
  return score;
}

function stripLog(s: BattleState): BattleState {
  return s.log.length === 0 ? s : { ...s, log: [] };
}

interface Step {
  action: Action;
  state: BattleState;
  score: number;
}

function candidates(s: BattleState, side: SideIndex): Action[] {
  return listLegalActions(s, side).filter((a) => a.type !== "endTurn" && a.type !== "concede");
}

function tryApply(s: BattleState, side: SideIndex, a: Action): BattleState | null {
  const r = applyAction(s, side, a);
  return r.ok ? r.state : null;
}

function isCoin(s: BattleState, side: SideIndex, a: Action): boolean {
  if (a.type !== "playCard") return false;
  const card = s.sides[side].hand.find((c) => c.iid === a.iid);
  return card?.cardId === SPARE_MANA_ID;
}

/** 한 수 탐욕 선택. 여분 마나는 다음 한 수까지 내다보고 평가한다. */
function bestStep(s: BattleState, side: SideIndex): Step | null {
  let best: Step | null = null;
  for (const a of candidates(s, side)) {
    const next = tryApply(s, side, a);
    if (!next) continue;
    let score: number;
    if (isCoin(s, side, a)) {
      // 여분 마나 자체는 가치가 없고, 덕분에 가능해진 다음 수의 가치로 평가
      score = -Infinity;
      for (const b of candidates(next, side)) {
        if (isCoin(next, side, b)) continue;
        const after = tryApply(next, side, b);
        if (after) score = Math.max(score, evaluate(after, side) - 0.6);
      }
    } else {
      score = evaluate(next, side);
    }
    if (!best || score > best.score) best = { action: a, state: next, score };
  }
  return best;
}

function enemyEffHp(s: BattleState, side: SideIndex): number {
  const c = s.sides[other(side)].commander;
  return c.hp + c.armor;
}

/** 치명타 모드 점수: 상대 지휘관 체력을 깎는 것이 최우선, 수호 병사 제거가 그다음 */
function lethalScore(s: BattleState, side: SideIndex): number {
  if (s.winner === side) return WIN_SCORE;
  if (s.winner !== null) return -WIN_SCORE;
  const op = s.sides[other(side)];
  const guardHp = op.board
    .filter((b) => b.health > 0 && b.keywords.includes("guard"))
    .reduce((a, b) => a + b.health + (b.keywords.includes("shield") ? 3 : 0), 0);
  return -enemyEffHp(s, side) * 10 - guardHp * 4 + evaluate(s, side) * 0.01;
}

/** 이번 턴에 상대 지휘관을 쓰러뜨릴 수 있으면 그 행동열을 돌려준다 */
function findLethal(s: BattleState, side: SideIndex): Action[] | null {
  let cur = s;
  const seq: Action[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_TURN; i++) {
    if (cur.winner === side) return seq;
    if (cur.winner !== null) return null;
    const base = lethalScore(cur, side);
    let best: Step | null = null;
    for (const a of candidates(cur, side)) {
      const next = tryApply(cur, side, a);
      if (!next) continue;
      const score = lethalScore(next, side);
      if (!best || score > best.score) best = { action: a, state: next, score };
    }
    if (!best || best.score <= base) break;
    seq.push(best.action);
    cur = best.state;
  }
  return cur.winner === side ? seq : null;
}

/**
 * side 의 한 턴 전체 행동 목록 (마지막은 endTurn, 승부가 나면 거기서 끝).
 * 같은 상태에 대해 항상 같은 결과를 돌려준다.
 */
export function chooseAiTurn(state: BattleState, side: SideIndex): Action[] {
  if (state.winner !== null || state.activeSide !== side) return [];
  const start = stripLog(state);

  const lethal = findLethal(start, side);
  if (lethal) return lethal;

  const actions: Action[] = [];
  let cur = start;
  for (let i = 0; i < MAX_ACTIONS_PER_TURN; i++) {
    if (cur.winner !== null) return actions;
    const base = evaluate(cur, side);
    const step = bestStep(cur, side);
    if (!step || step.score <= base + 0.01) break;
    actions.push(step.action);
    cur = step.state;
  }
  if (cur.winner !== null) return actions;
  // 남은 행동 후 마무리가 생겼을 수도 있다
  const late = findLethal(cur, side);
  if (late && late.length > 0) return [...actions, ...late];
  actions.push({ type: "endTurn" });
  return actions;
}
