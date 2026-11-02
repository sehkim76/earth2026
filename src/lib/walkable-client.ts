/**
 * 동별 도로망 기반 도보 가능 판정 (동기, 로컬 정적 데이터).
 * 조이스틱 이동 게이팅용 — 네트워크 왕복 없이 프레임 단위 판정한다.
 * 데이터는 빌드 스크립트(/tmp/opencode/osm/build_walkable.py)가
 * Geofabrik PBF에서 생성한 `/walkable/roads/{dongId}.json`이다.
 * 데이터가 아직 없으면 null 반환(fail-open, 이동 허용).
 */

/** 도로 중심선으로부터 도보 가능 버퍼 (m). */
import { buildWalkableContours } from "@/lib/walkable-contours";
import { loadGraphDong, searchGraphs } from "@/lib/walkable-graph";
import {
  fetchWithTimeout,
  queuedFetch,
  readCachedMeta,
  readCachedRaster,
  withIdbTimeout,
  writeCachedMeta,
  writeCachedRaster,
} from "@/lib/walkable-cache";

export const WALKABLE_BUFFER_M = 15;

/** 이동가능영역 디버그 로그 (console.debug — 평소엔 숨겨져 있어 UX 영향 없음). */
let wlogCount = 0;
const wlogLastByKey = new Map<string, number>();
export const wlog = (...args: unknown[]): void => {
  try {
    if (wlogCount > 300) {
      return;
    }
    const key = String(args[0] ?? "");
    const now = Date.now();
    const last = wlogLastByKey.get(key) ?? 0;
    // 같은 키는 2초에 1회로 (콘솔 폭주 방지).
    if (now - last < 2000 && args[0] !== "overlay ready") {
      return;
    }
    wlogLastByKey.set(key, now);
    wlogCount += 1;
    console.debug("[walkable]", ...args);
  } catch {
    // 로깅 실패 무시.
  }
};

/** 오버레이 표시 중인 동 (LRU에서 밀어내지 않는다 — 행군 재현 로드가 덮어쓰는 것 방지). */
const overlayPinned = new Set<string>();

type LonLat = [number, number];
type BBox = [number, number, number, number];

const INDEX_URL = "/walkable/index.json";
const ADJACENCY_URL = "/walkable/adjacency.json";
const roadUrl = (dongId: string): string => `/walkable/roads/${encodeURIComponent(dongId)}.json`;

/** 빌드타임 구움 래스터 (scripts/build-walkable-raster.py). 없으면 런타임에 직접 굽는다. */
const rasterUrl = (dongId: string): string => `/walkable/raster/${encodeURIComponent(dongId)}.json`;

/** 구움 타일 비트팩 디코딩 (MSB-first, raw deflate). */
const decodeBakedTile = async (b64: string, nx: number, ny: number): Promise<Uint8Array | null> => {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const stream = new DecompressionStream("deflate");
    const out = await new Response(
      new Blob([bytes]).stream().pipeThrough(stream),
    ).arrayBuffer();
    const packed = new Uint8Array(out);
    const filled = new Uint8Array(nx * ny);
    for (let i = 0; i < packed.length; i += 1) {
      const byte = packed[i] as number;
      if (!byte) {
        continue;
      }
      for (let bit = 0; bit < 8; bit += 1) {
        if (byte & (1 << (7 - bit))) {
          const idx = i * 8 + bit;
          if (idx < filled.length) {
            filled[idx] = 1;
          }
        }
      }
    }
    return filled;
  } catch {
    return null;
  }
};

/** 구움 래스터 JSON → GridFull. 하나라도 깨지면 null (런타임 래스터로 폴백). */
const gridsFromBaked = async (dongId: string, data: unknown): Promise<GridFull[] | null> => {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as { v?: unknown; tiles?: unknown };
  if (record.v !== 1 || !Array.isArray(record.tiles) || record.tiles.length === 0) {
    return null;
  }
  const kx = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
  const cellLon = GRID_CELL_M / kx;
  const cellLat = GRID_CELL_M / 110540;
  const grids: GridFull[] = [];
  for (const tile of record.tiles as unknown[]) {
    if (typeof tile !== "object" || tile === null) {
      return null;
    }
    const entry = tile as { c?: unknown; b?: unknown; f?: unknown };
    if (
      !Array.isArray(entry.c) ||
      entry.c.length !== 2 ||
      typeof entry.c[0] !== "number" ||
      typeof entry.c[1] !== "number" ||
      !Array.isArray(entry.b) ||
      entry.b.length !== 4 ||
      !entry.b.every((v) => typeof v === "number") ||
      typeof entry.f !== "string"
    ) {
      return null;
    }
    const [tileColumn, tileRow] = entry.c as [number, number];
    const [west, south, east, north] = entry.b as [number, number, number, number];
    const filled = await decodeBakedTile(entry.f, GRID_TILE_CELLS, GRID_TILE_CELLS);
    if (!filled) {
      return null;
    }
    // 대용량 동(수십 타일) 디코딩이 한 프레임에 몰려 롱태스크가 되지 않게 양보한다.
    if (grids.length % 4 === 3) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    grids.push({
      key: `dong:${dongId}:${tileColumn}:${tileRow}`,
      dongId,
      tileColumn,
      tileRow,
      dataUrl: "",
      borderDataUrl: "",
      west,
      south,
      east,
      north,
      cellLon,
      cellLat,
      nx: GRID_TILE_CELLS,
      ny: GRID_TILE_CELLS,
      filled,
      contourRuns: decodeBakedRuns((entry as { o?: unknown }).o),
    });
  }
  return grids;
};

const dongRoads = new Map<string, LonLat[][] | null>();
const pendingLoads = new Map<string, Promise<GridFull[] | null>>();
let index: Record<string, BBox> | null = null;
let indexPromise: Promise<Record<string, BBox> | null> | null = null;
let indexFailedAt = 0;
const INDEX_RETRY_MS = 60 * 1000;
let adjacency: Record<string, string[]> | null = null;

type WalkableListener = () => void;
const listeners = new Set<WalkableListener>();

/** 동 도로망 로드 완료 시 호출된다. 오버레이 다시 그리기에 사용한다. */
export const subscribeWalkableData = (fn: WalkableListener): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const notifyWalkableData = (): void => {
  // 로드 완료 알림 폭주(동마다 1회 → 거대 맵 컴포넌트 리렌더 연발)를 trailing으로 합친다.
  // 리로드 직후 1분간 메인스레드 점유의 주범.
  if (notifyTimer !== null) {
    return;
  }
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
  }, 400);
};

/** 로드된 모든 동의 도로선 (오버레이 표시용). */
export const getLoadedRoadLines = (): LonLat[][] => {
  const lines: LonLat[][] = [];
  dongRoads.forEach((roads) => {
    if (roads) {
      for (const line of roads) {
        lines.push(line);
      }
    }
  });
  return lines;
};

export interface WalkableGrid {
  key: string;
  dataUrl: string;
  borderDataUrl: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** 래스터 격자 해상도. 버퍼는 WALKABLE_BUFFER_M을 그대로 굽는다. */
const GRID_CELL_M = 5;
const GRID_TILE_CELLS = 800;
// 모든 동이 같은 격자 원점/해상도를 사용해야 중복 도로의 윤곽이 일치한다.
const GRID_REFERENCE_LAT = 36;

export interface GridFull extends WalkableGrid {
  dongId: string;
  tileColumn: number;
  tileRow: number;
  cellLon: number;
  cellLat: number;
  nx: number;
  ny: number;
  filled: Uint8Array;
  /** 구움 윤곽 run (전역 셀 좌표). undefined면 런타임 trace 폴백. */
  contourRuns?: Array<Array<[number, number]>>;
}

/** 구움 윤곽 디코드 (varint 델타). undefined=미베이크, []=윤곽 없음. */
const decodeBakedRuns = (o: unknown): Array<Array<[number, number]>> | undefined => {
  if (o === undefined || o === null) {
    return undefined;
  }
  if (typeof o !== "string" || o.length === 0) {
    return [];
  }
  try {
    const binary = atob(o as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const nums: number[] = [];
    let pos = 0;
    while (pos < bytes.length) {
      let value = 0;
      let shift = 0;
      let byte = 0;
      do {
        byte = bytes[pos++] as number;
        value += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte >= 128);
      nums.push(value % 2 === 1 ? -(value + 1) / 2 : value / 2);
    }
    let cursor = 0;
    const runCount = nums[cursor++] as number;
    const runs: Array<Array<[number, number]>> = [];
    for (let r = 0; r < runCount; r += 1) {
      const len = nums[cursor++] as number;
      const run: Array<[number, number]> = [];
      let px = 0;
      let py = 0;
      for (let i = 0; i < len; i += 1) {
        px += nums[cursor++] as number;
        py += nums[cursor++] as number;
        run.push([px, py]);
      }
      if (run.length >= 2) {
        runs.push(run);
      }
    }
    return runs;
  } catch {
    return undefined;
  }
};

/** 동별 격자 캐시 (표시 + 게이팅 공용). */
const dongGrids = new Map<string, GridFull[]>();
let mergedGridInputs: GridFull[] = [];
let mergedGrids: GridFull[] = [];
let mergedGridRevision = 0;

const invalidateDongGrid = (dongId: string): void => {
  dongGrids.delete(dongId);
};

/** 도로선을 작은 래스터 타일로 굽는다. 한 동 전체 크기에 상한을 두지 않는다. */
const rasterizeTile = (
  dongId: string,
  lines: LonLat[][],
  west: number,
  south: number,
  east: number,
  north: number,
  refLat: number,
  key: string,
  tileColumn: number,
  tileRow: number,
): GridFull | null => {
  const kx = 111320 * Math.cos((refLat * Math.PI) / 180);
  const cellLon = GRID_CELL_M / kx;
  const cellLat = GRID_CELL_M / 110540;
  const nx = GRID_TILE_CELLS;
  const ny = GRID_TILE_CELLS;
  if (nx * ny > GRID_TILE_CELLS ** 2) {
    return null;
  }
  const filled = new Uint8Array(nx * ny);
  const radiusCells = Math.ceil(WALKABLE_BUFFER_M / GRID_CELL_M);
  const stamp = (cx: number, cy: number): void => {
    for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
      for (let dy = -radiusCells; dy <= radiusCells; dy += 1) {
        if (dx * dx + dy * dy > radiusCells * radiusCells) {
          continue;
        }
        const ix = cx + dx;
        const iy = cy + dy;
        if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) {
          filled[iy * nx + ix] = 1;
        }
      }
    }
  };
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const lon1 = line[i - 1][0];
      const lat1 = line[i - 1][1];
      const lon2 = line[i][0];
      const lat2 = line[i][1];
      if (
        Math.max(lon1, lon2) < west - WALKABLE_BUFFER_M / kx ||
        Math.min(lon1, lon2) > east + WALKABLE_BUFFER_M / kx ||
        Math.max(lat1, lat2) < south - WALKABLE_BUFFER_M / 110540 ||
        Math.min(lat1, lat2) > north + WALKABLE_BUFFER_M / 110540
      ) {
        continue;
      }
      const ix1 = Math.floor((lon1 - west) / cellLon);
      const iy1 = Math.floor((lat1 - south) / cellLat);
      const ix2 = Math.floor((lon2 - west) / cellLon);
      const iy2 = Math.floor((lat2 - south) / cellLat);
      const steps = Math.max(Math.abs(ix2 - ix1), Math.abs(iy2 - iy1), 1);
      for (let s = 0; s <= steps; s += 1) {
        stamp(Math.round(ix1 + ((ix2 - ix1) * s) / steps), Math.round(iy1 + ((iy2 - iy1) * s) / steps));
      }
    }
  }
  return {
    key,
    dongId,
    tileColumn,
    tileRow,
    dataUrl: "",
    borderDataUrl: "",
    west,
    south,
    east,
    north,
    cellLon,
    cellLat,
    nx,
    ny,
    filled,
  };
};

