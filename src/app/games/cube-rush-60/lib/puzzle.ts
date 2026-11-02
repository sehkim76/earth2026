// Cube Rush 60 — 순수 퍼즐 로직 (React/three 의존성 없음, 테스트·엔진 공용)
// 유색 탄약 룰: 구조물은 시작 시 1회만 생성, 플레이 중 추가·리필 없음. 변동은 제거뿐.

import { ART_COUNT, cellsFromArt, type ArtCell } from "./voxel-art";
import { LANE_COUNT, LANE_DEPTH } from "./engine";

export const CUBE_COLORS = [
  "#2D7FF9", // Blue
  "#F43F5E", // Red
  "#22C55E", // Green
  "#FACC15", // Yellow
  "#8B5CF6", // Purple
  "#92400E", // Brown — 곰 갈색 몸통·지구 받침대·책상 현실감용
  "#9AA3B2", // Gray — 곰 주둥이·컴퓨터 본체 현실감용
] as const;

export type CubeColorIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CubeCell {
  id: number;
  x: number;
  y: number;
  z: number;
  color: CubeColorIndex;
  alive: boolean;
}

export interface Puzzle {
  cells: CubeCell[];
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

// 이번 판에 쓰는 탄약 색 (7색 — 하단 포대 색과 일치)
export const AMMO_COLORS: CubeColorIndex[] = [0, 1, 2, 3, 4, 5, 6];

export interface AmmoBlock {
  color: CubeColorIndex;
  count: number;
}

export interface MatchSetup {
  puzzle: Puzzle;
  hand: AmmoBlock[];
  structTotal: Record<number, number>;
  ammoTotal: Record<number, number>;
}

function hashRand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// 바깥에서 닿지 않는 빈칸(내부 구멍)을 최다 색으로 메운다.
function fillInterior(cells: ArtCell[]): ArtCell[] {
  if (cells.length === 0) return cells;
  const filled = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const colorCount = new Map<CubeColorIndex, number>();
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.z < minZ) minZ = c.z;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
    if (c.z > maxZ) maxZ = c.z;
    colorCount.set(c.color, (colorCount.get(c.color) ?? 0) + 1);
  }
  let majority: CubeColorIndex = cells[0]?.color ?? 0;
  let best = -1;
  for (const [color, n] of colorCount) {
    if (n > best) {
      best = n;
      majority = color;
    }
  }
  const outside = new Set<string>();
  const queue: Array<[number, number, number]> = [[minX - 1, minY - 1, minZ - 1]];
  const dirs: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  while (queue.length > 0) {
    const cur = queue.pop() as [number, number, number];
    const [x, y, z] = cur;
    if (x < minX - 1 || x > maxX + 1 || y < minY - 1 || y > maxY + 1 || z < minZ - 1 || z > maxZ + 1) {
      continue;
    }
    const k = `${x},${y},${z}`;
    if (filled.has(k) || outside.has(k)) continue;
    outside.add(k);
    for (const [dx, dy, dz] of dirs) queue.push([x + dx, y + dy, z + dz]);
  }
  const out = [...cells];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const k = `${x},${y},${z}`;
        if (!filled.has(k) && !outside.has(k)) {
          out.push({ x, y, z, color: majority });
        }
      }
    }
  }
  return out;
}

