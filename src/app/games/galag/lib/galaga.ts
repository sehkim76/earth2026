/**
 * galaga.ts — 갤러그식 슈팅 게임의 순수 로직 모듈.
 *
 * 렌더(Canvas)와 게임 루프(rAF)는 app/page.tsx가 담당하고,
 * 이 파일은 타입·편대 생성·이동·충돌·스폰 계산만 담당한다.
 * 모든 함수는 인자로 받은 상태를 직접 바꾸지 않고 새 값을 반환한다.
 */

export const WORLD_W = 480;
export const WORLD_H = 640;

export const PLAYER_Y = 584;
export const PLAYER_RADIUS = 14;
export const PLAYER_SPEED = 340; // px/s

export const FIRE_INTERVAL = 0.18; // 연사 간격(초)
export const BULLET_SPEED = 580; // px/s
export const BULLET_RADIUS = 4;

export const ENEMY_BULLET_RADIUS = 5;
export const INVINCIBLE_TIME = 2; // 피격 후 무적(초)

export const START_LIVES = 3;

export type EnemyKind = "scout" | "fighter" | "boss";
export type EnemyMotion = "formation" | "diving" | "returning";

export const ENEMY_SCORE: Record<EnemyKind, number> = {
  scout: 50,
  fighter: 100,
  boss: 300,
};

export const ENEMY_RADIUS: Record<EnemyKind, number> = {
  scout: 12,
  fighter: 14,
  boss: 19,
};

export interface Enemy {
  id: number;
  kind: EnemyKind;
  /** 현재 위치 */
  x: number;
  y: number;
  /** 편대 복귀 목표 위치 */
  homeX: number;
  homeY: number;
  motion: EnemyMotion;
  /** 급강하 진행도 0~1 */
  diveT: number;
  /** 급강하 시작 x / 좌우 흔들 방향 */
  diveFromX: number;
  diveDir: number;
}

export interface Bullet {
  x: number;
  y: number;
}

export interface EnemyBullet {
  x: number;
  y: number;
  speed: number;
}

export interface WaveParams {
  /** 편대 좌우 흔들 속도 */
  swaySpeed: number;
  /** 편대 좌우 흔들 폭 */
  swayAmp: number;
  /** 적 탄 속도 */
  enemyBulletSpeed: number;
  /** 적 발사 간격(초) */
  fireInterval: number;
  /** 급강하 개시 간격(초) */
  diveInterval: number;
  /** 급강하 낙하 속도 배율 */
  diveSpeed: number;
}

/** 웨이브가 오를수록 적 속도·발사 빈도가 상승한다 */
export function waveParams(wave: number): WaveParams {
  const w = Math.max(1, Math.floor(wave));
  return {
    swaySpeed: Math.min(0.6 + w * 0.12, 2.2),
    swayAmp: Math.min(18 + w * 2, 34),
    enemyBulletSpeed: Math.min(170 + w * 30, 420),
    fireInterval: Math.max(1.15 - w * 0.12, 0.35),
    diveInterval: Math.max(2.6 - w * 0.25, 0.9),
    diveSpeed: Math.min(0.55 + w * 0.07, 1.3),
  };
}

let nextEnemyId = 1;

/** 적 편대 생성. 보스 4 + 파이터 8 + 스카웃 8 (웨이브 3부터 한 줄씩 추가) */
export function createFormation(wave: number): Enemy[] {
  const enemies: Enemy[] = [];
  const cx = WORLD_W / 2;
  const spawn = (kind: EnemyKind, x: number, y: number): void => {
    enemies.push({
      id: nextEnemyId,
      kind,
      x,
      y,
      homeX: x,
      homeY: y,
      motion: "formation",
      diveT: 0,
      diveFromX: x,
      diveDir: x < cx ? 1 : -1,
    });
    nextEnemyId += 1;
  };

  const bossGap = 52;
  for (let i = 0; i < 4; i += 1) {
    spawn("boss", cx + (i - 1.5) * bossGap, 84);
  }
  const fighterGap = 52;
  for (let row = 0; row < 2; row += 1) {
    for (let i = 0; i < 4; i += 1) {
      spawn("fighter", cx + (i - 1.5) * fighterGap * 1.5, 140 + row * 44);
    }
  }
  const scoutGap = 48;
  for (let row = 0; row < 2; row += 1) {
    const count = wave >= 3 ? 6 : 4;
    for (let i = 0; i < count; i += 1) {
      spawn(
        "scout",
        cx + (i - (count - 1) / 2) * scoutGap * 1.4,
        232 + row * 42,
      );
    }
  }
  return enemies;
}

