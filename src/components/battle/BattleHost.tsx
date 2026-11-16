"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { PublicBattleView } from "@/lib/battle";

import { createServerBattleSource, fetchCurrentBattle, startBattle } from "@/components/battle/battle-api";
import { BattleScene } from "@/components/battle/BattleScene";
import type { BattleSource } from "@/components/battle/battle-source";

/** 지도 화면에서 무법자 토벌 요청 (wildId = 무법자 행 id) */
export interface OutlawBattleRequest {
  wildId: number;
  nonce: number;
}

interface BattleHostProps {
  enabled: boolean;
  outlawRequest: OutlawBattleRequest | null;
  onOutlawRequestDone: () => void;
  /** 전투가 시작됨 (무법자 패널 닫기, 고정 해제 신호 생략) */
  onBattleStarted: (wildId: number | null) => void;
  /** 결과를 확인하고 닫음 (무법자·부대 새로고침) */
  onBattleFinished: () => void;
}

interface CommanderOption {
  id: string;
  name: string;
  detail: string;
  available: boolean;
}

const CLOSED_KEY = "battle-closed-ids";
const STATE_LABEL: Readonly<Record<string, string>> = {
  training: "훈련 중",
  garrisoned: "주둔 중",
  dead: "전사",
  field: "출전 가능",
};

