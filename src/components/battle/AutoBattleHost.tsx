"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  COMMANDER_KIND_LABEL,
  NOVICE_COMMANDER_MAX_LEVEL,
  OUTLAW_TIER_LABEL,
  OUTLAW_TIER_STARS,
  effectiveOutlawTier,
  outlawTierForId,
} from "@/lib/battle";
import type { CommandersResponse } from "@/lib/battle";
import type { AutoUnitKind } from "@/lib/auto-battle";

import { startAutoBattle, type AutoBattleStartResult } from "@/components/battle/auto-battle-api";
import { AutoBattleScene } from "@/components/battle/AutoBattleScene";
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
  onCancel: () => void;
  onStarted: (r: AutoBattleStartResult, wildId: number | null) => void;
}

const SLOT_LABEL = ["전위 1", "전위 2", "전위 3", "후위 1", "후위 2"];

/** 편성 선택 (5칸: 전위3+후위2) + 스킬 타이밍. */
function FormationPicker({ target, onCancel, onStarted }: PickerProps) {
  const wildId = target.type === "outlaw" ? target.wildId : 0;
  const isOutlaw = target.type === "outlaw";
  const [options, setOptions] = useState<PickerOption[] | null>(null);
  const [slots, setSlots] = useState<Array<string | null>>([null, null, null, null, null]);
  const [skillTick, setSkillTick] = useState(8);
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
        // 자동 편성: 선두 + 가용 5기
        const avail = list.filter((o) => o.available && (o.injuredUntil === null || o.injuredUntil <= Date.now()) && o.reason === null);
        const next: Array<string | null> = [null, null, null, null, null];
        avail.slice(0, 5).forEach((o, i) => {
          next[i] = o.id;
        });
        setSlots(next);
      })
      .catch(() => {
        if (alive) setOptions([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const byId = new Map((options ?? []).map((o) => [o.id, o]));
  const filled = slots.filter(Boolean).length;
  const lead = slots.map((id) => (id ? byId.get(id) : undefined)).find((o) => o !== undefined);

  const toggle = (id: string): void => {
    setSlots((prev) => {
      if (prev.includes(id)) return prev.map((s) => (s === id ? null : s));
      const idx = prev.findIndex((s) => s === null);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = id;
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
      skillKind: lead?.kind ?? "infantry",
    });
    if (res.ok && res.result) {
      onStarted(res.result, isOutlaw ? wildId : null);
      return;
    }
    setStarting(false);
    setError(res.message);
  };

  return (
    <div
      className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center"
      onClick={() => !starting && onCancel()}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]"
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
                60초 자동전투. 편성 5기까지, 패배해도 보상이 일부 남고 선두만 30분 부상. Lv.{NOVICE_COMMANDER_MAX_LEVEL} 이하는 한 단계 약한 상대와 붙습니다.
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-bold">
                <span className="text-red-300">{target.name}</span> 공격 — 편성
              </p>
              <p className="mt-0.5 text-sm text-amber-100/70">
                60초 자동전투. 상대는 자기 지휘관들로 맞서며, 서버가 대신 싸웁니다. 150m 안에 있어야 합니다.
              </p>
            </>
          )}
        </div>
        <div className="p-3">
          <p className="mb-1 text-sm font-bold text-amber-200">전열 (전위 3 + 후위 1~2)</p>
          <div className="mb-2 grid grid-cols-5 gap-1">
            {slots.map((id, i) => {
              const o = id ? byId.get(id) : undefined;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={starting || !o}
                  onClick={() => {
                    if (id) toggle(id);
                  }}
                  className={`flex h-16 flex-col items-center justify-center rounded-md border px-1 text-center ${o ? "border-amber-300/60 bg-amber-300/10" : "border-dashed border-white/15 text-white/30"}`}
                >
                  <span className="text-[10px] text-amber-100/60">{SLOT_LABEL[i]}</span>
                  <span className="w-full truncate text-xs font-bold">{o ? o.name : "빈 칸"}</span>
                  {o ? <span className="text-[10px] text-amber-100/70">Lv.{o.level}</span> : null}
                </button>
              );
            })}
          </div>
          <p className="mb-1 text-sm font-bold text-amber-200">출전 지휘관 ({filled}/5)</p>
          {options === null ? (
            <p className="py-3 text-center text-sm text-amber-100/70">불러오는 중…</p>
          ) : options.length === 0 ? (
            <p className="py-3 text-center text-sm text-red-300">지휘관 목록을 불러오지 못했습니다.</p>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {options.map((o) => {
                const injured = o.injuredUntil !== null && o.injuredUntil > now;
                const enabled = o.available && !injured && o.reason === null && !starting;
                const picked = slots.includes(o.id);
                const tier = isOutlaw ? effectiveOutlawTier(baseTier, o.level) : null;
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={!enabled && !picked}
                    onClick={() => toggle(o.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-sm ${picked ? "border-amber-300 bg-amber-300/15" : "border-amber-200/25 bg-black/30"} enabled:hover:border-amber-200/60 disabled:opacity-45`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-bold">{o.name}</span>
                      <span className="block text-xs text-amber-100/70">{o.detail}</span>
                    </span>
                    <span className="shrink-0 text-xs text-amber-100/80">
                      {injured && o.injuredUntil ? formatRemain(o.injuredUntil - now) : (o.reason ?? (tier !== null ? `${OUTLAW_TIER_LABEL[tier]}${tier < baseTier ? " (보정)" : ""}` : "출전 가능"))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-2 rounded-lg bg-black/30 p-2">
            <p className="text-sm text-amber-100/80">
              스킬 <span className="font-bold text-amber-200">{lead ? `${lead.name} — ${skillNameOf(lead.kind)}` : "—"}</span> · {skillTick}틱에 발동
            </p>
            <input
              type="range"
              min={0}
              max={39}
              value={skillTick}
              disabled={starting}
              onChange={(e) => setSkillTick(Number(e.target.value))}
              className="w-full"
            />
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

function skillNameOf(kind: AutoUnitKind): string {
  if (kind === "lord") return "전군 격려";
  if (kind === "infantry") return "방벽";
  if (kind === "archer") return "조준 사격";
  if (kind === "cavalry") return "돌격";
  return "마법 작렬";
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
        {result.influence > 0 ? <p className="flex justify-between text-amber-200"><span>영향력</span><span>+{result.influence}</span></p> : null}
        {result.siege ? (
          <p className="flex justify-between text-amber-200">
            <span>공성 게이지</span>
            <span>
              {result.siege.gauge}%{result.siege.conquered ? " · 점령!" : ""}
            </span>
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
          onCancel={() => {
            onOutlawRequestDone();
            onCastleRequestDone();
          }}
          onStarted={onStarted}
        />
      ) : null}
      {playing && !finished ? (
        <div className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <AutoBattleScene result={playing} onFinished={() => setFinished(playing)} />
          </div>
        </div>
      ) : null}
      {finished ? (
        <div className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
            <ResultPanel result={finished} onClose={closeAll} />
          </div>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
