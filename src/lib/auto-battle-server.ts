// 오토배틀 서버 연결부 (원샷 확정전). 서버 전용.
// 카드 전투 battle-server.ts 의 검증 유틸을 재사용하고, 전투 자체는
// src/lib/auto-battle.ts 결정적 시뮬레이션으로 한 번에 끝낸다.
//
// - 공격 편성: 클라가 고른 지휘관 id 1~5기 (서버가 소유·부상·상태 검증)
// - 수비 편성: 서버가 구성 (무법자 티어 / 상대 지휘관 / 성 주둔)
// - 정산: 선두 지휘관은 full XP·승수, 나머지는 참가 XP. 패배 시 선두만 부상 30분.

import {
  BattleError,
  INJURY_MS,
  listCommanders,
  makeBattleId,
  makeBattleSeed,
  resolveCommander,
  toJsonObject,
  type JsonObject,
  type LordSnapshot,
} from "@/lib/battle-server";
import { battleXp, levelFromXp } from "@/lib/battle";
import { OUTLAW_TIER_LABEL, effectiveOutlawTier, outlawTierForId } from "@/lib/battle/outlaw";
import {
  type AutoBattleResult,
  type AutoFormation,
  type AutoSlot,
  type AutoUnitKind,
} from "@/lib/auto-battle";
import { loadUnits, withUnits } from "@/lib/units";
import type { Tx } from "@/lib/territory";

export interface ResolvedSlot extends AutoSlot {
  commanderId: string;
}

export interface AutoBattleStartInput {
  /** 5칸 슬롯 (null = 빈 칸). 전위 0~2 + 후위 3~4, 위치 그대로 전투에 반영. */
  slots: Array<string | null>;
  skillTick?: number;
  skillKind?: AutoUnitKind;
  seed?: number;
}

export interface SettledCommander {
  id: string;
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  wins: number;
  battles: number;
}

const TROOP_KINDS: ReadonlyArray<AutoUnitKind> = ["infantry", "archer", "cavalry", "mage"];

function toAutoKind(kind: string): AutoUnitKind {
  return kind === "lord" ? "lord" : (TROOP_KINDS as readonly string[]).includes(kind) ? (kind as AutoUnitKind) : "infantry";
}

export { toAutoKind as toAutoBattleKind };

/** 클라 slots → 서버 검증된 공격 편성 (중복·미보유·부상 거부). 선두가 출전 지휘관. */
export function buildAttackerFormation(
  data: ReturnType<typeof toJsonObject>,
  input: AutoBattleStartInput,
  lord: LordSnapshot,
  now: number,
): { formation: AutoFormation; resolved: ResolvedSlot[]; leadId: string; leadPos: { lat: number; lon: number } } {
  const idList = (Array.isArray(input.slots) ? input.slots : []).map((v) => (typeof v === "string" ? v.trim() : ""));
  if (idList.length > 5) throw new BattleError("invalid", 400, "편성은 1~5기입니다.");
  const ids = idList.filter(Boolean);
  if (ids.length === 0) throw new BattleError("invalid", 400, "편성은 1~5기입니다.");
  if (new Set(ids).size !== ids.length) throw new BattleError("invalid", 400, "중복된 지휘관입니다.");
  const byId = new Map<string, { pos: { lat: number; lon: number }; slot: ResolvedSlot }>();
  for (const id of ids) {
    if (byId.has(id)) continue;
    const c = resolveCommander(data, id, lord, now);
    byId.set(id, {
      pos: { lat: c.lat, lon: c.lon },
      slot: { commanderId: c.id, kind: toAutoKind(c.kind), name: c.name, level: c.level },
    });
  }
  const resolved: ResolvedSlot[] = [];
  const formation: AutoFormation = [0, 1, 2, 3, 4].map((i) => {
    const entry = idList[i] ? byId.get(idList[i] as string) : undefined;
    if (!entry) return null;
    if (!resolved.some((r) => r.commanderId === entry.slot.commanderId)) resolved.push(entry.slot);
    return { kind: entry.slot.kind, name: entry.slot.name, level: entry.slot.level };
  });
  const lead = resolved[0];
  const leadPos = lead ? byId.get(lead.commanderId)?.pos : undefined;
  if (!lead || !leadPos) throw new BattleError("invalid", 400, "편성이 비었습니다.");
  return { formation, resolved, leadId: lead.commanderId, leadPos };
}

export function attackerSkillKind(resolved: ResolvedSlot[], wanted?: AutoUnitKind): AutoUnitKind {
  if (wanted && resolved.some((r) => r.kind === wanted)) return wanted;
  return resolved[0].kind;
}

