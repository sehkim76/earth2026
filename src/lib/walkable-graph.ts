/**
 * 도로 그래프 라우팅 (길찾기 전용 간략 데이터).
 * 빌드: scripts/build-walkable-graph.py → public/walkable/graph/{dongId}.json
 * 포맷: {"v":2,"n":[dx,dy,...] (deg*1e6 델타),"p":[[nodeId,...],...] (체인)}
 * 체인 내 인접 노드 = 간선. 가중치는 실제 구간 길이, 휴리스틱은 직선거리.
 */

import { queuedFetch, readCachedGraph, writeCachedGraph } from "@/lib/walkable-cache";

type GraphPoint = { lat: number; lon: number };

export type GraphData = {
  nodes: Float64Array; // [lon,lat,...] 도 단위
  chains: number[][];
};

const graphCache = new Map<string, GraphData | null>();
const graphPending = new Map<string, Promise<GraphData | null>>();
const GRAPH_SCALE = 1_000_000;

const graphUrl = (dongId: string): string => `/walkable/graph/${encodeURIComponent(dongId)}.json`;

/** 동 그래프 로드 (캐시, 실패 시 null). */
export const loadGraphDong = (dongId: string): Promise<GraphData | null> => {
  if (!dongId) {
    return Promise.resolve(null);
  }
  const cached = graphCache.get(dongId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const ongoing = graphPending.get(dongId);
  if (ongoing) {
    return ongoing;
  }
  const task = (async (): Promise<GraphData | null> => {
    try {
      // 1) IDB 먼저 (리로드 재검증 회피).
      const cached = await readCachedGraph(dongId);
      if (cached) {
        const parsed = parseGraphData(cached);
        if (parsed) {
          return parsed;
        }
      }
      const res = await queuedFetch(graphUrl(dongId), 15000, { credentials: "omit" });
      if (!res || !res.ok) {
        return null;
      }
      const rawText = await res.text();
      if (!rawText) {
        return null;
      }
      void writeCachedGraph(dongId, rawText);
      let data: unknown = null;
      try {
        data = JSON.parse(rawText) as unknown;
      } catch {
        return null;
      }
      return parseGraphData(data);
    } catch {
      return null;
    }
  })()
    .then((parsed) => {
      graphCache.set(dongId, parsed);
      if (graphCache.size > 24) {
        const oldest = graphCache.keys().next();
        if (!oldest.done) {
          graphCache.delete(oldest.value);
        }
      }
      return parsed;
    })
    .finally(() => {
      graphPending.delete(dongId);
    });

  graphPending.set(dongId, task);
  return task;
};

/** 그래프 JSON 파싱 (v2 델타 포맷 → 노드/체인). 실패 시 null. */
export const parseGraphData = (data: unknown): GraphData | null => {
      if (!data || typeof data !== "object") {
        return null;
      }
      const record = data as { v?: unknown; n?: unknown; p?: unknown };
      if (record.v !== 2 || !Array.isArray(record.n) || !Array.isArray(record.p)) {
        return null;
      }
      const flat = record.n as unknown[];
      if (flat.length % 2 !== 0) {
        return null;
      }
      const count = flat.length / 2;
      const nodes = new Float64Array(flat.length);
      let x = 0;
      let y = 0;
      for (let i = 0; i < count; i += 1) {
        const dx = flat[i * 2];
        const dy = flat[i * 2 + 1];
        if (typeof dx !== "number" || typeof dy !== "number") {
          return null;
        }
        x += dx;
        y += dy;
        nodes[i * 2] = x / GRAPH_SCALE;
        nodes[i * 2 + 1] = y / GRAPH_SCALE;
      }
      const chains: number[][] = [];
      for (const chain of record.p as unknown[]) {
        if (!Array.isArray(chain) || chain.length < 2) {
          continue;
        }
        const ids: number[] = [];
        let valid = true;
        for (const id of chain) {
          if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= count) {
            valid = false;
            break;
          }
          ids.push(id);
        }
        if (valid) {
          chains.push(ids);
        }
      }
      if (chains.length === 0) {
        return null;
      }
      return { nodes, chains };
};

