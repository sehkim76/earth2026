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

/** Trace the union of occupied cells, keeping the filled side to the left of each edge. */
export const buildWalkableContours = (tiles: ContourTile[], tileSize: number): WalkableContour[] => {
  const key = (col: number, row: number): number => col * 100000 + row;
  const byTile = new Map(tiles.map(tile => [key(tile.tileColumn, tile.tileRow), tile]));
  // A four-bit edge mask per cell keeps dense urban road networks within a mobile worker's memory.
  const masks = new Map<number, Uint8Array>();
  const boundaryCell = (tile: ContourTile | undefined, x: number, y: number): boolean =>
    !!tile && x < tile.nx && y < tile.ny && tile.filled[y * tile.nx + x] === 1;
  for (const tile of tiles) {
    const { nx, ny, filled, tileColumn: col, tileRow: row } = tile;
    const left = byTile.get(key(col - 1, row));
    const right = byTile.get(key(col + 1, row));
    const below = byTile.get(key(col, row - 1));
    const above = byTile.get(key(col, row + 1));
    const mask = new Uint8Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (!filled[i]) continue;
        if (!(y ? filled[i - nx] : boundaryCell(below, x, tileSize - 1))) mask[i] |= 1;
        if (!(x + 1 < nx ? filled[i + 1] : x + 1 === tileSize && boundaryCell(right, 0, y))) mask[i] |= 2;
        if (!(y + 1 < ny ? filled[i + nx] : y + 1 === tileSize && boundaryCell(above, x, 0))) mask[i] |= 4;
        if (!(x ? filled[i - 1] : boundaryCell(left, tileSize - 1, y))) mask[i] |= 8;
      }
    }
    masks.set(key(col, row), mask);
  }
  const dx = [1, 0, -1, 0];
  const dy = [0, 1, 0, -1];
  const startX = [0, 1, 1, 0];
  const startY = [0, 0, 1, 1];
  const consume = (x: number, y: number, dir: number): boolean => {
    const cellX = x - startX[dir];
    const cellY = y - startY[dir];
    const col = Math.floor(cellX / tileSize);
    const row = Math.floor(cellY / tileSize);
    const tileKey = key(col, row);
    const tile = byTile.get(tileKey);
    const mask = masks.get(tileKey);
    if (!tile || !mask) return false;
    const localX = cellX - col * tileSize;
    const localY = cellY - row * tileSize;
    if (localX >= tile.nx || localY >= tile.ny) return false;
    const i = localY * tile.nx + localX;
    const bit = 1 << dir;
    if (!(mask[i] & bit)) return false;
    mask[i] &= ~bit;
    return true;
  };
  function trace(x: number, y: number, dir: number): ContourPoint[] {
    const firstX = x;
    const firstY = y;
    const ring: ContourPoint[] = [];
    do {
      ring.push([x, y]);
      x += dx[dir];
      y += dy[dir];
      if (x === firstX && y === firstY) break;
      // At diagonal contacts, stay on the current component.
      const left = (dir + 1) % 4;
      const right = (dir + 3) % 4;
      if (consume(x, y, left)) dir = left;
      else if (!consume(x, y, dir)) {
        if (!consume(x, y, right)) break;
        dir = right;
      }
    } while (true);
    return ring;
  }
  const contours: WalkableContour[] = [];
  function addRing(ring: ContourPoint[]): void {
    if (ring.length < 4) return;
    const half = Math.floor(ring.length / 2);
    // 허용치 1.0셀: 점 개수를 줄여 stroke·인코딩을 가볍게 한다 (시각 차이는 미세).
    const simplified = [
      ...simplifyLine(ring.slice(0, half + 1), 1.0).slice(0, -1),
      ...simplifyLine([...ring.slice(half), ring[0]], 1.0).slice(0, -1),
    ];
    // A small island or hole can simplify into a line. Keep its original boundary.
    const points = simplified.length >= 3 ? simplified : ring;
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
  for (const tile of tiles) {
    const mask = masks.get(key(tile.tileColumn, tile.tileRow))!;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = tile.tileColumn * tileSize + i % tile.nx;
      const y = tile.tileRow * tileSize + Math.floor(i / tile.nx);
      for (let dir = 0; dir < 4; dir++) {
        if (!(mask[i] & (1 << dir))) continue;
        mask[i] &= ~(1 << dir);
        addRing(trace(x + startX[dir], y + startY[dir], dir));
      }
    }
  }
  return contours;
};