/** 다음 적 id 발급값을 웨이브 시작 시점에 리셋(테스트·재시작 안정용) */
export function resetEnemyIds(): void {
  nextEnemyId = 1;
}

export function circlesHit(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/** 편대 흔들림: formation 상태 적의 표시 x 좌표 */
export function formationX(enemy: Enemy, time: number, params: WaveParams): number {
  return enemy.homeX + Math.sin(time * params.swaySpeed + enemy.homeY * 0.05) * params.swayAmp;
}

/**
 * 적 전체를 한 프레임 전진시킨다.
 * - formation: 편대 흔들림 위치로 복귀
 * - diving: 플레이어 쪽으로 급강하하며 좌우로 흔들림, 화면 밖으로 나가면 returning
 * - returning: 편대 자리로 복귀, 도착하면 formation
 */
export function stepEnemies(
  enemies: readonly Enemy[],
  dt: number,
  time: number,
  playerX: number,
  params: WaveParams,
): Enemy[] {
  return enemies.map((enemy) => {
    if (enemy.motion === "formation") {
      const x = formationX(enemy, time, params);
      return { ...enemy, x, y: enemy.homeY };
    }
    if (enemy.motion === "diving") {
      const nextT = enemy.diveT + dt * params.diveSpeed;
      if (nextT >= 1) {
        return { ...enemy, motion: "returning", diveT: 1, x: enemy.x, y: WORLD_H + 30 };
      }
      const startY = enemy.homeY;
      const endY = WORLD_H + 40;
      const x =
        enemy.diveFromX +
        (playerX - enemy.diveFromX) * nextT +
        Math.sin(nextT * Math.PI * 2) * 70 * enemy.diveDir;
      const y = startY + (endY - startY) * nextT * nextT;
      return { ...enemy, x, y, diveT: nextT };
    }
    // returning
    const speed = 260;
    const dx = enemy.homeX - enemy.x;
    const dy = enemy.homeY - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) {
      return { ...enemy, motion: "formation", x: enemy.homeX, y: enemy.homeY, diveT: 0 };
    }
    const step = Math.min(dist, speed * dt);
    return {
      ...enemy,
      x: enemy.x + (dx / dist) * step,
      y: enemy.y + (dy / dist) * step,
    };
  });
}

/** 급강하 개시: formation 상태 중 최대 n기를 diving으로 바꾼다(순수, 선택은 앞에서부터) */
export function startDive(enemies: readonly Enemy[], playerX: number, count: number): Enemy[] {
  let left = count;
  return enemies.map((enemy) => {
    if (left > 0 && enemy.motion === "formation") {
      left -= 1;
      return {
        ...enemy,
        motion: "diving" as EnemyMotion,
        diveT: 0,
        diveFromX: enemy.x,
        diveDir: enemy.x < playerX ? 1 : -1,
      };
    }
    return enemy;
  });
}

/** 발사 후보: 화면 안에 있고 플레이어보다 위에 있는 적 중 아래쪽 n기 */
export function pickShooters(enemies: readonly Enemy[], count: number): Enemy[] {
  const candidates = enemies.filter((e) => e.y > 0 && e.y < PLAYER_Y - 40);
  candidates.sort((a, b) => b.y - a.y);
  return candidates.slice(0, Math.max(0, count));
}

export function spawnEnemyBullets(
  shooters: readonly Enemy[],
  bulletSpeed: number,
): EnemyBullet[] {
  return shooters.map((s) => ({ x: s.x, y: s.y + ENEMY_RADIUS[s.kind], speed: bulletSpeed }));
}

