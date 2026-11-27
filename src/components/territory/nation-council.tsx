"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Proclamation {
  id: string;
  name: string;
  castleName: string;
  proposer: string;
  mine: boolean;
  status: "pending" | "approved" | "rejected";
  consent: boolean | null;
  deadline: number;
  agreed: number;
  total: number;
}

interface CouncilSnapshot {
  declarations: Proclamation[];
  nation: { id: string; name: string; myRole: string } | null;
}

export function useNationCouncil(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<CouncilSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    const seq = ++sequence.current;
    try {
      const res = await fetch("/api/nations", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (seq !== sequence.current) return;
      if (!Array.isArray(data.declarations)) throw new Error();
      setSnapshot({ declarations: data.declarations, nation: data.nation ?? null });
      setLoadError(false);
    } catch {
      if (seq === sequence.current) setLoadError(true);
    }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const visible = (): void => { if (!document.hidden) void refresh(); };
    visible();
    const timer = window.setInterval(visible, 15000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      sequence.current++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, refresh]);
  const nation = snapshot?.nation;
  const title = nation ? (nation.myRole === "leader" ? "국왕" : "제후") : "부족장";
  return { snapshot, refresh, loadError, title };
}

export type NationCouncilState = ReturnType<typeof useNationCouncil>;

interface CouncilProps {
  council: NationCouncilState;
  castleKeys: string[];
  names?: Record<string, string>;
}

const command = "joseon-command min-h-9 rounded-lg bg-[#263b31] px-3 text-sm font-bold text-[#fff4d8] disabled:opacity-50";

export function NationCouncil({ council, castleKeys, names }: CouncilProps) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const inFlight = useRef(false);
  const castle = castleKeys.includes(selected) ? selected : castleKeys[0] ?? "";
  const submit = async (body: { action: "vote"; id: string; consent: boolean } | { action: "propose"; castleKey: string; name: string }): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch("/api/nations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || "요청을 처리하지 못했습니다.");
      if (body.action === "propose") setName("");
      setFeedback(body.action === "propose" ? "선포를 접수했습니다." : "응답을 기록했습니다.");
      window.dispatchEvent(new Event("nation-territory-changed"));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "연결을 확인해 주세요.");
    } finally {
      await council.refresh();
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="mt-3 border-t border-[#ae976a] pt-3 text-[#26352d]" aria-label="국가 선포">
      <h3 className="font-black">국가 선포</h3>
      {council.snapshot?.nation && <p className="mt-1 font-bold">{council.snapshot.nation.name} · {council.title}</p>}
      {council.loadError && <p role="status">소식을 불러오지 못했습니다. <button className="underline" onClick={() => void council.refresh()}>다시 불러오기</button></p>}
      {council.snapshot?.declarations.map(p => (
        <article key={p.id} className="mt-2 rounded-lg border border-[#aa9062] bg-[#fffaf0] px-3 py-2 text-sm">
          <div className="flex items-start justify-between gap-2"><strong className="break-all">{p.name}</strong><span className="shrink-0">{p.status === "pending" ? "동의 대기" : p.status === "approved" ? "건국 성립" : "부결"}</span></div>
          <p>{p.castleName} · 선포자 {p.proposer}</p>
          {p.status === "approved" && p.consent === null && <p>응답 기한 만료 · 미가입</p>}
          {p.status === "pending" && <p>응답 기한 {new Date(p.deadline).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>}
          {p.status === "pending" && <p className="mt-1">동의 {p.agreed} / {p.total}명{p.consent === true ? " · 내 동의 완료" : ""}</p>}
          {p.status === "pending" && p.consent === null && <div className="mt-2 flex gap-2">
            <button className={command} disabled={busy} onClick={() => void submit({ action: "vote", id: p.id, consent: true })}>동의</button>
            <button className="rounded-lg border border-[#90784e] px-3 font-bold" disabled={busy} onClick={() => void submit({ action: "vote", id: p.id, consent: false })}>반대</button>
          </div>}
        </article>
      ))}
      {castle && <form className="mt-2 grid gap-2" onSubmit={e => {
        e.preventDefault();
        void submit({ action: "propose", castleKey: castle, name: name.trim() });
      }}>
        <p className="text-xs leading-5">이 동에 성이 있거나 마지막 게임 위치가 이 동인 플레이어에게 알립니다. 전원 동의 시 즉시 건국하며, 한 명이라도 반대하면 부결됩니다. 24시간이 지나면 동의한 사람만 참여합니다. 선포자는 국왕, 동의자는 제후가 되며 미응답자는 가입하지 않습니다.</p>
        {castleKeys.length > 1 && <select aria-label="선포할 성" className="rounded border border-[#aa9062] bg-[#fffaf0] p-2" value={castle} onChange={e => setSelected(e.target.value)}>
          {castleKeys.map(key => <option key={key} value={key}>{names?.[key] || key}</option>)}
        </select>}
        <div className="flex gap-2"><input aria-label="국호" className="min-w-0 flex-1 rounded border border-[#aa9062] bg-[#fffaf0] px-2" value={name} onChange={e => setName(e.target.value)} maxLength={30} placeholder="국호 (2~30자)" />
          <button className={command} disabled={busy || name.trim().length < 2}>국가 선포</button></div>
      </form>}
      <p role="status" className="mt-1 text-sm">{feedback}</p>
    </section>
  );
}
