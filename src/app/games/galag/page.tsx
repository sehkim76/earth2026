"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "./galag.css";
import {
  buildGameExitPath,
  checkEventEntry,
  clearSessionSnapshot,
  loadSessionSnapshot,
  readGameSearchParams,
  saveSessionSnapshot,
  submitGameScore,
} from "@/lib/game-score";
import { playGalagSound, unlockAudio } from "./lib/sound";
import {
  BULLET_RADIUS,
  ENEMY_BULLET_RADIUS,
  ENEMY_RADIUS,
  FIRE_INTERVAL,
  INVINCIBLE_TIME,
  PLAYER_RADIUS,
  PLAYER_Y,
  START_LIVES,
  WORLD_H,
  WORLD_W,
  clampPlayerX,
  createFormation,
  movePlayerX,
  pickShooters,
  resetEnemyIds,
  resolvePlayerHit,
  resolveShots,
  spawnEnemyBullets,
  startDive,
  stepBullets,
  stepEnemies,
  stepEnemyBullets,
  waveParams,
  type Bullet,
  type Enemy,
  type EnemyBullet,
  type WaveParams,
} from "./lib/galaga";

type Phase = "title" | "playing" | "waveclear" | "gameover";

interface Hud {
  score: number;
  lives: number;
  wave: number;
  phase: Phase;
  timeLeft: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  speed: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

interface Sim {
  phase: Phase;
  score: number;
  lives: number;
  wave: number;
  playerX: number;
  fireCooldown: number;
  invincibleUntil: number;
  time: number;
  enemies: Enemy[];
  bullets: Bullet[];
  enemyBullets: EnemyBullet[];
  particles: Particle[];
  params: WaveParams;
  fireTimer: number;
  diveTimer: number;
  waveClearTimer: number;
  stars: Star[];
}

const WAVE_CLEAR_DELAY = 2.2;
const GAME_SECONDS = 120;

function hudTimeLeftOf(sim: Sim): number {
  return Math.max(0, Math.ceil(GAME_SECONDS - sim.time));
}

function formatTimeLeft(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function dividedScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.floor(score / 1000);
}
const GALAG_SNAPSHOT_VERSION = 1;

interface GalagSnapshot {
  version: number;
  sim: Sim;
}

function galagSnapshotKey(eventKey: string): string {
  return `galag:${eventKey || "default"}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGalagSnapshot(value: unknown): value is GalagSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== GALAG_SNAPSHOT_VERSION) {
    return false;
  }
  const sim = record.sim;
  if (typeof sim !== "object" || sim === null) {
    return false;
  }
  const simRecord = sim as Record<string, unknown>;
  const phase = simRecord.phase;
  if (phase !== "playing" && phase !== "waveclear" && phase !== "gameover") {
    return false;
  }
  const numericKeys = [
    "score",
    "lives",
    "wave",
    "playerX",
    "fireCooldown",
    "invincibleUntil",
    "time",
    "fireTimer",
    "diveTimer",
    "waveClearTimer",
  ];
  if (!numericKeys.every((key) => isFiniteNumber(simRecord[key]))) {
    return false;
  }
  const arrayKeys = ["enemies", "bullets", "enemyBullets", "particles", "stars"];
  if (!arrayKeys.every((key) => Array.isArray(simRecord[key]))) {
    return false;
  }
  return true;
}

function makeStars(): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < 90; i += 1) {
    stars.push({
      x: (i * 137.5) % WORLD_W,
      y: (i * 89.3) % WORLD_H,
      r: 0.6 + ((i * 7) % 10) / 9,
      speed: 12 + ((i * 13) % 40),
    });
  }
  return stars;
}

function createSim(): Sim {
  resetEnemyIds();
  return {
    phase: "title",
    score: 0,
    lives: START_LIVES,
    wave: 1,
    playerX: WORLD_W / 2,
    fireCooldown: 0,
    invincibleUntil: 0,
    time: 0,
    enemies: createFormation(1),
    bullets: [],
    enemyBullets: [],
    particles: [],
    params: waveParams(1),
    fireTimer: 1,
    diveTimer: 2,
    waveClearTimer: 0,
    stars: makeStars(),
  };
}

function startWave(sim: Sim, wave: number): void {
  sim.wave = wave;
  sim.params = waveParams(wave);
  sim.enemies = createFormation(wave);
  sim.bullets = [];
  sim.enemyBullets = [];
  sim.fireTimer = 1.2;
  sim.diveTimer = 2;
  sim.waveClearTimer = 0;
  sim.phase = "playing";
}

function burst(sim: Sim, x: number, y: number, color: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 90 + ((i * 37) % 120);
    sim.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 0.5 + ((i * 11) % 10) / 25,
      color,
    });
  }
  if (sim.particles.length > 240) {
    sim.particles.splice(0, sim.particles.length - 240);
  }
}

function stepParticles(particles: Particle[], dt: number): Particle[] {
  const out: Particle[] = [];
  for (const p of particles) {
    const life = p.life + dt;
    if (life < p.maxLife) {
      out.push({ ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt, life });
    }
  }
  return out;
}

function enemyColor(kind: Enemy["kind"]): string {
  if (kind === "boss") return "#facc15";
  if (kind === "fighter") return "#f472b6";
  return "#22d3ee";
}

function draw(ctx: CanvasRenderingContext2D, sim: Sim): void {
  const bg = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  bg.addColorStop(0, "#070714");
  bg.addColorStop(0.6, "#0b0b24");
  bg.addColorStop(1, "#12081f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  ctx.save();
  for (const star of sim.stars) {
    ctx.globalAlpha = 0.35 + (star.r / 1.6) * 0.5;
    ctx.fillStyle = "#c7d2fe";
    ctx.fillRect(star.x, star.y, star.r, star.r);
  }
  ctx.restore();

  // 적 탄 (네온 오렌지)
  ctx.save();
  ctx.shadowColor = "#fb923c";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#fdba74";
  for (const b of sim.enemyBullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, ENEMY_BULLET_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 적 기체
  for (const enemy of sim.enemies) {
    const r = ENEMY_RADIUS[enemy.kind];
    const color = enemyColor(enemy.kind);
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (enemy.kind === "boss") {
      ctx.moveTo(0, r);
      ctx.lineTo(r * 0.9, -r * 0.4);
      ctx.lineTo(r * 0.4, -r * 0.2);
      ctx.lineTo(0, -r);
      ctx.lineTo(-r * 0.4, -r * 0.2);
      ctx.lineTo(-r * 0.9, -r * 0.4);
      ctx.closePath();
    } else if (enemy.kind === "fighter") {
      ctx.moveTo(0, r * 0.9);
      ctx.lineTo(r, -r * 0.7);
      ctx.lineTo(0, -r * 0.3);
      ctx.lineTo(-r, -r * 0.7);
      ctx.closePath();
    } else {
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.8, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.8, 0);
      ctx.closePath();
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 플레이어 탄 (네온 시안)
  ctx.save();
  ctx.shadowColor = "#22d3ee";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#a5f3fc";
  for (const b of sim.bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(b.x - 1.5, b.y - 10, 3, 8);
  }
  ctx.restore();

  // 파티클
  ctx.save();
  for (const p of sim.particles) {
    ctx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.restore();

  // 플레이어 기체 (피격 무적 중 깜빡임)
  const blinking = sim.time < sim.invincibleUntil && Math.floor(sim.time * 12) % 2 === 0;
  if (sim.phase !== "gameover" && !blinking) {
    const r = PLAYER_RADIUS;
    ctx.save();
    ctx.translate(sim.playerX, PLAYER_Y);
    ctx.shadowColor = "#4ade80";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "#4ade80";
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.2);
    ctx.lineTo(r * 0.85, r * 0.8);
    ctx.lineTo(r * 0.3, r * 0.45);
    ctx.lineTo(-r * 0.3, r * 0.45);
    ctx.lineTo(-r * 0.85, r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ecfdf5";
    ctx.beginPath();
    ctx.arc(0, -r * 0.3, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 하단 경계선
  ctx.save();
  ctx.strokeStyle = "rgba(74,222,128,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(8, WORLD_H - 12);
  ctx.lineTo(WORLD_W - 8, WORLD_H - 12);
  ctx.stroke();
  ctx.restore();
}

export default function GalagaPage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  if (simRef.current === null) {
    simRef.current = createSim();
  }
  const inputRef = useRef({
    left: false,
    right: false,
    fire: false,
    touchX: null as number | null,
  });
  const [hud, setHud] = useState<Hud>({
    score: 0,
    lives: START_LIVES,
    wave: 1,
    phase: "title",
    timeLeft: GAME_SECONDS,
  });
  const [exiting, setExiting] = useState(false);
  const [shownScore, setShownScore] = useState<number | null>(null);
  const [alreadyVisited, setAlreadyVisited] = useState(false);
  const [wrongQr, setWrongQr] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [entryChecked, setEntryChecked] = useState(false);

  useEffect(() => {
    if (hud.phase !== "gameover") {
      setShownScore(null);
      return;
    }
    const raw = simRef.current?.score ?? hud.score;
    const final = dividedScore(raw);
    if (raw <= 0) {
      setShownScore(0);
      return;
    }
    let raf = 0;
    const startedAt = performance.now();
    const duration = 1400;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShownScore(Math.round(raw + (final - raw) * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hud.phase]);

  const syncHud = useCallback(() => {
    const sim = simRef.current;
    if (sim === null) return;
    setHud((prev) => {
      const timeLeft = hudTimeLeftOf(sim);
      if (
        prev.score === sim.score &&
        prev.lives === sim.lives &&
        prev.wave === sim.wave &&
        prev.phase === sim.phase &&
        prev.timeLeft === timeLeft
      ) {
        return prev;
      }
      return { score: sim.score, lives: sim.lives, wave: sim.wave, phase: sim.phase, timeLeft };
    });
  }, []);

  const startGame = useCallback(() => {
    if (alreadyVisited || wrongQr || needsLogin) {
      return;
    }
    const sim = simRef.current;
    if (sim === null) return;
    unlockAudio();
    const keepStars = sim.stars;
    const fresh = createSim();
    fresh.stars = keepStars;
    fresh.phase = "playing";
    simRef.current = fresh;
    inputRef.current.fire = false;
    inputRef.current.touchX = null;
    const { eventKey } = readGameSearchParams();
    saveSessionSnapshot(galagSnapshotKey(eventKey), {
      version: GALAG_SNAPSHOT_VERSION,
      sim: fresh,
    } satisfies GalagSnapshot);
    syncHud();
  }, [syncHud, alreadyVisited, wrongQr, needsLogin]);

  const handleExit = useCallback(async () => {
    const sim = simRef.current;
    if (exiting || sim === null || sim.phase !== "gameover") {
      return;
    }
    setExiting(true);
    const params = readGameSearchParams();
    clearSessionSnapshot(galagSnapshotKey(params.eventKey));
    const finalScore = dividedScore(sim.score);
    await submitGameScore({
      score: finalScore,
      eventKey: params.eventKey,
      userId: params.userId,
      nickname: params.nickname,
      source: "galag",
    });
    router.push(
      buildGameExitPath({ exitUrl: params.exitUrl, from: params.from, score: finalScore, eventKey: params.eventKey }),
    );
  }, [exiting, router]);

  const handleGiveUp = useCallback(async () => {
    const sim = simRef.current;
    if (exiting || sim === null) {
      return;
    }
    setExiting(true);
    const params = readGameSearchParams();
    clearSessionSnapshot(galagSnapshotKey(params.eventKey));
    const finalScore = Math.max(1, dividedScore(sim.score));
    await submitGameScore({
      score: finalScore,
      eventKey: params.eventKey,
      userId: params.userId,
      nickname: params.nickname,
      source: "galag-giveup",
    });
    router.push(
      buildGameExitPath({ exitUrl: params.exitUrl, from: params.from, score: finalScore, eventKey: params.eventKey }),
    );
  }, [exiting, router]);

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
          const sim = simRef.current;
          if (sim !== null) {
            sim.phase = "title";
          }
          setAlreadyVisited(true);
          syncHud();
        } else if (result === "blocked") {
          setAlreadyVisited(true);
          setWrongQr(true);
          syncHud();
        } else if (result === "login") {
          const sim = simRef.current;
          if (sim !== null) {
            sim.phase = "title";
          }
          setNeedsLogin(true);
          syncHud();
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
  }, [syncHud]);

  // 게임 루프: 클라이언트 마운트 후에만 시작 (Hydration 방지)
  useEffect(() => {
    if (!entryChecked) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    // 리로드 복구
    const { eventKey } = readGameSearchParams();
    const snapshot = loadSessionSnapshot(galagSnapshotKey(eventKey), isGalagSnapshot);
    if (snapshot !== null && simRef.current !== null) {
      const restored = snapshot.sim;
      restored.params = waveParams(Math.max(1, Math.floor(restored.wave)));
      simRef.current = restored;
      inputRef.current.fire = false;
      inputRef.current.touchX = null;
      syncHud();
    }

    const snapshotTimer = window.setInterval(() => {
      const sim = simRef.current;
      if (
        sim === null ||
        (sim.phase !== "playing" && sim.phase !== "waveclear" && sim.phase !== "gameover")
      ) {
        return;
      }
      const { eventKey: liveEventKey } = readGameSearchParams();
      saveSessionSnapshot(galagSnapshotKey(liveEventKey), {
        version: GALAG_SNAPSHOT_VERSION,
        sim,
      } satisfies GalagSnapshot);
    }, 1000);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WORLD_W * dpr;
    canvas.height = WORLD_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let last = performance.now();
    let cancelled = false;

    const frame = (now: number): void => {
      if (cancelled) return;
      raf = requestAnimationFrame(frame);
      const sim = simRef.current;
      if (sim === null) return;
      const input = inputRef.current;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      // 별 배경은 항상 흐름
      for (const star of sim.stars) {
        star.y += star.speed * dt;
        if (star.y > WORLD_H) {
          star.y -= WORLD_H;
          star.x = (star.x + 67) % WORLD_W;
        }
      }
      sim.particles = stepParticles(sim.particles, dt);

      if (sim.phase === "playing" || sim.phase === "waveclear") {
        sim.time += dt;

        // 플레이어 이동
        let direction = 0;
        if (input.left) direction -= 1;
        if (input.right) direction += 1;
        if (direction !== 0) {
          sim.playerX = movePlayerX(sim.playerX, direction, dt);
          input.touchX = null;
        } else if (input.touchX !== null) {
          const target = clampPlayerX(input.touchX);
          const diff = target - sim.playerX;
          const maxStep = 640 * dt;
          sim.playerX = clampPlayerX(sim.playerX + Math.max(-maxStep, Math.min(maxStep, diff)));
        }

        // 발사 (누르고 있으면 연사)
        sim.fireCooldown -= dt;
        if (input.fire && sim.phase === "playing" && sim.fireCooldown <= 0) {
          sim.bullets.push({ x: sim.playerX, y: PLAYER_Y - 20 });
          sim.fireCooldown = FIRE_INTERVAL;
          playGalagSound("shoot");
        }

        // 적 이동
        sim.enemies = stepEnemies(sim.enemies, dt, sim.time, sim.playerX, sim.params);
        sim.bullets = stepBullets(sim.bullets, dt);
        sim.enemyBullets = stepEnemyBullets(sim.enemyBullets, dt);

        // 적 발사
        if (sim.phase === "playing") {
          sim.fireTimer -= dt;
          if (sim.fireTimer <= 0 && sim.enemies.length > 0) {
            const shooters = pickShooters(sim.enemies, sim.wave >= 4 ? 3 : sim.wave >= 2 ? 2 : 1);
            const spawned = spawnEnemyBullets(shooters, sim.params.enemyBulletSpeed);
            for (const b of spawned) sim.enemyBullets.push(b);
            if (spawned.length > 0) {
              playGalagSound("enemyShoot");
            }
            sim.fireTimer = sim.params.fireInterval;
          }

          // 급강하
          sim.diveTimer -= dt;
          if (sim.diveTimer <= 0 && sim.enemies.length > 0) {
            sim.enemies = startDive(sim.enemies, sim.playerX, sim.wave >= 3 ? 2 : 1);
            sim.diveTimer = sim.params.diveInterval;
          }
        }

        // 탄-적 충돌 → 점수·폭발
        const shot = resolveShots(sim.enemies, sim.bullets);
        sim.enemies = shot.enemies;
        sim.bullets = shot.bullets;
        if (shot.kills > 0) {
          sim.score += shot.gained;
          playGalagSound("enemyDown");
          for (const boom of shot.explosions) {
            burst(sim, boom.x, boom.y, enemyColor(boom.kind), 10);
          }
        }

        // 적탄·적기체와 플레이어 충돌 → 목숨
        const hit = resolvePlayerHit(
          sim.enemies,
          sim.enemyBullets,
          sim.playerX,
          sim.time < sim.invincibleUntil,
        );
        sim.enemies = hit.enemies;
        sim.enemyBullets = hit.bullets;
        if (hit.hit) {
          burst(sim, sim.playerX, PLAYER_Y, "#4ade80", 22);
          playGalagSound("playerDown");
          if (sim.lives > 1) {
            sim.lives -= 1;
            sim.invincibleUntil = sim.time + INVINCIBLE_TIME;
            sim.enemyBullets = [];
          } else {
            sim.lives = 0;
            sim.phase = "gameover";
            playGalagSound("gameover");
          }
        }

        // 웨이브 클리어 → 다음 웨이브
        if (sim.phase === "playing" && sim.enemies.length === 0) {
          sim.phase = "waveclear";
          sim.waveClearTimer = WAVE_CLEAR_DELAY;
        } else if (sim.phase === "waveclear") {
          sim.waveClearTimer -= dt;
          if (sim.waveClearTimer <= 0) {
            startWave(sim, sim.wave + 1);
          }
        }

        if (sim.time >= GAME_SECONDS && sim.phase !== "gameover") {
          burst(sim, sim.playerX, PLAYER_Y, "#4ade80", 22);
          sim.phase = "gameover";
          playGalagSound("gameover");
        }

        setHud((prev) => {
          const timeLeft = hudTimeLeftOf(sim);
          if (
            prev.score === sim.score &&
            prev.lives === sim.lives &&
            prev.wave === sim.wave &&
            prev.phase === sim.phase &&
            prev.timeLeft === timeLeft
          ) {
            return prev;
          }
          return { score: sim.score, lives: sim.lives, wave: sim.wave, phase: sim.phase, timeLeft };
        });
      } else if (sim.phase === "title") {
        // 타이틀 배경: 편대가 살랑이며 대기
        sim.time += dt;
        sim.enemies = stepEnemies(sim.enemies, dt, sim.time, WORLD_W / 2, sim.params);
      }

      draw(ctx, sim);
    };

    raf = requestAnimationFrame((t) => {
      last = t;
      frame(t);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearInterval(snapshotTimer);
    };
  }, [syncHud, entryChecked]);

  // 키보드 조작
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const sim = simRef.current;
      if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
        event.preventDefault();
        inputRef.current.left = true;
      } else if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") {
        event.preventDefault();
        inputRef.current.right = true;
      } else if (event.key === " ") {
        event.preventDefault();
        if (sim !== null && (sim.phase === "title" || sim.phase === "gameover")) {
          if (!event.repeat) {
            startGame();
          }
        } else {
          inputRef.current.fire = true;
        }
      } else if (event.key === "Enter") {
        if (sim !== null && (sim.phase === "title" || sim.phase === "gameover")) {
          if (!event.repeat) {
            startGame();
          }
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
        inputRef.current.left = false;
      } else if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") {
        inputRef.current.right = false;
      } else if (event.key === " ") {
        inputRef.current.fire = false;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startGame]);

  const canvasToGameX = (clientX: number): number | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return ((clientX - rect.left) / rect.width) * WORLD_W;
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLCanvasElement>): void => {
    const sim = simRef.current;
    if (sim !== null && (sim.phase === "title" || sim.phase === "gameover")) {
      return;
    }
    // React의 터치 리스너는 passive이므로 preventDefault() 호출 금지.
    // 스크롤/줌 차단은 CSS touch-action: none(.galaga-canvas)으로 처리한다.
    const touch = event.touches[0];
    if (touch) {
      const gx = canvasToGameX(touch.clientX);
      if (gx !== null) inputRef.current.touchX = gx;
      inputRef.current.fire = true;
      const s = simRef.current;
      if (s !== null) s.fireCooldown = Math.min(s.fireCooldown, 0);
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLCanvasElement>): void => {
    const touch = event.touches[0];
    if (touch) {
      const gx = canvasToGameX(touch.clientX);
      if (gx !== null) inputRef.current.touchX = gx;
    }
  };

  const endTouch = (): void => {
    inputRef.current.fire = false;
    inputRef.current.touchX = null;
  };

  const livesText = "♥".repeat(hud.lives) + "♡".repeat(Math.max(0, START_LIVES - hud.lives));

  if (!entryChecked) {
    return (
      <main className="galaga-page">
        <div className="galaga-container">
          <section className="galaga-visited" aria-live="polite" aria-busy="true">
            <p className="galaga-visited-title">확인 중…</p>
          </section>
        </div>
      </main>
    );
  }

  if (needsLogin) {
    return (
      <main className="galaga-page">
        <div className="galaga-container">
          <section className="galaga-visited" role="alertdialog" aria-live="polite">
            <p className="galaga-visited-title">로그인이 필요합니다</p>
            <button
              type="button"
              className="galaga-button galaga-button-big"
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
      <main className="galaga-page">
        <div className="galaga-container">
          <section className="galaga-visited" role="alertdialog" aria-live="polite">
            <p className="galaga-visited-title">
              {wrongQr ? "잘못된 QR코드입니다" : "이미 진행한 이벤트입니다"}
            </p>
            {wrongQr && (
              <p className="galaga-visited-sub">이 코드는 다른 게임의 코드입니다.</p>
            )}
            <button
              type="button"
              className="galaga-button galaga-button-big"
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
    <main className="galaga-page">
      <div className="galaga-container">
        <section className="galaga-timer" aria-label="남은 플레이 시간">
          <div
            className="galaga-timer-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={GAME_SECONDS}
            aria-valuenow={hud.timeLeft}
            aria-label={`남은 시간 ${formatTimeLeft(hud.timeLeft)}`}
          >
            <div
              className={`galaga-timer-fill${hud.timeLeft <= 10 ? " galaga-timer-fill-low" : ""}`}
              style={{ width: `${(hud.timeLeft / GAME_SECONDS) * 100}%` }}
            />
          </div>
          <span className="galaga-timer-text">{formatTimeLeft(hud.timeLeft)}</span>
          {(hud.phase === "playing" || hud.phase === "waveclear") && (
            <button
              type="button"
              className="galaga-button galaga-giveup"
              onClick={handleGiveUp}
              disabled={exiting}
            >
              포기
            </button>
          )}
        </section>

        <section className="galaga-hud" aria-label="게임 정보">
          <div className="galaga-hud-card">
            <span className="galaga-hud-label">SCORE</span>
            <span className="galaga-hud-value">{hud.score}</span>
          </div>
          <div className="galaga-hud-card">
            <span className="galaga-hud-label">WAVE</span>
            <span className="galaga-hud-value">{hud.wave}</span>
          </div>
          <div className="galaga-hud-card">
            <span className="galaga-hud-label">LIVES</span>
            <span className="galaga-hud-lives" aria-label={`목숨 ${hud.lives}개`}>
              {livesText}
            </span>
          </div>
        </section>

        <div className="galaga-stage">
          <canvas
            ref={canvasRef}
            className="galaga-canvas"
            role="img"
            aria-label="갤러그 슈팅 게임 화면"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={endTouch}
            onTouchCancel={endTouch}
          />
          {hud.phase === "title" && (
            <div className="galaga-overlay" role="status">
              <p className="galaga-overlay-title">GALAG</p>
              <p className="galaga-overlay-text">
                방향키 / A·D 이동 · 스페이스 연사
                <br />
                모바일은 드래그 이동 · 터치 발사
              </p>
              <button
                type="button"
                className="galaga-button galaga-button-big"
                onClick={(event) => {
                  event.currentTarget.blur();
                  startGame();
                }}
              >
                ▶ 게임 시작
              </button>
            </div>
          )}
          {hud.phase === "waveclear" && (
            <div className="galaga-overlay galaga-overlay-clear" role="status" aria-live="polite">
              <p className="galaga-overlay-title">WAVE {hud.wave} CLEAR!</p>
              <p className="galaga-overlay-text">다음 웨이브로 진입합니다…</p>
            </div>
          )}
          {hud.phase === "gameover" && (
            <div className="galaga-overlay" role="status" aria-live="polite">
              <p className="galaga-overlay-title">GAME OVER</p>
              <p className="galaga-overlay-text">
                SCORE {hud.score.toLocaleString("ko-KR")} · WAVE {hud.wave}
              </p>
              <div className="galaga-divide" aria-live="polite">
                <span className="galaga-divide-op">÷ 1000</span>
                <span className="galaga-divide-value">
                  {(shownScore ?? dividedScore(hud.score)).toLocaleString("ko-KR")}
                </span>
              </div>
              <button
                type="button"
                className="galaga-button galaga-button-big"
                onClick={handleExit}
                disabled={exiting}
              >
                {exiting ? "기록 중…" : "점수 기록하고 나가기"}
              </button>
            </div>
          )}
        </div>

      </div>
    </main>
  );
}
