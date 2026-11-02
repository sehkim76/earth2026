"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import "./cube.css";
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
  aliveCount,
  calculateCombo,
  CUBE_COLORS,
  generateMatch,
  removeCellsAt,
  type CubeCell,
  type CubeColorIndex,
  type Puzzle,
} from "./lib/puzzle";
import { dealLanes, emptySlots, FLY_MS, LANE_DEPTH, SLOT_COUNT, type HandBlock, type LaunchSlot } from "./lib/engine";
import { getGameEvents } from "./lib/events";
import { isSoundEnabled, playSound, setSoundEnabled } from "./lib/sound";
import type { RemovalBurst, SceneEngine, VolleyBatch } from "./components/CubeScene";

const CubeScene = dynamic(() => import("./components/CubeScene"), { ssr: false });

export type GameState = "menu" | "playing" | "gameover";
export type EndReason = "time" | "clear" | "empty";

const BEST_KEY = "cube-rush-best";
const GAME_SECONDS = 60;
const HIT_SOUND_MS = 120;
// 손패 블록 쌓기 간격(px) — CSS .rush-block 높이(56px) + 틈(6px)과 같은 값.
// 바꿀 때는 globals.css의 레인 높이와 함께 맞춘다.
const LANE_STEP_PX = 62;

const END_LABEL: Record<EndReason, string> = {
  time: "TIME UP!",
  clear: "CLEAR!",
  empty: "탄약 소진",
};

function dividedScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.floor(score / 1000);
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

const CUBE_SNAPSHOT_VERSION = 1;

type CubeSnapshotState = "playing" | "gameover";

interface CubeRushSnapshot {
  version: number;
  state: CubeSnapshotState;
  puzzle: Puzzle;
  lanes: HandBlock[][];
  slots: LaunchSlot[];
  score: number;
  streaks: number[];
  removedTotal: number;
  maxCombo: number;
  firedTotal: number;
  deadlineMs: number;
  uidCounter: number;
  endReason: EndReason;
  clearBonus: number;
}

function cubeSnapshotKey(eventKey: string): string {
  return `cube-rush-60:${eventKey || "default"}`;
}

function isCubeColorIndex(value: unknown): value is CubeColorIndex {
  return (
    value === 0 ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6
  );
}

function isCubeCell(value: unknown): value is CubeCell {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "number" &&
    Number.isFinite(record.id) &&
    typeof record.x === "number" &&
    Number.isFinite(record.x) &&
    typeof record.y === "number" &&
    Number.isFinite(record.y) &&
    typeof record.z === "number" &&
    Number.isFinite(record.z) &&
    isCubeColorIndex(record.color) &&
    typeof record.alive === "boolean"
  );
}

function isPuzzle(value: unknown): value is Puzzle {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.cells) &&
    record.cells.every(isCubeCell) &&
    typeof record.sizeX === "number" &&
    Number.isFinite(record.sizeX) &&
    typeof record.sizeY === "number" &&
    Number.isFinite(record.sizeY) &&
    typeof record.sizeZ === "number" &&
    Number.isFinite(record.sizeZ)
  );
}

function isHandBlock(value: unknown): value is HandBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.uid === "number" &&
    Number.isFinite(record.uid) &&
    isCubeColorIndex(record.color) &&
    typeof record.count === "number" &&
    Number.isFinite(record.count) &&
    record.count >= 0
  );
}

function isLaunchSlot(value: unknown): value is LaunchSlot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "idle" && status !== "flying" && status !== "firing") {
    return false;
  }
  const color = record.color;
  if (color !== null && !isCubeColorIndex(color)) {
    return false;
  }
  const count = record.count;
  if (count !== null && (typeof count !== "number" || !Number.isFinite(count) || count < 0)) {
    return false;
  }
  return true;
}

