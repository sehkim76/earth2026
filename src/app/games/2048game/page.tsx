"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "./2048.css";
import {
  buildGameExitPath,
  checkEventEntry,
  clearSessionSnapshot,
  loadSessionSnapshot,
  readGameSearchParams,
  saveSessionSnapshot,
  submitGameScore,
} from "@/lib/game-score";
import {
  canMove,
  createEmptyBoard,
  createInitialBoard,
  move,
  SIZE,
  spawnRandomTile,
  type Board,
  type Direction,
} from "./lib/2048";

const BEST_KEY = "2048-best";
const SWIPE_THRESHOLD = 24;
const SNAPSHOT_VERSION = 2;
const GAME_SECONDS = 120;

function formatTimeLeft(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function dividedScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.floor(score / 1000);
}

interface Game2048Snapshot {
  version: number;
  board: Board;
  score: number;
  over: boolean;
  deadlineMs: number;
}

function snapshotKey(eventKey: string): string {
  return `2048game:${eventKey || "default"}`;
}

function isBoard(value: unknown): value is Board {
  if (!Array.isArray(value) || value.length !== SIZE) {
    return false;
  }
  return value.every(
    (row): row is number[] =>
      Array.isArray(row) &&
      row.length === SIZE &&
      row.every(
        (cell): cell is number =>
          typeof cell === "number" && Number.isFinite(cell) && cell >= 0,
      ),
  );
}

function isGame2048Snapshot(value: unknown): value is Game2048Snapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === SNAPSHOT_VERSION &&
    isBoard(record.board) &&
    typeof record.score === "number" &&
    Number.isFinite(record.score) &&
    record.score >= 0 &&
    typeof record.over === "boolean" &&
    typeof record.deadlineMs === "number" &&
    Number.isFinite(record.deadlineMs)
  );
}

function isEmptyBoard(board: Board): boolean {
  return board.every((row) => row.every((cell) => cell === 0));
}

