// 편성형 오토배틀 엔진 — 60초 전투용 결정적 시뮬레이션.
// 규칙: 전위 3 + 후위 2, 자동 진행, 지휘관 스킬 1회 타이밍 개입.
// 순수 함수 + JSON 직렬화 가능. React/Next/Prisma import 금지.

/** 무법자·상대 부대·영주 공격 가능 거리 (m). 멀면 지도에서 먼저 다가간 뒤 전투한다. */
export const ATTACK_RANGE_M = 20;
/** 서버 판정 여유 (영주 위치 기록 주기·이동 보간 오차) */
export const ATTACK_RANGE_SLACK_M = 10;

export type AutoUnitKind = "lord" | "infantry" | "archer" | "cavalry" | "mage";

export interface AutoSlot {
  kind: AutoUnitKind;
  name: string;
  level: number;
}

export type AutoFormation = Array<AutoSlot | null>;

export interface AutoResolvedUnit {
  kind: AutoUnitKind;
  name: string;
  level: number;
  maxHp: number;
  hp: number;
  atk: number;
  alive: boolean;
}

export interface AutoTickEvent {
  tick: number;
  attackerSide: 0 | 1;
  attackerIdx: number;
  targetIdx: number;
  damage: number;
  counterBonus: boolean;
  targetHpAfter: number;
  killed: boolean;
}

/** 스킬 발동 기록 (재생 연출용). self는 발동 직후 시전 진영 5칸의 상태. */
export interface AutoSkillEvent {
  tick: number;
  side: 0 | 1;
  kind: AutoUnitKind;
  self: Array<{ hp: number; maxHp: number; atk: number; alive: boolean }>;
}

export interface AutoBattleResult {
  winner: 0 | 1 | "draw";
  ticks: number;
  events: AutoTickEvent[];
  skills: AutoSkillEvent[];
  remaining: [AutoResolvedUnit[], AutoResolvedUnit[]];
}

const clampLevel = (lv: number): number => Math.max(1, Math.min(10, Math.floor(lv)));

const baseStats = (kind: AutoUnitKind): { hp: number; atk: number } => {
  switch (kind) {
    case "lord":
      return { hp: 20, atk: 3 };
    case "infantry":
      return { hp: 10, atk: 3 };
    case "archer":
      return { hp: 8, atk: 4 };
    case "cavalry":
      return { hp: 9, atk: 4 };
    case "mage":
      return { hp: 7, atk: 5 };
  }
};

/** 상성: 보병>궁병>기병>마법>보병, 영주는 중립. 우위면 피해 +30%. */
export function counterBonusOf(atk: AutoUnitKind, def: AutoUnitKind): boolean {
  if (atk === "lord" || def === "lord") return false;
  return (
    (atk === "infantry" && def === "archer") ||
    (atk === "archer" && def === "cavalry") ||
    (atk === "cavalry" && def === "mage") ||
    (atk === "mage" && def === "infantry")
  );
}

export const unitStats = (slot: AutoSlot): { maxHp: number; atk: number } => {
  const base = baseStats(slot.kind);
  const lv = clampLevel(slot.level);
  return {
    maxHp: base.hp + (lv - 1) * 2,
    atk: base.atk + Math.floor((lv - 1) / 2),
  };
};

/** mulberry32 */
function rngNext(state: number): { value: number; state: number } {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: s };
}

const pickTarget = (
  enemies: AutoResolvedUnit[],
  rand: number,
): number => {
  const front = [0, 1, 2].filter((i) => enemies[i] && enemies[i].alive);
  const back = [3, 4].filter((i) => enemies[i] && enemies[i].alive);
  const pool = front.length > 0 ? front : back;
  if (pool.length === 0) return -1;
  return pool[Math.floor(rand * pool.length)] ?? pool[0];
};

export interface AutoBattleOptions {
  seed: number;
  attacker: AutoFormation;
  defender: AutoFormation;
  /** 지휘관 스킬: attacker가 tick 시점에 발동. 효과는 진영 전체 소폭 버프/피해. */
  attackerSkillTick?: number;
  attackerSkillKind?: AutoUnitKind;
  defenderSkillTick?: number;
  defenderSkillKind?: AutoUnitKind;
}

const MAX_TICKS = 40;