/** 동 bbox를 도로가 지나는 타일만 생성해 큰 읍·면도 5m 해상도로 표시한다. */
const rasterizeToGrid = (
  dongId: string,
  lines: LonLat[][],
  west: number,
  south: number,
  east: number,
  north: number,
  refLat: number,
): GridFull[] => {
  const kx = 111320 * Math.cos((refLat * Math.PI) / 180);
  const cellLon = GRID_CELL_M / kx;
  const cellLat = GRID_CELL_M / 110540;
  const firstColumn = Math.floor(west / (GRID_TILE_CELLS * cellLon));
  const firstRow = Math.floor(south / (GRID_TILE_CELLS * cellLat));
  west = firstColumn * GRID_TILE_CELLS * cellLon;
  south = firstRow * GRID_TILE_CELLS * cellLat;
  const nx = Math.max(1, Math.ceil((east - west) / cellLon));
  const ny = Math.max(1, Math.ceil((north - south) / cellLat));
  const tileColumns = Math.ceil(nx / GRID_TILE_CELLS);
  const tileRows = Math.ceil(ny / GRID_TILE_CELLS);
  const radius = Math.ceil(WALKABLE_BUFFER_M / GRID_CELL_M);
  const occupied = new Set<string>();
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const x1 = Math.floor((line[i - 1][0] - west) / cellLon);
      const y1 = Math.floor((line[i - 1][1] - south) / cellLat);
      const x2 = Math.floor((line[i][0] - west) / cellLon);
      const y2 = Math.floor((line[i][1] - south) / cellLat);
      const minColumn = Math.max(0, Math.floor((Math.min(x1, x2) - radius) / GRID_TILE_CELLS));
      const maxColumn = Math.min(tileColumns - 1, Math.floor((Math.max(x1, x2) + radius) / GRID_TILE_CELLS));
      const minRow = Math.max(0, Math.floor((Math.min(y1, y2) - radius) / GRID_TILE_CELLS));
      const maxRow = Math.min(tileRows - 1, Math.floor((Math.max(y1, y2) + radius) / GRID_TILE_CELLS));
      for (let column = minColumn; column <= maxColumn; column += 1) {
        for (let row = minRow; row <= maxRow; row += 1) {
          occupied.add(`${column},${row}`);
        }
      }
    }
  }
  const grids: GridFull[] = [];
  for (const tile of occupied) {
    const [column, row] = tile.split(",").map(Number);
    const globalColumn = firstColumn + column;
    const globalRow = firstRow + row;
    const tileWest = globalColumn * GRID_TILE_CELLS * cellLon;
    const tileSouth = globalRow * GRID_TILE_CELLS * cellLat;
    const tileEast = tileWest + GRID_TILE_CELLS * cellLon;
    const tileNorth = tileSouth + GRID_TILE_CELLS * cellLat;
    const grid = rasterizeTile(
      dongId,
      lines,
      tileWest,
      tileSouth,
      tileEast,
      tileNorth,
      refLat,
      `dong:${dongId}:${globalColumn}:${globalRow}`,
      globalColumn,
      globalRow,
    );
    if (grid) {
      grids.push(grid);
    }
  }
  return grids;
};

/** 윤곽 캐시 (타일 집합 기준 — 같은 집합은 재계산하지 않는다). */
import type { WalkableContour } from "@/lib/walkable-contours";

const contourCache = new Map<string, WalkableContour[]>();
const CONTOUR_CACHE_LIMIT = 8;

/** 윤곽 조회 (캐시, 없으면 빌드). */
const getWalkableContours = (needsPaint: GridFull[]): WalkableContour[] => {
  const contourSig = needsPaint.map((grid) => grid.key).sort().join(",");
  let contours = contourCache.get(contourSig);
  if (!contours) {
    contours = buildWalkableContours(needsPaint, GRID_TILE_CELLS);
    contourCache.set(contourSig, contours);
    if (contourCache.size > CONTOUR_CACHE_LIMIT) {
      const oldest = contourCache.keys().next();
      if (!oldest.done) {
        contourCache.delete(oldest.value);
      }
    }
  }
  return contours;
};

/** 채움 래스터화만 (빠름 — 첫 페인트용). */
export const paintWalkableFillTiles = (grids: GridFull[], visibleKeys?: Set<string>): void => {
  if (typeof document === "undefined") {
    return;
  }
  for (const grid of grids) {
    if (grid.dataUrl) {
      continue;
    }
    if (visibleKeys && !visibleKeys.has(grid.key)) {
      continue;
    }
    const canvas = document.createElement("canvas");
    canvas.width = grid.nx;
    canvas.height = grid.ny;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      continue;
    }
    const image = ctx.createImageData(grid.nx, grid.ny);
    for (let y = 0; y < grid.ny; y += 1) {
      for (let x = 0; x < grid.nx; x += 1) {
        if (grid.filled[y * grid.nx + x] !== 1) {
          continue;
        }
        const offset = ((grid.ny - 1 - y) * grid.nx + x) * 4;
        image.data[offset] = 167;
        image.data[offset + 1] = 139;
        image.data[offset + 2] = 250;
        image.data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    grid.dataUrl = canvas.toDataURL("image/png");
  }
};

/** 테두리 래스터화만 (무거움 — idle 시 후속 페인트용). */
export const paintWalkableBorderTiles = (grids: GridFull[], visibleKeys?: Set<string>): void => {
  if (typeof document === "undefined") {
    return;
  }
  const needsBorder = grids.filter(
    (grid) => grid.dataUrl && !grid.borderDataUrl && (!visibleKeys || visibleKeys.has(grid.key)),
  );
  if (needsBorder.length === 0) {
    return;
  }
  // 구움 run이 없는 타일만 런타임 trace (보통은 전부 구움).
  const fallbackTargets = needsBorder.filter((grid) => grid.contourRuns === undefined);
  const contours = fallbackTargets.length > 0 ? getWalkableContours(grids.filter((grid) => !grid.borderDataUrl)) : [];
  // 2.5m/pixel border texture: 4x 대비 픽셀 1/4로 인코딩·그리기가 가볍다.
  const borderScale = 2;
  for (const grid of needsBorder) {
    const canvas = document.createElement("canvas");
    canvas.width = grid.nx * borderScale;
    canvas.height = grid.ny * borderScale;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      continue;
    }
    ctx.strokeStyle = "#1491ff";
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const originX = grid.tileColumn * GRID_TILE_CELLS;
    const originY = grid.tileRow * GRID_TILE_CELLS;
    // 구움 run 우선 (타일 경계 이음매 없음), 없으면 trace 폴백.
    const runs = grid.contourRuns ?? [];
    if (grid.contourRuns === undefined) {
      for (const contour of contours) {
        if (contour.east < originX - 1 || contour.west > originX + grid.nx + 1 ||
            contour.north < originY - 1 || contour.south > originY + grid.ny + 1) continue;
        strokeRun(ctx, contour.points, originX, originY, grid.ny, borderScale);
      }
    } else {
      for (const run of runs) {
        strokeRun(ctx, run, originX, originY, grid.ny, borderScale);
      }
    }
    grid.borderDataUrl = canvas.toDataURL("image/png");
  }
};

/** run 1개를 둥글게 stroke한다 (trace 폴백·구움 공용). */
const strokeRun = (
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  originX: number,
  originY: number,
  tileNy: number,
  borderScale: number,
): void => {
  if (points.length < 2) {
    return;
  }
  // 양 끝이 닿으면 닫힌 ring으로 stroke한다 (구움 전체 포함 ring 대응).
  const first = points[0];
  const last = points[points.length - 1];
  const closed = !!first && !!last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1.5;
  ctx.beginPath();
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[(i + points.length - 1) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (!previous || !current || !next) {
      continue;
    }
    // 구움 run은 열린 폴리라인이라 끝점에서 이전·다음이 같아질 수 있다.
    const distanceBefore = Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    const distanceAfter = Math.hypot(next[0] - current[0], next[1] - current[1]);
    const before = Math.min(0.5, distanceBefore / 2) / Math.max(distanceBefore, 1e-9);
    const after = Math.min(0.5, distanceAfter / 2) / Math.max(distanceAfter, 1e-9);
    const startX = (current[0] + (previous[0] - current[0]) * before - originX) * borderScale;
    const startY = (tileNy - current[1] - (previous[1] - current[1]) * before + originY) * borderScale;
    const endX = (current[0] + (next[0] - current[0]) * after - originX) * borderScale;
    const endY = (tileNy - current[1] - (next[1] - current[1]) * after + originY) * borderScale;
    if (i === 0) ctx.moveTo(startX, startY);
    else ctx.lineTo(startX, startY);
    ctx.quadraticCurveTo((current[0] - originX) * borderScale,
      (tileNy - current[1] + originY) * borderScale, endX, endY);
  }
  // 열린 run은 닫지 않는다 (닫힌 ring만 close).
  if (closed) {
    ctx.closePath();
  }
  ctx.stroke();
};

/** 타일 경계를 이어서 그리드 윤곽을 파란색으로 표시한다. (미표시 타일만 그린다) */
export const paintWalkableTiles = (grids: GridFull[], visibleKeys?: Set<string>): void => {
  paintWalkableFillTiles(grids, visibleKeys);
  paintWalkableBorderTiles(grids, visibleKeys);
};

/**
 * 특정 동의 도보 가능 영역을 해당 동 bbox 래스터로 만든다 (위치 무관, 표시+게이팅 공용).
 */
export const getWalkableGridImageForDong = (dongId: string): GridFull[] | null => {
  if (!dongId || !index) {
    return null;
  }
  const hit = dongGrids.get(dongId);
  if (hit) return hit;
  const roads = dongRoads.get(dongId);
  if (roads === undefined) {
    void loadDong(dongId);
    return null;
  }
  if (!roads || roads.length === 0) {
    return null;
  }
  const bbox = index[dongId];
  if (!bbox) {
    return null;
  }
  const refLat = GRID_REFERENCE_LAT;
  const kx = 111320 * Math.cos((refLat * Math.PI) / 180);
  const grids = rasterizeToGrid(
    dongId,
    roads,
    bbox[0] - 30 / kx,
    bbox[1] - 30 / 110540,
    bbox[2] + 30 / kx,
    bbox[3] + 30 / 110540,
    refLat,
  );
  if (grids.length > 0) {
    dongGrids.set(dongId, grids);
    evictOldestGrid();
  }
  return grids;
};

