"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";

import {
  BUILDINGS,
  BUILDING_BY_KEY,
  CITY_SIEGE_DURATION_MS,
  GOLD_CAP,
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
import type { CityDistrict } from "@/components/city/city-scene-engine";

import "@/components/city/city-interface.css";

// three.js는 성 화면을 열 때만 불러온다
const CityScene3D = dynamic(() => import("@/components/city/CityScene3D"), {
  ssr: false,
  loading: () => <p className="absolute inset-0 grid place-items-center text-sm font-bold text-[#f3e8ce]">성 안 풍경을 그리는 중…</p>,
});

const CITY_TABS = [
  ["buildings", "건물"],
  ["research", "연구"],
  ["troops", "병력"],
  ["workers", "일꾼"],
] as const satisfies ReadonlyArray<readonly [CityDistrict, string]>;

const DISTRICT_NAMES = { research: "학당", troops: "병영", workers: "일꾼 막사" } as const;
const PANEL_CLASS = "pointer-events-auto absolute inset-x-2 bottom-2 max-h-[49%] overflow-y-auto overscroll-contain px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-[#32291d] [scrollbar-width:thin] md:inset-x-auto md:top-3 md:right-3 md:bottom-3 md:w-[min(33rem,42vw)] md:max-h-none md:px-4 md:py-4";
const ACTION_CLASS = "min-h-10 shrink-0 px-3 text-xs font-bold text-[#fff3d7]";
const ROW_CLASS = "px-3 py-2.5";
const META_CLASS = "text-xs font-semibold leading-relaxed text-[#6b5438]";

interface CityViewProps {
  open: boolean;
  onClose: () => void;
}

// 포털은 브라우저가 기존 페이지의 하이드레이션을 마친 뒤 연결한다.
const subscribeToDocument = (): (() => void) => () => undefined;
const clientDocument = (): boolean => true;
const serverDocument = (): boolean => false;

/** 서버 시각 기준 현재 */
const serverNow = (v: CityViewData | null): number => Date.now() - (v?.skew ?? 0);

/** 성 안 화면: 자원 막대, 건물 마당, 건설·연구·훈련·병력 배치·일꾼 */
export function CityView({ open, onClose }: CityViewProps) {
  const hasDocument = useSyncExternalStore(subscribeToDocument, clientDocument, serverDocument);
  const [view, setView] = useState<CityViewData | null>(null);
  const [tab, setTab] = useState<CityDistrict>("buildings");
  const [selected, setSelected] = useState<BuildingKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const show = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2600);
  }, []);

  const reload = useCallback(async () => {
    const r = await fetchCity();
    if (r.ok) {
      setLoadError(null);
      setView(r.view);
      if (r.view.events.length > 0) show(r.view.events.join(" · "));
    } else {
      setLoadError(r.message);
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
    if (!open || busy) return;
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
  }, [open, busy]);

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

  if (!open || !hasDocument) return null;

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

  const producing = (kind: ResourceKind): boolean =>
    (rates?.[kind] ?? 0) > 0 && liveRes(kind) < (kind === "gold" ? GOLD_CAP : cap);

  const sceneLots: CitySceneLot[] = s
    ? BUILDINGS.map((b) => {
        const build = s.build?.key === b.key ? s.build : null;
        const train = b.trains ? s.training[b.trains] : undefined;
        const research = b.key === "academy" && s.research && s.research.endsAt > now ? s.research : null;
        const training = !!train && train.endsAt > now;
        const operating = training || !!research || (b.produces ? producing(b.produces) : false) ||
          (b.key === "camp" && s.gathers.some((g) => g.returnAt > now)) ||
          (b.key === "storehouse" && (["stone", "wood", "iron"] as const).some(producing)) ||
          (b.key === "keep" && Object.values(s.assigned).some((troops) => troopTotal(troops) > 0));
        const job = build ?? research ?? (training ? train : null);
        return {
          key: b.key,
          name: b.name,
          level: s.buildings[b.key],
          building: !!build,
          training: !build && training,
          researching: !build && !!research,
          operating: operating && s.buildings[b.key] > 0,
          progress: job ? progress(job.startedAt, job.endsAt) : 0,
          remain: job ? fmtRemain(job.endsAt - now) : null,
        };
      })
    : [];

  return createPortal(
    <div data-city-interface className="fixed inset-0 z-[3800] isolate flex flex-col overflow-hidden text-[#2b2118]" role="dialog" aria-label="영주성">
      {s ? (
        <CityScene3D
          lots={sceneLots}
          district={tab}
          siege={{ active: !!activeSiege, wallLevel: s.buildings.wall }}
          selected={selected}
          onSelect={setSelected}
        />
      ) : null}
      <header data-city-surface="gatehouse" className="relative z-10 mx-1.5 mt-[max(0.25rem,env(safe-area-inset-top))] grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 pt-[21px] pb-3 text-[#fff0cc] sm:mx-3 md:grid-cols-[minmax(0,1fr)_minmax(19rem,32rem)_auto] md:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center border border-[#d2b781]/65 bg-[#163b35] md:size-11">
            <span className="city-gate-emblem" />
          </span>
          <div className="min-w-0">
            <h2 className="city-sign-title truncate text-lg leading-tight md:text-2xl">{view?.home?.name ?? "영주성"}</h2>
            <p className="text-[10px] leading-4 font-medium text-[#e0d4b7] md:text-xs">본관 Lv.{s?.buildings.keep ?? 1} · 창고 한도 {fmtNum(cap)}</p>
          </div>
        </div>
        <button type="button" onClick={onClose} data-city-surface="woodTag" className="min-h-11 justify-self-end px-3 text-xs font-semibold text-[#fff2d6] md:col-start-3 md:row-start-1">
          <span aria-hidden="true">← </span>지도로
        </button>
        <dl aria-label="성 자원" data-city-surface="ledger" className="col-span-2 grid grid-cols-4 divide-x divide-[#91734c]/35 px-1 py-1 text-[#372b1d] md:col-span-1 md:col-start-2 md:row-start-1">
          {RESOURCE_KINDS.map((k) => (
            <div key={k} className="min-w-0 px-1.5 md:px-3">
              <dt className="flex items-center gap-1 text-[10px] leading-3 font-semibold text-[#58412c]">
                <ResourceIcon kind={k} size={12} />{RESOURCE_LABEL[k]}
              </dt>
              <dd className="flex flex-wrap items-baseline gap-x-1.5">
                <strong className="text-sm leading-4 tabular-nums">{fmtNum(liveRes(k))}</strong>
                <span className="text-[10px] leading-3 whitespace-nowrap tabular-nums text-[#405745]">+{fmtNum(rates?.[k] ?? 0)}/시간</span>
              </dd>
            </div>
          ))}
        </dl>
      </header>

      <nav aria-label="성 내부" className="relative z-10 mx-3 flex shrink-0 gap-1 sm:mx-5 md:w-fit md:gap-1.5">
        {CITY_TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setSelected(null);
            }}
            data-city-surface={tab === key ? "sealTag" : "woodTag"}
            className="city-sign-title flex min-h-11 flex-1 items-center justify-center gap-1.5 px-2 pt-1 text-sm text-[#fff0cd] md:min-w-24 md:px-4"
          >
            <span aria-hidden="true" className={`size-1.5 rotate-45 border border-[#dbc394] ${tab === key ? "bg-[#f6d798]" : ""}`} />
            {label}
          </button>
        ))}
      </nav>

      <main className="pointer-events-none relative min-h-0 flex-1">
        {!view || !s ? (
          <div className="pt-10 text-center text-sm font-bold text-[#f3e8ce]">
            <p role="status">{loadError ?? "성 안을 불러오는 중…"}</p>
            {loadError ? (
              <button type="button" data-city-surface="button" className="pointer-events-auto mt-3 min-h-10 px-4" onClick={() => void reload()}>
                다시 불러오기
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div aria-live="polite" className="absolute top-3 left-2 flex w-[min(25rem,calc(100%_-_1rem))] flex-col gap-1.5 md:left-3">
              {activeSiege ? (
                <div data-city-surface="warning" className="px-3 py-2 text-orange-50">
                  <p className="text-xs font-bold">
                    {activeSiege.by}님의 공성 공격 · {now - activeSiege.at < 60_000 ? "방금 전" : `${Math.floor((now - activeSiege.at) / 60_000)}분 전`}
                  </p>
                  {activeSiege.defended !== null ? (
                    <p className="mt-0.5 text-[11px]">
                      {activeSiege.defended ? "수비대가 공격을 막아냈습니다." : "공격군이 이번 전투에서 승리했습니다."}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {tab === "buildings" && s.build ? (
                <div data-city-surface="frame" className="px-3 py-2 text-[#f3e8ce]">
                  <p className="text-xs font-bold">
                    공사 중 · {BUILDING_BY_KEY[s.build.key].name} Lv.{s.build.toLevel} · {fmtRemain(s.build.endsAt - now)}
                  </p>
                  <CityProgress value={progress(s.build.startedAt, s.build.endsAt)} label="공사 진행률" />
                </div>
              ) : null}
            </div>
            {tab === "buildings" && selected ? (
              <BuildingSheet
                key={selected}
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
            {tab !== "buildings" ? (
              <section key={tab} aria-label={DISTRICT_NAMES[tab]} data-city-surface="sheet" data-city-scroll className={PANEL_CLASS}>
                <h2 className="mb-3 border-b border-[#aa8b5e] pb-2 font-serif text-xl font-black tracking-tight">{DISTRICT_NAMES[tab]}</h2>
                {tab === "research" ? (
                    <div className="flex flex-col gap-2">
                      <p className={META_CLASS}>
                        학당 Lv.{s.buildings.academy} · 기술은 학당 레벨까지 올릴 수 있으며 한 번에 하나씩 연구합니다.
                      </p>
                      {s.research ? (
                        <div data-city-surface="row" className={ROW_CLASS}>
                          <p className="text-xs font-black">
                            연구 중: {TECH_BY_KEY[s.research.key].name} → Lv.{s.research.toLevel} · {fmtRemain(s.research.endsAt - now)}
                          </p>
                          <CityProgress value={progress(s.research.startedAt, s.research.endsAt)} label="연구 진행률" />
                        </div>
                      ) : null}
                      {TECHS.map((t) => {
                        const lv = s.tech[t.key];
                        const maxed = lv >= MAX_TECH_LEVEL;
                        const cost = researchCost(t.key, lv);
                        const blocked = lv + 1 > s.buildings.academy;
                        return (
                          <div key={t.key} data-city-surface="row" className={ROW_CLASS}>
                            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
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
                                  data-city-surface="action" className={ACTION_CLASS}
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
                      <p className={META_CLASS}>
                        일꾼 부대 {s.gathers.length}/{gatherParties(s.buildings.camp)} · 1회 운반 {fmtNum(gatherLoad(s.buildings.camp))}
                        <br />
                        지도에서 자원지(금·석재·나무·철광석)를 눌러 일꾼을 보내세요. 일꾼은 길로만 다니며, 영주성에서 4km 안만 갈 수 있습니다.
                      </p>
                      {s.gathers.length === 0 ? (
                        <p data-city-surface="row" className="px-3 py-5 text-sm font-bold">나가 있는 일꾼이 없습니다.</p>
                      ) : (
                        s.gathers.map((g) => {
                          const ph = gatherPhase(g, now);
                          const label = ph.phase === "going" ? "가는 중" : ph.phase === "gathering" ? "채집 중" : "돌아오는 중";
                          const until = ph.phase === "going" ? g.arriveAt : ph.phase === "gathering" ? g.doneAt : g.returnAt;
                          return (
                            <div key={g.id} data-city-surface="row" className={ROW_CLASS}>
                              <div className="flex items-center justify-between">
                                <p className="flex items-center gap-1 text-sm font-black">
                                  <ResourceIcon kind={g.kind} /> {RESOURCE_LABEL[g.kind]} {fmtNum(g.amount)}
                                </p>
                                <p className="text-xs font-bold text-[#354b3c]">
                                  {label} · {fmtRemain(until - now)}
                                </p>
                              </div>
                              <CityProgress value={progress(g.startedAt, g.returnAt)} label="채집 일정 진행률" />
                              {ph.phase !== "returning" ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void act({ type: "recall", gatherId: g.id })}
                                  data-city-surface="action" className={`mt-2 ${ACTION_CLASS}`}
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
              </section>
            ) : null}
          </>
        )}
      </main>

      {toast ? (
        <div role="status" data-city-surface="frame" className="pointer-events-none absolute top-1/3 left-1/2 z-20 w-max max-w-[calc(100%_-_2rem)] -translate-x-1/2 px-4 py-3 text-center text-sm font-bold text-[#fff4d8]">
          {toast}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function CityProgress({ value, label }: { value: number; label: string }): ReactElement {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} data-city-surface="track" className="relative mt-2 h-2">
      <div data-city-surface="fill" className="absolute inset-y-0 left-0" style={{ width: `${value}%` }} />
    </div>
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
    <section data-city-surface="sheet" data-city-scroll className={PANEL_CLASS} aria-label={def.name}>
      <div className="flex items-start gap-3">
        <BuildingIcon kind={k} size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl font-black tracking-tight">
            {def.name} <span className="text-sm text-[#7a5a1e]">{lv > 0 ? `Lv.${lv}` : "미건설"}</span>
          </h2>
          <p className="text-xs text-slate-600">{def.desc}</p>
        </div>
        <button type="button" onClick={onClose} data-city-surface="row" className="min-h-10 shrink-0 px-3 text-xs font-bold">
          닫기
        </button>
      </div>
      <div data-city-surface="row" className="mt-3 px-3 py-2 text-xs">
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
            data-city-surface="action" className={ACTION_CLASS}
          >
            {s.build ? "공사 중" : keepBlock ? `본관 Lv.${lv + 1} 필요` : lv === 0 ? "건설" : "업그레이드"}
          </button>
        </div>
      )}
      {k === "academy" && lv > 0 ? (
        <button type="button" onClick={onResearch} data-city-surface="button" className={`mt-3 w-full ${ACTION_CLASS}`}>
          연구 보러 가기
        </button>
      ) : null}
      {def.trains && lv > 0 ? (
        <div data-city-surface="row" className={`mt-3 ${ROW_CLASS}`}>
          <p className="text-sm font-black text-[#8e2f2f]">
            {TROOP_LABEL[def.trains]} 훈련 <span className="text-xs text-slate-600">예비 {fmtNum(s.reserve[def.trains])}명</span>
          </p>
          {trainJob ? (
            <>
              <p className="mt-1 text-xs font-bold">
                {trainJob.count}명 훈련 중 · {fmtRemain(trainJob.endsAt - now)}
              </p>
              <CityProgress value={progress(trainJob.startedAt, trainJob.endsAt)} label="훈련 진행률" />
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
                  data-city-surface="action" className={ACTION_CLASS}
                >
                  훈련
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
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
      <div data-city-surface="row" className={ROW_CLASS}>
        <p className="text-xs font-black">예비 병력 (성에 대기 중)</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm font-black tabular-nums">
          {TROOP_KINDS.map((k) => (
            <span key={k}>
              {TROOP_LABEL[k]} {fmtNum(s.reserve[k])}
            </span>
          ))}
        </p>
        <p className={META_CLASS}>
          지휘관에게 병력을 맡기면 전투에서 체력·공격력이 오릅니다. 전투에서 입은 피해만큼 병력을 잃습니다.
        </p>
      </div>
      {view.commanders.map((c) => {
        const b = troopBonus(c.troops, s.tech, s.buildings);
        return (
          <div key={c.id} data-city-surface="row" className={ROW_CLASS}>
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
                data-city-surface="action" className={ACTION_CLASS}
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
            {cmd?.id === c.id ? (
              <div className="mt-3 border-t border-[#baa075] pt-2">
                <div className="flex items-center justify-between">
                  <p className="text-base font-black">{cmd.name} 병력 배치</p>
                  <button type="button" onClick={() => setEditing(null)} data-city-surface="row" className="min-h-10 px-3 text-xs font-bold">
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
                  data-city-surface="action" className={`mt-2 w-full ${ACTION_CLASS}`}
                >
                  저장
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