function applySkill(
  self: AutoResolvedUnit[],
  foe: AutoResolvedUnit[],
  kind: AutoUnitKind,
  tick: number,
  events: AutoTickEvent[],
): void {
  if (kind === "archer") {
    const idx = foe.findIndex((u) => u.alive);
    if (idx >= 0) {
      const target = foe[idx];
      const dmg = 3;
      target.hp -= dmg;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
      }
      events.push({
        tick,
        attackerSide: 0,
        attackerIdx: -1,
        targetIdx: idx,
        damage: dmg,
        counterBonus: false,
        targetHpAfter: target.hp,
        killed: !target.alive,
      });
    }
    return;
  }
  if (kind === "infantry") {
    for (const u of self) {
      if (u.alive) u.hp = Math.min(u.maxHp, u.hp + 2);
    }
    return;
  }
  if (kind === "cavalry") {
    for (const u of self) {
      if (u.alive) u.atk += 1;
    }
    return;
  }
  if (kind === "mage") {
    foe.forEach((u, idx) => {
      if (u.alive) {
        u.hp -= 1;
        if (u.hp <= 0) {
          u.hp = 0;
          u.alive = false;
        }
        events.push({
          tick,
          attackerSide: 0,
          attackerIdx: -1,
          targetIdx: idx,
          damage: 1,
          counterBonus: false,
          targetHpAfter: u.hp,
          killed: !u.alive,
        });
      }
    });
    return;
  }
  // lord: 아군 전체 +1/+1
  for (const u of self) {
    if (u.alive) {
      u.atk += 1;
      u.maxHp += 1;
      u.hp += 1;
    }
  }
}

/** 편성 1개체를 전투 유닛으로 전개 (빈 칸은 null 유지하되 인덱스 고정). */
const deploy = (formation: AutoFormation): AutoResolvedUnit[] =>
  [0, 1, 2, 3, 4].map((i) => {
    const slot = formation[i];
    if (!slot) {
      return { kind: "infantry" as AutoUnitKind, name: "", level: 1, maxHp: 0, hp: 0, atk: 0, alive: false };
    }
    const stats = unitStats(slot);
    return { kind: slot.kind, name: slot.name, level: clampLevel(slot.level), maxHp: stats.maxHp, hp: stats.maxHp, atk: stats.atk, alive: true };
  });

export function resolveAutoBattle(opts: AutoBattleOptions): AutoBattleResult {
  const atk = deploy(opts.attacker);
  const def = deploy(opts.defender);
  const events: AutoTickEvent[] = [];
  const skills: AutoSkillEvent[] = [];
  const snap = (units: AutoResolvedUnit[]): AutoSkillEvent["self"] =>
    units.map((u) => ({ hp: u.hp, maxHp: u.maxHp, atk: u.atk, alive: u.alive }));
  let rng = opts.seed >>> 0;
  let attackerSkillUsed = false;
  let defenderSkillUsed = false;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    if (opts.attackerSkillTick === tick && !attackerSkillUsed && opts.attackerSkillKind) {
      attackerSkillUsed = true;
      applySkill(atk, def, opts.attackerSkillKind, tick, events);
      skills.push({ tick, side: 0, kind: opts.attackerSkillKind, self: snap(atk) });
    }
    if (opts.defenderSkillTick === tick && !defenderSkillUsed && opts.defenderSkillKind) {
      defenderSkillUsed = true;
      // 수비 스킬은 events attackerSide 표기를 1로 — applySkill은 0 고정이라 후처리
      const before = events.length;
      applySkill(def, atk, opts.defenderSkillKind, tick, events);
      for (let i = before; i < events.length; i++) {
        const ev = events[i];
        if (ev) ev.attackerSide = 1;
      }
      skills.push({ tick, side: 1, kind: opts.defenderSkillKind, self: snap(def) });
    }

    const atkAlive = atk.some((u) => u.alive);
    const defAlive = def.some((u) => u.alive);
    if (!atkAlive || !defAlive) break;

    // 양측이 칸 순서대로 한 기씩 번갈아 공격한다. 턴마다 먼저 치는 쪽을 바꿔 선공 편향을 없앤다.
    const firstSide: 0 | 1 = tick % 2 === 0 ? 0 : 1;
    const order: Array<[0 | 1, number]> = [];
    for (let idx = 0; idx < 5; idx++) {
      order.push([firstSide, idx], [firstSide === 0 ? 1 : 0, idx]);
    }
    for (const [side, idx] of order) {
      const self = side === 0 ? atk : def;
      const foe = side === 0 ? def : atk;
      const unit = self[idx];
      if (!unit || !unit.alive) continue;
      const r = rngNext(rng);
      rng = r.state;
      const targetIdx = pickTarget(foe, r.value);
      if (targetIdx < 0) break;
      const target = foe[targetIdx];
      const bonus = counterBonusOf(unit.kind, target.kind);
      // 피해 편차 ±25% (승패가 0%/100%로 굳지 않게)
      const roll = rngNext(rng);
      rng = roll.state;
      const base = bonus ? unit.atk * 1.3 : unit.atk;
      const damage = Math.max(1, Math.round(base * (0.75 + roll.value * 0.5)));
      target.hp -= damage;
      let killed = false;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        killed = true;
      }
      events.push({
        tick,
        attackerSide: side,
        attackerIdx: idx,
        targetIdx,
        damage,
        counterBonus: bonus,
        targetHpAfter: target.hp,
        killed,
      });
      if (!foe.some((u) => u.alive)) break;
    }
  }

  const atkAlive = atk.some((u) => u.alive);
  const defAlive = def.some((u) => u.alive);
  const winner: AutoBattleResult["winner"] = atkAlive && !defAlive ? 0 : !atkAlive && defAlive ? 1 : "draw";
  return { winner, ticks: MAX_TICKS, events, skills, remaining: [atk, def] };
}

