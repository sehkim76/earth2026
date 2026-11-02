import { inflateSync } from "node:zlib";

/**
 * 서버용 이동가능영역 판정 (클라이언트 구움 래스터와 동일 규격).
 * 중립 부대 스폰·배회 목적지를 도로 위로만 잡기 위해 사용한다.
 * 래스터는 HTTP로 가져온다. fs 직접 참조 시 번들러 파일 추적이
 * public 전체(360MB)를 람다에 포함시켜 배포가 실패한다.
 */

const GRID_CELL_M = 5;
const GRID_TILE_CELLS = 800;
const GRID_REFERENCE_LAT = 36;
const KX = 111320 * Math.cos((GRID_REFERENCE_LAT * Math.PI) / 180);
const CELL_LON = GRID_CELL_M / KX;
const CELL_LAT = GRID_CELL_M / 110540;

interface BakedGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  filled: Uint8Array;
}

const gridCache = new Map<string, BakedGrid[]>();
const MAX_CACHED_DONGS = 64;

const decodeTile = (b64: string): Uint8Array | null => {
  try {
    const bytes = Buffer.from(b64, "base64");
    const out = inflateSync(bytes);
    const packed = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    const filled = new Uint8Array(GRID_TILE_CELLS * GRID_TILE_CELLS);
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

let rasterBaseUrl = "";
export const setRasterBaseUrl = (origin: string): void => {
  if (origin) {
    rasterBaseUrl = origin.replace(/\/$/, "");
  }
};

const fetchCache = new Map<string, string>();

/** 래스터 JSON 확보 (메모리 캐시, 없으면 HTTP 1회). */
export const ensureDongRaster = async (dong: string): Promise<boolean> => {
  if (gridCache.has(dong) || fetchCache.has(dong)) {
    return true;
  }
  if (!rasterBaseUrl) {
    return false;
  }
  try {
    const res = await fetch(`${rasterBaseUrl}/walkable/raster/${encodeURIComponent(dong)}.json`);
    if (!res.ok) {
      return false;
    }
    const text = await res.text();
    if (!text) {
      return false;
    }
    fetchCache.set(dong, text);
    if (fetchCache.size > MAX_CACHED_DONGS) {
      const oldest = fetchCache.keys().next();
      if (!oldest.done) {
        fetchCache.delete(oldest.value);
      }
    }
    return true;
  } catch {
    return false;
  }
};

const loadDongGrids = (dong: string): BakedGrid[] | null => {
  const hit = gridCache.get(dong);
  if (hit) {
    gridCache.delete(dong);
    gridCache.set(dong, hit);
    return hit;
  }
  const raw = fetchCache.get(dong) ?? null;
  if (raw === null) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as { v?: unknown; tiles?: unknown };
    if (data.v !== 1 || !Array.isArray(data.tiles) || data.tiles.length === 0) {
      return null;
    }
    const grids: BakedGrid[] = [];
    for (const tile of data.tiles as unknown[]) {
      if (typeof tile !== "object" || tile === null) {
        continue;
      }
      const entry = tile as { c?: unknown; b?: unknown; f?: unknown };
      if (!Array.isArray(entry.b) || entry.b.length !== 4 || typeof entry.f !== "string") {
        continue;
      }
      const [west, south, east, north] = entry.b as unknown[];
      if (
        typeof west !== "number" ||
        typeof south !== "number" ||
        typeof east !== "number" ||
        typeof north !== "number"
      ) {
        continue;
      }
      const filled = decodeTile(entry.f);
      if (!filled) {
        continue;
      }
      grids.push({ west, south, east, north, filled });
    }
    if (grids.length === 0) {
      return null;
    }
    gridCache.set(dong, grids);
    if (gridCache.size > MAX_CACHED_DONGS) {
      const oldest = gridCache.keys().next();
      if (!oldest.done) {
        gridCache.delete(oldest.value);
      }
    }
    return grids;
  } catch {
    return null;
  }
};

// ---- 동 경계 (무법자 동 이탈 방지용) ----
interface TopoRing {
  points: Array<[number, number]>;
}

let topoDoc: {
  arcs: number[][][];
  transform: { scale: [number, number]; translate: [number, number] };
  byId: Map<string, number[][][]>;
} | null = null;
let topoLoaded = false;
const dongRingCache = new Map<string, TopoRing[]>();

const ensureTopo = async (): Promise<boolean> => {
  if (topoDoc) {
    return true;
  }
  if (topoLoaded || !rasterBaseUrl) {
    return false;
  }
  topoLoaded = true;
  try {
    const res = await fetch(`${rasterBaseUrl}/boundaries/kor_dong.topojson`);
    if (!res.ok) {
      return false;
    }
    const doc = (await res.json()) as {
      arcs?: unknown;
      transform?: unknown;
      objects?: unknown;
    };
    if (!Array.isArray(doc.arcs)) {
      return false;
    }
    const transform = doc.transform as { scale?: unknown; translate?: unknown };
    if (
      !Array.isArray(transform?.scale) ||
      !Array.isArray(transform?.translate)
    ) {
      return false;
    }
    const objects = doc.objects as Record<string, { geometries?: unknown }>;
    const collection = objects?.collection;
    if (!collection || !Array.isArray(collection.geometries)) {
      return false;
    }
    const byId = new Map<string, number[][][]>();
    for (const geometry of collection.geometries as Array<{
      type?: unknown;
      arcs?: unknown;
      properties?: unknown;
    }>) {
      const props = geometry.properties as { shapeID?: unknown } | null;
      const id = props && typeof props.shapeID === "string" ? props.shapeID : "";
      if (!id) {
        continue;
      }
      // Polygon [[[refs]]] / MultiPolygon [[[[refs]]]]
      const polys =
        geometry.type === "Polygon"
          ? [geometry.arcs as number[][]]
          : geometry.type === "MultiPolygon"
            ? (geometry.arcs as number[][][])
            : [];
      if (polys.length === 0) {
        continue;
      }
      const prev = byId.get(id);
      if (prev) {
        prev.push(...polys);
      } else {
        byId.set(id, [...polys]);
      }
    }
    topoDoc = {
      arcs: doc.arcs as number[][][],
      transform: {
        scale: (transform.scale as [number, number]).slice(0, 2) as [number, number],
        translate: (transform.translate as [number, number]).slice(0, 2) as [number, number],
      },
      byId,
    };
    return true;
  } catch {
    return false;
  }
};

const decodeDongRings = (dong: string): TopoRing[] | null => {
  const hit = dongRingCache.get(dong);
  if (hit) {
    return hit;
  }
  if (!topoDoc) {
    return null;
  }
  const polys = topoDoc.byId.get(dong);
  if (!polys) {
    return null;
  }
  const { arcs, transform } = topoDoc;
  const decodeArc = (index: number): Array<[number, number]> => {
    const forward = index >= 0;
    const arc = arcs[forward ? index : ~index];
    if (!arc) {
      return [];
    }
    const pts: Array<[number, number]> = [];
    let x = 0;
    let y = 0;
    for (const [dx, dy] of arc) {
      x += dx ?? 0;
      y += dy ?? 0;
      pts.push([x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1]]);
    }
    return forward ? pts : pts.reverse();
  };
  const rings: TopoRing[] = [];
  for (const poly of polys) {
    for (const ringRefs of poly) {
      const points: Array<[number, number]> = [];
      ringRefs.forEach((ref, ri) => {
        const pts = decodeArc(ref);
        for (let i = 0; i < pts.length; i += 1) {
          if (ri > 0 && i === 0) {
            continue;
          }
          const p = pts[i];
          if (p) {
            points.push(p);
          }
        }
      });
      if (points.length >= 4) {
        rings.push({ points });
      }
    }
  }
  if (rings.length === 0) {
    return null;
  }
  dongRingCache.set(dong, rings);
  if (dongRingCache.size > 24) {
    const oldest = dongRingCache.keys().next();
    if (!oldest.done) {
      dongRingCache.delete(oldest.value);
    }
  }
  return rings;
};