function readClosed(): string[] {
  try {
    const raw = window.sessionStorage.getItem(CLOSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function markClosed(id: string): void {
  try {
    const list = readClosed().filter((x) => x !== id);
    list.push(id);
    window.sessionStorage.setItem(CLOSED_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    // 무시
  }
}

async function loadCommanders(): Promise<CommanderOption[]> {
  const out: CommanderOption[] = [{ id: "lord", name: "영주 (나)", detail: "직접 출전", available: true }];
  try {
    const res = await fetch("/api/units", { credentials: "include", cache: "no-store" });
    const body: unknown = await res.json();
    const units = typeof body === "object" && body !== null ? (body as { units?: unknown }).units : null;
    if (Array.isArray(units)) {
      for (const u of units) {
        if (typeof u !== "object" || u === null) continue;
        const r = u as Record<string, unknown>;
        if (typeof r.id !== "string") continue;
        const state = typeof r.state === "string" ? r.state : "";
        const extra: string[] = [];
        if (typeof r.level === "number") extra.push(`Lv.${r.level}`);
        extra.push(STATE_LABEL[state] ?? state);
        out.push({
          id: r.id,
          name: typeof r.name === "string" && r.name ? r.name : "부대",
          detail: extra.join(" · "),
          available: state === "field",
        });
      }
    }
  } catch {
    // 부대 목록을 못 받아도 영주로는 출전할 수 있다
  }
  return out;
}

interface CommanderPickerProps {
  wildId: number;
  onCancel: () => void;
  onStarted: (v: PublicBattleView, wildId: number | null) => void;
}

/** 출전 지휘관 선택창 (영주 + 출전 가능한 부대) */
function CommanderPicker({ wildId, onCancel, onStarted }: CommanderPickerProps) {
  const [options, setOptions] = useState<CommanderOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadCommanders().then((list) => {
      if (alive) setOptions(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const start = async (commanderId: string): Promise<void> => {
    if (starting) return;
    setStarting(true);
    setError(null);
    const res = await startBattle({ targetType: "outlaw", targetId: String(wildId), commanderId });
    if (res.ok && res.battle) {
      onStarted(res.battle, wildId);
      return;
    }
    if (!res.ok && res.code === "battle_active") {
      const cur = await fetchCurrentBattle();
      if (cur.ok && cur.battle) {
        onStarted(cur.battle, null);
        return;
      }
    }
    setStarting(false);
    setError(res.ok ? "전투를 시작하지 못했습니다." : res.message);
  };

  return (
    <div
      className="fixed inset-0 z-[3900] flex items-end justify-center bg-black/55 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:items-center"
      onClick={() => !starting && onCancel()}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border-2 border-amber-200/40 bg-[linear-gradient(135deg,#2a2016_0%,#120c08_100%)] text-amber-50 shadow-[0_20px_50px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-amber-200/25 bg-amber-300/10 px-4 py-2.5">
          <p className="text-sm font-bold">무법자 토벌 — 출전할 지휘관</p>
          <p className="mt-0.5 text-[11px] text-amber-100/70">지휘관의 덱으로 카드 전투를 벌입니다. 패배하면 1시간 부상.</p>
        </div>
        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto p-3">
          {options === null ? (
            <p className="py-4 text-center text-xs text-amber-100/70">지휘관 목록을 불러오는 중…</p>
          ) : (
            options.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={!o.available || starting}
                onClick={() => void start(o.id)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-amber-200/25 bg-black/30 px-3 py-2 text-left transition enabled:hover:border-amber-200/60 enabled:hover:bg-amber-200/10 disabled:opacity-45"
              >
                <span className="truncate text-sm font-bold">{o.name}</span>
                <span className="shrink-0 text-[11px] text-amber-100/70">{o.detail}</span>
              </button>
            ))
          )}
        </div>
        {error ? <p className="px-4 pb-2 text-center text-xs font-semibold text-red-300">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-amber-200/15 bg-amber-200/5 px-4 py-2.5">
          <button
            type="button"
            disabled={starting}
            onClick={onCancel}
            className="rounded-lg border border-slate-600/60 bg-slate-800/80 px-4 py-1.5 text-xs font-semibold text-slate-200"
          >
            {starting ? "출전 중…" : "취소"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 지도 위 전투 진입점: 지휘관 선택 → 전투 시작 → 전투 화면, 진행 중 전투 복귀 */
export function BattleHost({ enabled, outlawRequest, onOutlawRequestDone, onBattleStarted, onBattleFinished }: BattleHostProps) {
  const [source] = useState<BattleSource>(() => createServerBattleSource());
  const [scene, setScene] = useState<PublicBattleView | null>(null);
  const [hidden, setHidden] = useState(false);
  const openView = useCallback((v: PublicBattleView) => {
    setScene(v);
    setHidden(false);
  }, []);

  // 지도 진입 시 진행 중인 전투 확인
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchCurrentBattle().then((res) => {
      if (!alive || !res.ok || !res.battle) return;
      const b = res.battle;
      if (readClosed().includes(b.battleId)) return;
      setScene(b);
      // 진행 중이면 바로 열지 않고 복귀 버튼을 띄운다. 끝난 전투(결과 미확인)는 결과를 보여 준다.
      setHidden(b.winner === null);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  const onStarted = (v: PublicBattleView, wildId: number | null): void => {
    onOutlawRequestDone();
    onBattleStarted(wildId);
    openView(v);
  };

  if (!enabled || typeof document === "undefined") return null;

  return createPortal(
    <>
      {outlawRequest ? (
        <CommanderPicker
          key={outlawRequest.nonce}
          wildId={outlawRequest.wildId}
          onCancel={onOutlawRequestDone}
          onStarted={onStarted}
        />
      ) : null}

      {scene && hidden ? (
        <button
          type="button"
          onClick={() => {
            // 숨긴 사이 진행된 상태(시간 초과 등)를 받아서 연다
            void fetchCurrentBattle().then((res) => {
              if (res.ok && res.battle) openView(res.battle);
              else if (res.ok) setScene(null);
              else setHidden(false);
            });
          }}
          className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+4.25rem)] z-[3800] -translate-x-1/2 animate-pulse rounded-full border-2 border-amber-200/70 bg-[linear-gradient(#a8352c,#5e121c)] px-4 py-1.5 text-xs font-bold text-white shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
        >
          진행 중인 전투로 돌아가기
        </button>
      ) : null}

      {scene && !hidden ? (
        <BattleScene
          key={scene.battleId}
          initial={scene}
          source={source}
          onExit={() => setHidden(true)}
          onFinished={(v) => {
            markClosed(v.battleId);
            setScene(null);
            setHidden(false);
            onBattleFinished();
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}