/** 지정된 동만의 격자 (이동가능 레이어 표시용). */
export const getWalkableDongGrids = (dongIds: string[]): GridFull[] => {
  const out: GridFull[] = [];
  for (const id of new Set(dongIds)) {
    out.push(...(getWalkableGridImageForDong(id) ?? []));
  }
  if (out.length === mergedGridInputs.length && out.every((grid, i) => grid === mergedGridInputs[i])) {
    return mergedGrids;
  }
  const tiles = new Map<string, GridFull>();
  mergedGridRevision += 1;
  for (const grid of out) {
    const key = `${grid.tileColumn}:${grid.tileRow}`;
    const existing = tiles.get(key);
    if (!existing) {
      // 단일 출처 타일은 원본 그대로 재사용한다 (복사·다시 그리기 없음).
      tiles.set(key, grid);
      continue;
    }
    let union = existing.dongId === "union" ? existing : null;
    if (!union) {
      // 첫 충돌 때만 복사본을 만든다 (경계 겹침 타일만 해당).
      union = {
        ...existing,
        dongId: "union",
        key: `union:${mergedGridRevision}:${key}`,
        filled: existing.filled.slice(),
      };
      tiles.set(key, union);
    }
    for (let i = 0; i < grid.filled.length; i += 1) {
      union.filled[i] |= grid.filled[i];
    }
    // 합성 내용은 매번 달라질 수 있으므로 다시 그린다.
    union.dataUrl = "";
    union.borderDataUrl = "";
  }
  const combined = [...tiles.values()];
  paintWalkableTiles(combined);
  mergedGridInputs = out;
  mergedGrids = combined;
  return combined;
};

/** 표시용 타일 합성 캐시 (전역 타일 좌표 기준 — 멤버십이 바뀔 때만 다시 합성한다). */
const overlayUnionCache = new Map<string, { membersSig: string; grid: GridFull }>();

const mergeOverlayTiles = (grids: GridFull[]): GridFull[] => {
  const groups = new Map<string, GridFull[]>();
  for (const grid of grids) {
    const colRow = `${grid.tileColumn}:${grid.tileRow}`;
    const group = groups.get(colRow);
    if (group) {
      if (!group.some((member) => member.key === grid.key)) {
        group.push(grid);
      }
    } else {
      groups.set(colRow, [grid]);
    }
  }
  const out: GridFull[] = [];
  for (const [colRow, members] of groups) {
    const first = members[0];
    if (!first) {
      continue;
    }
    if (members.length === 1) {
      out.push(first);
      continue;
    }
    const membersSig = members.map((member) => member.key).sort().join(",");
    let cached = overlayUnionCache.get(colRow);
    if (!cached || cached.membersSig !== membersSig) {
      // 멤버십 해시 (키 안정 + 내용 변경 시 재페인트).
      let hash = 2166136261;
      for (let i = 0; i < membersSig.length; i += 1) {
        hash ^= membersSig.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const merged = first.filled.slice();
      for (let m = 1; m < members.length; m += 1) {
        const filled = members[m]?.filled;
        if (!filled) {
          continue;
        }
        for (let i = 0; i < merged.length; i += 1) {
          merged[i] |= filled[i] as number;
        }
      }
      cached = {
        membersSig,
        grid: {
          ...first,
          dongId: "union",
          key: `union:${colRow}:${(hash >>> 0).toString(16)}`,
          filled: merged,
          dataUrl: "",
          borderDataUrl: "",
          contourRuns: members.every((member) => member.contourRuns !== undefined)
            ? members.flatMap((member) => member.contourRuns ?? [])
            : undefined,
        },
      };
      overlayUnionCache.set(colRow, cached);
      if (overlayUnionCache.size > 100) {
        const oldest = overlayUnionCache.keys().next();
        if (!oldest.done) {
          overlayUnionCache.delete(oldest.value);
        }
      }
    }
    out.push(cached.grid);
  }
  // 페인트는 호출자(레이어)가 담당한다. 여기서 전부 그리면 첫 표시가 블로킹된다.
  // 위성 레이어는 보이는 타일 채움만 동기 + 테두리 idle, globe/cesium은 합성 시점에 그린다.
  return out;
};

/** 아직 메모리에 없는 오버레이 동 목록 (스피너 표시용, 부수효과 없음). */
export const getWalkablePendingDongs = (dongIds: string[]): string[] => {
  const pending: string[] = [];
  for (const id of new Set(dongIds)) {
    if (!dongGrids.has(id)) {
      pending.push(id);
    }
  }
  return pending;
};

/**
 * 표시용 타일 (전부 로드될 때까지 null — 동이 따로 도착할 때마다
 * 합성·윤곽을 처음부터 다시 만드는 누적 블로킹을 없애기 위해 한 번에 그린다).
 */
/** IDB 재로드 1회 시도 기록 (무한 대기 방지). */
const rasterReloaded = new Set<string>();

/** Ready 대기 로그 (pending 집합이 바뀔 때만). */
let lastPendingSig = "";

/**
 * 표시용 타일 (되는 것부터 즉시 반환 — 전부 모을 때까지 기다리지 않는다).
 * 모자란 동은 로드를 걸고 pending으로 알린다. 실패한 동은 빈 타일로 간주해
 * 다음 호출에서 제외한다 (무한 대기 없음). 스피너는 그릴 게 하나도 없을 때만.
 */
export const getWalkableOverlayTilesBestEffort = (dongIds: string[]): {
  tiles: GridFull[];
  pending: string[];
} => {
  const unique = [...new Set(dongIds)];
  // 현재 오버레이 집합을 고정해 라우팅 로드가 밀어내지 못하게 한다.
  overlayPinned.clear();
  for (const id of unique) {
    overlayPinned.add(id);
  }
  const all: GridFull[] = [];
  const pending: string[] = [];
  for (const id of unique) {
    const grids = dongGrids.get(id);
    if (grids) {
      all.push(...grids);
      continue;
    }
    // 래스터 확보 불가면 도로 경로로 폴백한다 (미베이크 동 대응).
    if (rasterFailed.has(id)) {
      if (dongRoads.get(id) === undefined) {
        void loadDong(id);
        pending.push(id);
        continue;
      }
      continue;
    }
    if (!rasterDone.has(id)) {
      void loadRasterGrids(id);
      pending.push(id);
      continue;
    }
    if (!rasterReloaded.has(id)) {
      // 프리페치(IDB만)된 경우는 메모리로 1회 재로드한다.
      rasterReloaded.add(id);
      void loadRasterGrids(id);
      pending.push(id);
      continue;
    }
    // 구움 없음 → 도로 경로로 폴백 (이동 시점에 로드됨). 준비될 때까지 대기.
    if (dongRoads.get(id) === undefined) {
      void loadDong(id);
      pending.push(id);
      continue;
    }
  }
  if (pending.length > 0) {
    const sig = pending.join(",");
    if (sig !== lastPendingSig) {
      lastPendingSig = sig;
      wlog("overlay wait", `${unique.length - pending.length}/${unique.length}`, pending.slice(0, 6));
    }
  } else if (lastPendingSig !== "") {
    lastPendingSig = "";
    wlog("overlay ready", `tiles:${all.length}`);
  }
  try {
    (window as unknown as { __walkableDebug?: unknown }).__walkableDebug = {
      pending,
      at: Date.now(),
    };
  } catch {
    // 디버그 노출 실패는 무시한다.
  }
  return { tiles: mergeOverlayTiles(all), pending };
};

/** 좌표를 포함하는 도로망 동 ID를 반환한다. */
export const getWalkableDongIdsAt = (lat: number, lon: number): string[] => {
  if (!index || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return [];
  }
  const exact = Object.entries(index)
    .filter(([, bbox]) => lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3])
    .map(([id]) => id);
  return exact.length > 0 ? exact : candidateDongIds(lat, lon) ?? [];
};

/** 좌표가 속한 도로망 동과 인접 동의 도로망을 로드한다. */
export const ensureWalkableLocation = (lat: number, lon: number): void => {
  void loadIndex().then((loaded) => {
    if (!loaded) {
      return;
    }
    for (const id of getWalkableDongIdsAt(lat, lon)) {
      void loadDong(id);
      for (const neighbor of getAdjacentDongIds(id)) {
        void loadDong(neighbor);
      }
    }
  });
};

/**
 * 격자 셀 동기 판정 (오버레이와 동일한 래스터 기준).
 * 후보 동의 격자 중 하나라도 버퍼 셀이면 true, 범위 밖이면 false,
 * 데이터/격자 미비면 null (fail-open). rAF에서는 격자를 재생성하지 않는다.
 */
export const isWalkableGridSync = (lat: number, lon: number): boolean | null => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (!index) {
    ensureWalkableData(lat, lon);
    return null;
  }
  const ids = candidateDongIds(lat, lon) ?? [];
  if (ids.length === 0) {
    return false;
  }
  let covered = false;
  for (const id of ids) {
    if (!dongRoads.has(id)) {
      void loadDong(id);
      return null;
    }
    const grids = dongGrids.get(id);
    if (!grids) {
      return null;
    }
    for (const grid of grids) {
      const ix = Math.floor((lon - grid.west) / grid.cellLon);
      const iy = Math.floor((lat - grid.south) / grid.cellLat);
      if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) {
        continue;
      }
      covered = true;
      if (grid.filled[iy * grid.nx + ix] === 1) {
        return true;
      }
    }
  }
  return covered ? false : null;
};

export interface WalkableLocationCorrection {
  lat: number;
  lon: number;
  distanceM: number;
}

/** 위경도 웨이포인트 목록을 line-of-sight 단축으로 편다 (Theta*식 string-pulling).
 *  앞에서부터 가장 먼 지점까지 직선이 전부 이동가능 셀이고 충분히 단축되면
 *  중간을 잘라낸다. 막다른 왕복·우회 구불음이 모두 여기서 제거된다.
 *  데이터 없으면 유지 (fail-open). */
