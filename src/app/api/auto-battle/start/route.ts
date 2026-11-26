import { NextResponse } from "next/server";

import { acquirePgLock } from "@/lib/pg-advisory-lock";
import prisma from "@/lib/prismadb";
import {
  BATTLE_PROXIMITY_M,
  BattleError,
  OUTLAW_HOLD_MS,
  claimedByOther,
  listCommanders,
  makeBattleId,
  makeBattleSeed,
  makeClaim,
  outlawPositionAt,
  readCommanders,
  resolveCommander,
  toJsonObject,
} from "@/lib/battle-server";
import { levelFromXp } from "@/lib/battle";
import {
  ATTACK_RANGE_M,
  ATTACK_RANGE_SLACK_M,
  resolveAutoBattle,
  type AutoFormation,
  type AutoUnitKind,
} from "@/lib/auto-battle";
import { loadUnits } from "@/lib/units";
import { recordBattleResult } from "@/lib/records";
import {
  attackerSkillKind,
  buildAttackerFormation,
  formationFromList,
  neutralGarrisonFormation,
  outlawFormation,
  outlawTierForId,
  OUTLAW_TIER_LABEL,
  settleAutoBattle,
  settleDefenderLead,
  settleReinforcement,
  toAutoBattleKind,
} from "@/lib/auto-battle-server";
import { canAttack, ensureMyNation, siegeGain } from "@/lib/nations";
import {
  clearSiegeGauges,
  conquerCastle,
  currentSeasonId,
  ensureCastleSeason,
  grantInfluence,
  listReinforcements,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withNamedLock,
  type Tx,
} from "@/lib/territory";

export const OUTLAW_AUTO_INFLUENCE = 20;
export const PVP_AUTO_INFLUENCE = 10;

type TargetInput =
  | { type: "outlaw"; wildId: number }
  | { type: "unit"; targetId: string; targetOwnerId: string }
  | { type: "lord"; targetId: string; targetOwnerId: string }
  | { type: "castle"; castleKey: string };

function parseTarget(v: unknown): TargetInput | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.type === "outlaw" && (typeof r.wildId === "number" || typeof r.wildId === "string")) {
    const id = Number(r.wildId);
    if (Number.isInteger(id)) return { type: "outlaw", wildId: id };
    return null;
  }
  if ((r.type === "unit" || r.type === "lord") && typeof r.targetOwnerId === "string") {
    const targetId = r.type === "lord" ? "lord" : typeof r.targetId === "string" ? r.targetId.trim() : "";
    if (targetId && r.targetOwnerId.trim()) {
      return { type: r.type, targetId, targetOwnerId: r.targetOwnerId.trim() };
    }
    return null;
  }
  if (r.type === "castle" && typeof r.castleKey === "string" && r.castleKey.trim()) {
    return { type: "castle", castleKey: r.castleKey.trim() };
  }
  return null;
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

function tooFarMessage(d: number, max = BATTLE_PROXIMITY_M): string {
  return `대상과 너무 멉니다 (${Math.round(d)}m, 최대 ${max}m).`;
}

/** 대인전 수비 측 확인 (락 없이 읽기 — 스냅샷). */
async function resolveDefenderSnapshot(
  attackerId: string,
  ownerId: string,
  targetId: string,
  now: number,
): Promise<{ defender: { id: string; kind: string; name: string; level: number; lat: number; lon: number }; ownerName: string | null; ownerData: ReturnType<typeof toJsonObject>; ownerNickname: string | null }> {
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
    return {
      defender,
      ownerName: owner.nickname?.trim() || null,
      ownerData: toJsonObject(owner.data),
      ownerNickname: owner.nickname,
    };
  } catch (error) {
    if (error instanceof BattleError) {
      if (error.code === "injured") throw new BattleError("target_injured", 409, "상대가 부상 중이라 공격할 수 없습니다.");
      throw new BattleError("target_unavailable", 409, "지금은 이 상대를 공격할 수 없습니다.");
    }
    throw error;
  }
}