/** 편성 검증: 1~5기, 레벨 1~10. */
export function validateFormation(formation: unknown): AutoFormation | null {
  if (!Array.isArray(formation) || formation.length > 5) return null;
  const out: AutoFormation = [];
  let count = 0;
  for (let i = 0; i < 5; i++) {
    const slot = (formation as unknown[])[i];
    if (slot === null || slot === undefined) {
      out.push(null);
      continue;
    }
    if (typeof slot !== "object" || slot === null) return null;
    const rec = slot as Record<string, unknown>;
    const kind = rec.kind;
    if (kind !== "lord" && kind !== "infantry" && kind !== "archer" && kind !== "cavalry" && kind !== "mage") {
      return null;
    }
    const level = typeof rec.level === "number" && Number.isFinite(rec.level) ? Math.floor(rec.level) : NaN;
    if (!Number.isInteger(level) || level < 1 || level > 10) return null;
    const name = typeof rec.name === "string" ? rec.name.slice(0, 12) : "";
    out.push({ kind, name, level });
    count++;
  }
  if (count === 0) return null;
  return out;
}

// ── 서버가 쓰는 고정 수비 편성 (클라 미리보기도 같은 함수를 쓴다) ──

/** 무법자 등급별 표시 레벨 (지도 이름표·패널) */
export const OUTLAW_AUTO_LEVEL: Readonly<Record<1 | 2 | 3, number>> = { 1: 1, 2: 2, 3: 3 };

/** 무법자 등급별 권장 전력 (AI 대전 기준, 2026-11-27 조정) */
export const OUTLAW_AUTO_ADVICE: Readonly<Record<1 | 2 | 3, string>> = {
  1: "영주 혼자도 충분",
  2: "영주 + 부대 1기 이상",
  3: "영주 Lv.3 + 부대 3기(Lv.2) 이상",
};

/**
 * 무법자 등급 → 수비 편성.
 * 모의전(2026-11-27): 떠돌이는 영주 Lv.1 혼자 100%, 패거리는 영주+부대 1기 99%(영주 혼자 1%),
 * 두목은 영주 Lv.3+부대 Lv.2 3기 95%(영주 Lv.2+부대 2기 1%).
 */
export function outlawFormation(tier: 1 | 2 | 3, label: string): AutoFormation {
  if (tier === 1) {
    return [{ kind: "infantry", name: `${label} 졸개`, level: 1 }, null, null, null, null];
  }
  if (tier === 2) {
    return [
      { kind: "infantry", name: `${label} 졸개`, level: 2 },
      null,
      null,
      { kind: "archer", name: `${label} 궁수`, level: 1 },
      null,
    ];
  }
  return [
    { kind: "lord", name: label, level: 2 },
    { kind: "infantry", name: `${label} 친위`, level: 2 },
    { kind: "cavalry", name: `${label} 기수`, level: 2 },
    { kind: "archer", name: `${label} 궁수`, level: 2 },
    null,
  ];
}

/** 무주 성 기본 수비대 (성급별). */
export function neutralGarrisonFormation(kind: "lord" | "noble"): AutoFormation {
  if (kind === "noble") {
    return [
      { kind: "infantry", name: "성 수비대", level: 2 },
      { kind: "archer", name: "성 수비대", level: 2 },
      null,
      { kind: "cavalry", name: "성 수비대", level: 1 },
      null,
    ];
  }
  return [
    { kind: "lord", name: "성주 대리", level: 3 },
    { kind: "infantry", name: "성 수비대", level: 2 },
    { kind: "archer", name: "성 수비대", level: 2 },
    { kind: "cavalry", name: "성 수비대", level: 2 },
    { kind: "mage", name: "성 수비대", level: 1 },
  ];
}
