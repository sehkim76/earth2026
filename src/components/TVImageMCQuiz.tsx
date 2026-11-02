'use client';
import React, { useEffect, useMemo, useState } from "react";

type Choice = {
  id: "A" | "B" | "C" | "D";
  text: string;
};

type TVQuizProps = {
  imageUrl: string;
  imageAlt?: string;
  question: string;
  choices: Choice[];
  /** 정답 공개/채점용 (선택) */
  correctId?: Choice["id"];
  /** 선택 시 호출 (선택) */
  onSelect?: (id: Choice["id"]) => void;
  /** TV 리모컨/키보드용 (선택) */
  enableKeyboard?: boolean;
  /** 초기 선택값 (선택) */
  initialSelectedId?: Choice["id"] | null;
  /** 상단 배지 (선택) */
  badgeText?: string; // 예: "QUIZ 3/10"
};

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function TVImageMCQQuiz({
  imageUrl,
  imageAlt = "quiz image",
  question,
  choices,
  correctId,
  onSelect,
  enableKeyboard = true,
  initialSelectedId = null,
  badgeText = "QUIZ",
}: TVQuizProps) {
  const [selectedId, setSelectedId] = useState<Choice["id"] | null>(initialSelectedId);

  const choiceMap = useMemo(() => {
    const map = new Map<Choice["id"], Choice>();
    for (const c of choices) map.set(c.id, c);
    return map;
  }, [choices]);

  const select = (id: Choice["id"]) => {
    setSelectedId(id);
    onSelect?.(id);
  };

    useEffect(() => {
        if (!enableKeyboard) return;

        const handler = (e: KeyboardEvent) => {
            // 1~4, A~D 입력으로 선택
            const key = e.key.toLowerCase();

            if (key === "1" || key === "a") return select("A");
            if (key === "2" || key === "b") return select("B");
            if (key === "3" || key === "c") return select("C");
            if (key === "4" || key === "d") return select("D");

            // 방향키로 이동(선택된 항목 기준)
            if (!selectedId && (key === "arrowleft" || key === "arrowright" || key === "arrowup" || key === "arrowdown")) {
                // 아무것도 선택 안 됐으면 A로
                return select("A");
            }

            if (!selectedId) return;

            const order: Choice["id"][] = ["A", "B", "C", "D"];
            const idx = order.indexOf(selectedId);
            if (idx < 0) return;

            // 2x2 그리드로 가정: A B / C D
            const grid = {
                A: { right: "B", down: "C", left: "A", up: "A" },
                B: { left: "A", down: "D", right: "B", up: "B" },
                C: { right: "D", up: "A", left: "C", down: "C" },
                D: { left: "C", up: "B", right: "D", down: "D" },
            } as const;

            if (key === "arrowleft") return select(grid[selectedId].left);
            if (key === "arrowright") return select(grid[selectedId].right);
            if (key === "arrowup") return select(grid[selectedId].up);
            if (key === "arrowdown") return select(grid[selectedId].down);

            // Enter/Space: 그대로 유지 (이미 선택됨)
            if (key === "enter" || key === " ") return;
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [enableKeyboard, selectedId]);

    const getChoiceState = (id: Choice["id"]) => {
        const isSelected = selectedId === id;
        const isCorrect = correctId && id === correctId;
        const isWrongSelected = correctId && isSelected && id !== correctId;

        return { isSelected, isCorrect, isWrongSelected };
    };

    return (
        <div className="w-full min-h-screen bg-zinc-950 text-white">
            <div className="mx-auto max-w-[1400px] px-10 py-10">
                {/* Header */}
                <div className="flex items-center justify-between gap-6">
                    <div className="inline-flex items-center gap-3 rounded-2xl bg-white/10 px-6 py-3">
                        <span className="text-2xl font-black tracking-wide">{badgeText}</span>
                    </div>

                    <div className="text-right text-sm text-white/60">
                        {enableKeyboard && (
                        <div className="leading-relaxed">
                            <span className="font-semibold text-white/80">키보드</span>:
                            <span className="ml-2">1~4 또는 A~D, 방향키</span>
                        </div>
                        )}
                    </div>
                </div>

                {/* Main layout */}
                <div className="mt-8 grid grid-cols-12 gap-10">
                    {/* Image */}
                    <div className="col-span-12 lg:col-span-6 items-center flex">
                        <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-white/5 shadow-2xl">
                            <div className="aspect-[16/10] w-full">
                                <img
                                src={imageUrl}
                                alt={imageAlt}
                                className="h-full w-full object-cover"
                                draggable={false}
                                />
                            </div>

                            <div className="absolute left-6 top-6 rounded-2xl bg-black/55 px-4 py-2 backdrop-blur">
                                <span className="text-lg font-semibold text-white/90">그림을 보고 정답을 고르세요</span>
                            </div>
                        </div>
                    </div>

                    {/* Question + Choices */}
                    <div className="col-span-12 lg:col-span-6 flex flex-col">
                        <div className="rounded-[32px] border border-white/10 bg-white/5 p-10 shadow-2xl">
                            <div className="text-[34px] leading-tight font-extrabold tracking-tight">
                                {question}
                            </div>

                            <div className="mt-8 grid grid-cols-1 gap-5">
                                {/* 2x2 느낌을 주기 위해 lg 이상에서 2열 */}
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                {choices.map((c) => {
                                    const { isSelected, isCorrect, isWrongSelected } = getChoiceState(c.id);

                                    return (
                                    <button
                                        key={c.id}
                                        type="button"
                                        onClick={() => select(c.id)}
                                        className={cn(
                                        "group relative w-full rounded-[26px] border px-7 py-7 text-left transition",
                                        "focus:outline-none focus-visible:ring-4 focus-visible:ring-white/25",
                                        "active:scale-[0.99]",
                                        isSelected ? "border-white/40 bg-white/12" : "border-white/10 bg-white/5 hover:bg-white/10",
                                        isCorrect ? "border-emerald-300/60 bg-emerald-300/10" : "",
                                        isWrongSelected ? "border-rose-300/60 bg-rose-300/10" : ""
                                        )}
                                    >
                                        <div className="flex items-start gap-5">
                                        <div
                                            className={cn(
                                            "flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border text-2xl font-black",
                                            isCorrect
                                                ? "border-emerald-300/60 bg-emerald-300/15 text-emerald-100"
                                                : isWrongSelected
                                                ? "border-rose-300/60 bg-rose-300/15 text-rose-100"
                                                : isSelected
                                                    ? "border-white/35 bg-white/10 text-white"
                                                    : "border-white/15 bg-black/20 text-white/85"
                                            )}
                                        >
                                            {c.id}
                                        </div>

                                        <div className="min-w-0 flex-1">
                                            <div className="text-[26px] leading-snug font-semibold text-white">
                                            {c.text}
                                            </div>

                                            {/* 상태 라벨(정답 공개 시) */}
                                            {correctId && (
                                            <div className="mt-3 text-base font-semibold">
                                                {isCorrect && <span className="text-emerald-200">정답</span>}
                                                {isWrongSelected && <span className="text-rose-200">오답</span>}
                                            </div>
                                            )}
                                        </div>
                                        </div>

                                        {/* 선택 강조 바 */}
                                        <div
                                        className={cn(
                                            "pointer-events-none absolute inset-x-0 bottom-0 h-1.5 rounded-b-[26px] opacity-0 transition",
                                            isSelected ? "opacity-100" : "group-hover:opacity-60"
                                        )}
                                        />
                                    </button>
                                    );
                                })}
                                </div>
                            </div>

                            {/* Footer */}
                            <div className="mt-8 flex items-center justify-between gap-6">
                                <div className="text-lg text-white/70">
                                선택:{" "}
                                <span className="font-black text-white">
                                    {selectedId ?? "—"}
                                </span>
                                </div>

                                <div className="flex gap-3">
                                <button
                                    type="button"
                                    onClick={() => setSelectedId(null)}
                                    className="rounded-2xl border border-white/10 bg-white/5 px-6 py-4 text-lg font-bold text-white/85 hover:bg-white/10"
                                >
                                    선택 해제
                                </button>

                                <button
                                    type="button"
                                    onClick={() => selectedId && onSelect?.(selectedId)}
                                    disabled={!selectedId}
                                    className={cn(
                                    "rounded-2xl px-7 py-4 text-lg font-black transition",
                                    selectedId
                                        ? "bg-white text-black hover:opacity-90"
                                        : "bg-white/20 text-white/40 cursor-not-allowed"
                                    )}
                                >
                                    확정
                                </button>
                                </div>
                            </div>
                        </div>

                        {/* TV용 여백 */}
                        <div className="mt-6 text-base text-white/50">
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * 사용 예시:
 *
 * <TVImageMCQQuiz
 *   badgeText="QUIZ 1/5"
 *   imageUrl="/quiz/fruit.jpg"
 *   question="사진 속 과일은 무엇인가요?"
 *   choices={[
 *     { id: "A", text: "사과" },
 *     { id: "B", text: "배" },
 *     { id: "C", text: "복숭아" },
 *     { id: "D", text: "자두" },
 *   ]}
 *   // correctId="A"
 *   onSelect={(id) => console.log("selected:", id)}
 * />
 */