/** 무법자 티어 → 수비 편성 (2 / 3 / 5기). */
export function outlawFormation(tier: 1 | 2 | 3, label: string): AutoFormation {
  const troops: AutoFormation =
    tier === 1
      ? [
          { kind: "infantry", name: `${label} 졸개`, level: 1 },
          { kind: "archer", name: `${label} 궁수`, level: 1 },
          null,
          null,
          null,
        ]
      : tier === 2
        ? [
            { kind: "infantry", name: `${label} 졸개`, level: 2 },
            { kind: "archer", name: `${label} 궁수`, level: 1 },
            null,
            { kind: "cavalry", name: `${label} 기수`, level: 2 },
            null,
          ]
        : [
            { kind: "lord", name: label, level: 2 },
            { kind: "infantry", name: `${label} 친위`, level: 2 },
            { kind: "archer", name: `${label} 궁수`, level: 2 },
            { kind: "cavalry", name: `${label} 기수`, level: 2 },
            { kind: "mage", name: `${label} 주술사`, level: 1 },
          ];
  return troops;
}

/** 상대 성주 data → 수비 편성 (가용 지휘관 최대 5기) + 선두 id. */
export function ownerFormation(
  ownerData: ReturnType<typeof toJsonObject>,
  nickname: string | null,
  now: number,
  leadFirstId?: string,
): { formation: AutoFormation; leadId: string | null } {
  return formationFromList(listCommanders(ownerData, nickname, now), leadFirstId);
}