// 매치 1회 생성: 복셀 아트 3종 중 1종을 랜덤 선택해 구조물로 쓴다.
// 셀 색상은 아트 맵 그대로 (셔플 도배 없음) — structTotal은 아트 색상별 개수 그 자체.
// 손패 숫자 합계(ammoTotal)가 색상별로 structTotal과 정확히 일치하게 배분.
// 탄약 소진 = 구조물 전멸이 되도록 여유분을 두지 않는다. 시작 후 추가 없음.
export function generateMatch(seed?: number, artIndex?: number): MatchSetup {
  const seedValue = seed ?? ((Math.random() * 1e9) | 0);
  const rand = hashRand(seedValue);
  // 아트 선택은 순환 지정이 원칙(호출자가 순번 전달). 없으면 시드 모듈로 폴백.
  const artIdx = artIndex === undefined ? (seedValue >>> 0) % ART_COUNT : ((artIndex % ART_COUNT) + ART_COUNT) % ART_COUNT;
  const artCells = cellsFromArt(artIdx);
  // 속 빈 구멍 메우기: 바깥에서 닿지 않는 빈칸은 내부로 보고 최다 색으로 채운다.
  // 빈틈없이 딱 맞게 배치하기 위함. 개수는 아래에서 집계하므로 1:1 유지.
  const filled = fillInterior(artCells);
  const cells: CubeCell[] = filled.map((c, i) => ({
    id: i,
    x: c.x,
    y: c.y,
    z: c.z,
    color: c.color,
    alive: true,
  }));

  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  for (const c of cells) {
    maxX = Math.max(maxX, Math.abs(c.x));
    maxY = Math.max(maxY, c.y);
    maxZ = Math.max(maxZ, Math.abs(c.z));
  }
  const puzzle: Puzzle = {
    cells,
    sizeX: maxX * 2 + 1,
    sizeY: maxY + 1,
    sizeZ: maxZ * 2 + 1,
  };

  // structTotal/ammoTotal: 아트 색상별 개수를 그대로 집계해 정확히 일치시킨다.
  const colors = AMMO_COLORS;
  const structTotal: Record<number, number> = {};
  const ammoTotal: Record<number, number> = {};
  for (const c of colors) {
    structTotal[c] = 0;
    ammoTotal[c] = 0;
  }
  for (const cell of cells) {
    structTotal[cell.color] = (structTotal[cell.color] ?? 0) + 1;
    ammoTotal[cell.color] = (ammoTotal[cell.color] ?? 0) + 1;
  }

  // 손패 20칸(5열 × 4단, LANE_COUNT×LANE_DEPTH): 색상별 합계가 ammoTotal이
  // 되게 분할 (칸당 8~80발). 하드코딩 없이 손패 상수에서 칸 수를 유도한다.
  // 색당 기본 max(1, ceil(개수/80))칸, 합계가 20을 넘으면 최소 칸(>1)인 색부터
  // 1칸씩 회수하고, 모자라면 개수 많은 색부터 1칸씩 추가한다.
  // 어떤 색도 0칸이 되지 않는다 (개수 0인 색은 도안에 쓰지 않는다).
  // 5열 스택에 셔플 후 4개씩 분배한다.
  // 칸당 하한 8·상한 80 유지: 회수는 합친 뒤에도 80 이하인 색에서만,
  // 추가는 나눈 뒤 최소 조각이 8 이상인 색에만 적용한다.
  const TOTAL_BLOCKS = LANE_COUNT * LANE_DEPTH;
  const MAX_PER_BLOCK = 80;
  const MIN_PER_BLOCK = 8;

  const blocksPerColor = new Map<CubeColorIndex, number>();
  for (const c of colors) {
    blocksPerColor.set(c, Math.max(1, Math.ceil((ammoTotal[c] ?? 0) / MAX_PER_BLOCK)));
  }
  const blockSum = (): number => {
    let n = 0;
    for (const v of blocksPerColor.values()) n += v;
    return n;
  };
  // 초과분 회수: 칸이 많은 소수 색부터 (결정적: 칸수→개수→색상 순서).
  // 합친 뒤 칸당 80발을 넘기는 색은 건너뛴다 (상한 유지).
  while (blockSum() > TOTAL_BLOCKS) {
    const cand = [...colors]
      .filter((c) => {
        const parts = blocksPerColor.get(c) ?? 1;
        if (parts <= 1) return false;
        return (ammoTotal[c] ?? 0) <= (parts - 1) * MAX_PER_BLOCK;
      })
      .sort((a, b) => {
        const ba = blocksPerColor.get(a) ?? 1;
        const bb = blocksPerColor.get(b) ?? 1;
        if (bb !== ba) return bb - ba;
        const na = ammoTotal[a] ?? 0;
        const nb = ammoTotal[b] ?? 0;
        if (nb !== na) return na - nb;
        return a - b;
      })[0];
    if (cand === undefined) break;
    blocksPerColor.set(cand, (blocksPerColor.get(cand) ?? 2) - 1);
  }
  // 부족분 추가: 개수 많은 색부터 1칸씩 (동률이면 AMMO_COLORS 순서, 결정적).
  // 나눈 뒤 최소 조각이 8발 미만인 색은 건너뛴다 (하한 유지).
  const ordered = [...colors].sort((a, b) => {
    const d = (ammoTotal[b] ?? 0) - (ammoTotal[a] ?? 0);
    return d !== 0 ? d : a - b;
  });
  let fillIdx = 0;
  let fillGuard = 0;
  while (blockSum() < TOTAL_BLOCKS && fillGuard < colors.length * TOTAL_BLOCKS) {
    fillGuard += 1;
    const c = ordered[fillIdx % ordered.length];
    fillIdx += 1;
    if (c === undefined) break;
    const parts = blocksPerColor.get(c) ?? 1;
    const ammo = ammoTotal[c] ?? 0;
    if (Math.floor(ammo / (parts + 1)) < MIN_PER_BLOCK) continue;
    blocksPerColor.set(c, parts + 1);
  }

  // 균등 분할: base=floor(개수/칸수), 앞 rem칸이 +1씩. 단일칸은 개수 그대로
  // (8~80 범위: 아트는 색당 8개 이상, 칸수는 ceil 맞춤이라 평균이 40~80에 든다).
  const hand: AmmoBlock[] = [];
  for (const c of colors) {
    const parts = blocksPerColor.get(c) ?? 1;
    const ammo = ammoTotal[c] ?? 0;
    const base = Math.floor(ammo / parts);
    const rem = ammo % parts;
    for (let p = 0; p < parts; p++) {
      hand.push({ color: c, count: base + (p < rem ? 1 : 0) });
    }
  }
  const shuffledHand = shuffle(hand, rand);

  return { puzzle, hand: shuffledHand, structTotal, ammoTotal };
}