function isCubeRushSnapshot(value: unknown): value is CubeRushSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== "playing" && state !== "gameover") {
    return false;
  }
  const endReason = record.endReason;
  if (endReason !== "time" && endReason !== "clear" && endReason !== "empty") {
    return false;
  }
  if (!isPuzzle(record.puzzle)) {
    return false;
  }
  if (
    !Array.isArray(record.lanes) ||
    !record.lanes.every((lane): lane is HandBlock[] => Array.isArray(lane) && lane.every(isHandBlock))
  ) {
    return false;
  }
  if (
    !Array.isArray(record.slots) ||
    record.slots.length !== SLOT_COUNT ||
    !record.slots.every(isLaunchSlot)
  ) {
    return false;
  }
  const numericKeys = [
    "score",
    "removedTotal",
    "maxCombo",
    "firedTotal",
    "deadlineMs",
    "uidCounter",
    "clearBonus",
  ];
  if (
    !numericKeys.every(
      (key) => typeof record[key] === "number" && Number.isFinite(record[key]),
    )
  ) {
    return false;
  }
  if (
    (record.score as number) < 0 ||
    (record.removedTotal as number) < 0 ||
    (record.maxCombo as number) < 0 ||
    (record.firedTotal as number) < 0 ||
    (record.uidCounter as number) < 1 ||
    (record.clearBonus as number) < 0
  ) {
    return false;
  }
  return (
    Array.isArray(record.streaks) &&
    record.streaks.length === SLOT_COUNT &&
    (record.streaks as unknown[]).every(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
    )
  );
}