/** 플레이어 탄 전진 + 화면 밖 제거 */
export function stepBullets(bullets: readonly Bullet[], dt: number): Bullet[] {
  const out: Bullet[] = [];
  for (const b of bullets) {
    const y = b.y - BULLET_SPEED * dt;
    if (y > -20) out.push({ x: b.x, y });
  }
  return out;
}

/** 적 탄 전진 + 화면 밖 제거 */
export function stepEnemyBullets(bullets: readonly EnemyBullet[], dt: number): EnemyBullet[] {
  const out: EnemyBullet[] = [];
  for (const b of bullets) {
    const y = b.y + b.speed * dt;
    if (y < WORLD_H + 20) out.push({ x: b.x, y, speed: b.speed });
  }
  return out;
}

export interface PlayerHitResult {
  bullets: EnemyBullet[];
  enemies: Enemy[];
  hit: boolean;
}

/**
 * 적 탄·적 기체와 플레이어 충돌 판정.
 * 무적 중이면 탄만 통과시키고 hit=false를 반환한다.
 */
export function resolvePlayerHit(
  enemies: readonly Enemy[],
  enemyBullets: readonly EnemyBullet[],
  playerX: number,
  invincible: boolean,
): PlayerHitResult {
  if (invincible) {
    return { bullets: [...enemyBullets], enemies: [...enemies], hit: false };
  }
  const keptBullets = enemyBullets.filter(
    (b) => !circlesHit(b.x, b.y, ENEMY_BULLET_RADIUS, playerX, PLAYER_Y, PLAYER_RADIUS),
  );
  const bulletHit = keptBullets.length !== enemyBullets.length;
  let bodyHit = false;
  const keptEnemies = enemies.filter((e) => {
    const hit = circlesHit(e.x, e.y, ENEMY_RADIUS[e.kind], playerX, PLAYER_Y, PLAYER_RADIUS);
    if (hit) bodyHit = true;
    return !hit;
  });
  return { bullets: keptBullets, enemies: keptEnemies, hit: bulletHit || bodyHit };
}

export interface ShotResult {
  bullets: Bullet[];
  enemies: Enemy[];
  gained: number;
  kills: number;
  explosions: { x: number; y: number; kind: EnemyKind }[];
}

/** 플레이어 탄과 적 충돌 판정 → 점수·격추 집계 */
export function resolveShots(
  enemies: readonly Enemy[],
  bullets: readonly Bullet[],
): ShotResult {
  const alive: Enemy[] = [...enemies];
  const kept: Bullet[] = [];
  const explosions: { x: number; y: number; kind: EnemyKind }[] = [];
  let gained = 0;
  let kills = 0;
  for (const bullet of bullets) {
    let hitIndex = -1;
    for (let i = 0; i < alive.length; i += 1) {
      const e = alive[i];
      if (circlesHit(bullet.x, bullet.y, BULLET_RADIUS, e.x, e.y, ENEMY_RADIUS[e.kind])) {
        hitIndex = i;
        break;
      }
    }
    if (hitIndex >= 0) {
      const [down] = alive.splice(hitIndex, 1);
      gained += ENEMY_SCORE[down.kind];
      kills += 1;
      explosions.push({ x: down.x, y: down.y, kind: down.kind });
    } else {
      kept.push(bullet);
    }
  }
  return { bullets: kept, enemies: alive, gained, kills, explosions };
}

/** 플레이어 x 이동(경계 클램프 포함) */
export function movePlayerX(x: number, direction: number, dt: number): number {
  const next = x + direction * PLAYER_SPEED * dt;
  return Math.min(Math.max(next, PLAYER_RADIUS + 4), WORLD_W - PLAYER_RADIUS - 4);
}

/** 터치·드래그 목표 지점으로 이동(경계 클램프 포함) */
export function clampPlayerX(x: number): number {
  return Math.min(Math.max(x, PLAYER_RADIUS + 4), WORLD_W - PLAYER_RADIUS - 4);
}