export const smoothPathLatLon = (
  points: Array<{ lat: number; lon: number }>,
): Array<{ lat: number; lon: number }> => {
  const first = points[0];
  if (!first || points.length < 4) {
    return points;
  }
  const kx = 111320 * Math.cos((first.lat * Math.PI) / 180);
  const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
    Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
  const lineOpen = (aLat: number, aLon: number, bLat: number, bLon: number): boolean => {
    const total = Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 110540);
    // 좁은 수로(5m급)를 빗나가지 않게 2m 간격으로 샘플한다.
    const steps = Math.max(1, Math.ceil(total / 2));
    for (let s = 0; s <= steps; s += 1) {
      const lat = aLat + ((bLat - aLat) * s) / steps;
      const lon = aLon + ((bLon - aLon) * s) / steps;
      if (isWalkableGridSync(lat, lon) !== true) {
        return false;
      }
    }
    return true;
  };
  const out: Array<{ lat: number; lon: number }> = [first];
  // 누적 도보 거리 (구간합 O(1) 조회용).
  const cum: number[] = [0];
  for (let k = 1; k < points.length; k += 1) {
    const p = points[k - 1];
    const q = points[k];
    cum.push((cum[k - 1] as number) + (p && q ? distM(p, q) : 0));
  }
  // 막다른길 탐지용 공간 해시 (10m 셀). 점 개수와 무관하게 50m 이내 복귀점을 찾는다.
  const SPUR_RADIUS_M = 50;
  const SPUR_CELL_M = 10;
  const SPUR_MIN_WALK_M = 150;
  const ex = (p: { lat: number; lon: number }): number => p.lon * kx;
  const ey = (p: { lat: number; lon: number }): number => p.lat * 110540;
  const cellMap = new Map<string, number[]>();
  for (let k = 0; k < points.length; k += 1) {
    const p = points[k];
    if (!p) {
      continue;
    }
    const key = `${Math.floor(ex(p) / SPUR_CELL_M)}:${Math.floor(ey(p) / SPUR_CELL_M)}`;
    const bucket = cellMap.get(key);
    if (bucket) {
      bucket.push(k);
    } else {
      cellMap.set(key, [k]);
    }
  }
  const nearbyLater = (idx: number): number[] => {
    const anchor = points[idx];
    if (!anchor) {
      return [];
    }
    const ax = ex(anchor);
    const ay = ey(anchor);
    const collected = new Set<number>();
    const minCx = Math.floor((ax - SPUR_RADIUS_M) / SPUR_CELL_M);
    const maxCx = Math.floor((ax + SPUR_RADIUS_M) / SPUR_CELL_M);
    const minCy = Math.floor((ay - SPUR_RADIUS_M) / SPUR_CELL_M);
    const maxCy = Math.floor((ay + SPUR_RADIUS_M) / SPUR_CELL_M);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const bucket = cellMap.get(`${cx}:${cy}`);
        if (!bucket) {
          continue;
        }
        for (const j of bucket) {
          if (j > idx + 1) {
            collected.add(j);
          }
        }
      }
    }
    return [...collected].sort((a, b) => b - a);
  };
  // ahead 탐색 상한 (점 개수·거리). 그 이상은 어차피 다음 앵커에서 처리된다.
  const WINDOW = 120;
  const MAX_CHORD_M = 600;
  let i = 0;
  while (i < points.length - 1) {
    const anchor = points[i];
    let best = i + 1;
    if (anchor) {
      // 1) 막다른길 우선 제거: 반경 내 가장 먼 복귀점으로 점프한다.
      for (const j of nearbyLater(i)) {
        const candidate = points[j];
        if (!candidate) {
          continue;
        }
        const direct = distM(anchor, candidate);
        if (direct > SPUR_RADIUS_M) {
          continue;
        }
        const walk = (cum[j] as number) - (cum[i] as number);
        if (walk < SPUR_MIN_WALK_M || walk < direct * 3) {
          continue;
        }
        if (!lineOpen(anchor.lat, anchor.lon, candidate.lat, candidate.lon)) {
          continue;
        }
        best = j;
        break;
      }
    }
    if (best === i + 1 && anchor) {
      // 2) 일반 펴기: 가장 먼 단축 지점으로 점프한다.
      const end = Math.min(points.length - 1, i + WINDOW);
      for (let j = end; j > i + 1; j -= 1) {
        const candidate = points[j];
        if (!candidate) {
          continue;
        }
        const direct = distM(anchor, candidate);
        if (direct < 5 || direct > MAX_CHORD_M) {
          continue;
        }
        const walk = (cum[j] as number) - (cum[i] as number);
        // 단축 효과가 작으면 유지한다 (사소한 지그재그는 건드리지 않음).
        if (walk < direct * 1.2 + 15) {
          continue;
        }
        if (!lineOpen(anchor.lat, anchor.lon, candidate.lat, candidate.lon)) {
          continue;
        }
        best = j;
        break;
      }
    }
    const next = points[best];
    if (!next) {
      break;
    }
    out.push(next);
    i = best;
  }
  return out;
};

/** 출발지→목적지 이동가능 셀 경로 (A*, 5m 격자). 없으면 null. */
/** A* 단일 구간 상한 (m). 이보다 길면 다구간으로 나눈다. */
const LEG_MAX_M = 2500;

export const findWalkablePath = async (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  maxDistanceM = 8000,
  skipGridFallback = false,
  deadlineMs = 0,
): Promise<Array<{ lat: number; lon: number }> | null> => {
  if (
    !Number.isFinite(fromLat) ||
    !Number.isFinite(fromLon) ||
    !Number.isFinite(toLat) ||
    !Number.isFinite(toLon)
  ) {
    return null;
  }
  const earlyKx = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
  const earlyStraightM = Math.hypot((toLon - fromLon) * earlyKx, (toLat - fromLat) * 110540);
  // 8km 이내: 아래 A* 본문으로 이동가능영역을 따라 탐색한다.
  // 초과분은 2.5km 구간으로 나눠 구간별 A* 후 연결한다 (데이터 없는 구간은 직선).
  // 거리 상한 없음 (서울-부산급 포함). 호출자가 구간 단위로 나눠 호출하므로
  // 한 번에 수백 구간을 푸는 일은 없다.
  if (earlyStraightM > maxDistanceM) {
    // 구간 수 상한 200 (서버 경유지 200개 제한과 일치).
    const legCount = Math.min(201, Math.max(2, Math.ceil(earlyStraightM / LEG_MAX_M)));
    const joints: Array<{ lat: number; lon: number }> = [{ lat: fromLat, lon: fromLon }];
    const rawJoints: Array<{ lat: number; lon: number }> = [];
    for (let i = 1; i < legCount; i += 1) {
      rawJoints.push({
        lat: fromLat + ((toLat - fromLat) * i) / legCount,
        lon: fromLon + ((toLon - fromLon) * i) / legCount,
      });
    }
    const snappedJoints = await Promise.all(
      rawJoints.map(async (joint) => {
        const snapped = await snapToNearestWalkableLocation(joint.lat, joint.lon, 500, true);
        return snapped ? { lat: snapped.lat, lon: snapped.lon } : joint;
      }),
    );
    // 후퇴하는 경유지 제거: 출발→목적 직선상 진행도가 증가하는 점만 유지한다.
    // 스냅이 진행 반대 방향으로 끌려가면 구간이 되돌아가므로 미리 걷어낸다.
    const dirLon = toLon - fromLon;
    const dirLat = toLat - fromLat;
    const normSq = dirLon * dirLon + dirLat * dirLat;
    const progressOf = (p: { lat: number; lon: number }): number =>
      normSq > 0 ? ((p.lon - fromLon) * dirLon + (p.lat - fromLat) * dirLat) / normSq : 1;
    let jointProg = 0;
    for (const joint of snappedJoints) {
      if (progressOf(joint) > jointProg + 0.005) {
        joints.push(joint);
        jointProg = progressOf(joint);
      }
    }
    joints.push({ lat: toLat, lon: toLon });
    const full: Array<{ lat: number; lon: number }> = [];
    for (let i = 1; i < joints.length; i += 1) {
      const a = joints[i - 1];
      const b = joints[i];
      if (!a || !b) {
        continue;
      }
      const leg = await findWalkablePathRecursive(a.lat, a.lon, b.lat, b.lon, LEG_MAX_M * 2, deadlineMs);
      if (!leg || leg.length === 0) {
        // 직선 폴백 없음: 다리 하나라도 막히면 체인 전체를 실패로 둔다.
        return null;
      }
      const segment = leg;
      for (const point of segment) {
        const last = full[full.length - 1];
        if (!last || last.lat !== point.lat || last.lon !== point.lon) {
          full.push(point);
        }
      }
    }
    return full.length > 0 ? smoothPathLatLon(full) : null;
  }
  const loadedIndex = await loadIndex();
  if (!loadedIndex) {
    return null;
  }
  const fromIds = candidateDongIds(fromLat, fromLon) ?? [];
  const toIds = candidateDongIds(toLat, toLon) ?? [];
  const adjacentOf = (ids: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>(ids);
    for (const id of ids) {
      for (const neighbor of getAdjacentDongIds(id)) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          out.push(neighbor);
        }
      }
    }
    return out;
  };
  // 1차: 출발/목적지 + 인접 (빠름). 실패 시 2차에서 중간 복도를 추가 로드한다.
  // 복도(출발·목적지·중간 경유지) 우선, 인접 동은 여유분으로 최대 24개까지만.
  const corridorIds: string[] = [];
  const corridorSeen = new Set<string>();
  const pushCorridor = (ids: string[]): void => {
    for (const id of ids) {
      if (!corridorSeen.has(id)) {
        corridorSeen.add(id);
        corridorIds.push(id);
      }
    }
  };
  pushCorridor(fromIds);
  pushCorridor(toIds);
  // 경로상 중간 동 (2~3개 동 경유 대응).
  const midSamples = Math.min(12, Math.max(0, Math.floor(earlyStraightM / 500)));
  const midIds: string[] = [];
  const midSeen = new Set<string>();
  for (let i = 1; i < midSamples; i += 1) {
    const midLat = fromLat + ((toLat - fromLat) * i) / midSamples;
    const midLon = fromLon + ((toLon - fromLon) * i) / midSamples;
    for (const id of candidateDongIds(midLat, midLon) ?? []) {
      if (!midSeen.has(id)) {
        midSeen.add(id);
        midIds.push(id);
      }
    }
  }
  // 그래프 탐색 (빠름). 실패 시 null.
  const graphFirstIds = [...fromIds, ...toIds, ...adjacentOf([...fromIds, ...toIds]), ...midIds].slice(0, 48);
  const round2Ids = [...midIds, ...adjacentOf([...corridorIds, ...midIds])].slice(0, 48);
  const tryGraph = async (ids: string[]): Promise<Array<{ lat: number; lon: number }> | null> => {
    const uniqueGraphIds = [...new Set(ids)];
    const graphs = await Promise.all(uniqueGraphIds.map((id) => loadGraphDong(id)));
    // 로드 성공한 동만 서명에 넣어 캐시 적중률을 높인다.
    const loadedIds = uniqueGraphIds.filter((_, i) => graphs[i] !== null);
    const stitchKey = `g:${loadedIds.sort().join(",")}`;
    const graphFound = searchGraphs(graphs, fromLat, fromLon, toLat, toLon, 500, stitchKey);
    return graphFound && graphFound.length > 0 ? smoothPathLatLon(graphFound) : null;
  };
  const graphFirst = await tryGraph(graphFirstIds);
  if (graphFirst) {
    return graphFirst;
  }
  if (skipGridFallback) {
    return null;
  }
  if (round2Ids.length > 0) {
    const graphSecond = await tryGraph([...new Set([...graphFirstIds, ...round2Ids])].slice(0, 64));
    if (graphSecond) {
      return graphSecond;
    }
  }
  const loadGrids = async (ids: string[]): Promise<GridFull[]> => {    const unique = [...new Set(ids)];
    const loaded = await Promise.all(unique.map((id) => loadRouteDong(id)));
    return loaded.flatMap((list) => list ?? []);
  };
  const round1Ids = [...fromIds, ...toIds, ...adjacentOf([...fromIds, ...toIds])];
  const round1 = await loadGrids(round1Ids);
  if (round1.length > 0) {
    const found = await searchLoadedGrids(round1, fromLat, fromLon, toLat, toLon, deadlineMs);
    if (found) {
      return smoothPathLatLon(found);
    }
  }
  // 2차: 중간 복도 + 그 인접 동을 추가 로드 후 재탐색한다.
  if (round2Ids.length === 0) {
    return null;
  }
  const round2 = await loadGrids([...round1Ids, ...round2Ids]);
  if (round2.length === 0) {
    return null;
  }
  const round2Found = await searchLoadedGrids(round2, fromLat, fromLon, toLat, toLon, deadlineMs);
  return round2Found ? smoothPathLatLon(round2Found) : null;
};