const STITCH_M = 2.5;

/** 스티칭된 그래프 구조. */
type StitchedGraph = {
  repCoords: number[];
  adj: Array<Array<{ to: number; w: number }>>;
};

/**
 * 로드된 그래프들을 합쳐 A* 탐색한다. 실패 시 null (호출자가 격자 A*로 폴백).
 * snapMaxM: 출발/도착 스냅 허용 거리.
 */
/** 로드된 그래프들을 스티칭해 탐색 구조로 만든다 (무거움, 캐시 대상). */
const buildStitchedGraph = (loaded: GraphData[]): StitchedGraph | null => {
  // 전역 노드 수집.
    const coords: number[] = []; // [lon,lat,...]
    for (const g of loaded) {
      for (let i = 0; i < (g as GraphData).nodes.length; i += 1) {
        coords.push((g as GraphData).nodes[i] as number);
      }
    }
    const nodeCount = coords.length / 2;
    if (nodeCount === 0) {
      return null;
    }
    // 전 구간 단일 kx (동네 규모에서 위도별 편차 무시).
    let meanLat = 0;
    for (let i = 0; i < nodeCount; i += 1) {
      meanLat += coords[i * 2 + 1] as number;
    }
    meanLat /= nodeCount;
    const kx = 111320 * Math.cos((meanLat * Math.PI) / 180);
    const KY = 110540;
    const dist2 = (aLon: number, aLat: number, bLon: number, bLat: number): number => {
      const dx = (bLon - aLon) * kx;
      const dy = (bLat - aLat) * KY;
      return dx * dx + dy * dy;
    };
    // 셀 해시로 근접 노드 union (동 경계 스티칭 + 미세 오차 흡수).
    // 셀 키는 숫자 (문자열 할당 회피). cx*1000000+cy (cy<1000000, cx 양수).
    const CELL_M = 5;
    const STITCH2 = STITCH_M * STITCH_M;
    const cellNum = (cx: number, cy: number): number => cx * 1000000 + cy;
    const cellNumOf = (lon: number, lat: number): number =>
      cellNum(Math.floor((lon * kx) / CELL_M), Math.floor((lat * KY) / CELL_M));
    const parent = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i += 1) {
      parent[i] = i;
    }
    const find = (a: number): number => {
      let root = a;
      while (parent[root] !== root) {
        root = parent[root] as number;
      }
      let cursor = a;
      while (parent[cursor] !== root) {
        const next = parent[cursor] as number;
        parent[cursor] = root;
        cursor = next;
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) {
        parent[rb] = ra;
      }
    };
    const cellMap = new Map<number, number[]>();
    for (let i = 0; i < nodeCount; i += 1) {
      const key = cellNumOf(coords[i * 2] as number, coords[i * 2 + 1] as number);
      const bucket = cellMap.get(key);
      if (bucket) {
        bucket.push(i);
      } else {
        cellMap.set(key, [i]);
      }
    }
    const neighborKeys = (lon: number, lat: number, out: number[]): number[] => {
      const cx = Math.floor((lon * kx) / CELL_M);
      const cy = Math.floor((lat * KY) / CELL_M);
      out.length = 0;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          out.push(cellNum(cx + dx, cy + dy));
        }
      }
      return out;
    };
    const keyBuf: number[] = [];
    for (let i = 0; i < nodeCount; i += 1) {
      const lon = coords[i * 2] as number;
      const lat = coords[i * 2 + 1] as number;
      for (const key of neighborKeys(lon, lat, keyBuf)) {
        const bucket = cellMap.get(key);
        if (!bucket) {
          continue;
        }
        for (const j of bucket) {
          if (j <= i) {
            continue;
          }
          const olon = coords[j * 2] as number;
          const olat = coords[j * 2 + 1] as number;
          const dx = (olon - lon) * kx;
          if (dx > STITCH_M || dx < -STITCH_M) {
            continue;
          }
          const dy = (olat - lat) * KY;
          if (dy > STITCH_M || dy < -STITCH_M) {
            continue;
          }
          if (dx * dx + dy * dy <= STITCH2) {
            union(i, j);
          }
        }
      }
    }
    // 대표 노드 압축 + 인접 리스트.
    const repOf = new Int32Array(nodeCount);
    const repIndex = new Map<number, number>();
    const repCoords: number[] = [];
    for (let i = 0; i < nodeCount; i += 1) {
      const r = find(i);
      repOf[i] = r;
      if (!repIndex.has(r)) {
        repIndex.set(r, repCoords.length / 2);
        // 대표 좌표는 첫 번째 멤버를 사용한다.
        repCoords.push(coords[i * 2] as number, coords[i * 2 + 1] as number);
      }
    }
    const repCount = repCoords.length / 2;
    const adj: Array<Array<{ to: number; w: number }>> = Array.from({ length: repCount }, () => []);
    let offset = 0;
    const seenEdge = new Set<string>();
    for (const g of loaded) {
      const base = offset;
      offset += g.nodes.length / 2;
      for (const chain of g.chains) {
        for (let k = 1; k < chain.length; k += 1) {
          const aRep = repIndex.get(repOf[base + (chain[k - 1] as number)] as number);
          const bRep = repIndex.get(repOf[base + (chain[k] as number)] as number);
          if (aRep === undefined || bRep === undefined || aRep === bRep) {
            continue;
          }
          const key = aRep < bRep ? `${aRep}:${bRep}` : `${bRep}:${aRep}`;
          if (seenEdge.has(key)) {
            continue;
          }
          seenEdge.add(key);
          const w = Math.sqrt(
            dist2(
              repCoords[aRep * 2] as number,
              repCoords[aRep * 2 + 1] as number,
              repCoords[bRep * 2] as number,
              repCoords[bRep * 2 + 1] as number,
            ),
          );
          adj[aRep]?.push({ to: bRep, w });
          adj[bRep]?.push({ to: aRep, w });
        }
      }
    }
    // 간극 연결: 데드엔드(대표 차수 1) 노드는 15m 이내 최근접 노드와 잇는다.
    // 격자(도로 15m 버퍼)와 동등한 연결성 확보가 목적이다. 수치화 오차로 끊긴
    // 교차로(T자 미접합 등)가 전형적이며, 격자도 같은 수준으로 연결하므로
    // 정합성이 깨지지 않는다. 가중치 페널티로 실제 도로를 우선한다.
    const GAP_M = 15;
    const GAP_PENALTY = 1.5;
    {
      const degree = new Int32Array(repCount);
      for (let v = 0; v < repCount; v += 1) {
        degree[v] = (adj[v] as Array<unknown>).length;
      }
      // 대표 노드 셀 해시 (최근접 탐색용).
      const repCell = new Map<number, number[]>();
      for (let v = 0; v < repCount; v += 1) {
        const key = cellNumOf(repCoords[v * 2] as number, repCoords[v * 2 + 1] as number);
        const bucket = repCell.get(key);
        if (bucket) {
          bucket.push(v);
        } else {
          repCell.set(key, [v]);
        }
      }
      const GAP2 = GAP_M * GAP_M;
      for (let v = 0; v < repCount; v += 1) {
        if ((degree[v] as number) > 1) {
          continue;
        }
        const vlon = repCoords[v * 2] as number;
        const vlat = repCoords[v * 2 + 1] as number;
        const ccx = Math.floor((vlon * kx) / CELL_M);
        const ccy = Math.floor((vlat * KY) / CELL_M);
        const span = Math.ceil(GAP_M / CELL_M);
        let bestU = -1;
        let bestD2 = GAP2;
        for (let dx = -span; dx <= span; dx += 1) {
          for (let dy = -span; dy <= span; dy += 1) {
            const bucket = repCell.get(cellNum(ccx + dx, ccy + dy));
            if (!bucket) {
              continue;
            }
            for (const u of bucket) {
              if (u === v) {
                continue;
              }
              const d2 = dist2(vlon, vlat, repCoords[u * 2] as number, repCoords[u * 2 + 1] as number);
              if (d2 < bestD2) {
                const key = v < u ? `${v}:${u}` : `${u}:${v}`;
                if (seenEdge.has(key)) {
                  continue;
                }
                bestD2 = d2;
                bestU = u;
              }
            }
          }
        }
        if (bestU >= 0) {
          const key = v < bestU ? `${v}:${bestU}` : `${bestU}:${v}`;
          seenEdge.add(key);
          const w = Math.sqrt(bestD2) * GAP_PENALTY;
          adj[v]?.push({ to: bestU, w });
          adj[bestU]?.push({ to: v, w });
        }
      }
    }
  if (repCoords.length === 0) {
    return null;
  }
  return { repCoords, adj };
};

