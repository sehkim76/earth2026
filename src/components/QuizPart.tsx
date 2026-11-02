'use client';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { 
  CheckCircle2, 
  XCircle,
  Circle,
  Square,
  Triangle,
  Hexagon,

} from 'lucide-react';
import { QuizInfo } from "@/app/quiz/[EventKey]/quiz";
import { THEME_CONFIG } from "@/lib/armissionwebconfig";
import { AUTH_DEVICE_STORAGE_KEY, AUTH_NICKNAME_STORAGE_KEY } from "@/lib/auth-claim";
import { buildSiegeAnswer, checkCastleEntry, checkEventEntry, hashSiegeQuestion, isCastleEventKey } from "@/lib/game-score";
import { cn } from "@/lib/utils";
import { QuizAnswerChoice, QuizAnswerGrid } from "@/components/quiz/quiz-answer";
import { QuizFrame } from "@/components/quiz/quiz-frame";
import { QuizPanel } from "@/components/quiz/quiz-panel";

interface QuizPartProps {
    item: QuizInfo;
    eventKey: string;
    userId?: string;
    nickname?: string;
};

const QUIZ_TIME_LIMIT_SECONDS = 60;

const getQuizDeadlineStorageKey = (key: string): string => `quiz-deadline:${key}`;

const readQuizRemainingSeconds = (key: string): number | null => {
    try {
        const raw = window.sessionStorage.getItem(getQuizDeadlineStorageKey(key));
        if (!raw) {
            return null;
        }
        const deadline = Number(raw);
        if (!Number.isFinite(deadline)) {
            return null;
        }
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        if (remaining <= 0) {
            return null;
        }
        return Math.min(QUIZ_TIME_LIMIT_SECONDS, remaining);
    } catch {
        return null;
    }
};

const writeQuizDeadline = (key: string): void => {
    try {
        window.sessionStorage.setItem(
            getQuizDeadlineStorageKey(key),
            String(Date.now() + QUIZ_TIME_LIMIT_SECONDS * 1000)
        );
    } catch {
    }
};

const clearQuizDeadline = (key: string): void => {
    try {
        window.sessionStorage.removeItem(getQuizDeadlineStorageKey(key));
    } catch {
    }
};

const subscribeQuizDeadlineStorage = (onStoreChange: () => void): (() => void) => {
    window.addEventListener("storage", onStoreChange);
    return () => window.removeEventListener("storage", onStoreChange);
};

const getQuizDeadlineServerSnapshot = (): number => -1;

const makeScoreNonce = (): string => {
    const timePart = Date.now().toString(36);
    const randomPart = Math.floor(Math.random() * 36 ** 6).toString(36);
    return `${timePart}${randomPart}`;
};

const parseDifficulty = (value: unknown): number => {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? Math.max(1, Math.trunc(numeric)) : 1;
};

type QuizResultPayload = {
    ans: string;
    correct: boolean;
};

const getQuizResultStorageKey = (key: string): string => `quiz-result:${key}`;

const getNullSnapshot = (): null => null;

const readQuizResultRaw = (key: string): string | null => {
    try {
        return window.sessionStorage.getItem(getQuizResultStorageKey(key));
    } catch {
        return null;
    }
};

const writeQuizResult = (key: string, payload: QuizResultPayload): void => {
    try {
        window.sessionStorage.setItem(getQuizResultStorageKey(key), JSON.stringify(payload));
    } catch {
    }
};

const clearQuizResult = (key: string): void => {
    try {
        window.sessionStorage.removeItem(getQuizResultStorageKey(key));
    } catch {
    }
};

const parseQuizResultPayload = (raw: string): QuizResultPayload | null => {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        if (typeof record.ans !== "string" || typeof record.correct !== "boolean") {
            return null;
        }
        return { ans: record.ans, correct: record.correct };
    } catch {
        return null;
    }
};

