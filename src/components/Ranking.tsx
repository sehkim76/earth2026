'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trophy, Crown, Medal, Star, X } from 'lucide-react';

export type RankingItem = {
  nickname: string;
  score: number;
};

type RankingProps = {
    title?: string;
    subtitle?: string;

    /**
     * 랭킹 데이터 (정렬되지 않아도 됨)
     */
    items: RankingItem[];

    /**
     * 내 닉네임 (있으면 하단에 내 기록 표시)
     */
    myNickname?: string;

    /**
     * 표시 개수
     */
    topN?: number;

    /**
     * 점수 포맷
     */
    scoreSuffix?: string; // 예: "점"

    /**
     * 다시하기 버튼
     */
    showRestartButton?: boolean;
    onRestart?: () => void;

    showExitButton?: boolean;
    exitLabel?: string;
    onExit?: () => void;

    mapToolbar?: {
        onRanking: () => void;
        onQR: () => void;
        onExit: () => void;
        onResetScore: () => void;
        activeButton?: "ranking" | "qr" | "exit" | "reset";
    };
    embedded?: boolean;
};

export default function Ranking({
    title = 'RANKING',
    subtitle = 'TOP 플레이어 점수',
    items,
    myNickname,
    topN = 10,
    scoreSuffix = '점',
    showRestartButton = true,
    onRestart,
    showExitButton = false,
    exitLabel = '나가기',
    onExit,
    mapToolbar,
    embedded = false,

}: RankingProps) {
    const nicknameContainerRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const nicknameMeasureRefs = useRef<Record<string, HTMLSpanElement | null>>({});
    const rankingScrollContainerRef = useRef<HTMLDivElement | null>(null);
    const myInfoCardRef = useRef<HTMLDivElement | null>(null);
    const [overflowMap, setOverflowMap] = useState<Record<string, boolean>>({});
    const [showFloatingMyInfo, setShowFloatingMyInfo] = useState(false);

    const sorted = useMemo(() => {
        return [...items].sort((a, b) => b.score - a.score).slice(0, topN);
    }, [items, topN]);

    useLayoutEffect(() => {
        const checkOverflow = () => {
            const nextMap: Record<string, boolean> = {};

            sorted.forEach((row, i) => {
                const rank = i + 1;
                const rowKey = `${row.nickname}-${row.score}-${rank}`;
                const container = nicknameContainerRefs.current[rowKey];
                const measure = nicknameMeasureRefs.current[rowKey];

                if (!container || !measure) {
                    nextMap[rowKey] = false;
                    return;
                }

                nextMap[rowKey] = measure.scrollWidth > container.clientWidth;
            });

            setOverflowMap(nextMap);
        };

        checkOverflow();
        const resizeHandler = () => checkOverflow();
        window.addEventListener('resize', resizeHandler);

        return () => {
            window.removeEventListener('resize', resizeHandler);
        };
    }, [sorted]);

    const myInfo = useMemo(() => {
        if (!myNickname) return null;
        const allSorted = [...items].sort((a, b) => b.score - a.score);
        const idx = allSorted.findIndex((x) => x.nickname === myNickname);
        if (idx === -1) return null;
        return {
        rank: idx + 1,
        score: allSorted[idx].score,
        nickname: allSorted[idx].nickname,
        };
    }, [items, myNickname]);

    const getRankIcon = (rank: number) => {
        if (rank === 1) return <Crown size={15} strokeWidth={2.5} className="text-amber-300" />;
        if (rank === 2) return <Medal size={15} strokeWidth={2.5} className="text-slate-300" />;
        if (rank === 3) return <Star size={15} strokeWidth={2.5} className="text-orange-300" />;
        return null;
    };

    const baseRounded = 'rounded-2xl';
    const RANKING_MAP_TOOLBAR_RESERVED_PX = 104;
    const rankingScrollViewportHeight = embedded
        ? '100%'
        : mapToolbar
          ? `calc(100dvh - ${RANKING_MAP_TOOLBAR_RESERVED_PX}px - env(safe-area-inset-bottom))`
          : '100dvh';

    const getRowClass = (rank: number) => {
        if (rank === 1) return `border-amber-200/25 bg-[linear-gradient(120deg,rgba(120,72,12,0.42),rgba(30,27,16,0.72)_55%,rgba(15,17,26,0.82))] shadow-[0_10px_28px_rgba(217,119,6,0.22),inset_0_1px_0_rgba(255,255,255,0.12)] ${baseRounded}`;
        if (rank === 2) return `border-slate-200/20 bg-[linear-gradient(120deg,rgba(100,116,139,0.32),rgba(30,34,48,0.72)_55%,rgba(15,17,26,0.82))] shadow-[0_10px_28px_rgba(100,116,139,0.22),inset_0_1px_0_rgba(255,255,255,0.1)] ${baseRounded}`;
        if (rank === 3) return `border-orange-200/20 bg-[linear-gradient(120deg,rgba(154,82,32,0.36),rgba(34,24,18,0.72)_55%,rgba(15,17,26,0.82))] shadow-[0_10px_28px_rgba(194,120,52,0.2),inset_0_1px_0_rgba(255,255,255,0.1)] ${baseRounded}`;
        return `border-white/10 bg-white/[0.045] shadow-[0_8px_20px_rgba(2,6,23,0.5),inset_0_1px_0_rgba(255,255,255,0.06)] ${baseRounded}`;
    };

    const getRowTextClass = (rank: number) => (rank <= 3 ? 'text-white' : 'text-slate-100');
    const getScoreSuffixClass = (rank: number) =>
        rank <= 3 ? 'text-white/55' : 'text-slate-400';
    const getRankBadgeClass = (rank: number) => {
        if (rank === 1) {
            return 'border-amber-100/50 bg-[linear-gradient(145deg,#fde68a,#d97706_60%,#92400e)] text-amber-950 shadow-[0_4px_14px_rgba(217,119,6,0.45),inset_0_1px_0_rgba(255,255,255,0.55)]';
        }
        if (rank === 2) {
            return 'border-slate-100/50 bg-[linear-gradient(145deg,#f1f5f9,#94a3b8_60%,#475569)] text-slate-900 shadow-[0_4px_14px_rgba(148,163,184,0.4),inset_0_1px_0_rgba(255,255,255,0.6)]';
        }
        if (rank === 3) {
            return 'border-orange-100/50 bg-[linear-gradient(145deg,#fed7aa,#c2703d_60%,#7c3f16)] text-orange-950 shadow-[0_4px_14px_rgba(194,120,52,0.4),inset_0_1px_0_rgba(255,255,255,0.5)]';
        }

        return 'border-white/15 bg-white/[0.07] text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]';
    };

    const getPodiumBarClass = (rank: number) => {
        if (rank === 1) return 'bg-[linear-gradient(180deg,#fde68a,#f59e0b,#92400e)] shadow-[0_0_12px_rgba(245,158,11,0.8)]';
        if (rank === 2) return 'bg-[linear-gradient(180deg,#f8fafc,#94a3b8,#475569)] shadow-[0_0_12px_rgba(148,163,184,0.7)]';
        if (rank === 3) return 'bg-[linear-gradient(180deg,#fed7aa,#c2703d,#7c3f16)] shadow-[0_0_12px_rgba(194,120,52,0.7)]';
        return 'bg-white/10';
    };

    useEffect(() => {
        if ((!mapToolbar && !embedded) || !myInfo) {
            return;
        }

        const scrollContainer = rankingScrollContainerRef.current;
        const myInfoCard = myInfoCardRef.current;
        if (!scrollContainer || !myInfoCard) {
            return;
        }

        const updateFloatingMyInfoVisibility = () => {
            const scrollRect = scrollContainer.getBoundingClientRect();
            const myInfoRect = myInfoCard.getBoundingClientRect();
            const isMyInfoBelowViewport = myInfoRect.top > scrollRect.bottom - 1;
            setShowFloatingMyInfo(isMyInfoBelowViewport);
        };

        const rafId = window.requestAnimationFrame(updateFloatingMyInfoVisibility);

        scrollContainer.addEventListener('scroll', updateFloatingMyInfoVisibility, { passive: true });
        window.addEventListener('resize', updateFloatingMyInfoVisibility);

        return () => {
            window.cancelAnimationFrame(rafId);
            scrollContainer.removeEventListener('scroll', updateFloatingMyInfoVisibility);
            window.removeEventListener('resize', updateFloatingMyInfoVisibility);
        };
    }, [mapToolbar, myInfo, embedded]);

    return (
        <div className={`relative w-full overflow-hidden bg-slate-950 ${embedded ? 'h-full' : 'h-dvh'}`}>
            {/* ambient background: deep stage + indigo crown glow + faint gold shimmer */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_38%_at_50%_-4%,rgba(129,140,248,0.28),transparent_70%)]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_45%_22%_at_50%_0%,rgba(245,158,11,0.1),transparent_70%)]" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-[radial-gradient(ellipse_70%_60%_at_50%_115%,rgba(34,211,238,0.12),transparent_70%)]" />
                  {/* ✅ 우측 상단 고정 나가기 버튼 */}
        {showExitButton && (
            <button
            type="button"
            onClick={onExit}
            aria-label={exitLabel}
            className={
                'fixed top-4 right-4 z-50 ' +
                'rounded-full px-4 py-2.5 ' +
                'bg-white/[0.07] backdrop-blur-md ' +
                'border border-white/15 shadow-[0_8px_24px_rgba(2,6,23,0.5)] ' +
                'text-slate-200 text-sm font-bold uppercase tracking-wider ' +
                'hover:bg-white/[0.12] hover:text-white active:translate-y-0.5 transition-all ' +
                'flex items-center gap-2'
            }
            >
            <X size={16} strokeWidth={2.5} />
            {exitLabel}
            </button>
        )}

            <div
                ref={rankingScrollContainerRef}
                className="relative w-full overflow-y-auto overscroll-y-contain px-3 pt-6 pb-4 touch-pan-y [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                style={{ height: rankingScrollViewportHeight }}
            >

            {/* 메인 카드 */}
            <div className="mx-auto w-full max-w-full rounded-3xl border border-white/10 bg-white/[0.04] px-3 py-5 shadow-[0_24px_60px_rgba(2,6,23,0.6)] backdrop-blur-xl">
                <div className="flex flex-col items-center gap-1 text-center">
                {/* 상단 아이콘 */}
                <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/20 bg-[linear-gradient(150deg,#818cf8,#4f46e5_55%,#312e81)] text-white shadow-[0_12px_32px_rgba(79,70,229,0.5),inset_0_1px_0_rgba(255,255,255,0.35)]">
                    <Trophy size={28} strokeWidth={2.25} className="drop-shadow-[0_2px_6px_rgba(0,0,0,0.4)]" />
                    <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[linear-gradient(180deg,rgba(255,255,255,0.22),transparent_45%)]" />
                </div>

                {/* 타이틀 */}
                <div className="mt-3 space-y-1.5">
                    <p className="text-[11px] font-bold uppercase tracking-[0.35em] text-amber-200/80">
                    {title}
                    </p>
                    <h1 className="text-[26px] font-black leading-tight tracking-tight text-white sm:text-3xl">
                    {subtitle}
                    </h1>
                    <div className="mx-auto flex items-center justify-center gap-2 pt-1">
                        <span className="h-px w-10 bg-gradient-to-r from-transparent to-amber-200/50" />
                        <span className="h-1 w-1 rounded-full bg-amber-300/80" />
                        <span className="h-px w-10 bg-gradient-to-l from-transparent to-amber-200/50" />
                    </div>
                </div>

                {/* 랭킹 리스트 */}
                <div className="w-full mt-4 space-y-2">
                    <div className="w-full rounded-2xl border border-white/[0.07] bg-black/30 p-2 shadow-[inset_0_2px_12px_rgba(0,0,0,0.45)] sm:p-2.5">
                        <div className="flex flex-col gap-1.5">
                            {sorted.map((row, i) => {
                                const rank = i + 1;
                                const isMe = myNickname && row.nickname === myNickname;
                                const rowKey = `${row.nickname}-${row.score}-${rank}`;
                                const isOverflowing = overflowMap[rowKey] ?? false;
                                const tickerDuration = `${Math.max(6, row.nickname.length * 0.55)}s`;
                                const rowTextClass = getRowTextClass(rank);
                                const scoreSuffixClass = getScoreSuffixClass(rank);
                                const rankBadgeClass = getRankBadgeClass(rank);
                                const isTopThree = rank <= 3;

                                return (
                                    <div
                                        key={rowKey}
                                        className={`
                                            relative w-full overflow-hidden px-3 sm:px-4 ${isTopThree ? 'py-3' : 'py-2.5'}
                                            border
                                            grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3
                                            ${getRowClass(rank)}
                                            ${isMe ? 'ring-1 ring-cyan-300/60 shadow-[0_0_0_1px_rgba(103,232,249,0.35),0_10px_28px_rgba(34,211,238,0.18)]' : ''}
                                        `}
                                    >
                                        {isTopThree ? (
                                            <span className={`absolute left-0 top-0 h-full w-[3px] ${getPodiumBarClass(rank)}`} />
                                        ) : null}
                                        <div className="flex min-w-0 items-center gap-2.5 pl-0.5">
                                            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${rankBadgeClass}`}>
                                                <span className="inline-flex w-[1.4ch] justify-center font-mono font-black text-[15px] leading-none tabular-nums">
                                                    {rank}
                                                </span>
                                            </div>
                                            <div className={`flex min-w-0 items-center gap-1.5 font-bold ${rowTextClass}`}>
                                                <span className="inline-flex h-6 w-6 flex-none items-center justify-center">
                                                    {getRankIcon(rank)}
                                                </span>
                                                <div
                                                    ref={(node) => {
                                                        nicknameContainerRefs.current[rowKey] = node;
                                                    }}
                                                    className="relative min-w-0 overflow-hidden"
                                                >
                                                    <span
                                                        ref={(node) => {
                                                            nicknameMeasureRefs.current[rowKey] = node;
                                                        }}
                                                        className="pointer-events-none absolute opacity-0 whitespace-nowrap text-[15px] sm:text-base"
                                                    >
                                                        {row.nickname}
                                                    </span>

                                                    <span
                                                        className={`inline-flex whitespace-nowrap text-[15px] sm:text-base ${isOverflowing ? 'ranking-ticker' : 'ranking-ticker-static'}`}
                                                        style={isOverflowing ? { animationDuration: tickerDuration } : undefined}
                                                    >
                                                        <span className="pr-8">{row.nickname}</span>
                                                        <span className={isOverflowing ? 'pr-8' : 'hidden'}>{row.nickname}</span>
                                                    </span>
                                                </div>
                                                {isMe ? (
                                                    <span className="shrink-0 rounded-full border border-cyan-200/40 bg-cyan-400/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-cyan-200">
                                                        나
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                        <div className="flex items-baseline justify-end gap-1.5 whitespace-nowrap">
                                            <span className={`font-black text-xl sm:text-2xl tabular-nums tracking-tight ${rowTextClass}`}>
                                                {row.score.toLocaleString()}
                                            </span>
                                            <span className={`text-[11px] font-bold uppercase tracking-[0.18em] ${scoreSuffixClass}`}>
                                                {scoreSuffix}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}

                            {sorted.length === 0 && (
                            <div className="flex flex-col items-center gap-2 py-12 text-center">
                                <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-slate-400">
                                    <Trophy size={20} strokeWidth={2} />
                                </span>
                                <p className="text-sm font-bold tracking-wide text-slate-300">
                                아직 랭킹 데이터가 없습니다
                                </p>
                                <p className="text-[11px] font-medium tracking-widest text-slate-500 uppercase">
                                첫 기록의 주인공이 되어 보세요
                                </p>
                            </div>
                            )}
                        </div>
                    </div>

                    {/* 내 정보 */}
                    {myInfo && (
                    <div
                        ref={myInfoCardRef}
                        className="relative w-full overflow-hidden rounded-2xl border border-cyan-200/25 bg-[linear-gradient(120deg,rgba(14,60,80,0.75),rgba(21,32,68,0.8)_55%,rgba(12,14,28,0.85))] p-3.5 shadow-[0_14px_36px_rgba(34,211,238,0.16),inset_0_1px_0_rgba(255,255,255,0.12)]"
                    >
                        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/60 to-transparent" />
                        <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-100/30 bg-cyan-950/80 text-cyan-100 shadow-[0_6px_18px_rgba(34,211,238,0.25),inset_0_1px_0_rgba(255,255,255,0.15)]">
                            <span className="inline-flex w-full items-center justify-center text-center font-black text-lg leading-none tabular-nums">
                                {myInfo.rank}
                            </span>
                            </div>
                            <div className="min-w-0 text-left">
                            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-200/70">
                                내 등수
                            </div>
                            <div className="truncate text-[17px] font-black text-white">
                                {myInfo.nickname}
                            </div>
                            </div>
                        </div>

                        <div className="shrink-0 text-right">
                            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-200/70">
                            내 점수
                            </div>
                            <div className="text-[22px] font-black tabular-nums tracking-tight text-white">
                            {myInfo.score.toLocaleString()}
                            <span className="ml-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-200/70">
                                {scoreSuffix}
                            </span>
                            </div>
                        </div>
                        </div>
                    </div>
                    )}

                </div>
                </div>
            </div>

            {/* 하단 설명 */}
            <div className="mt-3 flex items-center justify-center gap-2 text-center text-[10px] font-bold uppercase tracking-[0.25em] text-slate-500">
                <span className="h-px w-6 bg-white/10" />
                점수는 높은 순으로 정렬됩니다
                <span className="h-px w-6 bg-white/10" />
            </div>

            </div>

{(mapToolbar || embedded) && myInfo && showFloatingMyInfo ? (
  <div
    className="pointer-events-none fixed left-0 right-0 z-[1001] px-3"
    style={{ bottom: `calc(${RANKING_MAP_TOOLBAR_RESERVED_PX}px + env(safe-area-inset-bottom) + 8px)` }}
  >
    <div className="relative mx-auto w-full overflow-hidden rounded-2xl border border-cyan-200/25 bg-[linear-gradient(120deg,rgba(14,60,80,0.92),rgba(21,32,68,0.94)_55%,rgba(12,14,28,0.95))] p-3.5 shadow-[0_14px_36px_rgba(34,211,238,0.25)] backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/60 to-transparent" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-100/30 bg-cyan-950/80 text-cyan-100 shadow-[0_6px_18px_rgba(34,211,238,0.25)]">
            <span className="inline-flex w-full items-center justify-center text-center font-black text-lg leading-none tabular-nums">
              {myInfo.rank}
            </span>
          </div>
          <div className="min-w-0 text-left">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-200/70">내 등수</div>
            <div className="truncate text-[17px] font-black text-white">{myInfo.nickname}</div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-200/70">내 점수</div>
          <div className="text-[22px] font-black tabular-nums tracking-tight text-white">
            {myInfo.score.toLocaleString()}
            <span className="ml-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-200/70">{scoreSuffix}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
) : null}

{mapToolbar ? (
  <div className="pointer-events-none fixed bottom-0 left-0 right-0 z-[1000]">
    <div className="pointer-events-auto relative flex w-full justify-center border-t border-indigo-900/50 px-4 py-3">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.55),rgba(49,46,129,0.85)_80%,rgba(49,46,129,1))]" />
      <div className="relative flex items-end gap-6">
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={mapToolbar.onRanking}
            className={`h-14 w-14 shrink-0 rounded-2xl border backdrop-blur-md active:translate-y-0.5 ${
              mapToolbar.activeButton === "ranking"
                ? "translate-y-0.5 border-amber-200/80 bg-white/25 shadow-[inset_0_2px_8px_rgba(15,23,42,0.55)]"
                : "border-white/20 bg-white/10 shadow-lg shadow-indigo-900/30"
            }`}
            aria-pressed={mapToolbar.activeButton === "ranking"}
          >
            <img src="/ranking_icon.png" alt="랭킹" className="h-full w-full rounded-2xl object-contain p-2" />
          </button>
          <span
            className={`text-[11px] font-medium drop-shadow-md ${
              mapToolbar.activeButton === "ranking" ? "text-amber-100" : "text-white"
            }`}
          >
            랭킹
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={mapToolbar.onQR}
            className="h-14 w-14 shrink-0 rounded-2xl border border-white/20 bg-white/10 backdrop-blur-md shadow-lg shadow-indigo-900/30 active:translate-y-0.5"
          >
            <img src="/qrreader_icon.png" alt="QR" className="h-full w-full rounded-2xl object-contain p-2" />
          </button>
          <span className="text-[11px] font-medium text-white drop-shadow-md">QR읽기</span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={mapToolbar.onExit}
            className="h-14 w-14 shrink-0 rounded-2xl border border-white/20 bg-white/10 backdrop-blur-md shadow-lg shadow-indigo-900/30 active:translate-y-0.5"
          >
            <img src="/exit_icon.png" alt="나가기" className="h-full w-full rounded-2xl object-contain p-2" />
          </button>
          <span className="text-[11px] font-medium text-white drop-shadow-md">나가기</span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={mapToolbar.onResetScore}
            className="h-14 w-14 shrink-0 rounded-2xl border border-white/20 bg-white/10 backdrop-blur-md shadow-lg shadow-indigo-900/30 active:translate-y-0.5"
          >
            <img src="/exit_icon.png" alt="점수리셋" className="h-full w-full rounded-2xl object-contain p-2" />
          </button>
          <span className="text-[11px] font-medium text-white drop-shadow-md">점수리셋</span>
        </div>
      </div>
    </div>
  </div>
) : null}

        </div>
    );
}