// 탄환 충돌로 제거된 좌표들을 퍼즐에서 제거한다. 중력 없음 — 빈 자리는 구멍으로 남는다.
export interface GridCoord {
  x: number;
  y: number;
  z: number;
}

export function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export interface RemoveResult {
  puzzle: Puzzle;
  removed: CubeCell[];
}

export function removeCellsAt(puzzle: Puzzle, coords: GridCoord[]): RemoveResult {
  const targets = new Set(coords.map((c) => cellKey(c.x, c.y, c.z)));
  const claimed = new Set<string>();
  const removed: CubeCell[] = [];
  const cells = puzzle.cells.map((c) => {
    const k = cellKey(c.x, c.y, c.z);
    if (c.alive && targets.has(k) && !claimed.has(k)) {
      claimed.add(k);
      removed.push(c);
      return { ...c, alive: false };
    }
    return c;
  });
  return { puzzle: { ...puzzle, cells }, removed };
}

// Volley 보너스: 2연속 +25 / 3연속 +50 / 4연속 +80 / 5연속+ +120
// (빗나간 탄환은 콤보에 영향 없음 — 명중 연속 수로 정산)
export function calculateCombo(streak: number): number {
  if (streak >= 5) return 120;
  if (streak === 4) return 80;
  if (streak === 3) return 50;
  if (streak === 2) return 25;
  return 0;
}

export function aliveCount(puzzle: Puzzle): number {
  return puzzle.cells.reduce((n, c) => (c.alive ? n + 1 : n), 0);
}
