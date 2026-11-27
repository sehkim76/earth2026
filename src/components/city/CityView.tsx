"use client";

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";

import {
  BUILDINGS,
  BUILDING_BY_KEY,
  CITY_SIEGE_DURATION_MS,
  FORGE_ATK_PCT,
  KEEP_HP_PCT,
  TROOP_BUILDING_PCT,
  MAX_BUILDING_LEVEL,
  MAX_TECH_LEVEL,
  RESOURCE_KINDS,
  RESOURCE_LABEL,
  TECHS,
  TECH_BY_KEY,
  TROOP_COST,
  TROOP_KINDS,
  TROOP_LABEL,
  commanderTroopCap,
  emptyTroops,
  gatherLoad,
  gatherParties,
  gatherPhase,
  multiplyCost,
  productionPerHour,
  researchCost,
  researchMs,
  storageCap,
  trainBatchMax,
  troopBonus,
  troopTotal,
  troopTrainMs,
  upgradeCost,
  upgradeMs,
  wallDefense,
  type BuildingKey,
  type Cost,
  type ResourceKind,
  type TechKey,
  type TroopCounts,
  type TroopKind,
} from "@/lib/city";

import { BuildingIcon, ResourceIcon } from "@/components/city/CityIcons";
import { cityAction, fetchCity, fmtNum, fmtRemain, type CityViewData } from "@/components/city/city-client";
import type { CitySceneLot } from "@/components/city/CityScene3D";

// three.js는 성 화면을 열 때만 불러온다
const CityScene3D = dynamic(() => import("@/components/city/CityScene3D"), {
  ssr: false,
  loading: () => <p className="absolute inset-0 grid place-items-center text-sm font-bold text-[#f3e8ce]">성 안 풍경을 그리는 중…</p>,
});

type Tab = "buildings" | "research" | "troops" | "workers";

interface CityViewProps {
  open: boolean;
  onClose: () => void;
}

/** 서버 시각 기준 현재 */
const serverNow = (v: CityViewData | null): number => Date.now() - (v?.skew ?? 0);