/**
 * 컴포넌트 스내퍼 (스티칭 + BFS 1회, 여러 점 스냅에 재사용).
 * 중간점마다 buildStitchedGraph를 반복하면 수십 초가 걸리므로 반드시 이걸 쓴다.
 */
export type ComponentSnapper = {
  snap(lat: number, lon: number, maxM: number): GraphPoint | null;
};

export const createComponentSnapper = (
  graphs: Array<GraphData | null>
): ComponentSnapper | null => {
  const loaded = graphs.filter((g): g is GraphData => g !== null);
  if (loaded.length === 0) {
    return null;
  }
  const stitched = buildStitchedGraph(loaded);
  if (!stitched) {
    return null;
  }
  const { repCoords, adj } = stitched;
  const n = repCoords.length / 2;
  if (n === 0) {
    return null;
  }
  // BFS로 컴포넌트 크기 계산.
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  let compCount = 0;
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (comp[i] !== -1) {
      continue;
    }
    comp[i] = compCount;
    queue.length = 0;
    queue.push(i);
    let size = 0;
    for (let q = 0; q < queue.length; q += 1) {
      const v = queue[q] as number;
      size += 1;
      const edges = adj[v];
      if (!edges) {
        continue;
      }
      for (const e of edges) {
        if (comp[e.to] === -1) {
          comp[e.to] = compCount;
          queue.push(e.to);
        }
      }
    }
    sizes.push(size);
    compCount += 1;
  }
  return {
    snap(lat: number, lon: number, maxM: number): GraphPoint | null {
      const kx = 111320 * Math.cos((lat * Math.PI) / 180);
      const limit2 = maxM * maxM;
      let best: { lat: number; lon: number; size: number; d2: number } | null = null;
      for (let i = 0; i < n; i += 1) {
        const nlon = repCoords[i * 2] as number;
        const nlat = repCoords[i * 2 + 1] as number;
        const dx = (nlon - lon) * kx;
        const dy = (nlat - lat) * 110540;
        const d2 = dx * dx + dy * dy;
        if (d2 > limit2) {
          continue;
        }
        const size = sizes[comp[i] as number] ?? 0;
        if (!best || size > best.size || (size === best.size && d2 < best.d2)) {
          best = { lat: nlat, lon: nlon, size, d2 };
        }
      }
      return best ? { lat: best.lat, lon: best.lon } : null;
    },
  };
};

