"use client";

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import {
  COMMANDER_KIND_LABEL,
  OUTLAW_TIER_LABEL,
  OUTLAW_TIER_STARS,
  outlawTierForId,
} from "@/lib/battle";
import type { CommandersResponse } from "@/lib/battle";
import {
  ATTACK_RANGE_M,
  OUTLAW_AUTO_ADVICE,
  OUTLAW_AUTO_LEVEL,
  counterBonusOf,
  outlawFormation,
  unitStats,
  type AutoFormation,
  type AutoUnitKind,
} from "@/lib/auto-battle";

import { estimateWinRate } from "@/lib/auto-battle-estimate";

import { startAutoBattle, type AutoBattleStartResult } from "@/components/battle/auto-battle-api";
import { AutoBattleScene, autoSkillName, skillEffectText } from "@/components/battle/AutoBattleScene";
import { PixelArt } from "@/components/battle/PixelArt";
import type { BattleTargetRequest, OutlawBattleRequest } from "@/components/battle/BattleHost";

/** 성 공성 요청 (성 패널에서 진입). */
export interface CastleBattleTarget {
  type: "castle";
  castleKey: string;
  name: string;
}

export type AutoBattleTarget = BattleTargetRequest | CastleBattleTarget;
export interface CastleBattleRequest {
  target: CastleBattleTarget;
  nonce: number;
}

interface AutoBattleHostProps {
  enabled: boolean;
  outlawRequest: OutlawBattleRequest | null;
  onOutlawRequestDone: () => void;
  castleRequest: CastleBattleRequest | null;
  onCastleRequestDone: () => void;
  onBattleStarted: (wildId: number | null) => void;
  onBattleFinished: () => void;
}

interface PickerOption {
  id: string;
  bonusHp: number;
  bonusAtk: number;
  troopCount: number;
  name: string;
  detail: string;
  kind: AutoUnitKind;
  level: number;
  available: boolean;
  injuredUntil: number | null;
  reason: string | null;
}

const KIND_OF: Record<string, AutoUnitKind> = {
  lord: "lord",
  infantry: "infantry",
  archer: "archer",
  cavalry: "cavalry",
  mage: "mage",
};

function formatRemain(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  return `부상 ${min}분 남음`;
}

async function loadOptions(): Promise<PickerOption[]> {
  const res = await fetch("/api/battle/commanders", { credentials: "include", cache: "no-store" });
  const body: unknown = await res.json();
  if (!res.ok || typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
    throw new Error("commanders_failed");
  }
  const payload = body as CommandersResponse;
  const skew = Date.now() - payload.serverNow;
  return payload.commanders.map((c) => ({
    id: c.id,
    bonusHp: c.bonusHp ?? 0,
    bonusAtk: c.bonusAtk ?? 0,
    troopCount: c.troopCount ?? 0,
    name: c.id === "lord" ? `영주 ${c.name}` : c.name,
    detail: `${COMMANDER_KIND_LABEL[c.kind]} · Lv.${c.level}`,
    kind: KIND_OF[c.kind] ?? "infantry",
    level: c.level,
    available: c.available,
    injuredUntil: c.injuredUntil === null ? null : c.injuredUntil + skew,
    reason: c.state === "field" ? null : "출전 불가",
  }));
}

interface PickerProps {
  target: AutoBattleTarget;
  /** 선두로 세울 지휘관 (가능할 때만) */
  leadId?: string;
  onCancel: () => void;
  onStarted: (r: AutoBattleStartResult, wildId: number | null) => void;
}

const SLOT_LABEL = ["전위 1", "전위 2", "전위 3", "후위 1", "후위 2"];
const RANGED: ReadonlySet<AutoUnitKind> = new Set<AutoUnitKind>(["archer", "mage"]);
const KIND_SHORT: Record<AutoUnitKind, string> = {
  lord: "영주",
  infantry: "보병",
  archer: "궁병",
  cavalry: "기병",
  mage: "마법",
};
/** 모의전 횟수 (예상 승률) */
const SIM_RUNS = 120;

/** 이 병종이 우위인 상대 / 열세인 상대 수 */
function matchup(kind: AutoUnitKind, enemies: AutoUnitKind[]): { good: number; bad: number } {
  let good = 0;
  let bad = 0;
  for (const e of enemies) {
    if (counterBonusOf(kind, e)) good++;
    if (counterBonusOf(e, kind)) bad++;
  }
  return { good, bad };
}