function readBest(): number {
  try {
    if (typeof window === "undefined") return 0;
    const raw = window.localStorage.getItem(BEST_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function tileClass(value: number): string {
  switch (value) {
    case 2:
      return "g2048-tile-2";
    case 4:
      return "g2048-tile-4";
    case 8:
      return "g2048-tile-8";
    case 16:
      return "g2048-tile-16";
    case 32:
      return "g2048-tile-32";
    case 64:
      return "g2048-tile-64";
    case 128:
      return "g2048-tile-128";
    case 256:
      return "g2048-tile-256";
    case 512:
      return "g2048-tile-512";
    case 1024:
      return "g2048-tile-1024";
    case 2048:
      return "g2048-tile-2048";
    default:
      return value === 0 ? "g2048-tile-empty" : "g2048-tile-super";
  }
}

export default function Home() {
  const router = useRouter();
  const [board, setBoard] = useState<Board>(() => createEmptyBoard());
  const [score, setScore] = useState<number>(0);
  const [best, setBest] = useState<number>(0);
  const [over, setOver] = useState<boolean>(false);
  const [exiting, setExiting] = useState<boolean>(false);
  const [alreadyVisited, setAlreadyVisited] = useState<boolean>(false);
  const [wrongQr, setWrongQr] = useState<boolean>(false);
  const [needsLogin, setNeedsLogin] = useState<boolean>(false);
  const [entryChecked, setEntryChecked] = useState<boolean>(false);
  const [timeLeft, setTimeLeft] = useState<number>(GAME_SECONDS);
  const [shownScore, setShownScore] = useState<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const persistBest = useCallback((value: number) => {
    setBest((prev) => {
      if (value > prev) {
        try {
          window.localStorage.setItem(BEST_KEY, String(value));
        } catch {
          // 저장 실패는 무시하고 화면 상태만 갱신한다
        }
        return value;
      }
      return prev;
    });
  }, []);

  const doMove = useCallback(
    (direction: Direction) => {
      if (over || alreadyVisited || wrongQr || needsLogin) return;
      setBoard((prevBoard) => {
        const result = move(prevBoard, direction);
        if (!result.moved) return prevBoard;
        const next = spawnRandomTile(result.board);
        setScore((prevScore) => {
          const nextScore = prevScore + result.gained;
          persistBest(nextScore);
          return nextScore;
        });
        if (!canMove(next)) setOver(true);
        return next;
      });
    },
    [over, persistBest, alreadyVisited, wrongQr, needsLogin],
  );

  useEffect(() => {
    if (!entryChecked) return;
    setBest(readBest());
    const { eventKey } = readGameSearchParams();
    const snapshot = loadSessionSnapshot(snapshotKey(eventKey), isGame2048Snapshot);
    if (snapshot && (snapshot.over || !isEmptyBoard(snapshot.board))) {
      setBoard(snapshot.board);
      setScore(snapshot.score);
      setOver(snapshot.over);
      if (!snapshot.over && snapshot.deadlineMs > Date.now()) {
        deadlineRef.current = snapshot.deadlineMs;
        setTimeLeft(Math.max(0, Math.ceil((snapshot.deadlineMs - Date.now()) / 1000)));
      } else {
        deadlineRef.current = null;
        setTimeLeft(0);
      }
    } else {
      setBoard(createInitialBoard());
      deadlineRef.current = Date.now() + GAME_SECONDS * 1000;
      setTimeLeft(GAME_SECONDS);
    }
  }, [entryChecked]);

  useEffect(() => {
    if (!over) {
      setShownScore(null);
      return;
    }
    const final = dividedScore(score);
    if (score <= 0) {
      setShownScore(0);
      return;
    }
    let raf = 0;
    const animStart = performance.now();
    const duration = 1400;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - animStart) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShownScore(Math.round(score + (final - score) * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);

  useEffect(() => {
    if (!entryChecked || over || alreadyVisited || wrongQr || needsLogin) {
      return;
    }
    const id = window.setInterval(() => {
      const deadline = deadlineRef.current;
      if (deadline === null) {
        return;
      }
      const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setTimeLeft((prev) => (prev === remain ? prev : remain));
      if (remain <= 0) {
        setOver(true);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [entryChecked, over, alreadyVisited, wrongQr, needsLogin]);

  useEffect(() => {
    const { eventKey } = readGameSearchParams();
    if (!eventKey) {
      setEntryChecked(true);
      return;
    }
    let cancelled = false;
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
  }, []);

  useEffect(() => {
    if (isEmptyBoard(board)) {
      return;
    }
    const { eventKey } = readGameSearchParams();
    const snapshot: Game2048Snapshot = {
      version: SNAPSHOT_VERSION,
      board,
      score,
      over,
      deadlineMs: deadlineRef.current ?? 0,
    };
    saveSessionSnapshot(snapshotKey(eventKey), snapshot);
  }, [board, score, over]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (key === "ArrowUp" || key === "w" || key === "W") {
        event.preventDefault();
        doMove("up");
      } else if (key === "ArrowDown" || key === "s" || key === "S") {
        event.preventDefault();
        doMove("down");
      } else if (key === "ArrowLeft" || key === "a" || key === "A") {
        event.preventDefault();
        doMove("left");
      } else if (key === "ArrowRight" || key === "d" || key === "D") {
        event.preventDefault();
        doMove("right");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doMove]);

  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    // 핀치줌 등 멀티터치는 방향 입력에서 제외한다
    if (event.touches.length > 1) {
      touchStart.current = null;
      return;
    }
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchCancel = () => {
    touchStart.current = null;
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    // 버튼 탭은 스와이프로 오인하지 않는다
    if ((event.target as HTMLElement).closest?.("button")) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      doMove(dx > 0 ? "right" : "left");
    } else {
      doMove(dy > 0 ? "down" : "up");
    }
  };

  const handleExit = useCallback(async () => {
    if (exiting) {
      return;
    }
    setExiting(true);
    const params = readGameSearchParams();
    clearSessionSnapshot(snapshotKey(params.eventKey));
    const finalScore = dividedScore(score);
    await submitGameScore({
      score: finalScore,
      eventKey: params.eventKey,
      userId: params.userId,
      nickname: params.nickname,
      source: "2048game",
    });
    router.push(
      buildGameExitPath({ exitUrl: params.exitUrl, from: params.from, score: finalScore, eventKey: params.eventKey }),
    );
  }, [exiting, score, router]);

  const handleGiveUp = useCallback(async () => {
    if (exiting) {
      return;
    }
    setExiting(true);
    const params = readGameSearchParams();
    clearSessionSnapshot(snapshotKey(params.eventKey));
    const finalScore = Math.max(1, dividedScore(score));
    await submitGameScore({
      score: finalScore,
      eventKey: params.eventKey,
      userId: params.userId,
      nickname: params.nickname,
      source: "2048game-giveup",
    });
    router.push(
      buildGameExitPath({ exitUrl: params.exitUrl, from: params.from, score: finalScore, eventKey: params.eventKey }),
    );
  }, [exiting, score, router]);

  if (!entryChecked) {
    return (
      <main className="g2048-page">
        <div className="g2048-container">
          <section className="g2048-visited" aria-live="polite" aria-busy="true">
            <p className="g2048-visited-title">확인 중…</p>
          </section>
        </div>
      </main>
    );
  }

  if (needsLogin) {
    return (
      <main className="g2048-page">
        <div className="g2048-container">
          <section className="g2048-visited" role="alertdialog" aria-live="polite">
            <p className="g2048-visited-title">로그인이 필요합니다</p>
            <button
              type="button"
              className="g2048-notice-button"
              onClick={() => {
                const { eventKey } = readGameSearchParams();
                router.push(
                  `/?callbackUrl=${encodeURIComponent(`/event?eventkey=${encodeURIComponent(eventKey)}`)}`,
                );
              }}
            >
              로그인하러 가기
            </button>
          </section>
        </div>
      </main>
    );
  }

  if (alreadyVisited) {
    return (
      <main className="g2048-page">
        <div className="g2048-container">
          <section className="g2048-visited" role="alertdialog" aria-live="polite">
            <p className="g2048-visited-title">
              {wrongQr ? "잘못된 QR코드입니다" : "이미 진행한 이벤트입니다"}
            </p>
            {wrongQr && (
              <p className="g2048-visited-sub">이 코드는 다른 게임의 코드입니다.</p>
            )}
            <button
              type="button"
              className="g2048-notice-button"
              onClick={() => router.push("/map")}
            >
              지도로 이동
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main
      className="g2048-page"
      onTouchStart={handleTouchStart}
      onTouchCancel={handleTouchCancel}
      onTouchEnd={handleTouchEnd}
    >
      <div className="g2048-container">
        <header className="g2048-header">
          <div>
            <h1 className="g2048-title">2048</h1>
            <p className="g2048-subtitle">숫자를 합쳐 2048을 만들어보세요 🍰</p>
          </div>
          {!over && (
            <button
              type="button"
              className="g2048-notice-button g2048-giveup"
              onClick={handleGiveUp}
              disabled={exiting}
            >
              포기
            </button>
          )}
        </header>

        <section className="g2048-timer" aria-label="남은 플레이 시간">
          <div
            className="g2048-timer-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={GAME_SECONDS}
            aria-valuenow={timeLeft}
            aria-label={`남은 시간 ${formatTimeLeft(timeLeft)}`}
          >
            <div
              className={`g2048-timer-fill${timeLeft <= 10 ? " g2048-timer-fill-low" : ""}`}
              style={{ width: `${(timeLeft / GAME_SECONDS) * 100}%` }}
            />
          </div>
          <span className="g2048-timer-text">{formatTimeLeft(timeLeft)}</span>
        </section>

        <section className="g2048-score-row" aria-label="점수">
          <div className="g2048-score-card">
            <span className="g2048-score-label">점수</span>
            <span className="g2048-score-value">{score}</span>
          </div>
          <div className="g2048-score-card">
            <span className="g2048-score-label">최고기록</span>
            <span className="g2048-score-value">{best}</span>
          </div>
        </section>

        {over && (
          <section
            className="g2048-notice g2048-notice-lose"
            role="status"
            aria-live="polite"
          >
            <p className="g2048-notice-title">😿 더 이상 움직일 곳이 없어요</p>
            <div className="g2048-divide" aria-live="polite">
              <span className="g2048-divide-op">÷ 1000</span>
              <span className="g2048-divide-value">
                {(shownScore ?? dividedScore(score)).toLocaleString("ko-KR")}
              </span>
            </div>
            <div className="g2048-notice-actions">
              <button
                type="button"
                className="g2048-notice-button g2048-notice-button-secondary"
                onClick={handleExit}
                disabled={exiting}
              >
                {exiting ? "기록 중…" : "점수 기록하고 나가기"}
              </button>
            </div>
          </section>
        )}

        <div
          className="g2048-board"
          role="grid"
           aria-label="2048 게임 보드"
        >
          {board.map((row, r) =>
            row.map((value, c) => (
              <div key={`${r}-${c}`} className="g2048-cell" role="gridcell">
                {value !== 0 && (
                  <div key={`${r}-${c}-${value}`} className={`g2048-tile ${tileClass(value)}`}>
                    {value}
                  </div>
                )}
              </div>
            )),
          )}
        </div>

      </div>
    </main>
  );
}
