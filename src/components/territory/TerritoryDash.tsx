"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface TerritoryMe {
  class: string;
  influence: number;
  ownedCastles: number;
  unitsAlive: number;
  unitCap: number;
  contribution: number;
}

const CLASS_LABEL: Record<string, string> = {
  slave: "노예",
  commoner: "평민",
  knight: "기사",
  noble: "귀족",
  lord: "영주",
};

const ROLL_DIGIT_PX = 20;

/** 슬롯머신식 숫자 롤러 (자릿수별 세로 릴). */
function RollingNumber({ value }: { value: number }) {
  const digits = String(Math.max(0, Math.trunc(value))).split("");
  return (
    <span
      className="flex h-5 items-center leading-none tabular-nums"
      aria-label={String(value)}
    >
      {digits.map((digit, index) => (
        <span
          key={`${index}-${digits.length}`}
          className="inline-block h-5 w-[0.62em] overflow-hidden text-center"
        >
          <span
            className="flex flex-col"
            style={{
              transform: `translateY(${-(Number(digit) * ROLL_DIGIT_PX)}px)`,
              transition: `transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) ${index * 90}ms`,
            }}
          >
            {["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <span
                key={d}
                className="flex h-5 items-center justify-center text-sm font-extrabold leading-none"
              >
                {d}
              </span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

/** 영토전 모드 좌상단 플레이어 대시 (점수/미방문/랭킹 대체). */
export default function TerritoryDash() {
  const [me, setMe] = useState<TerritoryMe | null>(null);
  const [displayContribution, setDisplayContribution] = useState<number | null>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    let cancelled = false;
    let rafId = 0;
    // 퀴즈 복귀(scoreUpdated)시에만 상승 애니메이션 (리마운트돼도 addedScore로 복원).
    const returned = searchParams.get("scoreUpdated") === "true";
    const addedRaw = parseInt(searchParams.get("addedScore") ?? "", 10);
    const addedScore = Number.isFinite(addedRaw) && addedRaw > 0 ? addedRaw : 0;
    void fetch("/api/territory/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") {
          return;
        }
        const payload = data as Record<string, unknown>;
        if (payload.ok !== true) {
          return;
        }
        const next: TerritoryMe = {
          class: typeof payload.class === "string" ? payload.class : "slave",
          influence: typeof payload.influence === "number" ? payload.influence : 0,
          ownedCastles: typeof payload.ownedCastles === "number" ? payload.ownedCastles : 0,
          unitsAlive:
            typeof payload.unitsAlive === "number" ? payload.unitsAlive : 0,
          unitCap: typeof payload.unitCap === "number" ? payload.unitCap : 0,
          contribution:
            typeof payload.contribution === "number" ? payload.contribution : 0,
        };
        setMe(next);
        if (returned && addedScore > 0) {
          // 공헌 상승 카운트업 애니메이션 (ease-out, 3초).
          const from = Math.max(0, next.contribution - addedScore);
          const to = next.contribution;
          const duration = 3000;
          const startedAt = performance.now();
          const tick = (now: number): void => {
            if (cancelled) {
              return;
            }
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplayContribution(Math.round(from + (to - from) * eased));
            if (progress < 1) {
              rafId = requestAnimationFrame(tick);
            }
          };
          rafId = requestAnimationFrame(tick);
        } else {
          setDisplayContribution(next.contribution);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [searchParams]);

  if (!me) {
    return (
      <div className="pointer-events-auto w-max max-w-[72vw] whitespace-nowrap rounded-2xl border border-[#b9995d]/70 bg-[#14201f]/95 p-3 text-[#f3e8ce]">
        <p className="text-sm font-black">지휘 상황판</p>
        <p className="mt-1 text-xs text-[#c8bea8]">전황을 불러오는 중…</p>
      </div>
    );
  }

  return (
    <section
      aria-label="영토전 지휘 상황"
      className="pointer-events-auto w-max max-w-[72vw] overflow-hidden rounded-2xl border border-[#b9995d]/75 bg-[#14201f]/95 text-[#f3e8ce]"
    >
      <header className="flex items-center gap-2 whitespace-nowrap bg-[#1c2c28] px-2.5 py-1.5">
        <p className="text-xs font-black leading-none">영토전 지휘 상황판</p>
        <span className="rounded-md bg-[#344333] px-1.5 py-0.5 text-[11px] font-black text-[#f0d99d]">
          {CLASS_LABEL[me.class] ?? me.class}
        </span>
      </header>
      <div className="flex items-stretch gap-1 bg-[#263631] p-1">
        <div className="flex min-w-0 flex-col justify-center whitespace-nowrap px-2 py-1" title="영향력">
          <span className="text-[10px] font-bold text-[#c8bea8]">영향력</span>
          <span className="mt-0.5 text-lg font-black leading-none tabular-nums text-[#f0d99d]">{me.influence}</span>
        </div>
        <div className="flex min-w-0 flex-col justify-center whitespace-nowrap px-2 py-1" title="보유 성">
          <span className="text-[10px] font-bold text-[#c8bea8]">성</span>
          <span className="mt-1 text-sm font-black leading-none tabular-nums">{me.ownedCastles}</span>
        </div>
        <div className="flex min-w-0 flex-col justify-center whitespace-nowrap px-2 py-1" title="부대">
          <span className="text-[10px] font-bold text-[#c8bea8]">부대</span>
          <span className="mt-1 text-sm font-black leading-none tabular-nums">{me.unitsAlive}/{me.unitCap}</span>
        </div>
        <div className="flex min-w-0 flex-col justify-center whitespace-nowrap px-2 py-1" title="공헌">
          <span className="text-[10px] font-bold text-[#c8bea8]">공헌</span>
          <span className="mt-1 text-sm font-black leading-none tabular-nums"><RollingNumber value={displayContribution ?? me.contribution} /></span>
        </div>
      </div>
    </section>
  );
}
