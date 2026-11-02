export type ContourPoint = [number, number];

export interface ContourTile {
  tileColumn: number;
  tileRow: number;
  nx: number;
  ny: number;
  filled: Uint8Array;
}

export interface WalkableContour {
  points: ContourPoint[];
  west: number;
  south: number;
  east: number;
  north: number;
}

interface BoundaryEdge {
  from: ContourPoint;
  to: ContourPoint;
  direction: number;
  visited: boolean;
}

/** Iterative RDP avoids stack overflow on long coast/island contours. */
const simplifyLine = (points: ContourPoint[], tolerance: number): ContourPoint[] => {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const pending: [number, number][] = [[0, points.length - 1]];
  while (pending.length > 0) {
    const range = pending.pop();
    if (!range) break;
    const [start, end] = range;
    const a = points[start];
    const b = points[end];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    let maximum = tolerance * tolerance;
    let split = -1;
    for (let i = start + 1; i < end; i += 1) {
      const p = points[i];
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
        ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared,
      ));
      const distanceSquared = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (distanceSquared > maximum) {
        maximum = distanceSquared;
        split = i;
      }
    }
    if (split !== -1) {
      keep[split] = 1;
      pending.push([start, split], [split, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
};

/** Trace the union on a shared grid, then simplify within 0.6 cells (about 3m). */
export const buildWalkableContours = (tiles: ContourTile[], tileSize: number): WalkableContour[] => {
  // 숫자 키 (문자열 할당 회피). 타일 좌표 < 100000, 정점 좌표는 중첩 맵으로 오버플로 없이 처리.
  const byTile = new Map(tiles.map((tile) => [tile.tileColumn * 100000 + tile.tileRow, tile]));
  const occupied = (x: number, y: number): boolean => {
    const column = Math.floor(x / tileSize);
    const row = Math.floor(y / tileSize);
    const tile = byTile.get(column * 100000 + row);
    if (!tile) return false;
    const localX = x - column * tileSize;
    const localY = y - row * tileSize;
    return localX < tile.nx && localY < tile.ny && tile.filled[localY * tile.nx + localX] === 1;
  };
  const outgoing = new Map<number, Map<number, BoundaryEdge[]>>();
  const edges: BoundaryEdge[] = [];
  const outgoingGet = (x: number, y: number): BoundaryEdge[] | undefined => outgoing.get(x)?.get(y);
  const add = (from: ContourPoint, to: ContourPoint, direction: number): void => {
    const edge: BoundaryEdge = { from, to, direction, visited: false };
    let col = outgoing.get(from[0]);
    if (!col) {
      col = new Map<number, BoundaryEdge[]>();
      outgoing.set(from[0], col);
    }
    const group = col.get(from[1]) ?? [];
    group.push(edge);
    col.set(from[1], group);
    edges.push(edge);
  };
  for (const tile of tiles) {
    for (let y = 0; y < tile.ny; y += 1) {
      for (let x = 0; x < tile.nx; x += 1) {
        if (tile.filled[y * tile.nx + x] !== 1) continue;
        const gx = tile.tileColumn * tileSize + x;
        const gy = tile.tileRow * tileSize + y;
        if (!occupied(gx, gy - 1)) add([gx, gy], [gx + 1, gy], 0);
        if (!occupied(gx + 1, gy)) add([gx + 1, gy], [gx + 1, gy + 1], 1);
        if (!occupied(gx, gy + 1)) add([gx + 1, gy + 1], [gx, gy + 1], 2);
        if (!occupied(gx - 1, gy)) add([gx, gy + 1], [gx, gy], 3);
      }
    }
  }
  const contours: WalkableContour[] = [];
  for (const first of edges) {
    if (first.visited) continue;
    const ring: ContourPoint[] = [];
    let current: BoundaryEdge | undefined = first;
    while (current && !current.visited) {
      current.visited = true;
      ring.push(current.from);
      if (current.to[0] === first.from[0] && current.to[1] === first.from[1]) break;
      const choices: BoundaryEdge[] = (outgoingGet(current.to[0], current.to[1]) ?? [])
        .filter((edge) => !edge.visited);
      // Keep diagonally touching components separate by preferring a left turn.
      const direction: number = current.direction;
      current = choices.find((edge) => edge.direction === (direction + 1) % 4) ?? choices[0];
    }
    if (ring.length < 4) continue;
    const half = Math.floor(ring.length / 2);
    // 허용치 1.0셀: 점 개수를 줄여 stroke·인코딩을 가볍게 한다 (시각 차이는 미세).
    const points = [
      ...simplifyLine(ring.slice(0, half + 1), 1.0).slice(0, -1),
      ...simplifyLine([...ring.slice(half), ring[0]], 1.0).slice(0, -1),
    ];
    if (points.length < 3) continue;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [x, y] of ring) {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
    contours.push({ points, west, south, east, north });
  }
  return contours;
};