/** 재귀 우회 탐색 상한 (무한 방지). */
const MAX_ROUTE_DEPTH = 3;
const MAX_ROUTE_ATTEMPTS = 14;

/** 실패한 구간은 대체 경유지로 재귀 우회한다 (이전 갈림길로 돌아가 다른 가지 탐색).
 *  직선 폴백은 하지 않고, 예산 소진 시 null을 반환한다. */
export const findWalkablePathRecursive = async (
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
  maxDistanceM = 8000,
  deadlineMs = 0,
): Promise<Array<{ lat: number; lon: number }> | null> => {
  const state = { attempts: 0 };
  const expired = (): boolean => deadlineMs > 0 && Date.now() > deadlineMs;
  const mergeHalves = (
    first: Array<{ lat: number; lon: number }> | null,
    second: Array<{ lat: number; lon: number }> | null,
  ): Array<{ lat: number; lon: number }> | null => {
    if (!first || first.length === 0 || !second || second.length === 0) {
      return null;
    }
    const lastFirst = first[first.length - 1];
    const firstSecond = second[0];
    if (
      lastFirst &&
      firstSecond &&
      lastFirst.lat === firstSecond.lat &&
      lastFirst.lon === firstSecond.lon
    ) {
      return [...first, ...second.slice(1)];
    }
    return [...first, ...second];
  };
  const tried: Array<{ lat: number; lon: number }> = [];
  const isTried = (lat: number, lon: number): boolean => {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    return tried.some(
      (p) => Math.hypot((p.lon - lon) * kx, (p.lat - lat) * 110540) < 30,
    );
  };
  const route = async (
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number,
    depth: number,
  ): Promise<Array<{ lat: number; lon: number }> | null> => {
    if (expired() || state.attempts >= MAX_ROUTE_ATTEMPTS) {
      return null;
    }
    state.attempts += 1;
    // 재귀 후보는 그래프만 시도한다 (격자는 느려서 마지막에 1회만).
    const direct = await findWalkablePath(fromLat, fromLon, toLat, toLon, maxDistanceM, true, deadlineMs);
    if (direct && direct.length > 0) {
      return direct;
    }
    if (depth >= MAX_ROUTE_DEPTH) {
      return null;
    }
    const dx = toLon - fromLon;
    const dy = toLat - fromLat;
    const degLen = Math.hypot(dx, dy);
    const nx = degLen > 0 ? -dy / degLen : 0;
    const ny = degLen > 0 ? dx / degLen : 0;
    // 얕은 깊이일수록 후보를 넓게, 깊어질수록 좁게 (발산 방지).
    // 깊이 0에서 다 실패하면 광역 우회(다리 길이의 ±60%, ±100%)를 한 번 더 시도한다.
    const fracs = depth === 0 ? [0, 0.15, -0.15, 0.3, -0.3] : [0, 0.2, -0.2];
    const wideFracs = depth === 0 ? [0.6, -0.6, 1.0, -1.0] : [];
    const allFracs = [...fracs, ...wideFracs];
    // 직접 탐색 1회 (시도 횟수 집계).
    const directSearch = async (
      aLat: number,
      aLon: number,
      bLat: number,
      bLon: number,
    ): Promise<Array<{ lat: number; lon: number }> | null> => {
      if (expired() || state.attempts >= MAX_ROUTE_ATTEMPTS) {
        return null;
      }
      state.attempts += 1;
      return findWalkablePath(aLat, aLon, bLat, bLon, maxDistanceM, false, deadlineMs);
    };
    const midOf = (frac: number): { lat: number; lon: number } => ({
      lat: (fromLat + toLat) / 2 + ny * degLen * frac,
      lon: (fromLon + toLon) / 2 + nx * degLen * frac,
    });
    const snapMid = async (mid: { lat: number; lon: number }): Promise<{ lat: number; lon: number } | null> => {
      try {
        // 스냅(250m)은 장벽 너머로 끌고갈 수 있어 보조 수단으로만 쓴다.
        const correction = await snapToNearestWalkableLocation(mid.lat, mid.lon, 250, true);
        return correction ? { lat: correction.lat, lon: correction.lon } : null;
      } catch {
        return null;
      }
    };
    // Phase A/B: frac마다 기하 중점(raw)부터, 다음으로 데드엔드 회피 스냅점을
    // 직접 halves로 시도한다. 예산을 깊은 재귀보다 넓은 후보에 먼저 쓴다.
    // 정확히 반쪽만 풀린 후보는 최대 2곳까지 기록해 Phase C에서 심화한다.
    type Partial = { mid: { lat: number; lon: number }; first: Array<{ lat: number; lon: number }> | null; second: Array<{ lat: number; lon: number }> | null };
    const partials: Partial[] = [];
    const tryMid = async (mid: { lat: number; lon: number }): Promise<Array<{ lat: number; lon: number }> | null> => {
      if (expired() || state.attempts >= MAX_ROUTE_ATTEMPTS || isTried(mid.lat, mid.lon)) {
        return null;
      }
      tried.push(mid);
      const first = await directSearch(fromLat, fromLon, mid.lat, mid.lon);
      const second = first ? await directSearch(mid.lat, mid.lon, toLat, toLon) : null;
      const merged = mergeHalves(first, second);
      if (merged) {
        return merged;
      }
      if (((first && !second) || (!first && second)) && partials.length < 2) {
        partials.push({ mid, first, second });
      }
      return null;
    };
    for (const frac of allFracs) {
      if (expired() || state.attempts >= MAX_ROUTE_ATTEMPTS) {
        return null;
      }
      const rawHit = await tryMid(midOf(frac));
      if (rawHit) {
        return rawHit;
      }
      const snapped = await snapMid(midOf(frac));
      if (snapped) {
        const snappedHit = await tryMid(snapped);
        if (snappedHit) {
          return snappedHit;
        }
      }
    }
    // Phase C: 표적 심화 — 반쪽만 풀린 후보의 실패 반쪽을 재귀 분할한다.
    if (depth < MAX_ROUTE_DEPTH) {
      for (const partial of partials) {
        if (expired() || state.attempts >= MAX_ROUTE_ATTEMPTS) {
          return null;
        }
        if (partial.first && !partial.second) {
          const second = await route(partial.mid.lat, partial.mid.lon, toLat, toLon, depth + 1);
          const merged = mergeHalves(partial.first, second);
          if (merged) {
            return merged;
          }
        } else if (!partial.first && partial.second) {
          const first = await route(fromLat, fromLon, partial.mid.lat, partial.mid.lon, depth + 1);
          const merged = mergeHalves(first, partial.second);
          if (merged) {
            return merged;
          }
        }
      }
    }
    // 깊이 0에서 그래프로 다 실패하면 격자 폴백 1회 (버퍼 병합 연결용).
    if (depth === 0) {
      if (expired() || state.attempts >= MAX_ROUTE_ATTEMPTS) {
        return null;
      }
      state.attempts += 1;
      const gridFallback = await findWalkablePath(fromLat, fromLon, toLat, toLon, maxDistanceM, false, deadlineMs);
      return gridFallback;
    }
    return null;
  };
  return route(aLat, aLon, bLat, bLon, 0);
};

/** 로드된 격자에서 A* 탐색을 수행한다 (동기). */
/** 무거운 동기 탐색 중간에 이벤트 루프에 양보한다 (9초 롱태스크 방지 — 결과는 동일). */
const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setTimeout !== "undefined") {
      setTimeout(resolve, 0);
    } else {
      resolve();
    }
  });

