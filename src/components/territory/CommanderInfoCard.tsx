"use client";

import { useEffect, useState } from "react";

import { COMMANDER_KIND_LABEL } from "@/lib/battle";
import type { CommanderListItem, CommandersResponse } from "@/lib/battle";



const STATE_LABEL: Readonly<Record<CommanderListItem["state"], string>> = {
  field: "출전 가능",
  training: "훈련 중",
  garrisoned: "주둔 중",
  dead: "전사",
};

interface CommanderInfoCardProps {
  /** "lord" 또는 부대 id */
  commanderId: string;
  /** 영주의 계급 id (slave·commoner…) */
  lordClass?: string | null;
  /** 이동 중이면 상태 칸에 표시 */
  moving?: boolean;
  /** 값이 바뀌면 다시 불러온다 (전투 후 등) */
  refreshKey?: number;
}

interface Loaded {
  item: CommanderListItem;
  /** 서버 시각 → 내 기기 시각 보정 */
  skew: number;
}

/** 영주·부대 선택 창 위쪽의 정보 칸: 병종·계급, 레벨·경험치, 전적, 상태(부상 남은 시간) */
export function CommanderInfoCard({ commanderId, lordClass, moving, refreshKey }: CommanderInfoCardProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void fetch("/api/battle/commanders", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<CommandersResponse>) : null))
      .then((body) => {
        if (!alive) return;
        const key = commanderId === "lord" ? "lord" : commanderId;
        const item = body?.ok ? body.commanders.find((c) => c.id === key) : undefined;
        if (!body || !item) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setLoaded({ item, skew: Date.now() - body.serverNow });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [commanderId, refreshKey]);

  // 부상 남은 시간 갱신
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!loaded) {
    return (
      <div className="mb-1.5 rounded-xl border border-[#8e7954]/35 bg-[#fffaf0] px-3 py-2 text-xs font-bold text-slate-500">
        {failed ? "정보를 불러오지 못했습니다." : "정보 불러오는 중…"}
      </div>
    );
  }

  const { item, skew } = loaded;
  const injuredUntil = item.injuredUntil === null ? null : item.injuredUntil + skew;
  const injured = injuredUntil !== null && injuredUntil > now;
  const xp = item.xp ?? 0;
  const start = item.levelXpStart ?? 0;
  const next = item.nextLevelXp ?? null;
  const pct = next === null ? 100 : Math.max(0, Math.min(100, ((xp - start) / Math.max(1, next - start)) * 100));
  const wins = item.wins ?? 0;
  const battles = item.battles ?? 0;
  const kindLabel = item.id === "lord" ? (lordClass ?? "부족장") : COMMANDER_KIND_LABEL[item.kind];
  const status = injured
    ? `부상 ${Math.max(1, Math.ceil(((injuredUntil as number) - now) / 60_000))}분 남음`
    : moving
      ? "이동 중"
      : STATE_LABEL[item.state];

  return (
    <div className="mb-1.5 rounded-xl border border-[#8e7954]/35 bg-[#fffaf0] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-black text-slate-900">
          {item.name} <span className="ml-1 text-xs font-bold text-[#526c49]">{kindLabel}</span>
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black ${
            injured ? "bg-red-100 text-red-700" : item.state === "field" ? "bg-[#e3ecd9] text-[#354b3c]" : "bg-slate-200 text-slate-700"
          }`}
        >
          {status}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="shrink-0 text-xs font-black text-[#7a5a1e]">Lv.{item.level}</span>
        <div
          className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-[#d1c5aa]"
          role="progressbar"
          aria-label="경험치"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="h-full rounded-full bg-[linear-gradient(90deg,#c9852a,#e7c26a)]" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-[11px] font-bold tabular-nums text-slate-600">
          {next === null ? "최대 레벨" : `${xp - start}/${next - start}`}
        </span>
      </div>
      <p className="mt-1 text-[11px] font-bold text-slate-600">
        카드 전투 {battles}전 {wins}승 {Math.max(0, battles - wins)}패
        {battles > 0 ? ` · 승률 ${Math.round((wins / battles) * 100)}%` : ""}
      </p>
    </div>
  );
}