/**
 * 최대 컴포넌트 기준 스냅 (1회용 — 반복 스냅에는 createComponentSnapper 사용).
 */
export const snapToLargestComponent = (
  graphs: Array<GraphData | null>,
  lat: number,
  lon: number,
  maxM: number
): GraphPoint | null => createComponentSnapper(graphs)?.snap(lat, lon, maxM) ?? null;

/** 스티칭 결과 캐시 (동 집합 서명 기준 — 다리마다 같은 합치기 반복 방지, 상한 24). */
const stitchedCache = new Map<string, StitchedGraph | null>();
const STITCHED_CACHE_LIMIT = 24;

export const searchGraphs = (
  graphs: Array<GraphData | null>,
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  snapMaxM = 500,
  cacheKey?: string,
): GraphPoint[] | null => {
  const loaded = graphs.filter((g): g is GraphData => g !== null);
  if (loaded.length === 0) {
    return null;
  }
  let sMeanLat = 0;
  let sMeanCount = 0;
  for (const g of loaded) {
    for (let i = 1; i < g.nodes.length; i += 2) {
      sMeanLat += g.nodes[i] as number;
      sMeanCount += 1;
    }
  }
  if (sMeanCount === 0) {
    return null;
  }
  sMeanLat /= sMeanCount;
  const skx = 111320 * Math.cos((sMeanLat * Math.PI) / 180);
  const sKY = 110540;
  const stitched = (() => {
    if (cacheKey) {
      const hit = stitchedCache.get(cacheKey);
      if (hit !== undefined) {
        return hit;
      }
    }
    const built = buildStitchedGraph(loaded);
    if (cacheKey) {
      stitchedCache.set(cacheKey, built);
      if (stitchedCache.size > STITCHED_CACHE_LIMIT) {
        const oldest = stitchedCache.keys().next();
        if (!oldest.done) {
          stitchedCache.delete(oldest.value);
        }
      }
    }
    return built;
  })();
  if (!stitched) {
    return null;
  }
  const { repCoords, adj } = stitched;
  const repCount = repCoords.length / 2;
  const dist2 = (aLon: number, aLat: number, bLon: number, bLat: number): number => {
    const dx = (bLon - aLon) * skx;
    const dy = (bLat - aLat) * sKY;
    return dx * dx + dy * dy;
  };
  // 출발/도착 스냅 (최근접 N개 — 고립 조각에 붙으면 다음 후보로).
  // 작은 조각에 스냅돼도 본망에 닿는 후보가 있으면 길을 찾는다.
  // 산속 직선점(최근접이 고립 조각) 대응으로 후보를 넓혔다.
  const SNAP_CANDIDATES = 12;
  const MAX_ASTAR_PAIRS = 24;
  const MAX_GRAPH_EXPANSIONS = 200000;
  const runAStar = (startIdx: number, goalIdx: number): GraphPoint[] | null => {
    if (startIdx === goalIdx) {
      return [{ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }];
    }
    const gScore = new Float64Array(repCount).fill(Number.POSITIVE_INFINITY);
    const cameFrom = new Int32Array(repCount).fill(-1);
    const closed = new Uint8Array(repCount);
    const heuristic = (v: number): number =>
      Math.sqrt(
        dist2(
          repCoords[v * 2] as number,
          repCoords[v * 2 + 1] as number,
          toLon,
          toLat,
        ),
      );
    const heap: number[] = [];
    const heapF = new Float64Array(repCount);
    const heapPos = new Int32Array(repCount).fill(-1);
    const heapSwap = (i: number, j: number): void => {
      const vi = heap[i] as number;
      const vj = heap[j] as number;
      heap[i] = vj;
      heap[j] = vi;
      heapPos[vi] = j;
      heapPos[vj] = i;
    };
    const heapUp = (i: number): void => {
      let c = i;
      while (c > 0) {
        const par = (c - 1) >> 1;
        if ((heapF[heap[c] as number] as number) >= (heapF[heap[par] as number] as number)) {
          break;
        }
        heapSwap(c, par);
        c = par;
      }
    };
    const heapDown = (i: number): void => {
      let c = i;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && (heapF[heap[l] as number] as number) < (heapF[heap[m] as number] as number)) {
          m = l;
        }
        if (r < heap.length && (heapF[heap[r] as number] as number) < (heapF[heap[m] as number] as number)) {
          m = r;
        }
        if (m === c) {
          break;
        }
        heapSwap(c, m);
        c = m;
      }
    };
    const pushOrUpdate = (v: number, f: number): void => {
      heapF[v] = f;
      if (heapPos[v] === -1) {
        heapPos[v] = heap.length;
        heap.push(v);
        heapUp(heap.length - 1);
      } else {
        heapUp(heapPos[v]);
        heapDown(heapPos[v]);
      }
    };
    const pop = (): number => {
      const top = heap[0] as number;
      const last = heap.pop() as number;
      heapPos[top] = -1;
      if (heap.length > 0) {
        heap[0] = last;
        heapPos[last] = 0;
        heapDown(0);
      }
      return top;
    };
    gScore[startIdx] = 0;
    pushOrUpdate(startIdx, heuristic(startIdx));
    let expansions = 0;
    while (heap.length > 0) {
      const current = pop();
      if (closed[current] === 1) {
        continue;
      }
      closed[current] = 1;
      if (current === goalIdx) {
        break;
      }
      expansions += 1;
      if (expansions > MAX_GRAPH_EXPANSIONS) {
        return null;
      }
      const cg = gScore[current] as number;
      for (const edge of adj[current] ?? []) {
        if (closed[edge.to] === 1) {
          continue;
        }
        const tentative = cg + edge.w;
        if (tentative < (gScore[edge.to] as number)) {
          gScore[edge.to] = tentative;
          cameFrom[edge.to] = current;
          pushOrUpdate(edge.to, tentative + heuristic(edge.to));
        }
      }
    }
    if (cameFrom[goalIdx] === -1) {
      return null;
    }
    const path: GraphPoint[] = [];
    let cursor: number | undefined = goalIdx;
    while (cursor !== undefined && cursor >= 0) {
      path.push({
        lat: repCoords[cursor * 2 + 1] as number,
        lon: repCoords[cursor * 2] as number,
      });
      const prev = cameFrom[cursor] as number;
      cursor = prev < 0 ? undefined : prev;
    }
    path.reverse();
    return path;
  };
  // 스냅 반경 확대: 전체 스캔 1회로 최대 반경까지 점수를 매겨 재사용한다.
  // (기존: 반경마다 전체 노드 선형 스캔 × 출발/도착 = 최대 6회 스캔)
  const scoredFrom: Array<{ idx: number; d2: number }> = [];
  const scoredTo: Array<{ idx: number; d2: number }> = [];
  {
    const limit2 = 3000 * 3000;
    for (let i = 0; i < repCount; i += 1) {
      const lon = repCoords[i * 2] as number;
      const lat = repCoords[i * 2 + 1] as number;
      const d2f = dist2(lon, lat, fromLon, fromLat);
      if (d2f <= limit2) {
        scoredFrom.push({ idx: i, d2: d2f });
      }
      const d2t = dist2(lon, lat, toLon, toLat);
      if (d2t <= limit2) {
        scoredTo.push({ idx: i, d2: d2t });
      }
    }
    scoredFrom.sort((a, b) => a.d2 - b.d2);
    scoredTo.sort((a, b) => a.d2 - b.d2);
  }
  let runs = 0;
  for (const radius of [snapMaxM, 1500, 3000]) {
    const r2 = radius * radius;
    const starts = scoredFrom.filter((s) => s.d2 <= r2).slice(0, SNAP_CANDIDATES);
    const goals = scoredTo.filter((s) => s.d2 <= r2).slice(0, SNAP_CANDIDATES);
    if (starts.length === 0 || goals.length === 0) {
      continue;
    }
    const pairs: Array<{ s: number; g: number; d2: number }> = [];
    for (const s of starts) {
      for (const g of goals) {
        pairs.push({ s: s.idx, g: g.idx, d2: s.d2 + g.d2 });
      }
    }
    pairs.sort((x, y) => x.d2 - y.d2);
    for (const pair of pairs) {
      if (runs >= MAX_ASTAR_PAIRS) {
        return null;
      }
      runs += 1;
      const found = runAStar(pair.s, pair.g);
      if (found) {
        return found;
      }
    }
  }
  return null;
};