/** 지휘관 목록 → 수비 편성. leadFirstId가 있으면 선두에 둔다. */
export function formationFromList(
  list: ReturnType<typeof listCommanders>,
  leadFirstId?: string,
  max = 5,
): { formation: AutoFormation; leadId: string | null } {
  const avail = list.filter((c) => c.available);
  const ordered = leadFirstId
    ? [...avail.filter((c) => c.id === leadFirstId), ...avail.filter((c) => c.id !== leadFirstId)]
    : avail;
  const picked = ordered.slice(0, max);
  if (picked.length === 0) return { formation: [null, null, null, null, null], leadId: null };
  const formation: AutoFormation = [0, 1, 2, 3, 4].map((i) => {
    const c = picked[i];
    if (!c) return null;
    return { kind: toAutoKind(c.kind), name: c.name, level: c.level };
  });
  return { formation, leadId: picked[0].id };
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

export interface AutoSettleInput {
  data: ReturnType<typeof toJsonObject>;
  resolved: ResolvedSlot[];
  result: AutoBattleResult;
  vsOutlaw: boolean;
  now: number;
}

/**
 * 정산 (순수): 선두는 full XP·승수, 나머지는 참가 XP(+10). 패배 시 선두만 부상.
 * data.commanders / lordInjuredUntil / units[].injuredUntil / lastBattleAt 갱신.
 */
export function settleAutoBattle(input: AutoSettleInput): {
  data: JsonObject;
  progress: SettledCommander[];
  injuredUntil: number | null;
  victory: boolean;
} {
  const { resolved, result, vsOutlaw, now } = input;
  const victory = result.winner === 0;
  const kills = result.events.filter((e) => e.attackerSide === 0 && e.killed).length;
  const fullXp = battleXp({ won: victory, kills, vsOutlaw });
  const commanders = { ...((input.data.commanders ?? {}) as Record<string, { xp?: unknown; kind?: unknown; wins?: unknown; battles?: unknown }>) };
  const progress: SettledCommander[] = [];

  resolved.forEach((r, idx) => {
    const prev = commanders[r.commanderId] ?? {};
    const xpBefore = typeof prev.xp === "number" ? prev.xp : 0;
    const winsBefore = typeof prev.wins === "number" ? prev.wins : 0;
    const battlesBefore = typeof prev.battles === "number" ? prev.battles : 0;
    const gained = idx === 0 ? fullXp : 10;
    const xpAfter = xpBefore + gained;
    commanders[r.commanderId] = {
      xp: xpAfter,
      kind: (typeof prev.kind === "string" ? prev.kind : r.kind) as unknown,
      wins: winsBefore + (idx === 0 && victory ? 1 : 0),
      battles: battlesBefore + 1,
    };
    const levelBefore = levelFromXp(xpBefore);
    const levelAfter = levelFromXp(xpAfter);
    progress.push({
      id: r.commanderId,
      xpBefore,
      xpAfter,
      levelBefore,
      levelAfter,
      wins: winsBefore + (idx === 0 && victory ? 1 : 0),
      battles: battlesBefore + 1,
    });
  });

  let out: JsonObject = { ...input.data, commanders: commanders as unknown as JsonObject[string], lastBattleAt: now };
  const injuredUntil = result.winner === 1 ? now + INJURY_MS : null;
  const lead = resolved[0];
  if (!lead) throw new BattleError("invalid", 400, "편성이 비었습니다.");
  const leadId = lead.commanderId;
  if (injuredUntil !== null) {
    if (leadId === "lord") {
      out = { ...out, lordInjuredUntil: injuredUntil };
    } else {
      const units = loadUnits(out);
      if (units.some((u) => u.id === leadId)) {
        out = withUnits(
          out,
          units.map((u) => (u.id === leadId ? { ...u, injuredUntil } : u)),
        );
      }
    }
  }
  return { data: out, progress, injuredUntil, victory };
}

export { BattleError, makeBattleId, makeBattleSeed, effectiveOutlawTier, outlawTierForId, OUTLAW_TIER_LABEL };
export type { Tx };

/** 원군 참전 정산: 참가 XP +10만 (승수·부상 없음). */
export async function settleReinforcement(
  tx: Tx,
  lenderUserId: string,
  unitId: string,
  now: number,
): Promise<void> {
  const row = await tx.missionUser.findUnique({ where: { userId: lenderUserId }, select: { data: true } });
  if (!row) return;
  const units = loadUnits(toJsonObject(row.data));
  if (!units.some((u) => u.id === unitId)) return;
  const data = toJsonObject(row.data);
  const commanders = { ...((data.commanders ?? {}) as Record<string, { xp?: unknown; kind?: unknown; wins?: unknown; battles?: unknown }>) };
  const prev = commanders[unitId] ?? {};
  const xpBefore = typeof prev.xp === "number" ? prev.xp : 0;
  commanders[unitId] = {
    xp: xpBefore + 10,
    kind: prev.kind ?? "infantry",
    wins: typeof prev.wins === "number" ? prev.wins : 0,
    battles: (typeof prev.battles === "number" ? prev.battles : 0) + 1,
  };
  const out: JsonObject = { ...data, commanders: commanders as unknown as JsonObject[string], lastBattleAt: now };
  await tx.missionUser.update({ where: { userId: lenderUserId }, data: { data: out } });
}

/** 대인전 수비 측 선두 정산 (공격자 트랜잭션과 분리 — 교착 방지). */
export async function settleDefenderLead(
  tx: Tx,
  ownerId: string,
  leadCommanderId: string,
  defenderWon: boolean,
  kills: number,
  now: number,
): Promise<{ injuredUntil: number | null }> {
  const row = await tx.missionUser.findUnique({ where: { userId: ownerId }, select: { data: true } });
  if (!row) return { injuredUntil: null };
  if (leadCommanderId !== "lord") {
    const units = loadUnits(toJsonObject(row.data));
    if (!units.some((u) => u.id === leadCommanderId)) return { injuredUntil: null };
  }
  const data = toJsonObject(row.data);
  const commanders = { ...((data.commanders ?? {}) as Record<string, { xp?: unknown; kind?: unknown; wins?: unknown; battles?: unknown }>) };
  const prev = commanders[leadCommanderId] ?? {};
  const xpBefore = typeof prev.xp === "number" ? prev.xp : 0;
  const gained = battleXp({ won: defenderWon, kills, vsOutlaw: false });
  commanders[leadCommanderId] = {
    xp: xpBefore + gained,
    kind: prev.kind ?? (leadCommanderId === "lord" ? "lord" : "infantry"),
    wins: (typeof prev.wins === "number" ? prev.wins : 0) + (defenderWon ? 1 : 0),
    battles: (typeof prev.battles === "number" ? prev.battles : 0) + 1,
  };
  let out: JsonObject = { ...data, commanders: commanders as unknown as JsonObject[string], lastBattleAt: now };
  const injuredUntil = !defenderWon ? now + INJURY_MS : null;
  if (injuredUntil !== null) {
    if (leadCommanderId === "lord") {
      out = { ...out, lordInjuredUntil: injuredUntil };
    } else {
      const units = loadUnits(out);
      out = withUnits(
        out,
        units.map((u) => (u.id === leadCommanderId ? { ...u, injuredUntil } : u)),
      );
    }
  }
  await tx.missionUser.update({ where: { userId: ownerId }, data: { data: out } });
  return { injuredUntil };
}
