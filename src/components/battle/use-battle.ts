"use client";

import { useCallback, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { Action, BattleEvent, PublicBattleView } from "@/lib/battle";

import type { BattleAnimator } from "@/components/battle/battle-animator";
import type { BattleCallResult, BattleSource } from "@/components/battle/battle-source";

export interface BattleToast {
  id: number;
  text: string;
  tone: "error" | "info";
}

interface UseBattleArgs {
  source: BattleSource;
  initial: PublicBattleView;
  /** 연출기 (아직 준비 전이면 null → 연출 없이 바로 반영) */
  getAnimator: () => BattleAnimator | null;
}

export interface UseBattle {
  view: PublicBattleView;
  busy: boolean;
  toast: BattleToast | null;
  log: string | null;
  send: (action: Action) => Promise<void>;
  refresh: () => Promise<void>;
  /** 연출기가 쓰는 동기 반영 */
  commit: (v: PublicBattleView) => void;
  getView: () => PublicBattleView;
  showToast: (text: string, tone?: BattleToast["tone"]) => void;
  setLog: (text: string) => void;
}

/** 시간 초과로 서버가 턴을 넘긴 응답인지 (행동 전에 내 턴 종료 이벤트가 먼저 옴) */
function wasTimedOut(events: BattleEvent[], action: Action | null): boolean {
  const first = events[0];
  if (!first) return false;
  if (action && (action.type === "endTurn" || action.type === "concede")) return false;
  return first.type === "turn-end" && first.side === 0;
}

/** 전투 데이터 흐름: 행동 전송 → 이벤트 연출 → 서버 view 로 확정 */
export function useBattle({ source, initial, getAnimator }: UseBattleArgs): UseBattle {
  const [view, setView] = useState<PublicBattleView>(initial);
  const viewRef = useRef<PublicBattleView>(initial);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [toast, setToast] = useState<BattleToast | null>(null);
  const toastSeq = useRef(0);
  const [log, setLogState] = useState<string | null>(null);

  const commit = useCallback((v: PublicBattleView) => {
    viewRef.current = v;
    flushSync(() => setView(v));
  }, []);

  const getView = useCallback(() => viewRef.current, []);

  const showToast = useCallback((text: string, tone: BattleToast["tone"] = "error") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);

  const setLog = useCallback((text: string) => setLogState(text), []);

  const apply = useCallback(
    async (res: BattleCallResult, action: Action | null): Promise<void> => {
      if (!res.ok) {
        showToast(res.message);
        return;
      }
      if (!res.battle) return;
      if (res.battle.battleId !== viewRef.current.battleId) {
        commit(res.battle);
        return;
      }
      if (wasTimedOut(res.events, action) && action) showToast("시간 초과로 턴이 넘어갔습니다.", "info");
      const anim = getAnimator();
      if (anim && res.events.length > 0) {
        await anim.play(res.events);
        anim.settle(res.battle);
      } else {
        commit(res.battle);
      }
    },
    [commit, getAnimator, showToast],
  );

  const run = useCallback(
    async (fn: () => Promise<BattleCallResult>, action: Action | null): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await fn();
        await apply(res, action);
        // 잘못된 행동이면 서버 상태로 다시 맞춘다
        if (!res.ok && (res.code === "invalid_action" || res.code === "not_your_turn")) {
          const again = await source.refresh();
          if (again.ok && again.battle) await apply(again, null);
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [apply, source],
  );

  const send = useCallback(
    (action: Action) => run(() => source.act(viewRef.current.battleId, action), action),
    [run, source],
  );

  const refresh = useCallback(() => run(() => source.refresh(), null), [run, source]);

  return { view, busy, toast, log, send, refresh, commit, getView, showToast, setLog };
}