const searchLoadedGrids = async (
  grids: GridFull[],
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  deadlineMs = 0,
): Promise<Array<{ lat: number; lon: number }> | null> => {
  const kx = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
  const cellLon = GRID_CELL_M / kx;
  const cellLat = GRID_CELL_M / 110540;
  const gridsByTile = new Map<string, GridFull[]>();
  grids.forEach((grid) => {
    const key = `${grid.tileColumn}:${grid.tileRow}`;
    const tileGrids = gridsByTile.get(key) ?? [];
    tileGrids.push(grid);
    gridsByTile.set(key, tileGrids);
  });
  const isFilled = (globalX: number, globalY: number): boolean => {
    const tileGrids = gridsByTile.get(
      `${Math.floor(globalX / GRID_TILE_CELLS)}:${Math.floor(globalY / GRID_TILE_CELLS)}`,
    );
    return (
      tileGrids?.some((grid) => {
        const x = globalX - grid.tileColumn * GRID_TILE_CELLS;
        const y = globalY - grid.tileRow * GRID_TILE_CELLS;
        return x >= 0 && y >= 0 && x < grid.nx && y < grid.ny && grid.filled[y * grid.nx + x] === 1;
      }) ?? false
    );
  };
  const startX = Math.floor(fromLon / cellLon);
  const startY = Math.floor(fromLat / cellLat);
  const goalX = Math.floor(toLon / cellLon);
  const goalY = Math.floor(toLat / cellLat);
  // 시작/목적지가 비어 있으면 가장 가까운 이동가능 셀로 보정한다.
  const nearestFilled = (
    gx: number,
    gy: number,
    limitCells = 40,
  ): { x: number; y: number } | null => {
    if (isFilled(gx, gy)) {
      return { x: gx, y: gy };
    }
    for (let r = 1; r <= limitCells; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (isFilled(gx + dx, gy - r)) return { x: gx + dx, y: gy - r };
        if (isFilled(gx + dx, gy + r)) return { x: gx + dx, y: gy + r };
      }
      for (let dy = -r + 1; dy < r; dy += 1) {
        if (isFilled(gx - r, gy + dy)) return { x: gx - r, y: gy + dy };
        if (isFilled(gx + r, gy + dy)) return { x: gx + r, y: gy + dy };
      }
    }
    return null;
  };
  const start = nearestFilled(startX, startY);
  const goal = nearestFilled(goalX, goalY);
  if (!start || !goal) {
    return null;
  }
  // 수치 키 (문자열 할당 없음 — 탐색 중 GC 압박 제거).
  // x*2^24+y, 오프셋으로 음수 셀도 처리 (한반도 범위 충분히 포함).
  const KEY_M = 16777216;
  const KEY_OFF = 8388608;
  const keyOf = (x: number, y: number): number => (x + KEY_OFF) * KEY_M + (y + KEY_OFF);
  const decodeKey = (key: number): { x: number; y: number } => {
    const x = Math.floor(key / KEY_M) - KEY_OFF;
    return { x, y: key - (x + KEY_OFF) * KEY_M - KEY_OFF };
  };
  const startKey = keyOf(start.x, start.y);
  const goalKey = keyOf(goal.x, goal.y);
  // 가중 휴리스틱(1.25): 목표 지향적으로 탐색해 불필요한 우회를 줄인다.
  // 최적 대비 최대 1.25배까지 길어질 수 있지만 탐색이 빠르고 경로가 자연스럽다.
  const octileTo = (x: number, y: number, tx: number, ty: number): number => {
    const dx = Math.abs(x - tx);
    const dy = Math.abs(y - ty);
    return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * 1.25;
  };
  type Frontier = {
    open: Array<{ x: number; y: number; f: number }>;
    pos: Map<number, number>;
    g: Map<number, number>;
    came: Map<number, number>;
    closed: Set<number>;
    h: (x: number, y: number) => number;
  };
  const makeFrontier = (
    sx: number,
    sy: number,
    h: (x: number, y: number) => number,
  ): Frontier => ({
    open: [{ x: sx, y: sy, f: 0 }],
    pos: new Map<number, number>([[keyOf(sx, sy), 0]]),
    g: new Map<number, number>([[keyOf(sx, sy), 0]]),
    came: new Map<number, number>(),
    closed: new Set<number>(),
    h,
  });
  // 양방향 A*: 출발→도착, 도착→출발을 번갈아 확장해 처음 만난 지점에서 합친다.
  // 후단 단순화가 직선 가시성으로 다듬으므로 첫 만남 경로로 충분하다.
  const fwd = makeFrontier(start.x, start.y, (x, y) => octileTo(x, y, goal.x, goal.y));
  const bwd = makeFrontier(goal.x, goal.y, (x, y) => octileTo(x, y, start.x, start.y));
  const heapSwap = (fr: Frontier, i: number, j: number): void => {
    const vi = fr.open[i];
    const vj = fr.open[j];
    if (!vi || !vj) {
      return;
    }
    fr.open[i] = vj;
    fr.open[j] = vi;
    fr.pos.set(keyOf(vj.x, vj.y), i);
    fr.pos.set(keyOf(vi.x, vi.y), j);
  };
  const heapUp = (fr: Frontier, i: number): void => {
    let c = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      const cc = fr.open[c];
      const pp = fr.open[p];
      if (!cc || !pp || cc.f >= pp.f) {
        break;
      }
      heapSwap(fr, c, p);
      c = p;
    }
  };
  const heapDown = (fr: Frontier, i: number): void => {
    let c = i;
    for (;;) {
      const l = c * 2 + 1;
      const r = l + 1;
      let m = c;
      const cm = fr.open[m];
      const cl = fr.open[l];
      const cr = fr.open[r];
      if (cl && cm && cl.f < cm.f) {
        m = l;
      }
      const mm = fr.open[m];
      if (cr && mm && cr.f < mm.f) {
        m = r;
      }
      if (m === c) {
        break;
      }
      heapSwap(fr, c, m);
      c = m;
    }
  };
  const heapPushOrUpdate = (fr: Frontier, x: number, y: number, f: number): void => {
    const key = keyOf(x, y);
    const at = fr.pos.get(key);
    if (at === undefined) {
      fr.pos.set(key, fr.open.length);
      fr.open.push({ x, y, f });
      heapUp(fr, fr.open.length - 1);
      return;
    }
    const existing = fr.open[at];
    if (existing && f < existing.f) {
      existing.f = f;
      heapUp(fr, at);
      heapDown(fr, at);
    }
  };
  const heapPop = (fr: Frontier): { x: number; y: number; f: number } | undefined => {
    const top = fr.open[0];
    const last = fr.open.pop();
    fr.pos.delete(top ? keyOf(top.x, top.y) : -1);
    if (fr.open.length > 0 && last) {
      fr.open[0] = last;
      fr.pos.set(keyOf(last.x, last.y), 0);
      heapDown(fr, 0);
    }
    return top;
  };
  const DIRS: Array<[number, number, number]> = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, 1.4142],
    [1, -1, 1.4142],
    [-1, 1, 1.4142],
    [-1, -1, 1.4142],
  ];
  let expansions = 0;
  const MAX_EXPANSIONS = 40000;
  const reconstruct = (meetKey: number): Array<{ x: number; y: number }> => {
    const chain: Array<{ x: number; y: number }> = [];
    let cursor: number | undefined = meetKey;
    let guard = 0;
    while (cursor !== undefined && guard++ < MAX_EXPANSIONS + 10) {
      chain.push(decodeKey(cursor));
      const parent = fwd.came.get(cursor);
      if (parent === undefined) {
        break;
      }
      cursor = parent;
    }
    chain.reverse();
    cursor = bwd.came.get(meetKey);
    guard = 0;
    while (cursor !== undefined && guard++ < MAX_EXPANSIONS + 10) {
      chain.push(decodeKey(cursor));
      const parent = bwd.came.get(cursor);
      if (parent === undefined) {
        break;
      }
      cursor = parent;
    }
    return chain;
  };
  // 한 걸음 확장한다. 만남이면 키 반환, 아니면 null.
  const step = (fr: Frontier, other: Frontier): number | null => {
    const current = heapPop(fr);
    if (!current) {
      return null;
    }
    const currentKey = keyOf(current.x, current.y);
    if (other.closed.has(currentKey)) {
      return currentKey;
    }
    if (fr.closed.has(currentKey)) {
      return null;
    }
    fr.closed.add(currentKey);
    expansions += 1;
    const currentG = fr.g.get(currentKey) ?? Number.POSITIVE_INFINITY;
    for (const [dx, dy, cost] of DIRS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nextKey = keyOf(nx, ny);
      if (fr.closed.has(nextKey) || !isFilled(nx, ny)) {
        continue;
      }
      // 대각선 이동 시 모서리 잘라먹기 방지.
      if (dx !== 0 && dy !== 0 && (!isFilled(current.x + dx, current.y) || !isFilled(current.x, current.y + dy))) {
        continue;
      }
      const tentative = currentG + cost;
      if (tentative < (fr.g.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        fr.g.set(nextKey, tentative);
        fr.came.set(nextKey, currentKey);
        heapPushOrUpdate(fr, nx, ny, tentative + fr.h(nx, ny));
      }
    }
    return null;
  };
  let cells: Array<{ x: number; y: number }> | null = null;
  if (startKey === goalKey) {
    cells = [{ x: start.x, y: start.y }];
  } else {
    let turnBwd = false;
    while (fwd.open.length > 0 || bwd.open.length > 0) {
      const fr = turnBwd ? bwd : fwd;
      const other = turnBwd ? fwd : bwd;
      turnBwd = !turnBwd;
      if (fr.open.length === 0) {
        continue;
      }
      const meetKey = step(fr, other);
      if (meetKey !== null) {
        cells = reconstruct(meetKey);
        break;
      }
      if ((expansions & 2047) === 0) {
        if (deadlineMs > 0 && Date.now() > deadlineMs) {
          return null;
        }
        await yieldToMain();
      }
      if (expansions > MAX_EXPANSIONS) {
        break;
      }
    }
  }
  if (!cells || cells.length === 0) {
    return null;
  }
      // 직선 가시성이 확보되는 구간은 건너뛰어 웨이포인트를 줄인다.
      const lineBlocked = (ax: number, ay: number, bx: number, by: number): boolean => {
        const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
        for (let s = 1; s < steps; s += 1) {
          const x = Math.round(ax + ((bx - ax) * s) / steps);
          const y = Math.round(ay + ((by - ay) * s) / steps);
          if (!isFilled(x, y)) {
            return true;
          }
        }
        return false;
      };
      const simplified: Array<{ x: number; y: number }> = [];
      let anchor = 0;
      for (let i = 1; i < cells.length; i += 1) {
        if ((i & 511) === 0) {
          await yieldToMain();
        }
        const a = cells[anchor];
        const b = cells[i];
        if (!a || !b || lineBlocked(a.x, a.y, b.x, b.y)) {
          const kept = cells[i - 1];
          if (kept) simplified.push(kept);
          anchor = i - 1;
        }
      }
      const last = cells[cells.length - 1];
      if (last) simplified.push(last);
      // 되돌아갔다 나오는 중복 구간 제거: 이전 지점 근처로 복귀하면
      // 그 사이를 직선으로 대체한다 (직선이 이동가능할 때만).
      const pruned: Array<{ x: number; y: number }> = [];
      const firstWaypoint = simplified[0];
      if (!firstWaypoint) {
        return [];
      }
      pruned.push(firstWaypoint);
      let pi = 0;
      let pruneSteps = 0;
      while (pi < simplified.length - 1) {
        pruneSteps += 1;
        if ((pruneSteps & 63) === 0) {
          await yieldToMain();
        }
        const anchorCell = simplified[pi];
        let best = pi + 1;
        if (anchorCell) {
          for (let j = pi + 2; j < simplified.length; j += 1) {
            const candidate = simplified[j];
            if (!candidate) {
              continue;
            }
            const directCells = Math.hypot(candidate.x - anchorCell.x, candidate.y - anchorCell.y);
            if (directCells * GRID_CELL_M > 25) {
              continue;
            }
            let walkCells = 0;
            let walkValid = true;
            for (let k = pi; k < j; k += 1) {
              const p = simplified[k];
              const q = simplified[k + 1];
              if (!p || !q) {
                walkValid = false;
                break;
              }
              walkCells += Math.hypot(q.x - p.x, q.y - p.y);
            }
            if (!walkValid || walkCells * GRID_CELL_M < 150 || walkCells < directCells * 4) {
              continue;
            }
            if (lineBlocked(anchorCell.x, anchorCell.y, candidate.x, candidate.y)) {
              continue;
            }
            best = j;
          }
        }
        const next = simplified[best];
        if (!next) {
          break;
        }
        pruned.push(next);
        pi = best;
      }
      return pruned.map((c) => ({
        lat: (c.y + 0.5) * cellLat,
        lon: (c.x + 0.5) * cellLon,
      }));
};