/** 성 안 화면: 자원 막대, 건물 마당, 건설·연구·훈련·병력 배치·일꾼 */
export function CityView({ open, onClose }: CityViewProps) {
  const [view, setView] = useState<CityViewData | null>(null);
  const [tab, setTab] = useState<Tab>("buildings");
  const [selected, setSelected] = useState<BuildingKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const show = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2600);
  }, []);

  const reload = useCallback(async () => {
    const r = await fetchCity();
    if (r.ok) {
      setView(r.view);
      if (r.view.events.length > 0) show(r.view.events.join(" · "));
    } else {
      show(r.message);
    }
  }, [show]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(id);
  }, [open, reload]);

  // 1초마다 진행률, 끝난 작업이 있으면 다시 불러온다
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if (!view) return;
      const now = serverNow(view);
      const s = view.state;
      const ends = [
        s.build?.endsAt,
        s.research?.endsAt,
        ...TROOP_KINDS.map((k) => s.training[k]?.endsAt),
        ...s.gathers.map((g) => g.returnAt),
      ].filter((x): x is number => typeof x === "number");
      if (ends.some((t) => t <= now && t > now - 1500)) void reload();
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, view, reload]);

  useEffect(() => {
    if (!open || tab !== "buildings" || busy) return;
    let pending = false;
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const r = await fetchCity();
        if (r.ok && !cancelled) setView((current) => !current || r.view.now >= current.now ? r.view : current);
      } finally {
        pending = false;
      }
    }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, tab, busy]);

  const act = async (body: Parameters<typeof cityAction>[0]): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    const r = await cityAction(body);
    setBusy(false);
    if (r.ok) {
      setView(r.view);
      if (r.view.events.length > 0) show(r.view.events.join(" · "));
      return true;
    }
    show(r.message);
    return false;
  };

  if (!open || typeof document === "undefined") return null;

  const now = serverNow(view);
  const s = view?.state ?? null;
  const siege = s?.siege;
  const activeSiege = siege && !siege.conquered && siege.castleKey === view?.home?.castleKey &&
    now - siege.at < CITY_SIEGE_DURATION_MS ? siege : null;
  const goldNow = view?.gold ?? 0;
  const cap = s ? storageCap(s.buildings.storehouse) : 0;
  const rates = s ? productionPerHour(s) : null;
  // 화면에서는 마지막 정산 뒤 생산분을 더해 보여 준다
  const liveRes = (k: ResourceKind): number => {
    if (!s || !rates) return 0;
    const h = Math.max(0, now - s.settledAt) / 3600_000;
    if (k === "gold") return goldNow + Math.floor(s.goldAcc + rates.gold * h);
    return Math.min(Math.max(cap, s.res[k]), s.res[k] + (s.res[k] < cap ? rates[k] * h : 0));
  };
  const affordable = (cost: Cost): boolean => RESOURCE_KINDS.every((k) => (cost[k] ?? 0) <= liveRes(k) + 1e-6);

  const costLine = (cost: Cost): ReactElement => (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {RESOURCE_KINDS.filter((k) => (cost[k] ?? 0) > 0).map((k) => (
        <span key={k} className={`inline-flex items-center gap-0.5 font-bold tabular-nums ${(cost[k] ?? 0) > liveRes(k) ? "text-red-600" : "text-slate-700"}`}>
          <ResourceIcon kind={k} size={13} />
          {fmtNum(cost[k] ?? 0)}
        </span>
      ))}
    </span>
  );

  const progress = (start: number, end: number): number => Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));

  const sceneLots: CitySceneLot[] = s
    ? BUILDINGS.map((b) => {
        const build = s.build?.key === b.key ? s.build : null;
        const train = b.trains ? s.training[b.trains] : undefined;
        const job = build ?? train ?? null;
        return {
          key: b.key,
          name: b.name,
          level: s.buildings[b.key],
          building: !!build,
          training: !build && !!train,
          progress: job ? progress(job.startedAt, job.endsAt) : 0,
          remain: job ? fmtRemain(job.endsAt - now) : null,
        };
      })
    : [];

  return createPortal(
    <div className="fixed inset-0 z-[3800] flex flex-col bg-[#1b1510] text-[#2b2118]" role="dialog" aria-label="영주성">
      {/* 머리: 성 이름 + 자원 */}
      <header className="shrink-0 border-b-2 border-[#8e7954] bg-[linear-gradient(180deg,#3a2c1f,#271d14)] px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-[#f3e8ce]">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-lg font-black">{view?.home?.name ?? "영주성"}</p>
            <p className="text-[11px] text-[#c8bea8]">본관 Lv.{s?.buildings.keep ?? 1} · 창고 한도 {fmtNum(cap)}</p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-xl border border-[#c8bea8]/50 bg-[#4a3a28] px-4 py-1.5 text-sm font-black">
            지도로
          </button>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1">
          {RESOURCE_KINDS.map((k) => (
            <div key={k} className="rounded-lg bg-black/35 px-1.5 py-1">
              <p className="flex items-center gap-1 text-[10px] font-bold text-[#c8bea8]">
                <ResourceIcon kind={k} size={12} />
                {RESOURCE_LABEL[k]}
              </p>
              <p className="text-sm font-black tabular-nums text-[#f0d99d]">{fmtNum(liveRes(k))}</p>
              <p className="text-[9px] tabular-nums text-[#9fbf8f]">+{fmtNum(rates?.[k] ?? 0)}/시간</p>
            </div>
          ))}
        </div>
      </header>

      {/* 탭 */}
      <nav className="flex shrink-0 gap-1 bg-[#271d14] px-2 py-1.5">
        {(
          [
            ["buildings", "건물"],
            ["research", "연구"],
            ["troops", "병력"],
            ["workers", "일꾼"],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setSelected(null);
            }}
            className={`flex-1 rounded-lg py-1.5 text-sm font-black ${tab === t ? "bg-[#f0d99d] text-[#2b2118]" : "bg-[#3a2c1f] text-[#e8dcc0]"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main
        className={
          tab === "buildings" && view && s
            ? "relative min-h-0 flex-1 overflow-hidden bg-[#86b553]"
            : "min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_50%_30%,#6d7a4a_0%,#4a5634_60%,#323b24_100%)] p-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
        }
      >
        {!view || !s ? (
          <p className="py-10 text-center text-sm font-bold text-[#f3e8ce]">성 안을 불러오는 중…</p>
        ) : tab === "buildings" ? (
          <>
            <CityScene3D
              lots={sceneLots}
              siege={{ active: !!activeSiege, wallLevel: s.buildings.wall }}
              selected={selected}
              onSelect={setSelected}
            />
            <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-col items-center gap-1">
              {activeSiege ? (
                <div className="w-full max-w-sm rounded-xl border border-orange-400/65 bg-red-950/90 px-3 py-2 text-orange-50">
                  <p className="text-xs font-black">
                    {activeSiege.by}님의 공성 공격 · {now - activeSiege.at < 60_000 ? "방금 전" : `${Math.floor((now - activeSiege.at) / 60_000)}분 전`}
                  </p>
                  {activeSiege.defended !== null ? (
                    <p className="mt-0.5 text-[11px]">
                      {activeSiege.defended ? "수비대가 공격을 막아냈습니다." : "공격군이 이번 전투에서 승리했습니다."}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {s.build ? (
                <div className="w-full max-w-sm rounded-xl bg-black/60 px-3 py-1.5 text-[#f3e8ce] backdrop-blur-sm">
                  <p className="text-xs font-black">
                    공사 중: {BUILDING_BY_KEY[s.build.key].name} → Lv.{s.build.toLevel} · {fmtRemain(s.build.endsAt - now)}
                  </p>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-black/50">
                    <div className="h-full bg-[linear-gradient(90deg,#c9852a,#f0d99d)]" style={{ width: `${progress(s.build.startedAt, s.build.endsAt)}%` }} />
                  </div>
                </div>
              ) : (
                <p className="rounded-full bg-black/50 px-3 py-1 text-center text-[11px] font-bold text-[#f3e8ce] backdrop-blur-sm">
                  끌어서 둘러보기 · 두 손가락으로 확대 · 건물을 눌러 짓기/올리기
                </p>
              )}
            </div>
            {selected ? (
              <BuildingSheet
                k={selected}
                view={view}
                now={now}
                busy={busy}
                affordable={affordable}
                costLine={costLine}
                progress={progress}
                onClose={() => setSelected(null)}
                onUpgrade={() => void act({ type: "upgrade", building: selected })}
                onTrain={(troop, count) => void act({ type: "train", troop, count })}
                onResearch={() => {
                  setTab("research");
                  setSelected(null);
                }}
              />
            ) : null}
          </>
        ) : tab === "research" ? (
          <div className="flex flex-col gap-1.5">
            <p className="rounded-xl bg-black/35 px-3 py-1.5 text-center text-xs font-bold text-[#f3e8ce]">
              학당 Lv.{s.buildings.academy}: 기술은 학당 레벨까지 올릴 수 있습니다. 한 번에 하나씩 연구합니다.
            </p>
            {s.research ? (
              <div className="rounded-xl bg-black/45 px-3 py-2 text-[#f3e8ce]">
                <p className="text-xs font-black">
                  연구 중: {TECH_BY_KEY[s.research.key].name} → Lv.{s.research.toLevel} · {fmtRemain(s.research.endsAt - now)}
                </p>
                <div className="mt-1 h-2 overflow-hidden rounded bg-black/50">
                  <div className="h-full bg-[linear-gradient(90deg,#4f6d8f,#9fc3e8)]" style={{ width: `${progress(s.research.startedAt, s.research.endsAt)}%` }} />
                </div>
              </div>
            ) : null}
            {TECHS.map((t) => {
              const lv = s.tech[t.key];
              const maxed = lv >= MAX_TECH_LEVEL;
              const cost = researchCost(t.key, lv);
              const blocked = lv + 1 > s.buildings.academy;
              return (
                <div key={t.key} className="rounded-xl border-2 border-[#5d513e] bg-[#e8dcc0] px-3 py-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-black">
                      {t.name} <span className="text-xs text-[#7a5a1e]">Lv.{lv}/{MAX_TECH_LEVEL}</span>
                    </p>
                    <p className="text-xs font-bold text-[#354b3c]">
                      {t.desc} +{lv * t.perLevel}%{maxed ? "" : ` → +${(lv + 1) * t.perLevel}%`}
                    </p>
                  </div>
                  {maxed ? (
                    <p className="mt-1 text-xs font-bold text-slate-500">최고 레벨</p>
                  ) : (
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <div className="text-xs">
                        {costLine(cost)}
                        <span className="text-[11px] text-slate-500">{fmtRemain(researchMs(t.key, lv))}</span>
                      </div>
                      <button
                        type="button"
                        disabled={busy || !!s.research || blocked || !affordable(cost)}
                        onClick={() => void act({ type: "research", tech: t.key as TechKey })}
                        className="shrink-0 rounded-lg bg-[#263b31] px-3 py-1.5 text-xs font-black text-[#fff4d8] disabled:opacity-40"
                      >
                        {blocked ? `학당 Lv.${lv + 1} 필요` : "연구"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : tab === "troops" ? (
          <TroopsTab view={view} busy={busy} onAssign={(id, troops) => void act({ type: "assign", commanderId: id, troops })} />
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="rounded-xl bg-black/35 px-3 py-1.5 text-center text-xs font-bold text-[#f3e8ce]">
              일꾼 부대 {s.gathers.length}/{gatherParties(s.buildings.camp)} · 1회 운반 {fmtNum(gatherLoad(s.buildings.camp))}
              <br />
              지도에서 자원지(금·석재·나무·철광석)를 눌러 일꾼을 보내세요. 일꾼은 길로만 다니며, 영주성에서 4km 안만 갈 수 있습니다.
            </p>
            {s.gathers.length === 0 ? (
              <p className="py-6 text-center text-sm font-bold text-[#f3e8ce]">나가 있는 일꾼이 없습니다.</p>
            ) : (
              s.gathers.map((g) => {
                const ph = gatherPhase(g, now);
                const label = ph.phase === "going" ? "가는 중" : ph.phase === "gathering" ? "채집 중" : "돌아오는 중";
                const until = ph.phase === "going" ? g.arriveAt : ph.phase === "gathering" ? g.doneAt : g.returnAt;
                return (
                  <div key={g.id} className="rounded-xl border-2 border-[#5d513e] bg-[#e8dcc0] px-3 py-2">
                    <div className="flex items-center justify-between">
                      <p className="flex items-center gap-1 text-sm font-black">
                        <ResourceIcon kind={g.kind} /> {RESOURCE_LABEL[g.kind]} {fmtNum(g.amount)}
                      </p>
                      <p className="text-xs font-bold text-[#354b3c]">
                        {label} · {fmtRemain(until - now)}
                      </p>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded bg-black/20">
                      <div className="h-full bg-[linear-gradient(90deg,#4f7a4a,#8fbf6a)]" style={{ width: `${progress(g.startedAt, g.returnAt)}%` }} />
                    </div>
                    {ph.phase !== "returning" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act({ type: "recall", gatherId: g.id })}
                        className="mt-1 rounded-lg border border-[#8e7954] bg-[#fff4d8] px-3 py-1 text-xs font-black disabled:opacity-40"
                      >
                        불러들이기
                      </button>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        )}
      </main>

      {toast ? (
        <div className="pointer-events-none fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[3810] rounded-xl bg-black/85 px-3 py-2 text-center text-sm font-bold text-[#fff4d8]">
          {toast}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function BuildingSheet({
  k,
  view,
  now,
  busy,
  affordable,
  costLine,
  progress,
  onClose,
  onUpgrade,
  onTrain,
  onResearch,
}: {
  k: BuildingKey;
  view: CityViewData;
  now: number;
  busy: boolean;
  affordable: (c: Cost) => boolean;
  costLine: (c: Cost) => ReactElement;
  progress: (a: number, b: number) => number;
  onClose: () => void;
  onUpgrade: () => void;
  onTrain: (troop: TroopKind, count: number) => void;
  onResearch: () => void;
}) {
  const s = view.state;
  const def = BUILDING_BY_KEY[k];
  const lv = s.buildings[k];
  const maxed = lv >= MAX_BUILDING_LEVEL;
  const cost = upgradeCost(k, lv);
  const keepBlock = k !== "keep" && lv + 1 > s.buildings.keep;
  const [count, setCount] = useState(10);
  const effect = (level: number): string => {
    const at = { ...s, buildings: { ...s.buildings, [k]: level } };
    if (k === "forge") return `철광석 ${fmtNum(productionPerHour(at).iron)}/시간 · 병력 공격 +${level * FORGE_ATK_PCT}%`;
    if (def.produces) return `${RESOURCE_LABEL[def.produces]} ${fmtNum(productionPerHour(at)[def.produces])}/시간`;
    if (k === "storehouse") return `석재·나무·철광석 각 ${fmtNum(storageCap(level))}까지`;
    if (k === "camp") return `일꾼 부대 ${gatherParties(level)} · 운반 ${fmtNum(gatherLoad(level))}`;
    if (k === "keep") return `지휘관 병력 상한 +${Math.max(0, level - 1) * 30} · 병력 체력 +${Math.max(0, level - 1) * KEEP_HP_PCT}% (건물 최대 Lv.${level})`;
    if (k === "wall") {
      const w = wallDefense(level);
      return `본거지 수비 지휘관 체력 +${w.hp} · 공격 +${w.atk}`;
    }
    if (k === "academy") return `기술 최대 Lv.${Math.min(level, MAX_TECH_LEVEL)}`;
    if (def.trains)
      return `${TROOP_LABEL[def.trains]} 체력·공격 +${level * TROOP_BUILDING_PCT}% · 1회 ${trainBatchMax(level)}명 · 1명 ${(troopTrainMs(def.trains, Math.max(1, level)) / 1000).toFixed(1)}초`;
    return "";
  };
  const trainJob = def.trains ? s.training[def.trains] : undefined;
  const batchMax = trainBatchMax(lv);
  const trainCost = def.trains ? multiplyCost(TROOP_COST[def.trains], Math.min(count, batchMax)) : {};

  return (
    <div className="fixed inset-x-0 bottom-0 z-[3805] max-h-[62vh] overflow-y-auto rounded-t-2xl border-t-4 border-[#8e7954] bg-[#f3ead6] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 shadow-[0_-10px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-start gap-3">
        <BuildingIcon kind={k} size={56} />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-black">
            {def.name} <span className="text-sm text-[#7a5a1e]">{lv > 0 ? `Lv.${lv}` : "미건설"}</span>
          </p>
          <p className="text-xs text-slate-600">{def.desc}</p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg border border-[#8e7954] bg-white/60 px-3 py-1 text-xs font-black">
          닫기
        </button>
      </div>
      <div className="mt-2 rounded-xl bg-white/60 px-3 py-2 text-xs">
        <p className="font-bold text-slate-700">현재: {lv > 0 ? effect(lv) : "없음"}</p>
        {!maxed ? <p className="font-bold text-[#354b3c]">Lv.{lv + 1}: {effect(lv + 1)}</p> : null}
      </div>
      {maxed ? (
        <p className="mt-2 text-sm font-bold text-slate-500">최고 레벨입니다.</p>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs">
            {costLine(cost)}
            <span className="text-[11px] text-slate-500">공사 {fmtRemain(upgradeMs(k, lv))}</span>
          </div>
          <button
            type="button"
            disabled={busy || !!s.build || keepBlock || !affordable(cost)}
            onClick={onUpgrade}
            className="shrink-0 rounded-xl bg-[#263b31] px-4 py-2 text-sm font-black text-[#fff4d8] disabled:opacity-40"
          >
            {s.build ? "공사 중" : keepBlock ? `본관 Lv.${lv + 1} 필요` : lv === 0 ? "건설" : "업그레이드"}
          </button>
        </div>
      )}
      {k === "academy" && lv > 0 ? (
        <button type="button" onClick={onResearch} className="mt-2 w-full rounded-xl border-2 border-[#4f6d8f] bg-white/70 py-2 text-sm font-black text-[#2c4a6b]">
          연구 보러 가기
        </button>
      ) : null}
      {def.trains && lv > 0 ? (
        <div className="mt-3 rounded-xl border-2 border-[#8e2f2f]/40 bg-white/60 px-3 py-2">
          <p className="text-sm font-black text-[#8e2f2f]">
            {TROOP_LABEL[def.trains]} 훈련 <span className="text-xs text-slate-600">예비 {fmtNum(s.reserve[def.trains])}명</span>
          </p>
          {trainJob ? (
            <>
              <p className="mt-1 text-xs font-bold">
                {trainJob.count}명 훈련 중 · {fmtRemain(trainJob.endsAt - now)}
              </p>
              <div className="mt-1 h-2 overflow-hidden rounded bg-black/15">
                <div className="h-full bg-[linear-gradient(90deg,#8e2f2f,#e07a5f)]" style={{ width: `${progress(trainJob.startedAt, trainJob.endsAt)}%` }} />
              </div>
            </>
          ) : (
            <>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={batchMax}
                  value={Math.min(count, batchMax)}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="flex-1"
                  aria-label="훈련 인원"
                />
                <span className="w-12 text-right text-sm font-black tabular-nums">{Math.min(count, batchMax)}명</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="text-xs">
                  {costLine(trainCost)}
                  <span className="text-[11px] text-slate-500">{fmtRemain(troopTrainMs(def.trains, lv) * Math.min(count, batchMax))}</span>
                </div>
                <button
                  type="button"
                  disabled={busy || !affordable(trainCost)}
                  onClick={() => def.trains && onTrain(def.trains, Math.min(count, batchMax))}
                  className="shrink-0 rounded-xl bg-[#8e2f2f] px-4 py-2 text-sm font-black text-white disabled:opacity-40"
                >
                  훈련
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 병력 탭: 예비 병력과 지휘관별 배치 */
function TroopsTab({
  view,
  busy,
  onAssign,
}: {
  view: CityViewData;
  busy: boolean;
  onAssign: (commanderId: string, troops: TroopCounts) => void;
}) {
  const s = view.state;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<TroopCounts>(emptyTroops());
  const cmd = view.commanders.find((c) => c.id === editing) ?? null;
  const cap = cmd ? commanderTroopCap(s.buildings.keep, cmd.level) : 0;
  const avail = useMemo(() => {
    const out = emptyTroops();
    if (!cmd) return out;
    for (const k of TROOP_KINDS) out[k] = s.reserve[k] + cmd.troops[k];
    return out;
  }, [cmd, s.reserve]);
  const total = troopTotal(draft);
  const bonus = troopBonus(draft, s.tech, s.buildings);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="rounded-xl bg-black/45 px-3 py-2 text-[#f3e8ce]">
        <p className="text-xs font-black">예비 병력 (성에 대기 중)</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm font-black tabular-nums">
          {TROOP_KINDS.map((k) => (
            <span key={k}>
              {TROOP_LABEL[k]} {fmtNum(s.reserve[k])}
            </span>
          ))}
        </p>
        <p className="mt-0.5 text-[11px] text-[#c8bea8]">
          지휘관에게 병력을 맡기면 전투에서 체력·공격력이 오릅니다. 전투에서 입은 피해만큼 병력을 잃습니다.
        </p>
      </div>
      {view.commanders.map((c) => {
        const b = troopBonus(c.troops, s.tech, s.buildings);
        return (
          <div key={c.id} className="rounded-xl border-2 border-[#5d513e] bg-[#e8dcc0] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-black">
                {c.name} <span className="text-xs text-[#7a5a1e]">Lv.{c.level}</span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditing(c.id);
                  setDraft({ ...c.troops });
                }}
                className="shrink-0 rounded-lg bg-[#263b31] px-3 py-1 text-xs font-black text-[#fff4d8]"
              >
                배치
              </button>
            </div>
            <p className="text-xs font-bold tabular-nums text-slate-700">
              {troopTotal(c.troops)}/{c.cap}명 ·{" "}
              {TROOP_KINDS.filter((k) => c.troops[k] > 0)
                .map((k) => `${TROOP_LABEL[k]} ${c.troops[k]}`)
                .join(" · ") || "병력 없음"}
            </p>
            {troopTotal(c.troops) > 0 ? <p className="text-[11px] font-bold text-[#354b3c]">전투 체력 +{b.hp} · 공격력 +{b.atk}</p> : null}
          </div>
        );
      })}
      {cmd ? (
        <div className="fixed inset-x-0 bottom-0 z-[3805] rounded-t-2xl border-t-4 border-[#8e7954] bg-[#f3ead6] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 shadow-[0_-10px_30px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between">
            <p className="text-base font-black">{cmd.name} 병력 배치</p>
            <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-[#8e7954] bg-white/60 px-3 py-1 text-xs font-black">
              닫기
            </button>
          </div>
          <p className="text-xs font-bold text-slate-600">
            {total}/{cap}명 · 전투 체력 +{bonus.hp} · 공격력 +{bonus.atk}
          </p>
          {TROOP_KINDS.map((k: TroopKind) => {
            const max = Math.min(avail[k], draft[k] + Math.max(0, cap - total));
            return (
              <label key={k} className="mt-1.5 flex items-center gap-2 text-sm font-bold">
                <span className="w-12 shrink-0">{TROOP_LABEL[k]}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, max)}
                  value={draft[k]}
                  disabled={max <= 0 && draft[k] === 0}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: Number(e.target.value) }))}
                  className="flex-1"
                />
                <span className="w-16 text-right tabular-nums">
                  {draft[k]}/{avail[k]}
                </span>
              </label>
            );
          })}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onAssign(cmd.id, draft);
              setEditing(null);
            }}
            className="mt-2 w-full rounded-xl bg-[#263b31] py-2 text-sm font-black text-[#fff4d8] disabled:opacity-40"
          >
            저장
          </button>
        </div>
      ) : null}
    </div>
  );
}