export const QuizPart = ({ item, eventKey, userId, nickname }: QuizPartProps) => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const from = searchParams.get("from");
    const exitUrl = searchParams.get("exitUrl") ?? (from === "qr" ? "/qr" : "/map");
    const [ans, setAns] = useState('');
    const [done, setDone] = useState(false);
    const [correct, setCorrect] = useState(false);
    const [timeLeft, setTimeLeft] = useState(QUIZ_TIME_LIMIT_SECONDS);
    const [nextMissionPath, setNextMissionPath] = useState("/map");
    const [prevStoredRemaining, setPrevStoredRemaining] = useState<number | null>(null);
    const [prevStoredResultRaw, setPrevStoredResultRaw] = useState<string | null>(null);
    const [resultRestored, setResultRestored] = useState(false);
    const [alreadyVisited, setAlreadyVisited] = useState(false);
    const [wrongQr, setWrongQr] = useState(false);
    const [needsLogin, setNeedsLogin] = useState(false);
    const [entryChecked, setEntryChecked] = useState(false);
    // 성 공성 모드: castle- 이벤트는 재방문 가드 대신 쿨다운으로 통제한다.
    // 오답/포기는 score 0 제출(미방문)이라 재입장이 막히지 않는다. HP 차감은 Phase 2 resolve가 담당한다.
    const isCastleSiege = isCastleEventKey(eventKey);
    const [needsTerritory, setNeedsTerritory] = useState(false);
    const [siegeCooldown, setSiegeCooldown] = useState(false);
    const [siegeCooldownMinutes, setSiegeCooldownMinutes] = useState(60);
    const [siegeDailyCapped, setSiegeDailyCapped] = useState(false);
    const [siegeResult, setSiegeResult] = useState<{
        hp: number;
        maxHp: number;
        conquered: boolean;
    } | null>(null);
    const siegeQuestionHash = hashSiegeQuestion(
        `${item.Hint ?? ""}|${item.Ex1 ?? ""}|${item.Ex2 ?? ""}|${item.Ex3 ?? ""}|${item.Ex4 ?? ""}`
    );
    const siegeFailScore = isCastleSiege ? 0 : 1;
    const hasScoreSubmittedRef = useRef(false);
    const exOptions = [item.Ex1, item.Ex2, item.Ex3, item.Ex4].filter(Boolean) as string[];
    const isShortAnswer = item.AnswerType === "SA";
    const isQuizEmpty = !item.Hint && !item.HintImageURL && exOptions.length === 0 && !isShortAnswer && item.AnswerType !== "OX";
    const hintImage = item.HintImageURL;
    const buildNextMissionPath = useCallback((scoreToAdd: number, nonce?: string): string => {
        const scoreNonce = nonce ?? makeScoreNonce();
        const query = `scoreUpdated=true&addedScore=${scoreToAdd}&scoreNonce=${encodeURIComponent(scoreNonce)}`;
        const returnsToMap = exitUrl.startsWith("/map") && from !== "qr";
        const completionEventKey = searchParams.get("neutralEventKey")?.trim() || eventKey;
        const completedEventParam = returnsToMap && completionEventKey.startsWith("neutral-")
            ? `&completedEventKey=${encodeURIComponent(completionEventKey)}`
            : "";
        return exitUrl
            ? `${exitUrl}${exitUrl.includes("?") ? "&" : "?"}${query}${completedEventParam}`
            : (from === "map" ? `/map?${query}${completedEventParam}` : "/qr");
    }, [eventKey, exitUrl, from, searchParams]);
    const postQuizScore = useCallback((scoreToAdd: number, answer: string): void => {
        hasScoreSubmittedRef.current = true;
        const storedDeviceId = window.localStorage.getItem(AUTH_DEVICE_STORAGE_KEY)?.trim() ?? "";
        const storedNickname = window.localStorage.getItem(AUTH_NICKNAME_STORAGE_KEY)?.trim() ?? "";
        const resolvedUserId = userId?.trim() ?? "";
        const resolvedNickname = nickname?.trim() || storedNickname;
        void fetch("/api/updatescore", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                score: scoreToAdd,
                eventKey,
                answer,
                userId: resolvedUserId || undefined,
                nickname: resolvedNickname || undefined,
                deviceId: storedDeviceId || undefined,
                source: "quiz-part",
            }),
        }).catch((error: unknown) => {
            console.error("[QuizPart] updatescore request error", {
                eventKey,
                scoreToAdd,
                error,
            });
        });
    }, [eventKey, userId, nickname]);
    const check = (val: string) => {
        if (done || alreadyVisited || wrongQr || needsLogin || needsTerritory || siegeCooldown) return;
        setSiegeResult(null);
        setAns(val);
        const normalize = (value: unknown) => String(value ?? "").toUpperCase().trim();
        let expected: unknown = item.Answer;
        if (item.AnswerType === "MC" && item.Answer !== undefined) {
            const idx = Number(item.Answer);
            if (!Number.isNaN(idx) && idx >= 0 && idx < exOptions.length) {
                expected = exOptions[idx];
            }
        }
        const isCorrect = normalize(val) === normalize(expected);
        setCorrect(isCorrect);
        setDone(true);
        clearQuizDeadline(eventKey);
        writeQuizResult(eventKey, { ans: val, correct: isCorrect });

        const difficulty = parseDifficulty(item.Difficulty);
        const scoreToAdd = isCorrect ? difficulty : siegeFailScore;
        setNextMissionPath(buildNextMissionPath(scoreToAdd, makeScoreNonce()));
        const storedDeviceId = window.localStorage.getItem(AUTH_DEVICE_STORAGE_KEY)?.trim() ?? "";
        const storedNickname = window.localStorage.getItem(AUTH_NICKNAME_STORAGE_KEY)?.trim() ?? "";
        const resolvedUserId = userId?.trim() ?? "";
        const resolvedNickname = nickname?.trim() || storedNickname;
        const siegeAnswer = isCastleSiege
            ? buildSiegeAnswer(isCorrect ? "hit" : "miss", siegeQuestionHash)
            : val;

        hasScoreSubmittedRef.current = true;
        fetch("/api/updatescore", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                score: scoreToAdd,
                eventKey,
                answer: siegeAnswer,
                userId: resolvedUserId || undefined,
                nickname: resolvedNickname || undefined,
                deviceId: storedDeviceId || undefined,
                source: "quiz-part",
            }),
        })
            .then(async (res) => {
                let payload: unknown = null;
                try {
                    payload = await res.json();
                } catch {
                    payload = null;
                }

                if (!res.ok) {
                    console.error("[QuizPart] updatescore failed", {
                        status: res.status,
                        eventKey,
                        scoreToAdd,
                        payload,
                    });
                    return;
                }

                console.log("[QuizPart] updatescore success", {
                    eventKey,
                    scoreToAdd,
                    payload,
                });

                // 성 공성 적중: HP 차감 판정 (Phase 2 resolve)
                if (isCastleSiege && isCorrect) {
                    const record = payload as { scoreId?: unknown } | null;
                    const scoreId =
                        record && typeof record.scoreId === "number" ? record.scoreId : null;
                    if (scoreId !== null) {
                        void fetch("/api/territory/resolve", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({ castleKey: eventKey, scoreId }),
                        })
                            .then(async (resolveRes) => {
                                try {
                                    const resolvePayload = (await resolveRes.json()) as {
                                        ok?: unknown;
                                        hp?: unknown;
                                        maxHp?: unknown;
                                        conquered?: unknown;
                                    };
                                    if (
                                        resolveRes.ok &&
                                        resolvePayload.ok === true &&
                                        typeof resolvePayload.hp === "number" &&
                                        typeof resolvePayload.maxHp === "number"
                                    ) {
                                        setSiegeResult({
                                            hp: resolvePayload.hp,
                                            maxHp: resolvePayload.maxHp,
                                            conquered: resolvePayload.conquered === true,
                                        });
                                    }
                                } catch {
                                    // 판정 실패해도 점수는 기록됨. 다음 타에 재시도 가능.
                                }
                            })
                            .catch(() => {
                                // 판정 실패해도 점수는 기록됨. 다음 타에 재시도 가능.
                            });
                    }
                }
            })
            .catch((error) => {
                console.error("[QuizPart] updatescore request error", {
                    eventKey,
                    scoreToAdd,
                    error,
                });
            });
    };

    const giveUp = async () => {
        if (done || alreadyVisited || wrongQr || needsLogin || needsTerritory || siegeCooldown) return;
        clearQuizDeadline(eventKey);
        clearQuizResult(eventKey);
        const scoreToAdd = siegeFailScore;
        const destination = buildNextMissionPath(scoreToAdd, makeScoreNonce());
        setNextMissionPath(destination);
        const storedDeviceId = window.localStorage.getItem(AUTH_DEVICE_STORAGE_KEY)?.trim() ?? "";
        const storedNickname = window.localStorage.getItem(AUTH_NICKNAME_STORAGE_KEY)?.trim() ?? "";
        const resolvedUserId = userId?.trim() ?? "";
        const resolvedNickname = nickname?.trim() || storedNickname;
        hasScoreSubmittedRef.current = true;
        try {
            await fetch("/api/updatescore", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    score: scoreToAdd,
                    eventKey,
                    answer: isCastleSiege ? buildSiegeAnswer("giveup", siegeQuestionHash) : "(포기)",
                    userId: resolvedUserId || undefined,
                    nickname: resolvedNickname || undefined,
                    deviceId: storedDeviceId || undefined,
                    source: "quiz-giveup",
                }),
            });
        } catch (error: unknown) {
            hasScoreSubmittedRef.current = false;
            console.error("[QuizPart] giveup updatescore request error", {
                eventKey,
                error,
            });
        }
        router.push(destination);
    };

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };
    const timePercent = Math.max(0, (timeLeft / QUIZ_TIME_LIMIT_SECONDS) * 100);

    useEffect(() => {
        if (readQuizRemainingSeconds(eventKey) === null) {
            writeQuizDeadline(eventKey);
        }
        const remaining = readQuizRemainingSeconds(eventKey);
        if (remaining !== null) {
            setPrevStoredRemaining(remaining);
            setTimeLeft(remaining);
        }
    }, [eventKey]);

    useEffect(() => {
        if (!entryChecked || done || alreadyVisited || wrongQr || needsLogin || needsTerritory || siegeCooldown || timeLeft <= 0) {
            return;
        }

        const timer = setInterval(() => {
            setTimeLeft((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    if (!done) {
                        setDone(true);
                        setCorrect(false);
                        clearQuizDeadline(eventKey);
                        writeQuizResult(eventKey, { ans: "", correct: false });
                        setNextMissionPath(buildNextMissionPath(siegeFailScore));
                        if (!hasScoreSubmittedRef.current) {
                            postQuizScore(
                                siegeFailScore,
                                isCastleSiege
                                    ? `${buildSiegeAnswer("miss", siegeQuestionHash)} (시간초과)`
                                    : "(시간초과)"
                            );
                        }
                    }
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        return () => clearInterval(timer);
    }, [entryChecked, done, alreadyVisited, wrongQr, needsLogin, needsTerritory, siegeCooldown, timeLeft, eventKey, buildNextMissionPath, postQuizScore, isCastleSiege, siegeFailScore, siegeQuestionHash]);

    const getStoredRemaining = useCallback((): number => {
        return readQuizRemainingSeconds(eventKey) ?? -1;
    }, [eventKey]);
    const storedRemaining = useSyncExternalStore(
        subscribeQuizDeadlineStorage,
        getStoredRemaining,
        getQuizDeadlineServerSnapshot
    );

    if (!done && storedRemaining > 0 && storedRemaining !== prevStoredRemaining) {
        setPrevStoredRemaining(storedRemaining);
        setTimeLeft(storedRemaining);
    }

    const getStoredResultRaw = useCallback((): string | null => {
        return readQuizResultRaw(eventKey);
    }, [eventKey]);
    const storedResultRaw = useSyncExternalStore(
        subscribeQuizDeadlineStorage,
        getStoredResultRaw,
        getNullSnapshot
    );

    if (!done && storedResultRaw !== null && storedResultRaw !== prevStoredResultRaw) {
        const restored = parseQuizResultPayload(storedResultRaw);
        setPrevStoredResultRaw(storedResultRaw);
        if (restored) {
            setAns(restored.ans);
            setCorrect(restored.correct);
            setDone(true);
            setResultRestored(true);
            setNextMissionPath(buildNextMissionPath(restored.correct ? parseDifficulty(item.Difficulty) : siegeFailScore));
        }
    }

    useEffect(() => {
        if (!eventKey) {
            setEntryChecked(true);
            return;
        }
        let cancelled = false;
        // 성은 재방문 가드 대신 영토 게이트 + 쿨다운으로 통제한다.
        if (isCastleSiege) {
            void checkCastleEntry(eventKey)
                .then((result) => {
                    if (cancelled) {
                        return;
                    }
                    if (result.status === "disabled") {
                        setNeedsTerritory(true);
                    } else if (result.status === "cooldown") {
                        setSiegeCooldown(true);
                        setSiegeDailyCapped(result.dailyCapped);
                        setSiegeCooldownMinutes(
                            result.cooldownUntil !== null
                                ? Math.max(1, Math.ceil((result.cooldownUntil - Date.now()) / 60000))
                                : 60
                        );
                    } else if (result.status === "login") {
                        setNeedsLogin(true);
                    }
                })
                .finally(() => {
                    if (!cancelled) {
                        setEntryChecked(true);
                    }
                });
            return () => {
                cancelled = true;
            };
        }
        void checkEventEntry(eventKey)
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if (result === "visited") {
                    setAlreadyVisited(true);
                } else if (result === "blocked") {
                    setAlreadyVisited(true);
                    setWrongQr(true);
                } else if (result === "login") {
                    setNeedsLogin(true);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setEntryChecked(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [eventKey, isCastleSiege]);

    const storeResolved = storedRemaining >= 0 || storedResultRaw !== null;

    if (!entryChecked) {
        return (
            <QuizFrame isShortAnswer={isShortAnswer}>
                <div
                    aria-live="polite"
                    aria-busy="true"
                    className="flex h-full min-h-0 flex-col items-center justify-center gap-4 rounded-[24px] border border-white/20 bg-white/95 p-6 text-center shadow-[0_18px_56px_rgba(15,23,42,0.25)]"
                >
                    <p className="text-xl font-black tracking-tight text-slate-900">확인 중…</p>
                </div>
            </QuizFrame>
        );
    }

    if (needsLogin) {
        return (
            <QuizFrame isShortAnswer={isShortAnswer}>
                <div
                    role="alertdialog"
                    aria-live="polite"
                    className="flex h-full min-h-0 flex-col items-center justify-center gap-4 rounded-[24px] border border-white/20 bg-white/95 p-6 text-center shadow-[0_18px_56px_rgba(15,23,42,0.25)]"
                >
                    <p className="text-xl font-black tracking-tight text-slate-900">
                        로그인이 필요합니다
                    </p>
                    <button
                        type="button"
                        onClick={() => router.push(`/?callbackUrl=${encodeURIComponent(`/event?eventkey=${encodeURIComponent(eventKey)}`)}`)}
                        className="min-h-12 rounded-[20px] bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
                    >
                        로그인하러 가기
                    </button>
                </div>
            </QuizFrame>
        );
    }

    if (needsTerritory) {
        return (
            <QuizFrame isShortAnswer={isShortAnswer}>
                <div
                    role="alertdialog"
                    aria-live="polite"
                    className="flex h-full min-h-0 flex-col items-center justify-center gap-4 rounded-[24px] border border-white/20 bg-white/95 p-6 text-center shadow-[0_18px_56px_rgba(15,23,42,0.25)]"
                >
                    <p className="text-xl font-black tracking-tight text-slate-900">
                        지원하지 않는 미션입니다
                    </p>
                    <p className="text-sm text-slate-500">영토전이 열리는 미션에서만 공성할 수 있습니다.</p>
                    <button
                        type="button"
                        onClick={() => router.push(exitUrl)}
                        className="min-h-12 rounded-[20px] bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
                    >
                        지도로 이동
                    </button>
                </div>
            </QuizFrame>
        );
    }

    if (siegeCooldown) {
        return (
            <QuizFrame isShortAnswer={isShortAnswer}>
                <div
                    role="alertdialog"
                    aria-live="polite"
                    className="flex h-full min-h-0 flex-col items-center justify-center gap-4 rounded-[24px] border border-white/20 bg-white/95 p-6 text-center shadow-[0_18px_56px_rgba(15,23,42,0.25)]"
                >
                    <p className="text-xl font-black tracking-tight text-slate-900">
                        {siegeDailyCapped ? "오늘의 공성 상한(5회)을 썼습니다" : `공성 쿨다운 ${siegeCooldownMinutes}분 남음`}
                    </p>
                    <p className="text-sm text-slate-500">
                        {siegeDailyCapped ? "자정 이후에 다시 도전하세요." : "성이 방어 태세를 정비하고 있습니다."}
                    </p>
                    <button
                        type="button"
                        onClick={() => router.push(exitUrl)}
                        className="min-h-12 rounded-[20px] bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
                    >
                        지도로 이동
                    </button>
                </div>
            </QuizFrame>
        );
    }

    if (alreadyVisited) {
        return (
            <QuizFrame isShortAnswer={isShortAnswer}>
                <div
                    role="alertdialog"
                    aria-live="polite"
                    className="flex h-full min-h-0 flex-col items-center justify-center gap-4 rounded-[24px] border border-white/20 bg-white/95 p-6 text-center shadow-[0_18px_56px_rgba(15,23,42,0.25)]"
                >
                    <p className="text-xl font-black tracking-tight text-slate-900">
                        {wrongQr ? "잘못된 QR코드입니다" : "이미 진행한 이벤트입니다"}
                    </p>
                    {wrongQr && (
                        <p className="text-sm text-slate-500">이 코드는 다른 게임의 코드입니다.</p>
                    )}
                    <button
                        type="button"
                        onClick={() => router.push(exitUrl)}
                        className="min-h-12 rounded-[20px] bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
                    >
                        지도로 이동
                    </button>
                </div>
            </QuizFrame>
        );
    }

    return (
        <QuizFrame isShortAnswer={isShortAnswer}>
            <QuizPanel aria-label="Quiz timer" className={cn("rounded-[20px] border border-white/40 bg-white/80 px-4 py-3 shadow-[0_12px_32px_rgba(15,23,42,0.15)] backdrop-blur", !storeResolved && "invisible")}>
                <div className="flex items-center justify-between text-xs font-black uppercase tracking-[0.3em] text-slate-600">
                    <span>Time Left</span>
                    <span className="flex items-center gap-2">
                        {!done && !isQuizEmpty && (
                            <button
                                type="button"
                                onClick={() => void giveUp()}
                                aria-label="포기하기"
                                className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-black normal-case tracking-widest text-slate-400 active:opacity-70"
                            >
                                포기하기
                            </button>
                        )}
                        <span className="text-base tracking-wide text-slate-900">{storedRemaining < 0 ? "--:--" : formatTime(timeLeft)}</span>
                    </span>
                </div>
                <div
                    className="mt-3 h-3 rounded-full bg-slate-200"
                    role="progressbar"
                    aria-label="Time remaining"
                    aria-valuemin={0}
                    aria-valuemax={QUIZ_TIME_LIMIT_SECONDS}
                    aria-valuenow={timeLeft}
                >
                    <div
                        className="h-full w-full origin-left rounded-full bg-rose-500 transition-transform motion-reduce:transition-none"
                            style={{ transform: `scaleX(${storedRemaining < 0 ? 0 : timePercent / 100})` }}
                    />
                </div>
            </QuizPanel>
            <QuizPanel aria-labelledby="quiz-question" className={cn(
                "rounded-[24px] border border-white/20 bg-white/95 p-3 shadow-[0_18px_56px_rgba(15,23,42,0.25)]",
                isShortAnswer && "p-4 sm:p-5",
                !storeResolved && "invisible"
            )}>
                <div className="flex h-full min-h-0 flex-col gap-3">
                    {hintImage && (
                        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
                            <Image
                                src={hintImage}
                                alt="quiz hint"
                                fill
                                className="object-contain"
                                sizes="100vw"
                                priority
                            />
                        </div>
                    )}
                    <div className={cn(
                        "flex min-h-0 flex-1 items-center rounded-2xl border border-slate-200 px-4 py-3 text-white shadow-inner",
                        isShortAnswer ? "min-h-[4.5rem]" : "min-h-[96px]",
                        hintImage 
                            ? "bg-slate-900" 
                            : "bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500"
                    )}>
                        <h3 id="quiz-question" className={cn(
                            "text-base font-black leading-snug tracking-tight",
                            isShortAnswer
                                ? "text-2xl sm:text-4xl"
                                : (item.Hint ?? "").length <= 80
                                    ? "text-3xl"
                                    : "sm:text-xl"
                        )}>
                            {item.Hint ?? (isQuizEmpty ? "문제를 불러오지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의해주세요." : "")}
                        </h3>
                    </div>
                </div>
            </QuizPanel>
            <QuizPanel
                aria-label="Quiz answers"
                className={cn(
                    "overflow-y-auto overscroll-y-contain rounded-[24px] border border-white/20 bg-white/95 p-3 shadow-[0_14px_40px_rgba(15,23,42,0.2)] backdrop-blur",
                    isShortAnswer && "px-2 py-1",
                    !storeResolved && "invisible"
                )}
            >
                    {isQuizEmpty ? (
                        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 text-center">
                            <button
                                type="button"
                                onClick={() => router.push(nextMissionPath)}
                                className="min-h-12 rounded-[20px] bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
                            >
                                돌아가기
                            </button>
                        </div>
                    ) : item.AnswerType === 'SA' ? (
                    <div className="flex h-full min-h-0 flex-col justify-center gap-1 text-center">
                        <input
                            type="text"
                            placeholder="답을 입력하세요"
                            aria-label="답을 입력하세요"
                            className="min-h-12 w-full rounded-[20px] border-b-[6px] border-slate-100 bg-slate-50 px-3 py-1 text-center text-lg font-black uppercase italic tracking-wide text-slate-800 outline-none transition-all placeholder:text-slate-300 focus:border-indigo-100"
                            value={ans}
                            onChange={e => setAns(e.target.value.toUpperCase())}
                            disabled={done}
                        />
                        {!done && (
                            <button
                                onClick={() => check(ans)}
                                className="min-h-12 w-full rounded-[20px] border-b-5 border-black bg-slate-900 py-1.5 text-base font-black uppercase italic tracking-[0.2em] text-white shadow-md active:translate-y-0.5"
                            >
                                Submit
                            </button>
                        )}
                    </div>
                ) : (
                    <QuizAnswerGrid>
                        {item.AnswerType === 'OX' && ['O', 'X'].map((o, i) => (
                            <QuizAnswerChoice
                                key={o}
                                onClick={() => check(o)}
                                variant="ox"
                                className={cn(
                                    done
                                        ? o === item.Answer
                                            ? 'bg-green-500 text-white border-green-800'
                                            : ans === o
                                              ? 'bg-red-500 text-white border-red-800'
                                              : 'bg-slate-100 text-slate-300 opacity-20 shadow-none'
                                        : i === 0
                                          ? 'bg-blue-600 text-white border-blue-900'
                                          : 'bg-red-600 text-white border-red-900 hover:scale-105 active:scale-95'
                                )}>
                                {o}
                            </QuizAnswerChoice>
                        ))}

                        { item.AnswerType === 'MC' &&
                            exOptions.map((o: string, i: number) => {
                                const colors = ['bg-red-600 border-red-900',
                                    'bg-blue-600 border-blue-900',
                                    'bg-yellow-500 border-yellow-800',
                                    'bg-green-600 border-green-800'];
                                const Shapes = [Triangle, Circle, Square, Hexagon];
                                return (
                                    <QuizAnswerChoice
                                        key={o}
                                        onClick={() => check(o)}
                                        className={cn(
                                            done
                                                ? o === item.Answer
                                                    ? 'bg-green-500 text-white border-green-800'
                                                    : ans === o
                                                      ? 'bg-red-500 text-white border-red-800'
                                                      : 'bg-slate-100 text-slate-300 opacity-20 shadow-none'
                                                : `${colors[i]} text-white hover:scale-102 active:scale-95`
                                        )}>
                                            <span aria-hidden="true" className="shrink-0 text-white/80">
                                                {React.createElement(Shapes[i], { size: 14, fill: 'white', strokeWidth: 0 })}
                                            </span>
                                            {o}
                                    </QuizAnswerChoice>
                                );
                            })
                        }
                    </QuizAnswerGrid>
                )}

            </QuizPanel>
        {done && (
            <div className={cn("fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-xl", !resultRestored && "animate-in fade-in duration-300 motion-reduce:animate-none")}>
                <div className="w-full h-full max-w-2xl grid grid-rows-[auto_auto] gap-2 rounded-sm border border-white/30 bg-white/95 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.45)]">
                    <section className="rounded-[24px] border border-white/40 bg-white p-6 text-center shadow-inner">
                        <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-3xl border-4 border-slate-100 bg-slate-900 text-white">
                            {correct ? <CheckCircle2 size={72} /> : <XCircle size={72} />}
                        </div>
                        <h3 className={`mt-6 text-4xl font-black uppercase tracking-tight ${correct ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {correct ? '정답입니다' : '오답입니다!'}
                        </h3>
                        {isCastleSiege && siegeResult && (
                            <p className="mt-3 text-lg font-black tracking-tight text-slate-900">
                                {siegeResult.conquered
                                    ? `함락! 성을 차지했습니다 (HP ${siegeResult.maxHp}/${siegeResult.maxHp})`
                                    : `적중! 성 HP ${siegeResult.hp}/${siegeResult.maxHp}`}
                            </p>
                        )}

                    </section>
                    <section className="rounded-[24px] border border-white/30 bg-white/90 p-6 shadow-inner">

                        <button
                            onClick={() => {
                                if (!hasScoreSubmittedRef.current) {
                                    const scoreToAdd = correct ? parseDifficulty(item.Difficulty) : siegeFailScore;
                                    postQuizScore(
                                        scoreToAdd,
                                        isCastleSiege && !correct
                                            ? buildSiegeAnswer("miss", siegeQuestionHash)
                                            : ans || "(미제출)"
                                    );
                                }
                                clearQuizResult(eventKey);
                                router.push(nextMissionPath);
                            }}
                            className={`mt-5 w-full rounded-sm border-b-8 border-black/10 px-6 py-4 text-xl font-black uppercase tracking-[0.3em] text-white shadow-2xl active:translate-y-1 ${THEME_CONFIG.pythagoras.bgClass}`}
                        >
                            다음 미션으로
                        </button>
                    </section>
                </div>
            </div>
        )}
        </QuizFrame>
    );
}