/** 이동 판정과 동일한 5m 래스터에서 가장 가까운 이동가능 셀 중심을 찾는다. */
export const snapToNearestWalkableLocation = async (
  lat: number,
  lon: number,
  maxDistanceM = 5000,
  avoidDeadEnds = false,
): Promise<WalkableLocationCorrection | null> => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || maxDistanceM <= 0) {
    return null;
  }
  const loadedIndex = await loadIndex();
  if (!loadedIndex) {
    return null;
  }
  const ids = candidateDongIds(lat, lon) ?? [];
  if (ids.length === 0) {
    return null;
  }
  const roadIds = new Set(ids);
  ids.forEach((id) => getAdjacentDongIds(id).forEach((neighbor) => roadIds.add(neighbor)));
  // 라우팅 전용 캐시에서 들고 온다 (표시 캐시를 밀어내지 않음).
  const loadedGrids = await Promise.all([...roadIds].map((id) => loadRouteDong(id)));
  const grids = loadedGrids.flatMap((list) => list ?? []);
  if (grids.length === 0) {
    return null;
  }

  const kx = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
  const cellLon = GRID_CELL_M / kx;
  const cellLat = GRID_CELL_M / 110540;
  const originX = Math.floor(lon / cellLon);
  const originY = Math.floor(lat / cellLat);
  const maxCells = Math.ceil(maxDistanceM / GRID_CELL_M);
  const markerInsetCells = 2;
  const gridsByTile = new Map<string, GridFull[]>();
  grids.forEach((grid) => {
    const key = `${grid.tileColumn}:${grid.tileRow}`;
    const tileGrids = gridsByTile.get(key) ?? [];
    tileGrids.push(grid);
    gridsByTile.set(key, tileGrids);
  });
  let nearestDistanceM = Number.POSITIVE_INFINITY;
  let nearestLat = Number.NaN;
  let nearestLon = Number.NaN;
  let throughDistanceM = Number.POSITIVE_INFINITY;
  let throughLat = Number.NaN;
  let throughLon = Number.NaN;

  const isFilled = (globalX: number, globalY: number): boolean => {
    const tileGrids = gridsByTile.get(
      `${Math.floor(globalX / GRID_TILE_CELLS)}:${Math.floor(globalY / GRID_TILE_CELLS)}`,
    );
    return tileGrids?.some((grid) => {
      const x = globalX - grid.tileColumn * GRID_TILE_CELLS;
      const y = globalY - grid.tileRow * GRID_TILE_CELLS;
      return x >= 0 && y >= 0 && x < grid.nx && y < grid.ny && grid.filled[y * grid.nx + x] === 1;
    }) ?? false;
  };

  const hasMarkerInset = (globalX: number, globalY: number): boolean => {
    for (let dx = -markerInsetCells; dx <= markerInsetCells; dx += 1) {
      for (let dy = -markerInsetCells; dy <= markerInsetCells; dy += 1) {
        if (dx * dx + dy * dy > markerInsetCells * markerInsetCells) continue;
        if (!isFilled(globalX + dx, globalY + dy)) return false;
      }
    }
    return true;
  };

  // 막다른길 판정: 30m 링을 돌아 이동가능 덩어리가 1개뿐이면 데드엔드.
  // 경유지가 웅덩이 안에 찍히면 다리가 들렀다 나와야 하므로, 경유지 스냅은
  // 관통 도로를 우선한다 (없으면 가장 가까운 점으로 폴백).
  const isDeadEndCell = (globalX: number, globalY: number): boolean => {
    const ringCells = 6;
    const samples = 16;
    let runs = 0;
    let prev = false;
    let first = false;
    for (let k = 0; k < samples; k += 1) {
      const dx = Math.round(ringCells * Math.cos((k * 2 * Math.PI) / samples));
      const dy = Math.round(ringCells * Math.sin((k * 2 * Math.PI) / samples));
      const cur = isFilled(globalX + dx, globalY + dy);
      if (k === 0) {
        first = cur;
      }
      if (cur && !prev) {
        runs += 1;
      }
      prev = cur;
    }
    if (first && prev) {
      runs = Math.max(0, runs - 1);
    }
    return runs <= 1;
  };

  if (hasMarkerInset(originX, originY)) {
    if (!avoidDeadEnds || !isDeadEndCell(originX, originY)) {
      return { lat, lon, distanceM: 0 };
    }
  }

  const checkCell = (globalX: number, globalY: number): void => {
    if (!hasMarkerInset(globalX, globalY)) return;
    const snappedLon = (globalX + 0.5) * cellLon;
    const snappedLat = (globalY + 0.5) * cellLat;
    const distanceM = distM(lat, lon, snappedLat, snappedLon);
    if (distanceM > maxDistanceM) {
      return;
    }
    if (distanceM < nearestDistanceM) {
      nearestDistanceM = distanceM;
      nearestLat = snappedLat;
      nearestLon = snappedLon;
    }
    if (
      distanceM < throughDistanceM &&
      (!avoidDeadEnds || !isDeadEndCell(globalX, globalY))
    ) {
      throughDistanceM = distanceM;
      throughLat = snappedLat;
      throughLon = snappedLon;
    }
  };

  for (let radius = 0; radius <= maxCells; radius += 1) {
    if (radius === 0) {
      checkCell(originX, originY);
    } else {
      for (let dx = -radius; dx <= radius; dx += 1) {
        checkCell(originX + dx, originY - radius);
        checkCell(originX + dx, originY + radius);
      }
      for (let dy = -radius + 1; dy < radius; dy += 1) {
        checkCell(originX - radius, originY + dy);
        checkCell(originX + radius, originY + dy);
      }
    }
    if (Number.isFinite(throughDistanceM) && radius * GRID_CELL_M > throughDistanceM + GRID_CELL_M * 2) {
      return { lat: throughLat, lon: throughLon, distanceM: throughDistanceM };
    }
    if (
      !Number.isFinite(throughDistanceM) &&
      Number.isFinite(nearestDistanceM) &&
      radius * GRID_CELL_M > nearestDistanceM + 100
    ) {
      // 관통 도로가 근처에 없으면 막다른길이라도 반환한다 (기존 동작 폴백).
      return { lat: nearestLat, lon: nearestLon, distanceM: nearestDistanceM };
    }
  }
  if (Number.isFinite(throughDistanceM)) {
    return { lat: throughLat, lon: throughLon, distanceM: throughDistanceM };
  }
  return Number.isFinite(nearestDistanceM)
    ? { lat: nearestLat, lon: nearestLon, distanceM: nearestDistanceM }
    : null;
};

const fetchJson = (url: string): Promise<unknown> =>
  fetchWithTimeout(url, 12000, { credentials: "omit" })
    .then((res) => (res && res.ok ? res.json() : null))
    .catch(() => null);

const loadIndex = (): Promise<Record<string, BBox> | null> => {
  if (index) {
    return Promise.resolve(index);
  }
  // 인덱스 404(데이터 배포 전)면 60초 후 재시도한다.
  if (indexPromise && Date.now() - indexFailedAt < INDEX_RETRY_MS) {
    return indexPromise;
  }
  // 인접 목록은 같은 체인에서 로드해 race를 없앤다.
  indexPromise = (async (): Promise<Record<string, BBox> | null> => {
    // 1) IDB 먼저 (620KB+229KB 재검증 회피).
    try {
      const [cachedIndex, cachedAdjacency] = await Promise.all([
        withIdbTimeout(readCachedMeta("index")),
        withIdbTimeout(readCachedMeta("adjacency")),
      ]);
      if (cachedIndex && typeof cachedIndex === "object") {
        index = cachedIndex as Record<string, BBox>;
        if (cachedAdjacency && typeof cachedAdjacency === "object") {
          adjacency = cachedAdjacency as Record<string, string[]>;
        }
        return index;
      }
    } catch {
      // 캐시 실패는 네트워크로 폴백한다.
    }
    const [indexData, adjacencyData] = await Promise.all([
      fetchJson(INDEX_URL),
      fetchJson(ADJACENCY_URL),
    ]);
    if (!indexData || typeof indexData !== "object") {
      indexFailedAt = Date.now();
      return null;
    }
    index = indexData as Record<string, BBox>;
    void writeCachedMeta("index", indexData);
    if (adjacencyData && typeof adjacencyData === "object") {
      adjacency = adjacencyData as Record<string, string[]>;
      void writeCachedMeta("adjacency", adjacencyData);
    }
    return index;
  })();
  return indexPromise;
};

/** 특정 동의 인접 동 id 목록 (adjacency 미로드 시 빈 배열). */
export const getAdjacentDongIds = (dongId: string): string[] => {
  const list = adjacency?.[dongId];
  return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
};

/** 특정 동 + 인접 동의 도로망 로드를 예약한다 (오버레이 표시용). */
export const ensureWalkableDong = (dongId: string): void => {
  if (!dongId) {
    return;
  }
  void loadIndex().then((loaded) => {
    if (!loaded) {
      return;
    }
    void loadDong(dongId);
    for (const neighbor of getAdjacentDongIds(dongId)) {
      void loadDong(neighbor);
    }
  });
};

/** 선택한 동의 도로망만 로드한다 (선택 동의 인접 동은 대상에서 제외). */
export const ensureWalkableSelectedDong = (dongId: string): void => {
  if (!dongId) {
    return;
  }
  void loadIndex().then((loaded) => {
    if (loaded) {
      void loadDong(dongId);
    }
  });
};

/** 래스터 로드 완료 여부 (성공·실패·무타일 모두 포함). */
const rasterDone = new Set<string>();
const pendingRasterLoads = new Map<string, Promise<GridFull[] | null>>();

/** 표시용 비고정 동 상한 (고정은 개수와 무관하게 유지). */
const DISPLAY_UNPINNED_LIMIT = 24;
const evictOldestGrid = (): void => {
  // 고정(오버레이 표시 중) 동은 절대 내보내지 않는다.
  // 이전에는 전체 20 상한 때문에 22개 집합에서 고정 동까지 쫓아내고
  // 다음 recalc에서 다시 받는 무한 재로드→깜빡임 루프가 돌았다.
  let unpinned = 0;
  for (const key of dongGrids.keys()) {
    if (!overlayPinned.has(key)) {
      unpinned += 1;
    }
  }
  if (unpinned <= DISPLAY_UNPINNED_LIMIT) {
    return;
  }
  for (const key of dongGrids.keys()) {
    if (!overlayPinned.has(key)) {
      dongGrids.delete(key);
      rasterReloaded.delete(key);
      return;
    }
  }
};

/** 구움 래스터만 로드한다 (표시·스냅용. 도로 선은 받지 않는다). */
const loadRasterGrids = (dongId: string): Promise<GridFull[] | null> => {
  const hit = dongGrids.get(dongId);
  if (hit) {
    return Promise.resolve(hit);
  }
  if (rasterDone.has(dongId)) {
    // 캐시에서 밀려났으면 다시 받는다.
    rasterDone.delete(dongId);
  }
  const ongoing = pendingRasterLoads.get(dongId);
  if (ongoing) {
    return ongoing;
  }
  const startedAt = Date.now();
  wlog("raster load start", dongId);
  const task = (async (): Promise<GridFull[] | null> => {
    try {
      // 1) IDB 먼저 (리로드 재검증 회피 — 네트워크 없이 즉시 그린다).
      let rasterData: unknown = await readCachedRaster(dongId);
      let rawText: string | null = null;
      if (rasterData == null) {
        try {
          const res = await queuedFetch(rasterUrl(dongId), 15000, { credentials: "omit" });
          rawText = res && res.ok ? await res.text() : null;
        } catch {
          rawText = null;
        }
        if (rawText) {
          try {
            rasterData = JSON.parse(rawText) as unknown;
          } catch {
            rasterData = null;
          }
          void writeCachedRaster(dongId, rawText);
        }
      }
      let grids: GridFull[] | null = null;
      try {
        const baked = await gridsFromBaked(dongId, rasterData);
        if (baked && baked.length > 0) {
          grids = baked;
        }
      } catch {
        grids = null;
      }
      if (grids && grids.length > 0) {
        dongGrids.set(dongId, grids);
        evictOldestGrid();
        wlog("raster ok", dongId, `${Date.now() - startedAt}ms`, `tiles:${grids.length}`);
        return grids;
      }
      wlog("raster empty", dongId, `${Date.now() - startedAt}ms`);
      return null;
    } catch {
      wlog("raster throw", dongId, `${Date.now() - startedAt}ms`);
      return null;
    } finally {
      rasterDone.add(dongId);
      if (!dongGrids.has(dongId)) {
        rasterFailed.add(dongId);
      }
      pendingRasterLoads.delete(dongId);
      notifyWalkableData();
    }
  })();
  pendingRasterLoads.set(dongId, task);
  return task;
};

/** 래스터 확보 실패 동 (타임아웃·404 — 빈 타일로 간주해 무한 대기를 막는다). */
const rasterFailed = new Set<string>();

