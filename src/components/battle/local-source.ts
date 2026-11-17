// 브라우저 안에서 엔진+AI 로 돌리는 전투 공급원 (개발용 데모, 서버·DB 불필요).

import {
  COLLECTIBLE_CARDS,
  MAX_LEVEL,
  OUTLAW_PRESETS,
  applyAction,
  battleXp,
  chooseAiTurn,
  createBattle,
  levelFromXp,
  redactEvents,
  starterDeck,
  toPublicSides,
  xpForLevel,
} from "@/lib/battle";
import type {
  Action,
  BattleCommanderInfo,
  BattleEvent,
  BattleResult,
  BattleState,
  CommanderKind,
  OutlawTier,
  PublicBattleView,
  StarterDeckKey,
} from "@/lib/battle";

import type { BattleCallResult, BattleSource } from "@/components/battle/battle-source";

const TURN_MS = 45_000;

export interface LocalBattleOptions {
  seed: number;
  commanderKind: Exclude<CommanderKind, "outlaw" | "garrison">;
  commanderLevel: number;
  commanderName: string;
  outlawTier: OutlawTier;
  lat: number;
  lon: number;
}

function commanderInfo(name: string, xp: number): BattleCommanderInfo {
  const level = levelFromXp(xp);
  return {
    id: "lord",
    name,
    level,
    xp,
    levelXpStart: xpForLevel(level),
    nextLevelXp: level >= MAX_LEVEL ? null : xpForLevel(level + 1),
  };
}

export interface LocalBattle {
  initial: PublicBattleView;
  source: BattleSource;
}

export function createLocalBattle(opts: LocalBattleOptions): LocalBattle {
  const preset = OUTLAW_PRESETS[opts.outlawTier];
  const deckKey: StarterDeckKey = opts.commanderKind;
  let state: BattleState = createBattle({
    seed: opts.seed,
    attacker: {
      commander: { id: "lord", kind: opts.commanderKind, name: opts.commanderName, level: opts.commanderLevel },
      deck: starterDeck(deckKey, 15),
    },
    defender: {
      commander: { id: "outlaw", kind: "outlaw", name: preset.name, level: preset.level, maxHp: preset.hp },
      deck: preset.deck,
    },
  });
  let deadline = Date.now() + TURN_MS;
  const xpStart = xpForLevel(opts.commanderLevel) + 40;
  const before = commanderInfo(opts.commanderName, xpStart);
  let result: BattleResult | null = null;

  const view = (): PublicBattleView => ({
    battleId: `local-${opts.seed}`,
    viewerSide: 0,
    turn: state.turn,
    activeSide: state.activeSide,
    turnDeadline: deadline,
    sides: toPublicSides(state, 0),
    winner: state.winner,
    endReason: state.endReason,
    target: { type: "outlaw", id: "demo", name: preset.name, lat: opts.lat, lon: opts.lon, tier: opts.outlawTier },
    commander: before,
    result,
  });

  const settle = (): void => {
    if (state.winner === null || result) return;
    const victory = state.winner === 0;
    const gained = battleXp({ won: victory, kills: state.sides[0].kills, vsOutlaw: true });
    const after = commanderInfo(opts.commanderName, xpStart + gained);
    const pool = COLLECTIBLE_CARDS;
    result = {
      winner: state.winner,
      reason: state.endReason ?? "commander-defeated",
      victory,
      xpGained: gained,
      commanderBefore: before,
      commanderAfter: after,
      levelUp: after.level > before.level,
      cardRewards: victory ? [pool[opts.seed % pool.length].id] : [],
      injuredUntil: victory ? null : Date.now() + 60 * 60 * 1000,
    };
  };

  const runAi = (events: BattleEvent[]): void => {
    if (state.winner !== null || state.activeSide !== 1) return;
    const actions = chooseAiTurn(state, 1);
    for (const a of actions) {
      const r = applyAction(state, 1, a);
      if (!r.ok) break;
      state = r.state;
      events.push(...r.events);
      if (state.winner !== null || state.activeSide !== 1) break;
    }
    if (state.winner === null && state.activeSide === 1) {
      const r = applyAction(state, 1, { type: "endTurn" });
      if (r.ok) {
        state = r.state;
        events.push(...r.events);
      }
    }
    deadline = Date.now() + TURN_MS;
  };

  const step = (action: Action | null): BattleCallResult => {
    const events: BattleEvent[] = [];
    if (state.winner === null && state.activeSide === 0 && Date.now() > deadline + 3000) {
      const r = applyAction(state, 0, { type: "endTurn" });
      if (r.ok) {
        state = r.state;
        events.push(...r.events);
        runAi(events);
      }
      if (action && action.type !== "concede") action = null;
    }
    if (action) {
      const r = applyAction(state, 0, action);
      if (!r.ok) return { ok: false, code: "invalid_action", message: r.error };
      state = r.state;
      events.push(...r.events);
      runAi(events);
    }
    settle();
    return { ok: true, battle: view(), events: redactEvents(events, 0) };
  };

  // 네트워크처럼 약간 늦게 응답한다 (AI 계산은 동기라 화면이 먼저 그려지도록)
  const later = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve) => window.setTimeout(() => resolve(fn()), 120));

  return {
    initial: view(),
    source: {
      act: (_battleId: string, action: Action) => later(() => step(action)),
      refresh: () => later(() => step(null)),
      now: () => Date.now(),
    },
  };
}
