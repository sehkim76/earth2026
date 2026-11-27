"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

import { cityAction, fetchCity, fmtNum, fmtRemain, type CityActionBody, type CityViewData } from "@/components/city/city-client";
import { gatherLoad, gatherPhase, RESOURCE_LABEL, workerCargo, WORKER_PHASE_LABEL, type VisibleWorker } from "@/lib/city";
import { serverNow } from "@/lib/server-clock";

import type { WorkerSelection } from "@/components/territory/map-dialog";

interface WorkerPanelProps {
  selection: WorkerSelection;
  view: CityViewData | null;
  others: VisibleWorker[];
  center: () => { lat: number; lon: number } | null;
  onClose: () => void;
}

export function WorkerPanel({ selection, view, others, center, onClose }: WorkerPanelProps): ReactElement {
  const [now, setNow] = useState(serverNow);
  const [aim, setAim] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(serverNow()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const slot = "slot" in selection ? selection.slot : null;
  const own = view?.state.gathers.find(g => g.slot === slot && g.returnAt > now);
  const foreign = "foreignId" in selection ? others.find(g => g.id === selection.foreignId && g.returnAt > now) : undefined;
  const g = own ?? foreign;
  const phase = g ? gatherPhase(g, now).phase : null;
  const status = phase ? WORKER_PHASE_LABEL[phase] : slot === null ? "귀환 완료" : "성내 대기";
  const until = phase === "going" ? g?.arriveAt : phase === "gathering" ? g?.doneAt : phase === "returning" ? g?.returnAt : null;
  const name = slot === null ? `${foreign?.ownerNickname || "상대"}의 일꾼` : `일꾼 ${slot + 1}부대`;
  const carried = own ? workerCargo(own, now) : 0;
  const command = async (move: boolean): Promise<void> => {
    if (pending.current || slot === null || !view?.home) return;
    let action: CityActionBody;
    if (move) {
      const target = center();
      if (!target) { setMessage("지도 중심 위치를 확인할 수 없습니다."); return; }
      action = { type: "workerMove", slot, gatherId: own?.id ?? null, ...target };
    } else {
      if (!own) return;
      action = { type: "recall", gatherId: own.id };
    }
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await cityAction(action);
      if (result.ok) { setAim(false); setMessage(move ? "이동 명령을 내렸습니다." : "귀환 명령을 내렸습니다."); }
      else { setMessage(result.message); if (result.code === "changed" || result.code === "gone") void fetchCity(); }
    } finally { pending.current = false; setBusy(false); }
  };
  return <>
    {aim && <div className="pointer-events-none fixed left-1/2 top-1/2 z-[1300] -translate-x-1/2 -translate-y-1/2" aria-hidden="true"><div className="unit-target-center-pin" /></div>}
    <section role="dialog" aria-labelledby="worker-name" className="joseon-sheet fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-[1200] mx-auto max-w-md p-3">
      <header className="flex items-center gap-3">
        <span aria-hidden="true" className="worker-portrait" />
        <div className="min-w-0 flex-1"><h2 id="worker-name" className="font-serif text-lg font-bold">{name}</h2><p className="text-sm">{status}{until ? ` · ${fmtRemain(until - now)}` : ""}</p></div>
        <button className="joseon-button" onClick={onClose}>닫기</button>
      </header>
      {own && view && <p className="mt-2 border-t border-[#af956e] pt-2 text-sm">운반 중 · {carried > 0 ? RESOURCE_LABEL[own.kind] + " " : ""}{fmtNum(carried)} / {fmtNum(gatherLoad(view.state.buildings.camp))}</p>}
      {g && !g.order && <p className="text-sm">채집 자원 · {RESOURCE_LABEL[g.kind]}</p>}
      {slot !== null && view?.home && <div className="mt-3">
        {aim && <p className="mb-2 text-sm">지도를 움직여 길 위에 중앙 표식을 맞추세요.</p>}
        <div className="flex gap-2">
          <button disabled={busy} className="joseon-command flex-1" onClick={() => {
            if (aim) void command(true);
            else { setAim(true); setMessage(""); }
          }}>{busy ? "명령 처리 중…" : aim ? "여기로 이동" : "이동"}</button>
          {aim ? <button disabled={busy} className="joseon-button" onClick={() => setAim(false)}>취소</button> : own && phase !== "returning" && <button disabled={busy} className="joseon-button" onClick={() => void command(false)}>영주성 귀환</button>}
        </div>
      </div>}
      {message && <p role="status" className="mt-2 text-sm font-bold">{message}</p>}
    </section>
  </>;
}