/** 주변 동 래스터를 IDB에만 미리 받아둔다 (idle 프리페치용 — 메모리·화면은 건드리지 않음). */
export const prefetchWalkableRasters = (dongIds: string[]): void => {
  if (typeof window === "undefined") {
    return;
  }
  const run = (): void => {
    // 오버레이 완성 후에 도는 것으로 충분하다 — 16개로 상한을 둔다 (렌더 경합 방지).
    for (const id of [...new Set(dongIds)].slice(0, 16)) {
      if (!id || rasterDone.has(id) || pendingRasterLoads.has(id)) {
        continue;
      }
      void (async (): Promise<void> => {
        let ok = false;
        try {
          if (await readCachedRaster(id)) {
            ok = true;
            return;
          }
          const res = await queuedFetch(rasterUrl(id), 15000, { credentials: "omit" });
          const rawText = res && res.ok ? await res.text() : null;
          if (rawText) {
            await writeCachedRaster(id, rawText);
            ok = true;
          }
        } catch {
          // 프리페치는 실패해도 된다.
        } finally {
          rasterDone.add(id);
          if (!ok) {
            rasterFailed.add(id);
          }
          notifyWalkableData();
        }
      })();
    }
  };
  const ric = (
    window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof ric === "function") {
    ric.call(window, run, { timeout: 8000 });
  } else {
    setTimeout(run, 1500);
  }
};

/** 특정 동의 구움 래스터 로드를 예약한다 (오버레이 표시용, 도로 선 제외).
 *  인접 동은 미리 받지 않는다 — 집합에 들어올 때 Ready가 직접 로드한다.
 *  (콜드 스타트 폭주 방지: 12개 집합이 40개 로드로 불어나지 않게) */
export const ensureWalkableRaster = (dongId: string): void => {
  if (!dongId) {
    return;
  }
  void loadIndex().then((loaded) => {
    if (!loaded) {
      return;
    }
    void loadRasterGrids(dongId);
  });
};

/** 인덱스만 보장한다 (표시용 — 도로 선은 받지 않는다). */
export const ensureWalkableIndex = (): void => {
  void loadIndex().then(() => {
    notifyWalkableData();
  });
};

const fetchRoads = async (dongId: string): Promise<LonLat[][] | null> => {
  try {
    const res = await queuedFetch(roadUrl(dongId), 15000, { credentials: "omit" });
    const data: unknown = res && res.ok ? await res.json() : null;
    const parsed =
      data && typeof data === "object" && Array.isArray((data as { roads?: unknown }).roads)
        ? ((data as { roads: unknown }).roads as LonLat[][])
        : null;
    return parsed && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
};
const loadDong = (dongId: string): Promise<GridFull[] | null> => {
  // 격자가 이미 있으면 도로 선을 다시 받지 않는다 (표시·스냅·탐색은 격자+그래프로 충분).
  const gridHit = dongGrids.get(dongId);
  if (gridHit && gridHit.length > 0) {
    return Promise.resolve(gridHit);
  }
  const cached = dongRoads.get(dongId);
  if (cached !== undefined) {
    const hit = dongGrids.get(dongId);
    if (hit && hit.length > 0) {
      return Promise.resolve(hit);
    }
    // 캐시는 있으나 격자가 비었으면 아래에서 새로 만든다.
  }
  const ongoing = pendingLoads.get(dongId);
  if (ongoing) {
    return ongoing;
  }
  const task = (async (): Promise<GridFull[] | null> => {
    try {
      // 래스터는 공유 로더로 (오버레이가 이미 받았으면 재수신 안 함).
      const [roads, gridsFromRaster] = await Promise.all([
        fetchRoads(dongId),
        loadRasterGrids(dongId),
      ]);
      dongRoads.set(dongId, roads);
      if (dongRoads.size > 20) {
        const oldest = dongRoads.keys().next();
        if (!oldest.done && oldest.value !== dongId) {
          dongRoads.delete(oldest.value);
        }
      }
      // 구움 래스터 우선: 있으면 스탬프 과정을 통째로 건너뛴다.
      // 지역 변수에 들고 반환한다 (반환 직전 캐시 재조회는 병렬 eviction에 어긋난다).
      let grids: GridFull[] | null = gridsFromRaster;
      if (!grids && roads && roads.length > 0 && index) {
        const bbox = index[dongId];
        if (bbox) {
          const kx = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
          grids = rasterizeToGrid(
            dongId,
            roads,
            bbox[0] - 30 / kx,
            bbox[1] - 30 / 110540,
            bbox[2] + 30 / kx,
            bbox[3] + 30 / 110540,
            GRID_REFERENCE_LAT,
          );
        }
      }
      if (grids && grids.length > 0) {
        dongGrids.set(dongId, grids);
        evictOldestGrid();
        return grids;
      }
      invalidateDongGrid(dongId);
      return null;
    } catch {
      dongRoads.set(dongId, null);
      return null;
    } finally {
      pendingLoads.delete(dongId);
      notifyWalkableData();
    }
  })();
  pendingLoads.set(dongId, task);
  return task;
};

/** 라우팅 전용 격자 캐시 (표시 캐시를 밀어내지 않는다 — 행군 복도 로드용). */
const routeGrids = new Map<string, GridFull[]>();
const routeRoads = new Map<string, LonLat[][] | null>();
const pendingRouteLoads = new Map<string, Promise<GridFull[] | null>>();
const ROUTE_CACHE_LIMIT = 32;

const loadRouteDong = (dongId: string): Promise<GridFull[] | null> => {
  const hit = routeGrids.get(dongId);
  if (hit && hit.length > 0) {
    return Promise.resolve(hit);
  }
  const ongoing = pendingRouteLoads.get(dongId);
  if (ongoing) {
    return ongoing;
  }
  const task = (async (): Promise<GridFull[] | null> => {
    try {
      // IDB→네트워크(큐 경유, gentle). 표시용 로더와 네트워크를 공유하지 않는다.
      let rasterData: unknown = await readCachedRaster(dongId);
      if (rasterData == null) {
        try {
          const res = await queuedFetch(rasterUrl(dongId), 15000, { credentials: "omit" });
          const rawText = res && res.ok ? await res.text() : null;
          if (rawText) {
            try {
              rasterData = JSON.parse(rawText) as unknown;
            } catch {
              rasterData = null;
            }
            void writeCachedRaster(dongId, rawText);
          }
        } catch {
          rasterData = null;
        }
      }
      let grids: GridFull[] | null = null;
      try {
        const baked = await gridsFromBaked(dongId, rasterData);
        if (baked && baked.length > 0) {
          grids = baked;
        }
      } catch {
        grids = null;
      }
      if (!grids) {
        let roads = routeRoads.get(dongId);
        if (roads === undefined) {
          roads = await fetchRoads(dongId);
          routeRoads.set(dongId, roads);
        }
        if (roads && roads.length > 0 && index) {
          const bbox = index[dongId];
          if (bbox) {
            const kx = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
            grids = rasterizeToGrid(
              dongId,
              roads,
              bbox[0] - 30 / kx,
              bbox[1] - 30 / 110540,
              bbox[2] + 30 / kx,
              bbox[3] + 30 / 110540,
              GRID_REFERENCE_LAT,
            );
          }
        }
      }
      if (grids && grids.length > 0) {
        routeGrids.set(dongId, grids);
        if (routeGrids.size > ROUTE_CACHE_LIMIT) {
          const oldest = routeGrids.keys().next();
          if (!oldest.done) {
            routeGrids.delete(oldest.value);
          }
        }
        return grids;
      }
      return null;
    } catch {
      return null;
    } finally {
      pendingRouteLoads.delete(dongId);
      // 표시 틱을 울리지 않는다 (라우팅 로드는 화면과 무관).
    }
  })();
  pendingRouteLoads.set(dongId, task);
  return task;
};

/** 점을 포함하는(200m 여유) 동 후보. 인덱스 미로드 시 null.
 *  매번 전체 스캔한다 (3504개 bbox, 수십 µs). 캐시를 쓰면 동 경계에서
 *  새로 진입한 동이 빠져 불완전한 목록이 되고, 병렬 탐색마다 결과가 달라진다. */
const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const kx = 111320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot((aLon - bLon) * kx, (aLat - bLat) * 110540);
};

const candidateDongIds = (lat: number, lon: number): string[] | null => {
  if (!index) {
    return null;
  }
  return Object.keys(index).filter((id) => {
    const bbox = index?.[id];
    if (!bbox) {
      return false;
    }
    return lon >= bbox[0] - 0.002 && lon <= bbox[2] + 0.002 && lat >= bbox[1] - 0.002 && lat <= bbox[3] + 0.002;
  });
};

/** 현재 위치 주변 동 도로망 로드를 예약한다 (fire-and-forget). */
export const ensureWalkableData = (lat: number, lon: number): void => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return;
  }
  void loadIndex().then((loaded) => {
    if (!loaded) {
      return;
    }
    const ids = candidateDongIds(lat, lon) ?? [];
    for (const id of ids) {
      void loadDong(id);
    }
  });
};

/** 영역 밖에 있을 때 가장 가까운 이동가능 셀 방향으로 의도한 보폭만큼 내딛는다 (동기). */
const stepIntoWalkable = (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): [number, number] | null => {
  const kx = 111320 * Math.cos((fromLat * Math.PI) / 180);
  const stepM = Math.max(1, Math.hypot((toLon - fromLon) * kx, (toLat - fromLat) * 110540));
  const cellLon = GRID_CELL_M / (111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180));
  const cellLat = GRID_CELL_M / 110540;
  const originX = Math.floor(fromLon / cellLon);
  const originY = Math.floor(fromLat / cellLat);
  const DIRS = 12;
  // 5m→120m 링을 넓혀가며 가장 먼저 걸리는 이동가능 셀을 찾는다.
  for (let r = 1; r <= 24; r += 1) {
    for (let k = 0; k < DIRS; k += 1) {
      const gx = originX + Math.round(r * Math.cos((k * 2 * Math.PI) / DIRS));
      const gy = originY + Math.round(r * Math.sin((k * 2 * Math.PI) / DIRS));
      if (isWalkableGridSync((gy + 0.5) * cellLat, (gx + 0.5) * cellLon) !== true) {
        continue;
      }
      const cellLatC = (gy + 0.5) * cellLat;
      const cellLonC = (gx + 0.5) * cellLon;
      const distM = Math.max(0.001, Math.hypot((cellLonC - fromLon) * kx, (cellLatC - fromLat) * 110540));
      const t = Math.min(1, stepM / distM);
      return [fromLat + (cellLatC - fromLat) * t, fromLon + (cellLonC - fromLon) * t];
    }
  }
  return null;
};

/**
 * 이동 게이팅 + 벽 슬라이딩: 전진 → 위도만 → 경도만 → 제자리 순으로 시도한다.
 * 격자 셀 기준(오버레이와 동일), 데이터 미비(null)면 이동을 허용한다.
 * 현재 위치 자체가 영역 밖이면(=== false) 조이스틱 방향 대신
 * 가장 가까운 이동가능 셀 방향으로 한 걸음 내딛는다 (밖에서 갇힘 방지).
 */
export const clampWalkableMove = (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): [number, number] => {
  ensureWalkableData(toLat, toLon);
  const fromWalk = isWalkableGridSync(fromLat, fromLon);
  if (fromWalk === false) {
    const step = stepIntoWalkable(fromLat, fromLon, toLat, toLon);
    if (step) {
      return step;
    }
    return [fromLat, fromLon];
  }
  const full = isWalkableGridSync(toLat, toLon);
  if (full !== false) {
    return [toLat, toLon];
  }
  const latOnly = isWalkableGridSync(toLat, fromLon);
  if (latOnly !== false) {
    return [toLat, fromLon];
  }
  const lonOnly = isWalkableGridSync(fromLat, toLon);
  if (lonOnly !== false) {
    return [fromLat, toLon];
  }
  return [fromLat, fromLon];
};
