// 오토배틀 예상 승률 (순수, 클라 전용 계산에 쓴다).
// 지도 무법자 이름표 색·편성 화면이 같은 방식으로 계산한다.

import { resolveAutoBattle, type AutoFormation, type AutoUnitKind } from "@/lib/auto-battle";

export interface EstimateCommander {
  kind: AutoUnitKind;
  name: string;
  level: number;
  bonusHp?: number;
  bonusAtk?: number;
}

const RANGED: ReadonlySet<AutoUnitKind> = new Set<AutoUnitKind>(["archer", "mage"]);

/** 가용 지휘관 → 추천 편성 (영주·최고 레벨 선두, 근접 전위·원거리 후위, 최대 5기) */
export function recommendFormation(list: EstimateCommander[]): AutoFormation {
  const sorted = [...list].sort((a, b) => (a.kind === "lord" ? -1 : b.kind === "lord" ? 1 : b.level - a.level));
  const lead = sorted.shift();
  const out: AutoFormation = [null, null, null, null, null];
  if (!lead) return out;
  out[0] = { kind: lead.kind, name: lead.name, level: lead.level, bonusHp: lead.bonusHp, bonusAtk: lead.bonusAtk };
  const melee = sorted.filter((c) => !RANGED.has(c.kind));
  const ranged = sorted.filter((c) => RANGED.has(c.kind));
  const put = (idx: number, c: EstimateCommander | undefined): void => {
    if (c) out[idx] = { kind: c.kind, name: c.name, level: c.level, bonusHp: c.bonusHp, bonusAtk: c.bonusAtk };
  };
  put(3, ranged.shift());
  put(4, ranged.shift());
  put(1, melee.shift() ?? ranged.shift());
  put(2, melee.shift() ?? ranged.shift());
  if (!out[3]) put(3, melee.shift());
  if (!out[4]) put(4, melee.shift());
  return out;
}

/** 모의전 승률(%) — 선두 병종 스킬을 3턴째에 쓴다고 가정 */
export function estimateWinRate(
  attacker: AutoFormation,
  defender: AutoFormation,
  opts: { runs?: number; skillKind?: AutoUnitKind; skillTick?: number } = {},
): number | null {
  const lead = attacker.find((s) => s !== null);
  if (!lead) return null;
  const runs = opts.runs ?? 120;
  const skillKind = opts.skillKind ?? lead.kind;
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const r = resolveAutoBattle({
      seed: (Math.imul(i + 1, 2654435761) ^ 0x5bd1) >>> 0,
      attacker,
      defender,
      attackerSkillTick: opts.skillTick ?? 2,
      attackerSkillKind: skillKind,
    });
    if (r.winner === 0) wins++;
  }
  return Math.round((wins / runs) * 100);
}

export type OutlawDifficulty = "easy" | "even" | "hard";

/** 예상 승률 → 난이도 (쉬움 70% 이상, 보통 40% 이상, 어려움 그 밖) */
export function difficultyOf(winRate: number | null): OutlawDifficulty | null {
  if (winRate === null) return null;
  return winRate >= 70 ? "easy" : winRate >= 40 ? "even" : "hard";
}
