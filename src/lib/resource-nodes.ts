import { NODE_CELL_LAT, NODE_CELL_LON, NODE_EPOCH_MS, nodeEpoch, type ResourceKind, type ResourceNode } from "@/lib/city";
import availableBands from "@/lib/resource-roadsides/bands.json";

interface Site {
  x: number;
  y: number;
  wooded: boolean;
}
type RoadsideBand = Readonly<Record<string, string>>;
interface BandData {
  roads: RoadsideBand;
  woodland: RoadsideBand;
}
const BLOCK = 32;
const decoded = new Map<string, Map<number, Site[]>>();

async function loadBand(row: number): Promise<BandData> {
  if (!availableBands.includes(row)) return { roads: {}, woodland: {} };
  const [roads, woodland] = await Promise.all([
    import(`./resource-roadsides/${row}.json`),
    import("../../public/map-assets/wooded-roadsides.json"),
  ]);
  return { roads: roads.default, woodland: woodland.default.blocks };
}

function sitesInCell(cx: number, cy: number, band: BandData): Site[] {
  const col = Math.floor(cx / BLOCK);
  const packed = band.roads[col];
  if (!packed) return [];
  const key = `${col}:${Math.floor(cy / BLOCK)}`;
  let cells = decoded.get(key);
  if (!cells) {
    const forest = atob(band.woodland[key] ?? "");
    const woodedSites = new Set<number>();
    for (let i = 0; i < forest.length; i += 4) {
      woodedSites.add(forest.charCodeAt(i) | forest.charCodeAt(i + 1) << 8 |
        forest.charCodeAt(i + 2) << 16 | forest.charCodeAt(i + 3) << 24);
    }
    cells = new Map<number, Site[]>();
    const data = atob(packed);
    let offset = 0;
    while (offset < data.length) {
      const cell = data.charCodeAt(offset++) + 256 * data.charCodeAt(offset++);
      const count = data.charCodeAt(offset++);
      const sites: Site[] = [];
      for (let i = 0; i < count; i++) {
        const x = data.charCodeAt(offset++);
        const y = data.charCodeAt(offset++);
        sites.push({ x, y, wooded: woodedSites.has((cell << 16) | (y << 8) | x) });
      }
      cells.set(cell, sites);
    }
    decoded.set(key, cells);
  }
  return cells.get((cy % BLOCK) * BLOCK + cx % BLOCK) ?? [];
}

function hash32(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
  }
  return h >>> 0;
}
const rand01 = (seed: number, salt: number): number => hash32(seed, salt) / 4294967296;

const NODE_AMOUNT: Readonly<Record<ResourceKind, number>> = { gold: 500, stone: 1200, wood: 1500, iron: 900 };

/** 한 격자 칸의 자원지 (0~2곳) */
function nodesInCell(cx: number, cy: number, epoch: number, band: BandData): ResourceNode[] {
  const sites = sitesInCell(cx, cy, band);
  if (!sites.length) return [];
  const seed = hash32(cx, cy, epoch, 0x7f4a);
  const count = rand01(seed, 1) < 0.25 ? 0 : rand01(seed, 2) < 0.55 ? 1 : 2;
  const out: ResourceNode[] = [];
  const first = hash32(seed, 30) % sites.length;
  for (let i = 0; i < Math.min(count, sites.length); i++) {
    const r = rand01(seed, 10 + i);
    const kind: ResourceKind = r < 0.32 ? "wood" : r < 0.6 ? "stone" : r < 0.85 ? "iron" : "gold";
    if (kind === "gold") continue; // 금은 은행 영업점의 고정 광맥에서만 생성한다.
    const lr = rand01(seed, 20 + i);
    const level = (lr < 0.6 ? 1 : lr < 0.9 ? 2 : 3) as 1 | 2 | 3;
    const site = sites[(first + i) % sites.length];
    if (kind === "wood" && !site.wooded) continue;
    const lat = (cy + (site.y + 0.5) / 256) * NODE_CELL_LAT;
    const lon = (cx + (site.x + 0.5) / 256) * NODE_CELL_LON;
    out.push({
      id: `${cx}:${cy}:${epoch}:${i}`,
      kind,
      level,
      lat,
      lon,
      amount: NODE_AMOUNT[kind] * level,
      expiresAt: (epoch + 1) * NODE_EPOCH_MS,
    });
  }
  return out;
}

/** 경계 안 자원지 */
export async function nodesInBounds(
  south: number,
  west: number,
  north: number,
  east: number,
  now: number,
  maxCells = 400,
): Promise<ResourceNode[]> {
  if (![south, west, north, east].every(Number.isFinite) || north < south || east < west ||
      south < -90 || north > 90 || west < -180 || east > 180) return [];
  const epoch = nodeEpoch(now);
  const y0 = Math.floor(south / NODE_CELL_LAT);
  const y1 = Math.floor(north / NODE_CELL_LAT);
  const x0 = Math.floor(west / NODE_CELL_LON);
  const x1 = Math.floor(east / NODE_CELL_LON);
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > maxCells) return [];
  const out: ResourceNode[] = [];
  for (let row = Math.floor(y0 / BLOCK); row <= Math.floor(y1 / BLOCK); row++) {
    const band = await loadBand(row);
    const from = Math.max(y0, row * BLOCK);
    const to = Math.min(y1, (row + 1) * BLOCK - 1);
    for (let cy = from; cy <= to; cy++) {
      for (let cx = x0; cx <= x1; cx++) out.push(...nodesInCell(cx, cy, epoch, band));
    }
  }
  return out;
}

/** id → 자원지 (현재 시대만 유효) */
export async function nodeById(id: string, now: number): Promise<ResourceNode | null> {
  const m = /^(-?\d+):(-?\d+):(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  const [cx, cy, epoch, idx] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (epoch !== nodeEpoch(now) || idx > 1 || ![cx, cy].every(Number.isSafeInteger)) return null;
  const band = await loadBand(Math.floor(cy / BLOCK));
  return nodesInCell(cx, cy, epoch, band).find(node => node.id === id) ?? null;
}