/** POST /api/auto-battle/start — 편성 확정전 (무법자·대인·공성). */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();

  let body: { slots?: unknown; target?: unknown; skillTick?: unknown; skillKind?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const slots = Array.isArray(body.slots) ? body.slots : [];
  const target = parseTarget(body.target);
  if (slots.length === 0 || slots.length > 5 || !target) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  const skillTick =
    typeof body.skillTick === "number" && Number.isInteger(body.skillTick)
      ? Math.max(0, Math.min(39, body.skillTick))
      : 8;
  const kinds = ["lord", "infantry", "archer", "cavalry", "mage"] as const;
  const skillKind: AutoUnitKind = (kinds as readonly string[]).includes(body.skillKind as string)
    ? (body.skillKind as AutoUnitKind)
    : "infantry";

  try {
    const result = await withNamedLock(`autobattle:${userId}`, async (tx: Tx) => {
      const now = Date.now();
      const user = await tx.missionUser.findUnique({
        where: { userId },
        select: { data: true, nickname: true, lat: true, lon: true, location_updated_at: true },
      });
      if (!user) throw new BattleError("not_found", 404, "사용자를 찾을 수 없습니다.");
      const data = toJsonObject(user.data);
      const atk = buildAttackerFormation(
        data,
        { slots: slots as Array<string | null>, skillTick, skillKind },
        {
          nickname: user.nickname,
          lat: user.lat === null ? null : Number(user.lat),
          lon: user.lon === null ? null : Number(user.lon),
          updatedAt: user.location_updated_at ? user.location_updated_at.getTime() : null,
        },
        now,
      );
      const skill = attackerSkillKind(atk.resolved, skillKind);
      const seed = makeBattleSeed();
      const battleId = makeBattleId();

      let defender: AutoFormation;
      let defenderName: string;
      let defenderTier: number | null = null;
      let defenderSkill: { tick: number; kind: AutoUnitKind } | null = null;
      let siege: { gauge: number; conquered: boolean; prevOwner?: string | null } | null = null;
      let influence = 0;
      const vsOutlaw = target.type === "outlaw";

      if (target.type === "outlaw") {
        const peek = await tx.territoryNeutralUnit.findUnique({ where: { id: target.wildId }, select: { dong: true } });
        if (!peek) throw new BattleError("not_found", 404, "무법자를 찾을 수 없습니다.");
        const dong = peek.dong.trim();
        await acquirePgLock(tx, `neutral:${dong}`);
        const row = await tx.territoryNeutralUnit.findUnique({ where: { id: target.wildId } });
        if (!row) throw new BattleError("not_found", 404, "무법자를 찾을 수 없습니다.");
        if (claimedByOther(row.quizKey, userId, now)) {
          throw new BattleError("outlaw_busy", 409, "다른 영주가 이 무법자와 싸우고 있습니다.");
        }
        const pos = outlawPositionAt(row, now);
        const dist = distM(atk.leadPos.lat, atk.leadPos.lon, pos.lat, pos.lon);
        if (dist > ATTACK_RANGE_M + ATTACK_RANGE_SLACK_M) {
          throw new BattleError("too_far", 400, tooFarMessage(dist, ATTACK_RANGE_M));
        }
        // 지도에 보이는 등급 그대로 싸운다 (견습 보정 없음, 2026-11-27).
        const tier = outlawTierForId(row.id);
        defenderName = `${OUTLAW_TIER_LABEL[tier]}`;
        defenderTier = tier;
        defender = outlawFormation(tier, defenderName);
        // 고정 후 즉시 결행 (원샷).
        await tx.territoryNeutralUnit.update({
          where: { id: row.id },
          data: {
            lat: pos.lat,
            lon: pos.lon,
            destLat: pos.lat,
            destLon: pos.lon,
            legStartedAt: BigInt(now),
            legEndsAt: BigInt(now + OUTLAW_HOLD_MS),
            updatedAt: BigInt(now),
            quizKey: makeClaim({ userId, battleId, until: now + OUTLAW_HOLD_MS }),
          },
        });
        const settled = await runAndSettle(tx, userId, data, atk, defender, skill, skillTick, seed, vsOutlaw, now);
        if (settled.victory) {
          const current = await tx.territoryNeutralUnit.findUnique({ where: { id: row.id }, select: { quizKey: true } });
          if (current && !claimedByOther(current.quizKey, userId, now)) {
            await tx.territoryNeutralUnit.delete({ where: { id: row.id } });
          }
          influence = OUTLAW_AUTO_INFLUENCE;
          await grantInfluence(tx, userId, influence);
        } else {
          await tx.territoryNeutralUnit.update({
            where: { id: row.id },
            data: { quizKey: "", legEndsAt: BigInt(now), updatedAt: BigInt(now) },
          });
        }
        return {
          victory: settled.victory,
          winner: settled.result.winner,
          progress: settled.progress,
          injuredUntil: settled.injuredUntil,
          events: settled.result.events,
          skills: settled.result.skills,
          attacker: atk.formation,
          skillTick,
          skillKind: skill,
          defender, defenderName, defenderTier, defenderSkill, siege, influence, battleId, seed,
          defenderLead: null as null,
          reinforced: [] as Array<{ lenderUserId: string; unitId: string }>,
        };
      }

      if (target.type === "unit" || target.type === "lord") {
        const snap = await resolveDefenderSnapshot(userId, target.targetOwnerId, target.targetId, now);
        const dist = distM(atk.leadPos.lat, atk.leadPos.lon, snap.defender.lat, snap.defender.lon);
        if (dist > ATTACK_RANGE_M + ATTACK_RANGE_SLACK_M) {
          throw new BattleError("too_far", 400, tooFarMessage(dist, ATTACK_RANGE_M));
        }
        const ownerNation = await tx.territoryNationMember.findFirst({
          where: { userId: target.targetOwnerId, nation: { missionKey: ctx.missionKey } },
          select: { nationId: true },
        });
        if (ownerNation) {
          const mine = await ensureMyNation(tx, userId, ctx.missionKey);
          if (ownerNation.nationId !== mine.id) {
            const gate = await canAttack(tx, ctx.missionKey, mine.id, ownerNation.nationId);
            if (!gate.ok) throw new BattleError("blocked", 409, "외교 관계상 공격할 수 없습니다.");
          }
        }
        const built = formationFromList(
          listCommanders(snap.ownerData, snap.ownerNickname, now),
          target.targetId,
        );
        defender = built.formation;
        const isLord = target.type === "lord";
        defenderName = isLord || !snap.ownerName ? snap.defender.name : `${snap.ownerName}의 ${snap.defender.name}`;
        if (!built.leadId) throw new BattleError("target_unavailable", 409, "상대 편성을 구성할 수 없습니다.");
        defenderSkill = { tick: 12, kind: "infantry" };
        const settled = await runAndSettle(tx, userId, data, atk, defender, skill, skillTick, seed, false, now, defenderSkill);
        if (settled.victory) {
          influence = PVP_AUTO_INFLUENCE;
          await grantInfluence(tx, userId, influence);
        }
        const defenderLead = {
          ownerId: target.targetOwnerId,
          leadId: built.leadId,
          defenderWon: !settled.victory && settled.result.winner === 1,
          kills: settled.result.events.filter((e) => e.attackerSide === 1 && e.killed).length,
        };
        return {
          victory: settled.victory,
          winner: settled.result.winner,
          progress: settled.progress,
          injuredUntil: settled.injuredUntil,
          events: settled.result.events,
          skills: settled.result.skills,
          attacker: atk.formation,
          skillTick,
          skillKind: skill,
          defender, defenderName, defenderTier, defenderSkill, siege, influence, battleId, seed, defenderLead,
          reinforced: [] as Array<{ lenderUserId: string; unitId: string }>,
        };
      }

      // castle
      const castle = await ensureCastleSeason(tx, target.castleKey, ctx.missionKey);
      if (!castle) throw new BattleError("not_found", 404, "성을 찾을 수 없습니다.");
      if (castle.meta.status !== "active") throw new BattleError("castle_pending", 409, "아직 유효하지 않은 성입니다.");
      if (castle.meta.owner === userId) throw new BattleError("own_castle", 409, "내 성은 공격할 수 없습니다.");
      const dist = distM(atk.leadPos.lat, atk.leadPos.lon, castle.lat, castle.lon);
      if (dist > BATTLE_PROXIMITY_M) throw new BattleError("too_far", 400, tooFarMessage(dist));
      const mine = await ensureMyNation(tx, userId, ctx.missionKey);
      let defenderLeadId: string | null = null;
      const reinforcedLenders: Array<{ lenderUserId: string; unitId: string }> = [];
      if (castle.meta.owner) {
        const ownerRow = await tx.missionUser.findUnique({
          where: { userId: castle.meta.owner },
          select: { data: true, nickname: true },
        });
        if (ownerRow) {
          const built = formationFromList(listCommanders(toJsonObject(ownerRow.data), ownerRow.nickname, now));
          defender = built.formation;
          defenderLeadId = built.leadId;
          const holder = await tx.territoryNationMember.findFirst({
            where: { userId: castle.meta.owner, nation: { missionKey: ctx.missionKey } },
            select: { nationId: true },
          });
          if (holder && holder.nationId !== mine.id) {
            const gate = await canAttack(tx, ctx.missionKey, mine.id, holder.nationId);
            if (!gate.ok) throw new BattleError("blocked", 409, "외교 관계상 공격할 수 없습니다.");
          }
          // 원군 합류: 성주 편성이 5기 미만이면 빈 칸을 원군으로 채운다.
          const filled = defender.filter(Boolean).length;
          if (filled < 5) {
            const reinforcements = await listReinforcements(tx, ctx.missionKey, target.castleKey);
            for (const rec of reinforcements) {
              if (defender.filter(Boolean).length >= 5) break;
              const slot = await buildLenderSlot(tx, rec.lenderUserId, rec.unitId, target.castleKey);
              if (!slot) continue;
              const idx = defender.findIndex((s) => s === null);
              if (idx < 0) break;
              defender[idx] = slot;
              reinforcedLenders.push({ lenderUserId: rec.lenderUserId, unitId: rec.unitId });
            }
          }
        } else {
          defender = neutralGarrisonFormation(castle.meta.kind);
        }
      } else {
        defender = neutralGarrisonFormation(castle.meta.kind);
      }
      defenderName = castle.name;
      defenderSkill = { tick: 12, kind: "infantry" };
      const settled = await runAndSettle(tx, userId, data, atk, defender, skill, skillTick, seed, false, now, defenderSkill);
      const gain = siegeGain(mine.isSolo, settled.victory);
      const existing = await tx.territorySiege.findUnique({
        where: { missionKey_castleKey_attackerNationId: { missionKey: ctx.missionKey, castleKey: target.castleKey, attackerNationId: mine.id } },
      });
      const gauge = Math.min(100, (existing?.gauge ?? 0) + gain);
      await tx.territorySiege.upsert({
        where: { missionKey_castleKey_attackerNationId: { missionKey: ctx.missionKey, castleKey: target.castleKey, attackerNationId: mine.id } },
        create: { missionKey: ctx.missionKey, castleKey: target.castleKey, attackerNationId: mine.id, gauge },
        update: { gauge },
      });
      let conquered = false;
      let prevOwner: string | null = null;
      if (gauge >= 100) {
        const done = await conquerCastle(tx, ctx.missionKey, castle, userId);
        conquered = done.conquered;
        prevOwner = done.prevOwner;
        await clearSiegeGauges(tx, ctx.missionKey, target.castleKey);
      }
      void defenderLeadId;
      siege = { gauge, conquered, prevOwner };
      return {
        victory: settled.victory,
        winner: settled.result.winner,
        progress: settled.progress,
        injuredUntil: settled.injuredUntil,
        events: settled.result.events,
        skills: settled.result.skills,
        attacker: atk.formation,
        skillTick,
        skillKind: skill,
        defender, defenderName, defenderTier, defenderSkill, siege, influence, battleId, seed,
        defenderLead: null as null,
        reinforced: reinforcedLenders,
      };
    });

    const defenderLead = result.defenderLead;
    const seasonId = currentSeasonId();
    try {
      await recordBattleResult(prisma, {
        missionKey: ctx.missionKey,
        seasonId,
        userId,
        won: result.victory,
        outlaw: target.type === "outlaw",
      });
    } catch (error) {
      console.error(`[auto-battle] record failed user=${userId}`, error);
    }
    if (defenderLead) {
      try {
        await withNamedLock(`autobattle:${defenderLead.ownerId}`, async (tx: Tx) => {
          await settleDefenderLead(tx, defenderLead.ownerId, defenderLead.leadId, defenderLead.defenderWon, defenderLead.kills, Date.now());
        });
        await recordBattleResult(prisma, {
          missionKey: ctx.missionKey,
          seasonId,
          userId: defenderLead.ownerId,
          won: defenderLead.defenderWon,
          outlaw: false,
        });
      } catch (error) {
        console.error(`[auto-battle] defender settle failed owner=${defenderLead.ownerId}`, error);
      }
    }
    if (result.reinforced.length > 0) {
      for (const rec of result.reinforced) {
        try {
          await withNamedLock(`autobattle:${rec.lenderUserId}`, async (tx: Tx) => {
            await settleReinforcement(tx, rec.lenderUserId, rec.unitId, Date.now());
          });
        } catch (error) {
          console.error(`[auto-battle] reinforcement settle failed lender=${rec.lenderUserId}`, error);
        }
      }
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof BattleError) {
      return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[auto-battle] start failed", error);
    return NextResponse.json({ ok: false, code: "battle_failed" }, { status: 500 });
  }
}

/** 원군 부대 → 수비 슬롯 (주둔 상태·성이 일치할 때만). */
async function buildLenderSlot(
  tx: Tx,
  lenderUserId: string,
  unitId: string,
  castleKey: string,
): Promise<{ kind: AutoUnitKind; name: string; level: number } | null> {
  const lender = await tx.missionUser.findUnique({ where: { userId: lenderUserId }, select: { data: true } });
  if (!lender) return null;
  const data = toJsonObject(lender.data);
  const unit = loadUnits(data).find((u) => u.id === unitId);
  if (!unit || unit.state !== "garrisoned" || unit.castleKey !== castleKey) return null;
  const progress = readCommanders(data)[unitId];
  const kind = toAutoBattleKind(typeof progress?.kind === "string" ? progress.kind : "infantry");
  const level = levelFromXp(typeof progress?.xp === "number" ? progress.xp : 0);
  return { kind, name: unit.name, level };
}

async function runAndSettle(
  tx: Tx,
  userId: string,
  data: ReturnType<typeof toJsonObject>,
  atk: { formation: AutoFormation; resolved: { commanderId: string; kind: AutoUnitKind; name: string; level: number }[] },
  defender: AutoFormation,
  skill: AutoUnitKind,
  skillTick: number,
  seed: number,
  vsOutlaw: boolean,
  now: number,
  defenderSkill?: { tick: number; kind: AutoUnitKind } | null,
): Promise<ReturnType<typeof settleAutoBattle> & { result: ReturnType<typeof resolveAutoBattle> }> {
  const result = resolveAutoBattle({
    seed,
    attacker: atk.formation,
    defender,
    attackerSkillTick: skillTick,
    attackerSkillKind: skill,
    defenderSkillTick: defenderSkill?.tick,
    defenderSkillKind: defenderSkill?.kind,
  });
  const settled = settleAutoBattle({ data, resolved: atk.resolved, result, vsOutlaw, now });
  await tx.missionUser.update({ where: { userId }, data: { data: settled.data } });
  return { ...settled, result };
}