/** 추천 배치: 선두(전위 1)는 그대로 두고, 근접은 전위·원거리는 후위로, 레벨 높은 순. */
function recommendSlots(current: Array<string | null>, avail: PickerOption[]): Array<string | null> {
  const leadId = current.find((id) => id !== null) ?? avail[0]?.id ?? null;
  const others = avail.filter((o) => o.id !== leadId).sort((a, b) => b.level - a.level);
  const melee = others.filter((o) => !RANGED.has(o.kind));
  const ranged = others.filter((o) => RANGED.has(o.kind));
  const next: Array<string | null> = [leadId, null, null, null, null];
  const front = [1, 2];
  const back = [3, 4];
  for (const idx of back) {
    const o = ranged.shift();
    if (o) next[idx] = o.id;
  }
  for (const idx of front) {
    const o = melee.shift() ?? ranged.shift();
    if (o) next[idx] = o.id;
  }
  for (const idx of back) {
    if (next[idx] === null) {
      const o = melee.shift();
      if (o) next[idx] = o.id;
    }
  }
  return next;
}

/** 편성 선택: 전위3+후위2 배치(누르면 선택·교체), 상성 미리보기, 스킬 종류·시점. */
function FormationPicker({ target, leadId, onCancel, onStarted }: PickerProps) {
  const wildId = target.type === "outlaw" ? target.wildId : 0;
  const isOutlaw = target.type === "outlaw";
  const [options, setOptions] = useState<PickerOption[] | null>(null);
  const [slots, setSlots] = useState<Array<string | null>>([null, null, null, null, null]);
  const [selected, setSelected] = useState<number | null>(null);
  const [skillTick, setSkillTick] = useState(2);
  const [skillPick, setSkillPick] = useState<AutoUnitKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const baseTier = outlawTierForId(wildId);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    void loadOptions()
      .then((list) => {
        if (!alive) return;
        setOptions(list);
        const avail = list.filter((o) => o.available && (o.injuredUntil === null || o.injuredUntil <= Date.now()) && o.reason === null);
        const preferred = leadId && avail.some((o) => o.id === leadId) ? leadId : (avail[0]?.id ?? null);
        setSlots(recommendSlots([preferred], avail));
      })
      .catch(() => {
        if (alive) setOptions([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const byId = new Map((options ?? []).map((o) => [o.id, o]));
  const usable = (o: PickerOption): boolean =>
    o.available && !(o.injuredUntil !== null && o.injuredUntil > now) && o.reason === null;
  const filled = slots.filter(Boolean).length;
  const leadSlot = slots.findIndex((id) => id !== null);
  const lead = leadSlot >= 0 ? byId.get(slots[leadSlot] as string) : undefined;
  const pickedKinds = [...new Set(slots.map((id) => (id ? byId.get(id)?.kind : undefined)).filter((k): k is AutoUnitKind => !!k))];
  const skillKind: AutoUnitKind | null =
    skillPick && pickedKinds.includes(skillPick) ? skillPick : (lead?.kind ?? null);

  // 상대 편성: 무법자는 서버와 같은 함수로 미리 본다.
  const tier = isOutlaw ? baseTier : null;
  const enemy: AutoFormation | null = tier !== null ? outlawFormation(tier, OUTLAW_TIER_LABEL[tier]) : null;
  const enemyKinds = enemy ? enemy.filter((s): s is NonNullable<typeof s> => s !== null).map((s) => s.kind) : [];

  const formation: AutoFormation = slots.map((id) => {
    const o = id ? byId.get(id) : undefined;
    return o ? { kind: o.kind, name: o.name, level: o.level, bonusHp: o.bonusHp, bonusAtk: o.bonusAtk } : null;
  });
  const formationKey = formation.map((f) => (f ? `${f.kind}${f.level}+${f.bonusHp ?? 0}/${f.bonusAtk ?? 0}` : "-")).join(",");
  const winRate = useMemo(() => {
    if (!enemy || filled === 0 || !skillKind) return null;
    return estimateWinRate(formation, enemy, { runs: SIM_RUNS, skillKind, skillTick });
    // formationKey가 편성 내용을 대신한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formationKey, tier, skillKind, skillTick, filled]);

  /** 칸 누르기: 선택 → 다른 칸 누르면 자리 바꿈 */
  const tapSlot = (idx: number): void => {
    if (starting) return;
    if (selected === null) {
      setSelected(idx);
      return;
    }
    if (selected !== idx) {
      setSlots((prev) => {
        const next = [...prev];
        const a = next[selected] ?? null;
        next[selected] = next[idx] ?? null;
        next[idx] = a;
        return next;
      });
    }
    setSelected(null);
  };

  const clearSlot = (idx: number): void => {
    setSlots((prev) => prev.map((s, i) => (i === idx ? null : s)));
    setSelected(null);
  };

  /** 목록에서 누르기: 선택한 칸이 있으면 그 칸에, 없으면 병종에 맞는 빈 칸에. 이미 있으면 뺀다. */
  const tapOption = (o: PickerOption): void => {
    if (starting) return;
    const at = slots.indexOf(o.id);
    if (selected !== null) {
      setSlots((prev) => {
        const next = [...prev];
        const from = next.indexOf(o.id);
        if (from >= 0) next[from] = next[selected] ?? null;
        next[selected] = o.id;
        return next;
      });
      setSelected(null);
      return;
    }
    if (at >= 0) {
      clearSlot(at);
      return;
    }
    setSlots((prev) => {
      const order = RANGED.has(o.kind) ? [3, 4, 0, 1, 2] : [0, 1, 2, 3, 4];
      const idx = order.find((i) => prev[i] === null);
      if (idx === undefined) return prev;
      const next = [...prev];
      next[idx] = o.id;
      return next;
    });
  };

  const start = async (): Promise<void> => {
    if (starting || filled === 0) return;
    setStarting(true);
    setError(null);
    const tgt =
      target.type === "outlaw"
        ? { type: "outlaw" as const, wildId: target.wildId }
        : target.type === "castle"
          ? { type: "castle" as const, castleKey: target.castleKey }
          : target.type === "lord"
            ? { type: "lord" as const, targetId: "lord", targetOwnerId: target.ownerId }
            : { type: "unit" as const, targetId: target.targetId, targetOwnerId: target.ownerId };
    const res = await startAutoBattle({
      slots,
      target: tgt,
      skillTick,
      skillKind: skillKind ?? lead?.kind ?? "infantry",
    });
    if (res.ok && res.result) {
      onStarted(res.result, isOutlaw ? wildId : null);
      return;
    }
    setStarting(false);
    setError(res.message);
  };

  const renderSlot = (idx: number): ReactElement => {
    const id = slots[idx];
    const o = id ? byId.get(id) : undefined;
    const isSel = selected === idx;
    const stats = o ? unitStats({ kind: o.kind, name: o.name, level: o.level, bonusHp: o.bonusHp, bonusAtk: o.bonusAtk }) : null;
    const mu = o && enemy ? matchup(o.kind, enemyKinds) : null;
    return (
      <button
        key={idx}
        type="button"
        disabled={starting}
        onClick={() => tapSlot(idx)}
        className={`relative flex w-[31%] max-w-[104px] flex-col items-center rounded-lg border-2 px-1 pb-1 pt-1.5 text-center transition ${
          isSel
            ? "border-amber-300 bg-amber-300/25 shadow-[0_0_12px_rgba(252,211,77,0.6)]"
            : o
              ? idx < 3
                ? "border-sky-300/40 bg-sky-400/10"
                : "border-emerald-300/40 bg-emerald-400/10"
              : "border-dashed border-white/20 bg-black/20"
        }`}
      >
        <span className="text-[9px] font-bold text-amber-100/60">{SLOT_LABEL[idx]}</span>
        {o ? (
          <>
            {idx === leadSlot ? (
              <span className="absolute -right-1 -top-2 rounded bg-amber-300 px-1 text-[9px] font-black text-black">선두</span>
            ) : null}
            <PixelArt name={`cmd-${o.kind}`} scale={1} className="my-0.5" />
            <span className="w-full truncate text-[11px] font-bold leading-tight">{o.name}</span>
            <span className="text-[9px] leading-tight text-amber-100/70">
              {KIND_SHORT[o.kind]} Lv.{o.level}
            </span>
            {stats ? (
              <span className="text-[9px] tabular-nums leading-tight text-amber-100/60">
                체 {stats.maxHp} · 공 {stats.atk}
              </span>
            ) : null}
            {mu ? (
              <span className="mt-0.5 flex gap-0.5 text-[9px] font-black leading-tight">
                {mu.good > 0 ? <span className="rounded bg-emerald-500/30 px-1 text-emerald-200">유리 {mu.good}</span> : null}
                {mu.bad > 0 ? <span className="rounded bg-red-500/30 px-1 text-red-200">불리 {mu.bad}</span> : null}
                {mu.good === 0 && mu.bad === 0 ? <span className="rounded bg-white/10 px-1 text-amber-100/60">보통</span> : null}
              </span>
            ) : null}
          </>
        ) : (
          <span className="flex h-[58px] items-center text-xs text-white/35">{isSel ? "여기에 배치" : "빈 칸"}</span>
        )}
      </button>
    );
  };

  const selectedHasUnit = selected !== null && slots[selected] !== null;

  return (
    <div
      className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center"
      onClick={() => !starting && onCancel()}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-amber-200/25 bg-amber-300/10 px-4 py-2.5">
          {target.type === "castle" ? (
            <>
              <p className="text-lg font-bold">
                <span className="text-red-300">{target.name}</span> 공성 — 편성
              </p>
              <p className="mt-0.5 text-sm text-amber-100/70">
                60초 자동전투. 이기면 공성 게이지가 오르고 100%가 되면 점령합니다. 져도 게이지는 조금 오릅니다.
              </p>
            </>
          ) : target.type === "outlaw" ? (
            <>
              <p className="text-lg font-bold">
                {OUTLAW_TIER_LABEL[baseTier]} <span className="text-amber-300">{OUTLAW_TIER_STARS[baseTier]}</span> 토벌 — 편성
              </p>
              <p className="mt-0.5 text-sm text-amber-100/70">
                Lv.{OUTLAW_AUTO_LEVEL[baseTier]} · 권장 {OUTLAW_AUTO_ADVICE[baseTier]}. 패배해도 보상이 일부 남고 선두만 30분 부상.
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-bold">
                <span className="text-red-300">{target.name}</span> 공격 — 편성
              </p>
              <p className="mt-0.5 text-sm text-amber-100/70">
                60초 자동전투. 상대는 자기 지휘관들로 맞서며, 서버가 대신 싸웁니다. 선두가 {ATTACK_RANGE_M}m 안에 있어야 합니다.
              </p>
            </>
          )}
        </div>
        <div className="p-3">
          {/* 상대 편성 미리보기 */}
          <div className="mb-2 rounded-lg border border-red-300/25 bg-red-950/30 p-2">
            <p className="mb-1 flex items-center justify-between text-xs font-bold text-red-200">
              <span>상대 편성{tier !== null ? ` — ${OUTLAW_TIER_LABEL[tier]} Lv.${OUTLAW_AUTO_LEVEL[tier]}` : ""}</span>
              {winRate !== null ? (
                <span className={winRate >= 70 ? "text-emerald-300" : winRate >= 40 ? "text-amber-300" : "text-red-300"}>
                  예상 승률 {winRate}%
                </span>
              ) : null}
            </p>
            {enemy ? (
              <div className="flex flex-wrap justify-center gap-1">
                {enemy.map((e, i) =>
                  e ? (
                    <div key={i} className="flex w-[18%] min-w-[56px] flex-col items-center rounded bg-black/30 px-0.5 py-0.5">
                      <span aria-hidden="true" className="outlaw-animal-sprite inline-block size-8" data-outlaw-tier={tier} />
                      <span className="text-[9px] font-bold leading-tight">
                        {KIND_SHORT[e.kind]} Lv.{e.level}
                      </span>
                      <span className="text-[8px] leading-tight text-amber-100/50">{i < 3 ? "전위" : "후위"}</span>
                    </div>
                  ) : null,
                )}
              </div>
            ) : (
              <p className="py-1 text-center text-xs text-amber-100/60">상대 편성은 전투가 시작되면 공개됩니다.</p>
            )}
            {winRate !== null ? <p className="mt-1 text-center text-[10px] text-amber-100/45">모의전 {SIM_RUNS}회 기준 · 실제 결과는 매번 다릅니다</p> : null}
          </div>

          {/* 상성 안내 */}
          <p className="mb-2 rounded-md bg-black/30 px-2 py-1 text-center text-[11px] text-amber-100/80">
            상성 <b className="text-sky-200">보병</b> ▶ <b className="text-emerald-200">궁병</b> ▶ <b className="text-orange-200">기병</b> ▶{" "}
            <b className="text-violet-200">마법</b> ▶ <b className="text-sky-200">보병</b> · 우위면 피해 +30% · 영주는 중립
          </p>

          {/* 배치판 */}
          <div className="mb-1 rounded-xl border border-amber-200/20 bg-[linear-gradient(180deg,#55663a_0%,#3d4a2c_100%)] p-2">
            <p className="mb-1 text-center text-[10px] font-bold text-sky-100/80">▲ 적 방향 · 전위 — 적이 먼저 노립니다</p>
            <div className="flex justify-center gap-1.5">{[0, 1, 2].map(renderSlot)}</div>
            <p className="mb-1 mt-2 text-center text-[10px] font-bold text-emerald-100/80">후위 — 전위가 모두 쓰러져야 공격받습니다</p>
            <div className="flex justify-center gap-1.5">{[3, 4].map(renderSlot)}</div>
          </div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-amber-100/60">
              {selected === null ? "칸을 누르고 다른 칸을 누르면 자리를 바꿉니다." : "바꿀 칸이나 아래 지휘관을 누르세요."}
            </p>
            <span className="flex shrink-0 gap-1">
              {selectedHasUnit && selected !== null ? (
                <button
                  type="button"
                  onClick={() => clearSlot(selected)}
                  className="rounded bg-red-500/25 px-2 py-0.5 text-xs font-bold text-red-100"
                >
                  빼기
                </button>
              ) : null}
              <button
                type="button"
                disabled={starting || !options}
                onClick={() => {
                  setSelected(null);
                  setSlots((prev) => recommendSlots(prev, (options ?? []).filter(usable)));
                }}
                className="rounded bg-amber-300/20 px-2 py-0.5 text-xs font-bold text-amber-100"
              >
                추천 배치
              </button>
            </span>
          </div>

          <p className="mb-1 text-sm font-bold text-amber-200">출전 지휘관 ({filled}/5)</p>
          {options === null ? (
            <p className="py-3 text-center text-sm text-amber-100/70">불러오는 중…</p>
          ) : options.length === 0 ? (
            <p className="py-3 text-center text-sm text-red-300">지휘관 목록을 불러오지 못했습니다.</p>
          ) : (
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {options.map((o) => {
                const injured = o.injuredUntil !== null && o.injuredUntil > now;
                const at = slots.indexOf(o.id);
                const picked = at >= 0;
                const enabled = usable(o) && !starting;
                const mu = enemy ? matchup(o.kind, enemyKinds) : null;
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={!enabled && !picked}
                    onClick={() => tapOption(o)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-sm ${picked ? "border-amber-300 bg-amber-300/15" : "border-amber-200/25 bg-black/30"} enabled:hover:border-amber-200/60 disabled:opacity-45`}
                  >
                    <PixelArt name={`cmd-${o.kind}`} scale={1} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{o.name}</span>
                      <span className="block text-xs text-amber-100/70">
                        {o.detail}
                        {o.troopCount > 0 ? <span className="ml-1 text-sky-200">병력 {o.troopCount}</span> : null}
                        {mu && mu.good > 0 ? <span className="ml-1 text-emerald-300">유리 {mu.good}</span> : null}
                        {mu && mu.bad > 0 ? <span className="ml-1 text-red-300">불리 {mu.bad}</span> : null}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-amber-100/80">
                      {picked
                        ? SLOT_LABEL[at]
                        : injured && o.injuredUntil
                          ? formatRemain(o.injuredUntil - now)
                          : (o.reason ?? "대기")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 스킬 */}
          <div className="mt-2 rounded-lg bg-black/30 p-2">
            <p className="mb-1 text-sm font-bold text-amber-200">지휘관 스킬 (1회)</p>
            {pickedKinds.length > 0 ? (
              <div className="mb-1 flex flex-wrap gap-1">
                {pickedKinds.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={starting}
                    onClick={() => setSkillPick(k)}
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${skillKind === k ? "bg-amber-300 text-black" : "bg-white/10 text-amber-100"}`}
                  >
                    {autoSkillName(k)}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="text-xs text-amber-100/75">
              {skillKind ? `${skillEffectText(skillKind)} · ` : ""}
              <b className="text-amber-200">{skillTick + 1}턴째</b> 발동
            </p>
            <input
              type="range"
              min={0}
              max={14}
              value={Math.min(skillTick, 14)}
              disabled={starting}
              onChange={(e) => setSkillTick(Number(e.target.value))}
              className="w-full"
              aria-label="스킬 발동 턴"
            />
            <p className="text-[10px] text-amber-100/45">강화는 일찍, 회복은 피해를 입은 뒤가 좋습니다. 전투는 보통 4~10턴 안에 끝납니다.</p>
          </div>
          {error ? <p className="mt-1 text-center text-sm font-semibold text-red-300">{error}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              disabled={starting}
              onClick={onCancel}
              className="rounded-lg border border-slate-600/60 bg-slate-800/80 px-5 py-2 text-base font-semibold text-slate-200"
            >
              취소
            </button>
            <button
              type="button"
              disabled={starting || filled === 0}
              onClick={() => void start()}
              className="rounded-lg bg-amber-300 px-5 py-2 text-base font-bold text-black disabled:opacity-45"
            >
              {starting ? "출전 중…" : `전투 시작 (${filled}기)`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ result, onClose }: { result: AutoBattleStartResult; onClose: () => void }) {
  const lead = result.progress[0];
  return (
    <div className="p-4">
      <p className={`text-center text-2xl font-bold ${result.victory ? "text-amber-300" : result.winner === "draw" ? "text-slate-200" : "text-red-300"}`}>
        {result.victory ? "승리!" : result.winner === "draw" ? "무승부" : "패배…"}
      </p>
      <p className="mt-1 text-center text-sm text-amber-100/70">vs {result.defenderName}</p>
      {result.reinforced.length > 0 ? (
        <p className="mt-0.5 text-center text-xs font-bold text-sky-300">
          원군 {result.reinforced.length}기 참전
        </p>
      ) : null}
      <div className="mt-3 space-y-1 rounded-lg bg-black/30 p-2 text-sm">
        {result.progress.map((p) => (
          <p key={p.id} className="flex justify-between text-amber-50">
            <span>
              {p.id === lead?.id ? "선두" : "참전"} · Lv.{p.levelBefore} → Lv.{p.levelAfter}
              {p.levelAfter > p.levelBefore ? " ⬆" : ""}
            </span>
            <span>+{p.xpAfter - p.xpBefore} XP · {p.wins}승</span>
          </p>
        ))}
        {result.influence > 0 ? <p className="flex justify-between text-amber-200"><span>금</span><span>+{result.influence}</span></p> : null}
        {result.siege ? (
          <p className="flex justify-between text-amber-200">
            <span>공성 게이지</span>
            <span>
              {result.siege.gauge}%{result.siege.conquered ? " · 점령!" : ""}
            </span>
          </p>
        ) : null}
        {result.troopsLost ? (
          <p className="flex justify-between text-red-200">
            <span>잃은 병력</span>
            <span>-{result.troopsLost}명</span>
          </p>
        ) : null}
        {result.injuredUntil ? <p className="text-center text-sm font-semibold text-red-300">선두 부상 30분</p> : null}
      </div>
      <button type="button" onClick={onClose} className="mt-3 w-full rounded-lg bg-amber-300 px-4 py-2 text-base font-bold text-black">
        확인
      </button>
    </div>
  );
}

/** 지도 전투 진입점: 편성 → 자동전투 재생 → 결과. 카드 전투(BattleHost)와 같은 props + 성 공성. */
export function AutoBattleHost({ enabled, outlawRequest, onOutlawRequestDone, castleRequest, onCastleRequestDone, onBattleStarted, onBattleFinished }: AutoBattleHostProps) {
  const [playing, setPlaying] = useState<AutoBattleStartResult | null>(null);
  const [finished, setFinished] = useState<AutoBattleStartResult | null>(null);
  const active = !playing && !finished ? (outlawRequest ?? castleRequest) : null;
  const target = active?.target ?? null;

  const onStarted = useCallback(
    (r: AutoBattleStartResult, wildId: number | null) => {
      onOutlawRequestDone();
      onCastleRequestDone();
      onBattleStarted(wildId);
      setPlaying(r);
    },
    [onOutlawRequestDone, onCastleRequestDone, onBattleStarted],
  );

  const closeAll = useCallback(() => {
    setPlaying(null);
    setFinished(null);
    onBattleFinished();
  }, [onBattleFinished]);

  if (!enabled || typeof document === "undefined") return null;

  return createPortal(
    <>
      {target && !playing && !finished ? (
        <FormationPicker
          key={active?.nonce ?? JSON.stringify(target)}
          target={target}
          leadId={outlawRequest?.leadId}
          onCancel={() => {
            onOutlawRequestDone();
            onCastleRequestDone();
          }}
          onStarted={onStarted}
        />
      ) : null}
      {playing && !finished ? (
        <div className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center">
          <div className="joseon-war-panel w-full max-w-md overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <AutoBattleScene result={playing} onFinished={() => setFinished(playing)} />
          </div>
        </div>
      ) : null}
      {finished ? (
        <div className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center">
          <div className="joseon-war-panel w-full max-w-md overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <ResultPanel result={finished} onClose={closeAll} />
          </div>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