/** 동의 바운딩박스 (배회 목적지 추첨용, 없으면 null). */
export const dongBboxServer = (
  dong: string,
): { minLon: number; minLat: number; maxLon: number; maxLat: number } | null => {
  const rings = decodeDongRings(dong);
  if (!rings) {
    return null;
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring.points) {
      if (x < minLon) {
        minLon = x;
      }
      if (x > maxLon) {
        maxLon = x;
      }
      if (y < minLat) {
        minLat = y;
      }
      if (y > maxLat) {
        maxLat = y;
      }
    }
  }
  if (!Number.isFinite(minLon)) {
    return null;
  }
  return { minLon, minLat, maxLon, maxLat };
};

/** 해당 좌표가 동 경계 안에 있는지 (데이터 없으면 null). */
export const isInDongServer = (dong: string, lat: number, lon: number): boolean | null => {
  const rings = decodeDongRings(dong);
  if (!rings) {
    return null;
  }
  let inside = false;
  for (const ring of rings) {
    const pts = ring.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const a = pts[i];
      const b = pts[j];
      if (!a || !b) {
        continue;
      }
      if (a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
    }
  }
  return inside;
};

/** 동 경계 데이터 확보 (메모리 캐시, 없으면 HTTP 1회). */
export const ensureDongBoundary = async (): Promise<boolean> => ensureTopo();

/** 해당 좌표가 이동가능영역 위인지 (데이터 없으면 null). */
export const isWalkableServer = (dong: string, lat: number, lon: number): boolean | null => {
  const grids = loadDongGrids(dong);
  if (!grids) {
    return null;
  }
  let covered = false;
  for (const grid of grids) {
    const ix = Math.floor((lon - grid.west) / CELL_LON);
    const iy = Math.floor((lat - grid.south) / CELL_LAT);
    if (ix < 0 || iy < 0 || ix >= GRID_TILE_CELLS || iy >= GRID_TILE_CELLS) {
      continue;
    }
    covered = true;
    if (grid.filled[iy * GRID_TILE_CELLS + ix] === 1) {
      return true;
    }
  }
  return covered ? false : null;
};

const randomNear = (lat: number, lon: number, maxM: number): { lat: number; lon: number } => {
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * maxM;
  return {
    lat: lat + (dist * Math.cos(angle)) / 110540,
    lon: lon + (dist * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180)),
  };
};

/**
 * 기준점 반경 안에서 이동가능영역 위 좌표를 찾는다 (최대 40회 시도).
 * 없으면 null (호수·데이터 공백) — 호출자가 스폰 건너뛰기/대기로 처리한다.
 */
export const snapToWalkableServer = async (
  dong: string,
  lat: number,
  lon: number,
  maxRadiusM: number,
): Promise<{ lat: number; lon: number } | null> => {
  await ensureDongRaster(dong);
  const direct = isWalkableServer(dong, lat, lon);
  if (direct === true) {
    return { lat, lon };
  }
  if (direct === null) {
    return null;
  }
  for (let i = 0; i < 40; i += 1) {
    const candidate = randomNear(lat, lon, maxRadiusM);
    if (isWalkableServer(dong, candidate.lat, candidate.lon) === true) {
      return candidate;
    }
  }
  return null;
};
