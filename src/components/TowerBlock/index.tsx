"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Game } from "./classes/Game";
import "./TowerBlock.css";
import { AUTH_DEVICE_STORAGE_KEY, AUTH_NICKNAME_STORAGE_KEY } from "@/lib/auth-claim";
import { checkEventEntry } from "@/lib/game-score";

interface TowerBlockProps {
  eventKey?: string;
  userId?: string;
  nickname?: string;
  exitUrl?: string;
  from?: string;
}

export default function TowerBlock({ 
  eventKey = "BUSANCITIZEN_STACK", 
  userId, 
  nickname, 
  exitUrl,
  from 
}: TowerBlockProps) {
  const router = useRouter();
  
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<HTMLDivElement>(null);
  const instructionsRef = useRef<HTMLDivElement>(null);
  const startButtonRef = useRef<HTMLDivElement>(null);
  const gameInstanceRef = useRef<Game | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);

  const handleAction = useCallback(() => {
    if (needsLogin) {
      return;
    }
    if (gameInstanceRef.current) {
      gameInstanceRef.current.onAction();
    }
  }, [needsLogin]);

  useEffect(() => {
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
        if (result === "login") {
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
  }, [eventKey]);

  useEffect(() => {
    if (!entryChecked) return;
    if (
      !gameRef.current ||
      !scoreRef.current ||
      !timerRef.current ||
      !startButtonRef.current ||
      !instructionsRef.current ||
      !containerRef.current
    ) {
      return;
    }

    gameInstanceRef.current = new Game(
      gameRef.current,
      scoreRef.current,
      timerRef.current,
      startButtonRef.current,
      instructionsRef.current,
      containerRef.current,
      eventKey
    );

    const snapshot = Game.loadSnapshot(eventKey);
    if (snapshot) {
      gameInstanceRef.current.restoreSnapshot(snapshot);
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.keyCode === 32) {
        handleAction();
      }
    };

    const handleClick = () => {
      handleAction();
    };

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("click", handleClick);
    document.addEventListener("touchstart", handleTouchStart);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("click", handleClick);
      document.removeEventListener("touchstart", handleTouchStart);

      if (gameInstanceRef.current) {
        gameInstanceRef.current.dispose();
        gameInstanceRef.current = null;
      }
    };
  }, [handleAction, entryChecked]);

  if (!entryChecked) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center bg-slate-950 p-6" aria-live="polite" aria-busy="true">
        <p className="text-sm font-black tracking-wide text-white/80">확인 중…</p>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center bg-slate-950 p-6">
        <div
          role="alertdialog"
          aria-live="polite"
          className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-white p-8 text-center shadow-2xl"
        >
          <p className="text-xl font-black tracking-tight text-slate-900">로그인이 필요합니다</p>
          <button
            type="button"
            onClick={() => {
              router.push(`/?callbackUrl=${encodeURIComponent(`/event?eventkey=${encodeURIComponent(eventKey)}`)}`);
            }}
            className="min-h-12 w-full rounded-2xl bg-slate-900 px-8 py-3 text-base font-black tracking-wide text-white active:translate-y-0.5"
          >
            로그인하러 가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} id="container">
      <div ref={gameRef} id="game" />
      <div ref={scoreRef} id="score">
        점수: 0점
      </div>
      <div ref={timerRef} id="timer">
        제한시간: 60초
      </div>
      <div ref={instructionsRef} id="instructions">
        터치하여 블록을 내려놓으세요.
      </div>
      <div className="game-over">
        <h2>게임 오버</h2>
        <button
          id="exit-button"
          onClick={() => {
            if (!gameInstanceRef.current) {
              return;
            }

            Game.clearSnapshot(eventKey);
            const scoreToAdd = gameInstanceRef.current.getScore();
            const path = exitUrl 
              ? `${exitUrl}${exitUrl.includes("?") ? "&" : "?"}scoreUpdated=true&addedScore=${scoreToAdd}`
              : (from === "map" ? `/map?scoreUpdated=true&addedScore=${scoreToAdd}` : "/qr");
            
            const storedDeviceId = window.localStorage.getItem(AUTH_DEVICE_STORAGE_KEY)?.trim() ?? "";
            const storedNickname = window.localStorage.getItem(AUTH_NICKNAME_STORAGE_KEY)?.trim() ?? "";
            const resolvedUserId = userId?.trim() ?? "";
            const resolvedNickname = nickname?.trim() || storedNickname;

            fetch("/api/updatescore", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                score: scoreToAdd,
                eventKey,
                userId: resolvedUserId || undefined,
                nickname: resolvedNickname || undefined,
                deviceId: storedDeviceId || undefined,
                source: "towerblock",
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
                  console.error("[TowerBlock] updatescore failed", {
                    status: res.status,
                    eventKey,
                    scoreToAdd,
                    payload,
                  });
                  router.push(path);
                  return;
                }

                console.log("[TowerBlock] updatescore success", {
                  eventKey,
                  scoreToAdd,
                  payload,
                });
                router.push(path);
              })
              .catch((error) => {
                console.error("[TowerBlock] updatescore request error", {
                  eventKey,
                  scoreToAdd,
                  error,
                });
                router.push(path);
              });
          }}
        >
          나가기
        </button>
      </div>
      <div className="game-ready">
        <div ref={startButtonRef} id="start-button">
          Start
        </div>
        <div />
      </div>
    </div>
  );
}
