// AI 대 AI 자동 대전 시뮬레이션 (밸런스 검증용).
// 실행: node --experimental-strip-types --no-warnings scripts/battle-sim.ts [games]
//
// src/lib/battle 의 파일들은 Next 번들러용으로 확장자 없는 상대 import 를 쓰므로,
// 여기서 확장자 없는 경로를 .ts 로 풀어 주는 resolve 훅을 먼저 등록한 뒤 동적 import 한다.

import * as nodeModule from "node:module";

// registerHooks 는 Node 22.15+ 에 있으나 설치된 @types/node 에는 아직 없어 최소 타입을 직접 선언한다
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context: unknown) => ResolveResult;
interface ModuleHooksApi {
  registerHooks(hooks: {
    resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolveResult;
  }): unknown;
}
const { registerHooks } = nodeModule as unknown as ModuleHooksApi;

registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: NextResolve): ResolveResult {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

type Battle = typeof import("../src/lib/battle/index");
type BattleStateT = import("../src/lib/battle/types").BattleState;
type CommanderKindT = import("../src/lib/battle/types").CommanderKind;

const B: Battle = await import("../src/lib/battle/index");

const SECONDS_PER_TURN = 8;
const totalGames = Math.max(25, Number(process.argv[2] ?? 1000) || 1000);

interface DeckSpec {
  label: string;
  kind: CommanderKindT;
  level: number;
  deck: string[];
  maxHp?: number;
}

interface GameResult {
  winner: 0 | 1 | "draw";
  turns: number;
}

function playGame(seed: number, a: DeckSpec, d: DeckSpec): GameResult {
  let s: BattleStateT = B.createBattle({
    seed,
    attacker: { commander: { id: "A", kind: a.kind, name: a.label, level: a.level }, deck: a.deck },
    defender: { commander: { id: "D", kind: d.kind, name: d.label, level: d.level, maxHp: d.maxHp }, deck: d.deck },
  });
  let safety = 0;
  while (s.winner === null) {
    if (++safety > 200) throw new Error("턴이 끝나지 않음");
    const side = s.activeSide;
    const actions = B.chooseAiTurn(s, side);
    if (actions.length === 0) throw new Error("AI 가 행동을 내지 않음");
    for (const act of actions) {
      const r = B.applyAction(s, side, act);
      if (!r.ok) throw new Error(`불법 행동: ${r.error} ${JSON.stringify(act)}`);
      s = r.state;
      if (s.winner !== null) break;
    }
  }
  return { winner: s.winner, turns: s.turn };
}

// ---------------------------------------------------------------- 병종 시작 덱 대전
const keys = ["infantry", "archer", "cavalry", "mage", "lord"] as const;
const specs: DeckSpec[] = keys.map((k) => ({
  label: k,
  kind: k,
  level: 1,
  deck: B.starterDeck(k, 15),
}));

const pairs = specs.length * specs.length;
const perPair = Math.max(1, Math.round(totalGames / pairs));
const t0 = performance.now();

// wins[i][j]: i 가 j 를 상대로 이긴 판수 (선후공 합산), games[i][j]
const wins: number[][] = specs.map(() => specs.map(() => 0));
const games: number[][] = specs.map(() => specs.map(() => 0));
const turnCells: number[][] = specs.map(() => specs.map(() => 0));
let firstWins = 0;
let draws = 0;
let played = 0;
let turnSum = 0;
const turnHist = new Map<number, number>();

let seed = 1;
for (let i = 0; i < specs.length; i++) {
  for (let j = 0; j < specs.length; j++) {
    for (let g = 0; g < perPair; g++) {
      const r = playGame(seed++, specs[i], specs[j]);
      played++;
      turnSum += r.turns;
      turnHist.set(r.turns, (turnHist.get(r.turns) ?? 0) + 1);
      games[i][j]++;
      games[j][i]++;
      turnCells[i][j] += r.turns;
      turnCells[j][i] += r.turns;
      if (r.winner === "draw") {
        draws++;
        continue;
      }
      if (r.winner === 0) {
        firstWins++;
        wins[i][j]++;
      } else {
        wins[j][i]++;
      }
    }
  }
}
const elapsed = (performance.now() - t0) / 1000;

const pct = (n: number, d: number): string => (d === 0 ? "  -  " : `${((100 * n) / d).toFixed(1).padStart(5)}`);
const pad = (x: string, n = 9): string => x.padEnd(n);

console.log(`\n== 병종 시작 덱 (15장, L1) AI 대전: ${played}판 (조합당 ${perPair}판, ${elapsed.toFixed(1)}s) ==`);
console.log("행 병종의 승률(%) vs 열 병종 (선후공 합산)");
console.log(pad("") + specs.map((s) => pad(s.label)).join(""));
for (let i = 0; i < specs.length; i++) {
  const row = specs.map((_, j) => pad(i === j ? "  (거울)" : pct(wins[i][j], games[i][j])));
  console.log(pad(specs[i].label) + row.join(""));
}
console.log("\n조합별 평균 턴:");
console.log(pad("") + specs.map((s) => pad(s.label)).join(""));
for (let i = 0; i < specs.length; i++) {
  const row = specs.map((_, j) => pad((turnCells[i][j] / games[i][j]).toFixed(1).padStart(5)));
  console.log(pad(specs[i].label) + row.join(""));
}
console.log("\n병종 전체 승률 (거울전 제외):");
for (let i = 0; i < specs.length; i++) {
  let w = 0;
  let n = 0;
  for (let j = 0; j < specs.length; j++) {
    if (i === j) continue;
    w += wins[i][j];
    n += games[i][j];
  }
  console.log(`  ${pad(specs[i].label)} ${pct(w, n)}%`);
}
const avgTurns = turnSum / played;
console.log(`\n선공 승률: ${pct(firstWins, played - draws)}%   무승부: ${draws}`);
console.log(
  `평균 턴(양측 합산): ${avgTurns.toFixed(2)}  → 예상 소요 ${((avgTurns * SECONDS_PER_TURN) / 60).toFixed(1)}분 (턴당 ${SECONDS_PER_TURN}초 가정)`,
);
const hist = [...turnHist.entries()].sort((a, b) => a[0] - b[0]);
console.log("턴 분포: " + hist.map(([t, n]) => `${t}:${n}`).join(" "));

// ---------------------------------------------------------------- 무법자 난이도 vs L1 시작 덱
console.log(`\n== 무법자 난이도 vs L1 시작 덱(10장), 플레이어 선공 ==`);
const outlawGames = Math.max(10, Math.round(totalGames / 25));
const header = pad("", 16) + keys.map((k) => pad(k)).join("") + "평균턴";
console.log(header + "   (플레이어 승률 %)");
for (const tier of [1, 2, 3] as const) {
  const preset = B.OUTLAW_PRESETS[tier];
  const outlaw: DeckSpec = { label: preset.name, kind: "outlaw", level: preset.level, deck: preset.deck, maxHp: preset.hp };
  const cells: string[] = [];
  let tSum = 0;
  let n = 0;
  for (const k of keys) {
    const player: DeckSpec = { label: k, kind: k, level: 1, deck: B.starterDeck(k, B.deckSizeForLevel(1)) };
    let w = 0;
    for (let g = 0; g < outlawGames; g++) {
      const r = playGame(seed++, player, outlaw);
      if (r.winner === 0) w++;
      tSum += r.turns;
      n++;
    }
    cells.push(pad(pct(w, outlawGames)));
  }
  console.log(pad(`T${tier} ${preset.name}`, 16) + cells.join("") + (tSum / n).toFixed(1));
}

// ---------------------------------------------------------------- 성 기본 수비대 vs L1~L5
console.log(`\n== 성 기본 수비대(L${B.GARRISON_DEFAULT_LEVEL}) vs 병종 시작 덱, 플레이어 선공 ==`);
for (const lv of [1, 5]) {
  const cells: string[] = [];
  for (const k of keys) {
    const player: DeckSpec = { label: k, kind: k, level: lv, deck: B.starterDeck(k, B.deckSizeForLevel(lv)) };
    const garrison: DeckSpec = {
      label: "수비대",
      kind: "garrison",
      level: B.GARRISON_DEFAULT_LEVEL,
      deck: [...B.GARRISON_DEFAULT_DECK],
    };
    let w = 0;
    for (let g = 0; g < outlawGames; g++) {
      if (playGame(seed++, player, garrison).winner === 0) w++;
    }
    cells.push(pad(pct(w, outlawGames)));
  }
  console.log(pad(`플레이어 L${lv}`, 16) + cells.join(""));
}