export default function Home() {
  const router = useRouter();
  const [gameState, setGameState] = useState<GameState>("menu");
  const [score, setScore] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(GAME_SECONDS);
  const [combo, setCombo] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [cubeCount, setCubeCount] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const [endReason, setEndReason] = useState<EndReason>("time");
  const [clearBonus, setClearBonus] = useState(0);

  const [removedTotal, setRemovedTotal] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [firedTotal, setFiredTotal] = useState(0);

  const [cells, setCells] = useState<CubeCell[]>([]);
  const [lanes, setLanes] = useState<HandBlock[][]>([]);
  const [slots, setSlots] = useState<LaunchSlot[]>(() => emptySlots());
  const [burst, setBurst] = useState<RemovalBurst | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [burstSlot, setBurstSlot] = useState<number | null>(null);
  const [exiting, setExiting] = useState(false);
  const [shownScore, setShownScore] = useState<number | null>(null);
  const [alreadyVisited, setAlreadyVisited] = useState(false);
  const [wrongQr, setWrongQr] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);

  useEffect(() => {
    if (gameState !== "gameover") {
      setShownScore(null);
      return;
    }
    const raw = scoreRef.current;
    const final = dividedScore(raw);
    if (raw <= 0) {
      setShownScore(0);
      return;
    }
    let raf = 0;
    const animStart = performance.now();
    const duration = 1400;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - animStart) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShownScore(Math.round(raw + (final - raw) * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameState]);

  const puzzleRef = useRef<Puzzle | null>(null);
  const uidCounter = useRef(1);
  const artSeq = useRef(0);
  const burstKey = useRef(0);
  const engineRef = useRef<SceneEngine | null>(null);
  const stateRef = useRef<GameState>("menu");
  const lanesRef = useRef<HandBlock[][]>([]);
  const slotsRef = useRef<LaunchSlot[]>(emptySlots());
  const startedAt = useRef(0);
  const scoreRef = useRef(0);
  const streaksRef = useRef<number[]>(Array.from({ length: SLOT_COUNT }, () => 0));
  const removedRef = useRef(0);
  const maxComboRef = useRef(0);
  const firedRef = useRef(0);
  const lastHitSound = useRef(0);
  const warned5 = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashHint = useCallback((text: string | null) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setHint(text);
    if (text !== null) {
      hintTimer.current = setTimeout(() => setHint(null), 1800);
    }
  }, []);

  useEffect(() => {
    stateRef.current = gameState;
    lanesRef.current = lanes;
    slotsRef.current = slots;
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setBestScore(readBest());
      setSoundOn(isSoundEnabled());
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const volleyDoneRef = useRef<(slot: number, attempt?: number) => void>(() => undefined);
  const runWhenPlaying = useCallback((ms: number, fn: () => void): void => {
    window.setTimeout(() => {
      if (stateRef.current === "playing") fn();
    }, ms);
  }, []);

  const pushCells = useCallback((puzzle: Puzzle) => {
    puzzleRef.current = puzzle;
    const alive = puzzle.cells.filter((c) => c.alive);
    setCells(alive);
    setCubeCount(alive.length);
  }, []);

  const armTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    let lastSecond = -1;
    timerRef.current = setInterval(() => {
      if (stateRef.current !== "playing") return;
      const elapsed = (Date.now() - startedAt.current) / 1000;
      const remain = Math.max(0, Math.ceil(GAME_SECONDS - elapsed));
      if (remain !== lastSecond) {
        lastSecond = remain;
        setTimeRemaining(remain);
        if (remain === 5 && !warned5.current) {
          warned5.current = true;
          playSound("warning");
        }
      }
      if (remain <= 0) {
        finishGameRef.current("time");
      }
    }, 200);
  }, []);

  const finishGameRef = useRef<(reason: EndReason) => void>(() => undefined);

  const finishGame = useCallback((reason: EndReason) => {
    if (stateRef.current !== "playing") return;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    let bonus = 0;
    if (reason === "clear") {
      const elapsed = (Date.now() - startedAt.current) / 1000;
      const remain = Math.max(0, Math.ceil(GAME_SECONDS - elapsed));
      bonus = remain * 50;
      scoreRef.current += bonus;
      setScore(scoreRef.current);
      setClearBonus(bonus);
      playSound("combo", 5);
    }
    const finalScore = scoreRef.current;
    setBestScore((prev) => {
      if (finalScore > prev) {
        try {
          window.localStorage.setItem(BEST_KEY, String(finalScore));
        } catch {
          return prev;
        }
        return finalScore;
      }
      return prev;
    });
    getGameEvents().onGameOver({
      score: finalScore,
      removed: removedRef.current,
      maxCombo: maxComboRef.current,
    });
    playSound("gameover");
    setEndReason(reason);
    setGameState("gameover");
    const { eventKey } = readGameSearchParams();
    saveSessionSnapshot(cubeSnapshotKey(eventKey), {
      version: CUBE_SNAPSHOT_VERSION,
      state: "gameover",
      puzzle: puzzleRef.current ?? { cells: [], sizeX: 0, sizeY: 0, sizeZ: 0 },
      lanes: lanesRef.current,
      slots: slotsRef.current,
      score: finalScore,
      streaks: streaksRef.current,
      removedTotal: removedRef.current,
      maxCombo: maxComboRef.current,
      firedTotal: firedRef.current,
      deadlineMs: startedAt.current + GAME_SECONDS * 1000,
      uidCounter: uidCounter.current,
      endReason: reason,
      clearBonus: bonus,
    } satisfies CubeRushSnapshot);
  }, []);

  useEffect(() => {
    finishGameRef.current = finishGame;
  });

  const startGame = useCallback(() => {
    if (alreadyVisited || wrongQr || needsLogin) {
      return;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
    const artIndex = artSeq.current;
    artSeq.current += 1;
    const match = generateMatch(seed, artIndex);
    uidCounter.current = 1;
    const dealt: HandBlock[] = match.hand.map((b) => {
      const uid = uidCounter.current;
      uidCounter.current += 1;
      return { uid, color: b.color, count: b.count };
    });
    scoreRef.current = 0;
    streaksRef.current = Array.from({ length: SLOT_COUNT }, () => 0);
    removedRef.current = 0;
    maxComboRef.current = 0;
    firedRef.current = 0;
    lastHitSound.current = 0;
    warned5.current = false;
    startedAt.current = Date.now();
    setScore(0);
    setCombo(0);
    setRemovedTotal(0);
    setMaxCombo(0);
    setFiredTotal(0);
    setTimeRemaining(GAME_SECONDS);
    setEndReason("time");
    setClearBonus(0);
    setBurst(null);
    setSlots(emptySlots());
    const initialLanes = dealLanes(dealt);
    setLanes(initialLanes);
    flashHint(null);
    engineRef.current?.resetVolleys();
    pushCells(match.puzzle);
    setGameState("playing");
    armTimer();
    const { eventKey } = readGameSearchParams();
    saveSessionSnapshot(cubeSnapshotKey(eventKey), {
      version: CUBE_SNAPSHOT_VERSION,
      state: "playing",
      puzzle: match.puzzle,
      lanes: initialLanes,
      slots: emptySlots(),
      score: 0,
      streaks: Array.from({ length: SLOT_COUNT }, () => 0),
      removedTotal: 0,
      maxCombo: 0,
      firedTotal: 0,
      deadlineMs: startedAt.current + GAME_SECONDS * 1000,
      uidCounter: uidCounter.current,
      endReason: "time",
      clearBonus: 0,
    } satisfies CubeRushSnapshot);
  }, [pushCells, flashHint, armTimer]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const { eventKey } = readGameSearchParams();
    const snapshot = loadSessionSnapshot(cubeSnapshotKey(eventKey), isCubeRushSnapshot);
    if (snapshot === null) {
      return;
    }
    if (snapshot.state === "gameover") {
      scoreRef.current = snapshot.score;
      removedRef.current = snapshot.removedTotal;
      maxComboRef.current = snapshot.maxCombo;
      firedRef.current = snapshot.firedTotal;
      setScore(snapshot.score);
      setRemovedTotal(snapshot.removedTotal);
      setMaxCombo(snapshot.maxCombo);
      setFiredTotal(snapshot.firedTotal);
      setEndReason(snapshot.endReason);
      setClearBonus(snapshot.clearBonus);
      setGameState("gameover");
      return;
    }
    const remain = Math.max(0, Math.ceil((snapshot.deadlineMs - Date.now()) / 1000));
    if (remain <= 0 || aliveCount(snapshot.puzzle) === 0) {
      return;
    }
    const refundedLanes = snapshot.lanes.map((lane) => [...lane]);
    const restoredSlots = snapshot.slots.map((slot) => ({ ...slot }));
    let nextUid = snapshot.uidCounter;
    for (const slot of restoredSlots) {
      if (slot.status !== "idle" && slot.color !== null && slot.count !== null && slot.count > 0) {
        const target = refundedLanes.find((lane) => lane.length < LANE_DEPTH) ?? refundedLanes[0];
        if (target) {
          target.push({ uid: nextUid, color: slot.color, count: slot.count });
          nextUid += 1;
        }
        slot.status = "idle";
        slot.color = null;
        slot.count = null;
      } else if (slot.status !== "idle") {
        slot.status = "idle";
        slot.color = null;
        slot.count = null;
      }
    }
    puzzleRef.current = snapshot.puzzle;
    const alive = snapshot.puzzle.cells.filter((c) => c.alive);
    uidCounter.current = nextUid;
    scoreRef.current = snapshot.score;
    streaksRef.current = [...snapshot.streaks];
    removedRef.current = snapshot.removedTotal;
    maxComboRef.current = snapshot.maxCombo;
    firedRef.current = snapshot.firedTotal;
    warned5.current = remain <= 5;
    startedAt.current = snapshot.deadlineMs - GAME_SECONDS * 1000;
    setCells(alive);
    setCubeCount(alive.length);
    setLanes(refundedLanes);
    setSlots(restoredSlots);
    setScore(snapshot.score);
    setCombo(Math.max(0, ...snapshot.streaks));
    setRemovedTotal(snapshot.removedTotal);
    setMaxCombo(snapshot.maxCombo);
    setFiredTotal(snapshot.firedTotal);
    setTimeRemaining(remain);
    setBurst(null);
    flashHint(null);
    engineRef.current?.resetVolleys();
    setGameState("playing");
    armTimer();
  }, [armTimer, flashHint, pushCells]);

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
          setGameState("menu");
          setAlreadyVisited(true);
        } else if (result === "blocked") {
          setGameState("menu");
          setAlreadyVisited(true);
          setWrongQr(true);
        } else if (result === "login") {
          setGameState("menu");
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
    const id = window.setInterval(() => {
      const state = stateRef.current;
      if (state !== "playing") {
        return;
      }
      if (!puzzleRef.current) {
        return;
      }
      const { eventKey } = readGameSearchParams();
      saveSessionSnapshot(cubeSnapshotKey(eventKey), {
        version: CUBE_SNAPSHOT_VERSION,
        state,
        puzzle: puzzleRef.current,
        lanes: lanesRef.current,
        slots: slotsRef.current,
        score: scoreRef.current,
        streaks: streaksRef.current,
        removedTotal: removedRef.current,
        maxCombo: maxComboRef.current,
        firedTotal: firedRef.current,
        deadlineMs: startedAt.current + GAME_SECONDS * 1000,
        uidCounter: uidCounter.current,
        endReason: "time",
        clearBonus: 0,
      } satisfies CubeRushSnapshot);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const tapHand = useCallback(
    (laneIdx: number) => {
      if (stateRef.current !== "playing") return;
      const lane = lanesRef.current[laneIdx];
      const block = lane?.[0];
      if (!block) return;
      // 보이는 목표 발사 조건: 같은 색 살아있는 큐브가 없으면 이동 취소
      const puzzle = puzzleRef.current;
      if (puzzle) {
        let aliveSame = 0;
        for (const c of puzzle.cells) {
          if (c.alive && c.color === block.color) aliveSame += 1;
        }
        if (aliveSame === 0) {
          flashHint("이미 다 치웠어요!");
          return;
        }
      }
      const freeIdx = slotsRef.current.findIndex((s) => s.status === "idle");
      if (freeIdx === -1) return;
      // 같은 색도 새 발사칸으로 동시 발사한다. 탄약 총합이 잔여 구조물을
      // 넘을 수 없어(소진된 탄환은 반드시 명중) 1:1이 유지된다.
      const color = block.color;
      const count = block.count;
      const uid = block.uid;
      flashHint(null);
      setLanes((prev) => prev.map((l, i) => (i === laneIdx ? l.filter((b) => b.uid !== uid) : l)));
      setSlots((prev) =>
        prev.map((s, i) => (i === freeIdx ? { status: "flying", color, count } : s)),
      );
      // 0.3초 flying 연출 후 발사 시작 — 목표 확정 수를 받아 표시와 맞춤
      runWhenPlaying(FLY_MS, () => {
        const cur = slotsRef.current[freeIdx];
        if (cur?.status !== "flying" || cur.color === null || cur.count === null) return;
        const actual = engineRef.current?.startVolley(freeIdx, cur.count, cur.color) ?? 0;
        if (actual <= 0) {
          const refundUid = uidCounter.current;
          uidCounter.current += 1;
          setSlots((prev) =>
            prev.map((s, i) => (i === freeIdx ? { status: "idle" as const, color: null, count: null } : s)),
          );
          setLanes((prev) =>
            prev.map((l, i) => (i === laneIdx ? [{ uid: refundUid, color: cur.color as CubeColorIndex, count: cur.count as number }, ...l] : l)),
          );
          flashHint("이미 다 치웠어요!");
          return;
        }
        if (actual < (cur.count ?? 0)) {
          const diff = (cur.count ?? 0) - actual;
          const refundUid = uidCounter.current;
          uidCounter.current += 1;
          setLanes((prev) =>
            prev.map((l, i) => (i === laneIdx ? [{ uid: refundUid, color: cur.color as CubeColorIndex, count: diff }, ...l] : l)),
          );
        }
        setSlots((prev) =>
          prev.map((s, i) => (i === freeIdx ? { status: "firing", color: cur.color, count: actual } : s)),
        );
        streaksRef.current[freeIdx] = 0;
        playSound("select");
      });
    },
    [flashHint, runWhenPlaying],
  );

  // 탄환 엔진이 프레임당 1회 전달하는 batch — 점수 state 갱신은 여기서만
  const handleBatch = useCallback(
    (batch: VolleyBatch) => {
      if (stateRef.current !== "playing") return;
      const puzzle = puzzleRef.current;
      if (!puzzle) return;
      if (batch.spawned > 0) {
        firedRef.current += batch.spawned;
        setFiredTotal(firedRef.current);
      }
      // 발사칸 숫자는 엔진 잔량을 그대로 표시한다. 화면별도 차감은 어긋남의 원인이라 쓰지 않는다.
      if (batch.remainingBySlot.length > 0) {
        setSlots((prev) =>
          prev.map((s, i) => {
            const left = batch.remainingBySlot[i];
            if (s.status !== "firing" || s.count === null || left === undefined) return s;
            return left === s.count ? s : { ...s, count: Math.max(0, left) };
          }),
        );
      }
      if (batch.hits.length === 0) return;
      const result = removeCellsAt(puzzle, batch.hits);
      if (result.removed.length === 0) return;
      pushCells(result.puzzle);

      removedRef.current += result.removed.length;
      setRemovedTotal(removedRef.current);
      scoreRef.current += result.removed.length * 10;
      setScore(scoreRef.current);

      const perSlot = new Map<number, number>();
      for (const h of batch.hits) perSlot.set(h.slot, (perSlot.get(h.slot) ?? 0) + 1);
      for (const [slot, n] of perSlot) {
        streaksRef.current[slot] = (streaksRef.current[slot] ?? 0) + n;
        maxComboRef.current = Math.max(maxComboRef.current, streaksRef.current[slot] ?? 0);
      }
      setMaxCombo(maxComboRef.current);
      setCombo(Math.max(0, ...streaksRef.current));

      burstKey.current += 1;
      const first = result.removed[0];
      setBurst({
        key: burstKey.current,
        positions: result.removed.map((c) => ({ x: c.x, y: c.y, z: c.z })),
        colorHex: first ? (CUBE_COLORS[first.color] ?? "#ffffff") : "#ffffff",
      });

      getGameEvents().onCubeRemoved({
        count: result.removed.length,
        color: first ? first.color : 0,
        score: scoreRef.current,
      });
      // 명중음은 초당 횟수 제한으로 스팸 방지
      const now = Date.now();
      if (now - lastHitSound.current > HIT_SOUND_MS) {
        lastHitSound.current = now;
        playSound("remove");
      }

      // 구조물 전멸 → CLEAR + 남은초×50 보너스 → 결과
      if (aliveCount(result.puzzle) === 0) {
        finishGame("clear");
      }
    },
    [pushCells, finishGame],
  );

  const handleVolleyDone = useCallback(
    (slot: number, attempt = 0) => {
      if (stateRef.current !== "playing") {
        return;
      }
      // 엔진 종료 신호가 화면 상태보다 먼저 오면 잠시 후 다시 확인 (최대 3회)
      if (slotsRef.current[slot]?.status !== "firing") {
        if (attempt < 3) {
          window.setTimeout(() => volleyDoneRef.current(slot, attempt + 1), 200);
        }
        return;
      }
      const streak = streaksRef.current[slot] ?? 0;
      streaksRef.current[slot] = 0;
      if (streak >= 2) {
        const bonus = calculateCombo(streak);
        scoreRef.current += bonus;
        setScore(scoreRef.current);
        getGameEvents().onCombo({ streak, bonus });
        playSound("combo", streak);
      }
      setCombo(Math.max(0, ...streaksRef.current));
      const next = slotsRef.current.map((s, i) =>
        i === slot ? { status: "idle" as const, color: null, count: null } : s,
      );
      setSlots(next);
      if (burstTimer.current) clearTimeout(burstTimer.current);
      setBurstSlot(slot);
      burstTimer.current = setTimeout(() => setBurstSlot(null), 650);
      // 리필 없음 — 발사칸+손패가 모두 비면 탄약 소진 종료
      const handEmpty = lanesRef.current.every((l) => l.length === 0);
      const allIdle = next.every((s) => s.status === "idle");
      if (handEmpty && allIdle) {
        finishGame("empty");
      }
    },
    [finishGame],
  );

  useEffect(() => {
    volleyDoneRef.current = handleVolleyDone;
  });

  // 와치독: 끝난 Volley인데 화면만 firing이면 idle로 맞춤 (놓친 종료 신호 수습)
  useEffect(() => {
    const id = window.setInterval(() => {
      if (stateRef.current !== "playing") return;
      const d = engineRef.current?.getDebug();
      if (!d) return;
      setSlots((prev) => {
        let changed = false;
        const next = prev.map((s, i) => {
          const e = d.slots[i];
          if (
            s.status === "firing" &&
            e &&
            !e.active &&
            e.toSpawn <= 0 &&
            e.alive <= 0
          ) {
            changed = true;
            return { status: "idle" as const, color: null, count: null };
          }
          return s;
        });
        return changed ? next : prev;
      });
    }, 1500);
    return () => window.clearInterval(id);
  }, []);

  const handleExit = useCallback(async () => {
    if (exiting || stateRef.current !== "gameover") {
      return;
    }
    setExiting(true);
    const params = readGameSearchParams();
    clearSessionSnapshot(cubeSnapshotKey(params.eventKey));
    const finalScore = dividedScore(scoreRef.current);
    await submitGameScore({
      score: finalScore,
      eventKey: params.eventKey,
      userId: params.userId,
      nickname: params.nickname,
      source: "cube-rush-60",
    });
    router.push(
      buildGameExitPath({ exitUrl: params.exitUrl, from: params.from, score: finalScore, eventKey: params.eventKey }),
    );
  }, [exiting, router]);

  const handleGiveUp = useCallback(async () => {
    if (exiting) {
      return;
    }
    setExiting(true);
    const params = readGameSearchParams();
    clearSessionSnapshot(cubeSnapshotKey(params.eventKey));
    const finalScore = Math.max(1, dividedScore(scoreRef.current));
    await submitGameScore({
      score: finalScore,
      eventKey: params.eventKey,
      userId: params.userId,
      nickname: params.nickname,
      source: "cube-rush-60-giveup",
    });
    router.push(
      buildGameExitPath({ exitUrl: params.exitUrl, from: params.from, score: finalScore, eventKey: params.eventKey }),
    );
  }, [exiting, router]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      setSoundEnabled(next);
      return next;
    });
  }, []);

  const accuracy = firedTotal === 0 ? 100 : Math.round((removedTotal / firedTotal) * 100);
  const urgent = timeRemaining <= 5 && gameState === "playing";
  const pulse = timeRemaining <= 10 && timeRemaining > 5 && gameState === "playing";

  if (!entryChecked) {
    return (
      <main className="rush-page">
        <div className="rush-shell">
          <section className="rush-visited" aria-live="polite" aria-busy="true">
            <p className="rush-visited-title">확인 중…</p>
          </section>
        </div>
      </main>
    );
  }

  if (needsLogin) {
    return (
      <main className="rush-page">
        <div className="rush-shell">
          <section className="rush-visited" role="alertdialog" aria-live="polite">
            <p className="rush-visited-title">로그인이 필요합니다</p>
            <button
              type="button"
              className="rush-again"
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
      <main className="rush-page">
        <div className="rush-shell">
          <section className="rush-visited" role="alertdialog" aria-live="polite">
            <p className="rush-visited-title">
              {wrongQr ? "잘못된 QR코드입니다" : "이미 진행한 이벤트입니다"}
            </p>
            {wrongQr && (
              <p className="rush-visited-sub">이 코드는 다른 게임의 코드입니다.</p>
            )}
            <button
              type="button"
              className="rush-again"
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
    <main className="rush-page">
      <div className="rush-shell">
        {gameState === "menu" && (
          <section className="rush-menu" aria-label="시작 메뉴">
            <p className="rush-badge">60초 3D 슈팅 퍼즐</p>
            <h1 className="rush-title">Cube Rush 60</h1>
            <p className="rush-desc">같은 색 숫자 블록을 발사칸에 올려 구조물을 깎아내리세요!</p>
            {bestScore > 0 && <p className="rush-best">BEST {bestScore}</p>}
            <button type="button" className="rush-start" onClick={startGame}>
              START
            </button>
            <p className="rush-hint">드래그 회전 · 핀치 줌 · 블록 탭 발사</p>
          </section>
        )}

        {gameState === "playing" && (
          <>
            <header className="rush-hud" aria-label="게임 정보">
              <div className="rush-scorebox">
                <span className="rush-label">SCORE</span>
                <span className="rush-score">{score}</span>
                <span className="rush-combo">{combo >= 2 ? `COMBO ×${combo}` : ""}</span>
              </div>
              <div
                className={`rush-timer${urgent ? " rush-timer-urgent" : ""}${pulse ? " rush-timer-pulse" : ""}`}
                role="timer"
                aria-live="polite"
              >
                {timeRemaining}
              </div>
              <div className="rush-side">
                <button
                  type="button"
                  className="rush-giveup"
                  onClick={handleGiveUp}
                  disabled={exiting}
                  aria-label="포기하기"
                >
                  포기
                </button>
                <button
                  type="button"
                  className="rush-iconbtn"
                  onClick={toggleSound}
                  aria-label={soundOn ? "사운드 끄기" : "사운드 켜기"}
                >
                  {soundOn ? "🔊" : "🔇"}
                </button>
              </div>
            </header>
          </>
        )}

        {/* 3D 씬은 항상 마운트 유지 — 게임 시작·재시작 때마다 재생성하면
            캔버스가 두 번 그려진 것처럼 깜빡인다 */}
        <div
          className="rush-canvaswrap"
          data-show={gameState === "playing"}
        >
          <CubeScene
            cells={cells}
            burst={burst}
            engineRef={engineRef}
            paused={gameState !== "playing"}
            onBatch={handleBatch}
            onVolleyDone={handleVolleyDone}
          />
        </div>

        {gameState === "playing" && (
          <>
            <div className="rush-meta">
              <span>남은 큐브 {cubeCount}</span>
              <span>BEST {Math.max(bestScore, score)}</span>
            </div>

            <div className="rush-slots" aria-label="발사칸">
              {slots.map((s, i) => (
                <div
                  key={i}
                  className={`rush-slot rush-slot-${s.status}${burstSlot === i ? " rush-slot-burst" : ""}`}
                  aria-label={`발사칸 ${i + 1} ${s.status}`}
                  style={
                    s.color !== null && s.count !== null
                      ? { background: CUBE_COLORS[s.color], borderColor: CUBE_COLORS[s.color] }
                      : undefined
                  }
                >
                  {s.count === null ? (
                    <span className="rush-slot-empty">+</span>
                  ) : (
                    <span className="rush-slot-num rush-slot-num-lit">{s.count}</span>
                  )}
                </div>
              ))}
            </div>

            <p className="rush-hint" data-show={hint !== null} role="status" aria-live="polite">
              {hint ?? ""}
            </p>
            <nav className="rush-hand" aria-label="숫자 블록">
              {lanes.map((lane, li) => (
                <div key={li} className="rush-lane" aria-label={`손패 ${li + 1}열`}>
                  {lane.length === 0 && <div className="rush-lane-empty" aria-hidden="true" />}
                  {lane.map((b, p) =>
                    p === 0 ? (
                      <button
                        key={b.uid}
                        type="button"
                        className="rush-block rush-block-top"
                        style={{
                          background: CUBE_COLORS[b.color],
                          top: `${p * LANE_STEP_PX}px`,
                        }}
                        onClick={() => tapHand(li)}
                        aria-label={`${b.count} 발사`}
                      >
                        {b.count}
                      </button>
                    ) : (
                      <div
                        key={b.uid}
                        className="rush-block rush-block-dimmed"
                        style={{
                          background: CUBE_COLORS[b.color],
                          top: `${p * LANE_STEP_PX}px`,
                        }}
                        aria-hidden="true"
                      >
                        {b.count}
                      </div>
                    ),
                  )}
                </div>
              ))}
            </nav>
          </>
        )}

        {gameState === "gameover" && (
          <section className="rush-result" aria-label="결과">
            <p className="rush-badge">{END_LABEL[endReason]}</p>
            <h2 className="rush-title">Cube Rush 60</h2>
            <p className="rush-final">{score}</p>
            <div className="rush-divide" aria-live="polite">
              <span className="rush-divide-op">÷ 1000</span>
              <span className="rush-divide-value">
                {(shownScore ?? dividedScore(score)).toLocaleString("ko-KR")}
              </span>
            </div>
            {endReason === "clear" && <p className="rush-best">시간 보너스 +{clearBonus}</p>}
            <p className="rush-best">
              BEST {dividedScore(Math.max(bestScore, score)).toLocaleString("ko-KR")}
              {score >= Math.max(bestScore, score) && score > 0 ? " 🎉" : ""}
            </p>
            <dl className="rush-stats">
              <div>
                <dt>제거</dt>
                <dd>{removedTotal}</dd>
              </div>
              <div>
                <dt>최대콤보</dt>
                <dd>×{maxCombo}</dd>
              </div>
              <div>
                <dt>정확도</dt>
                <dd>{accuracy}%</dd>
              </div>
            </dl>
            <button
              type="button"
              className="rush-again rush-again-secondary"
              onClick={handleExit}
              disabled={exiting}
            >
              {exiting ? "기록 중…" : "점수 기록하고 나가기"}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
