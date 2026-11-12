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

/** 보라색 다리: 최대 길이(m). 도로 버퍼 15m×2=30m에서 래스터 양자화 여유를 뺐다. */
const BRIDGE_M = 28;
/** 다리 간선 가중치 배율 (실제 도로를 약간 우선). */
const BRIDGE_PENALTY = 1.2;
/** 같은 선분 위 분할점 병합 거리(m) — 평행 도로에서 다리가 촘촘해지는 것을 막는다. */
const BRIDGE_MERGE_M = 8;
/** 차수 2 출발 노드 표본 간격(m). */
const BRIDGE_SAMPLE_M = 12;
/** 래스터 확인 없이 놓는 다리 상한(m) — 기존 데드엔드 간극 연결(15m)과 같은 수준. */
const BRIDGE_UNCHECKED_M = 15;
/** 래스터 확인 표본 간격(m) (격자 셀 5m의 절반). */
const BRIDGE_CHECK_STEP_M = 2.5;

/** 이동가능(보라색) 셀 판정 — 로드된 래스터 기준. 모르면 false(다리 거부). */
export type WalkableCheck = (lat: number, lon: number) => boolean;

/**
 * 그래프로는 끊겼지만 도로 버퍼(보라색)로는 이어진 곳에 다리 간선을 추가한다 (제자리 수정).
 * 노드 v → 반경 BRIDGE_M 안의 비인접 선분 최근접점 p (거리 d).
 * v에서 p까지 기존 그래프 거리(제한 다익스트라)가 2d+15m를 넘으면 v–p를 잇는다.
 * d가 BRIDGE_UNCHECKED_M를 넘는 다리는 isWalkable로 다리 전 구간이 보라색 셀인지 확인한 뒤에만 놓는다
 * (래스터 양자화 때문에 15~28m 간격은 실제로 끊겨 보일 수 있다). isWalkable이 없으면 15m까지만 잇는다.
 */
const addPurpleBridges = (
  repCoords: number[],
  adj: Array<Array<{ to: number; w: number }>>,
  kx: number,
  ky: number,
  isWalkable?: WalkableCheck,
): void => {
  const n = repCoords.length / 2;
  if (n < 2) {
    return;
  }
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let v = 0; v < n; v += 1) {
    px[v] = (repCoords[v * 2] as number) * kx;
    py[v] = (repCoords[v * 2 + 1] as number) * ky;
  }
  // 선분 목록 (무방향 1회).
  const segA: number[] = [];
  const segB: number[] = [];
  for (let v = 0; v < n; v += 1) {
    for (const e of adj[v] ?? []) {
      if (v < e.to) {
        segA.push(v);
        segB.push(e.to);
      }
    }
  }
  const segCount = segA.length;
  // 선분 셀 인덱스 (셀 = 2×BRIDGE_M, 노드 주변 BRIDGE_M 사각형과 겹치는 1~2×1~2 셀만 조회).
  // 셀 좌표는 bbox 기준 상대값으로 둬서 키가 소정수(SMI) 범위에 머물게 한다 (Map 해시 속도).
  const CELL = BRIDGE_M * 2;
  const HALF_DIAG = (CELL * Math.SQRT2) / 2;
  let minPx = Number.POSITIVE_INFINITY;
  let minPy = Number.POSITIVE_INFINITY;
  let maxPx = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < n; v += 1) {
    if ((px[v] as number) < minPx) minPx = px[v] as number;
    if ((py[v] as number) < minPy) minPy = py[v] as number;
    if ((px[v] as number) > maxPx) maxPx = px[v] as number;
  }
  const gridW = Math.floor((maxPx - minPx) / CELL) + 3;
  for (let v = 0; v < n; v += 1) {
    px[v] = (px[v] as number) - minPx + CELL;
    py[v] = (py[v] as number) - minPy + CELL;
  }
  const cellKey = (cx: number, cy: number): number => cy * gridW + cx;
  // 다리 전 구간(양끝 제외, 2.5m 간격)이 보라색 셀인지 확인한다.
  const bridgeOnPurple = (ax: number, ay: number, bx: number, by: number, d: number): boolean => {
    if (!isWalkable) {
      return false;
    }
    const steps = Math.max(2, Math.ceil(d / BRIDGE_CHECK_STEP_M));
    for (let k = 1; k < steps; k += 1) {
      const x = ax + ((bx - ax) * k) / steps;
      const y = ay + ((by - ay) * k) / steps;
      const lon = (x - CELL + minPx) / kx;
      const lat = (y - CELL + minPy) / ky;
      if (!isWalkable(lat, lon)) {
        return false;
      }
    }
    return true;
  };
  // 선분 셀 인덱스 (CSR: 셀 키 → 슬롯, 슬롯별 [start,end) 구간). 셀마다 배열을 만들면 GC가 커진다.
  // 대각선 긴 선분이 bbox 전체 셀에 들어가지 않도록, 셀 중심에서 선분까지 거리가 반대각선 이하인 셀만 넣는다.
  const segNearCell = (s: number, cx: number, cy: number): boolean => {
    const a = segA[s] as number;
    const b = segB[s] as number;
    const ox = (cx + 0.5) * CELL;
    const oy = (cy + 0.5) * CELL;
    const ax = px[a] as number;
    const ay = py[a] as number;
    const bx = (px[b] as number) - ax;
    const by = (py[b] as number) - ay;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((ox - ax) * bx + (oy - ay) * by) / len2)) : 0;
    const dx = ax + bx * t - ox;
    const dy = ay + by * t - oy;
    return dx * dx + dy * dy <= HALF_DIAG * HALF_DIAG;
  };
  const slotOf = new Map<number, number>();
  let slotCount = 0;
  const slotCounts: number[] = [];
  const segCx0 = new Int32Array(segCount);
  const segCx1 = new Int32Array(segCount);
  const segCy0 = new Int32Array(segCount);
  const segCy1 = new Int32Array(segCount);
  let pairTotal = 0;
  for (let s = 0; s < segCount; s += 1) {
    const a = segA[s] as number;
    const b = segB[s] as number;
    const cx0 = Math.floor(Math.min(px[a] as number, px[b] as number) / CELL);
    const cx1 = Math.floor(Math.max(px[a] as number, px[b] as number) / CELL);
    const cy0 = Math.floor(Math.min(py[a] as number, py[b] as number) / CELL);
    const cy1 = Math.floor(Math.max(py[a] as number, py[b] as number) / CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) {
      segCx0[s] = 1;
      segCx1[s] = 0; // 비정상적으로 긴 선분은 건너뛴다 (빈 범위).
      continue;
    }
    segCx0[s] = cx0;
    segCx1[s] = cx1;
    segCy0[s] = cy0;
    segCy1[s] = cy1;
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        if (!segNearCell(s, cx, cy)) {
          continue;
        }
        const key = cellKey(cx, cy);
        let slot = slotOf.get(key);
        if (slot === undefined) {
          slot = slotCount;
          slotCount += 1;
          slotOf.set(key, slot);
          slotCounts.push(0);
        }
        slotCounts[slot] = (slotCounts[slot] as number) + 1;
        pairTotal += 1;
      }
    }
  }
  const slotStart = new Int32Array(slotCount + 1);
  for (let i = 0; i < slotCount; i += 1) {
    slotStart[i + 1] = (slotStart[i] as number) + (slotCounts[i] as number);
  }
  const slotFill = slotStart.slice(0, slotCount);
  const cellSegs = new Int32Array(pairTotal);
  for (let s = 0; s < segCount; s += 1) {
    for (let cx = segCx0[s] as number; cx <= (segCx1[s] as number); cx += 1) {
      for (let cy = segCy0[s] as number; cy <= (segCy1[s] as number); cy += 1) {
        if (!segNearCell(s, cx, cy)) {
          continue;
        }
        const slot = slotOf.get(cellKey(cx, cy)) as number;
        cellSegs[slotFill[slot] as number] = s;
        slotFill[slot] = (slotFill[slot] as number) + 1;
      }
    }
  }
  // 제한 다익스트라 (스탬프 배열 재사용).
  const LIMIT = 2 * BRIDGE_M + 15;
  const dist = new Float64Array(n);
  const stamp = new Int32Array(n);
  let curStamp = 0;
  const heapNode: number[] = [];
  const heapDist: number[] = [];
  const heapPush = (node: number, d: number): void => {
    let i = heapNode.length;
    heapNode.push(node);
    heapDist.push(d);
    while (i > 0) {
      const par = (i - 1) >> 1;
      if ((heapDist[par] as number) <= d) {
        break;
      }
      heapNode[i] = heapNode[par] as number;
      heapDist[i] = heapDist[par] as number;
      i = par;
    }
    heapNode[i] = node;
    heapDist[i] = d;
  };
  const heapPop = (): number => {
    const top = heapNode[0] as number;
    const lastNode = heapNode.pop() as number;
    const lastDist = heapDist.pop() as number;
    const size = heapNode.length;
    if (size > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= size) {
          break;
        }
        const r = l + 1;
        const c = r < size && (heapDist[r] as number) < (heapDist[l] as number) ? r : l;
        if ((heapDist[c] as number) >= lastDist) {
          break;
        }
        heapNode[i] = heapNode[c] as number;
        heapDist[i] = heapDist[c] as number;
        i = c;
      }
      heapNode[i] = lastNode;
      heapDist[i] = lastDist;
    }
    return top;
  };
  // 목표 노드(후보 선분 끝점)가 모두 확정되거나 need를 넘으면 멈춘다.
  const targetStamp = new Int32Array(n);
  const reach = (src: number, targets: number[], need: number): void => {
    curStamp += 1;
    heapNode.length = 0;
    heapDist.length = 0;
    let pending = 0;
    for (const t of targets) {
      if (targetStamp[t] !== curStamp) {
        targetStamp[t] = curStamp;
        pending += 1;
      }
    }
    stamp[src] = curStamp;
    dist[src] = 0;
    heapPush(src, 0);
    const limit = Math.min(LIMIT, need);
    while (heapNode.length > 0) {
      const d0 = heapDist[0] as number;
      const v = heapPop();
      if (d0 > (dist[v] as number)) {
        continue;
      }
      if (targetStamp[v] === curStamp) {
        targetStamp[v] = 0;
        pending -= 1;
        if (pending === 0) {
          return;
        }
      }
      for (const e of adj[v] ?? []) {
        const nd = d0 + e.w;
        if (nd > limit) {
          continue;
        }
        if (stamp[e.to] !== curStamp || nd < (dist[e.to] as number)) {
          stamp[e.to] = curStamp;
          dist[e.to] = nd;
          heapPush(e.to, nd);
        }
      }
    }
  };
  const graphDist = (v: number): number => (stamp[v] === curStamp ? (dist[v] as number) : Number.POSITIVE_INFINITY);
  // 수집: 선분별 분할점(t), 다리(v → 선분 s의 t).
  type Bridge = { v: number; s: number; t: number; d: number };
  const bridges: Bridge[] = [];
  const segSeen = new Int32Array(segCount).fill(-1);
  type Cand = { s: number; t: number; d: number; qx: number; qy: number };
  const cand: Cand[] = [];
  const targets: number[] = [];
  const R2 = BRIDGE_M * BRIDGE_M;
  // 수락된 다리 공간 해시 (출발 노드 셀 기준) — 이웃 노드가 이미 놓은 다리로 갈 수 있으면 생략한다.
  const bridgeQx: number[] = [];
  const bridgeQy: number[] = [];
  const bridgeCells = new Map<number, number[]>();
  // 출발 노드 표본화: 데드엔드·교차로는 전부, 차수 2 노드는 도로를 따라 약 BRIDGE_SAMPLE_M마다 하나.
  // (곡선 도로의 촘촘한 정점마다 주변 선분을 훑으면 느리다. 다리 위치 오차는 표본 간격 이내.)
  const srcGap = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  for (let v = 0; v < n; v += 1) {
    const edges = adj[v] ?? [];
    if (edges.length === 2) {
      let near = Number.POSITIVE_INFINITY;
      for (const e of edges) {
        const g = (srcGap[e.to] as number) + e.w;
        if (g < near) {
          near = g;
        }
      }
      if (near < BRIDGE_SAMPLE_M) {
        srcGap[v] = near;
        continue;
      }
    }
    srcGap[v] = 0;
    const vx = px[v] as number;
    const vy = py[v] as number;
    const ccx = Math.floor(vx / CELL);
    const ccy = Math.floor(vy / CELL);
    cand.length = 0;
    targets.length = 0;
    let maxD = 0;
    const qx0 = Math.floor((vx - BRIDGE_M) / CELL);
    const qx1 = Math.floor((vx + BRIDGE_M) / CELL);
    const qy0 = Math.floor((vy - BRIDGE_M) / CELL);
    const qy1 = Math.floor((vy + BRIDGE_M) / CELL);
    for (let qcx = qx0; qcx <= qx1; qcx += 1) {
      for (let qcy = qy0; qcy <= qy1; qcy += 1) {
        const slot = slotOf.get(cellKey(qcx, qcy));
        if (slot === undefined) {
          continue;
        }
        const end = slotStart[slot + 1] as number;
        for (let k = slotStart[slot] as number; k < end; k += 1) {
          const s = cellSegs[k] as number;
          if (segSeen[s] === v) {
            continue;
          }
          segSeen[s] = v;
          const a = segA[s] as number;
          const b = segB[s] as number;
          if (a === v || b === v) {
            continue;
          }
          const ax = px[a] as number;
          const ay = py[a] as number;
          const bx = (px[b] as number) - ax;
          const by = (py[b] as number) - ay;
          const len2 = bx * bx + by * by;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((vx - ax) * bx + (vy - ay) * by) / len2)) : 0;
          const qx = ax + bx * t;
          const qy = ay + by * t;
          const d2 = (qx - vx) * (qx - vx) + (qy - vy) * (qy - vy);
          if (d2 <= R2) {
            const d = Math.sqrt(d2);
            cand.push({ s, t, d, qx, qy });
            targets.push(a, b);
            if (d > maxD) {
              maxD = d;
            }
          }
        }
      }
    }
    if (cand.length === 0) {
      continue;
    }
    // 2홉 상한으로 모든 후보가 이미 가깝게 이어져 있으면 다익스트라를 생략한다.
    curStamp += 1;
    stamp[v] = curStamp;
    dist[v] = 0;
    for (const e1 of adj[v] ?? []) {
      if (stamp[e1.to] !== curStamp || e1.w < (dist[e1.to] as number)) {
        stamp[e1.to] = curStamp;
        dist[e1.to] = e1.w;
      }
      for (const e2 of adj[e1.to] ?? []) {
        const d2w = e1.w + e2.w;
        if (stamp[e2.to] !== curStamp || d2w < (dist[e2.to] as number)) {
          stamp[e2.to] = curStamp;
          dist[e2.to] = d2w;
        }
      }
    }
    let allNear = true;
    for (const c of cand) {
      const a = segA[c.s] as number;
      const b = segB[c.s] as number;
      const len = Math.hypot((px[b] as number) - (px[a] as number), (py[b] as number) - (py[a] as number));
      if (Math.min(graphDist(a) + len * c.t, graphDist(b) + len * (1 - c.t)) > 2 * c.d + 15) {
        allNear = false;
        break;
      }
    }
    if (allNear) {
      continue;
    }
    reach(v, targets, 2 * maxD + 15);
    cand.sort((x, y) => x.d - y.d);
    const accepted: Array<{ qx: number; qy: number }> = [];
    for (const c of cand) {
      const a = segA[c.s] as number;
      const b = segB[c.s] as number;
      const len = Math.hypot((px[b] as number) - (px[a] as number), (py[b] as number) - (py[a] as number));
      const via = Math.min(graphDist(a) + len * c.t, graphDist(b) + len * (1 - c.t));
      if (via <= 2 * c.d + 15) {
        continue; // 이미 그래프로 가깝게 이어져 있다.
      }
      if (accepted.some((q) => Math.hypot(q.qx - c.qx, q.qy - c.qy) < BRIDGE_MERGE_M)) {
        continue; // 같은 곳으로 가는 다리는 하나만.
      }
      // 근처에 이미 놓인 다리(출발점까지 그래프 거리 + 다리 + 착지점 간 거리)로 충분하면 생략.
      let covered = false;
      for (let dx = -1; dx <= 1 && !covered; dx += 1) {
        for (let dy = -1; dy <= 1 && !covered; dy += 1) {
          const bucket = bridgeCells.get(cellKey(ccx + dx, ccy + dy));
          if (!bucket) {
            continue;
          }
          for (const bi of bucket) {
            const br = bridges[bi] as Bridge;
            const gap = Math.hypot((bridgeQx[bi] as number) - c.qx, (bridgeQy[bi] as number) - c.qy);
            if (gap > BRIDGE_M) {
              continue;
            }
            if (graphDist(br.v) + br.d * BRIDGE_PENALTY + gap <= 2 * c.d + 15) {
              covered = true;
              break;
            }
          }
        }
      }
      if (covered) {
        continue;
      }
      if (c.d > BRIDGE_UNCHECKED_M && !bridgeOnPurple(vx, vy, c.qx, c.qy, c.d)) {
        continue;
      }
      accepted.push({ qx: c.qx, qy: c.qy });
      const bi = bridges.length;
      bridges.push({ v, s: c.s, t: c.t, d: c.d });
      bridgeQx.push(c.qx);
      bridgeQy.push(c.qy);
      const bkey = cellKey(ccx, ccy);
      const bbucket = bridgeCells.get(bkey);
      if (bbucket) {
        bbucket.push(bi);
      } else {
        bridgeCells.set(bkey, [bi]);
      }
    }
  }
  if (bridges.length === 0) {
    return;
  }
  // 선분별 분할점 노드 생성 (가까운 분할점은 병합, 끝점 근처는 끝점 사용).
  const bySeg = new Map<number, Bridge[]>();
  for (const br of bridges) {
    const list = bySeg.get(br.s);
    if (list) {
      list.push(br);
    } else {
      bySeg.set(br.s, [br]);
    }
  }
  const addEdge = (a: number, b: number, w: number): void => {
    if (a === b) {
      return;
    }
    const list = adj[a] as Array<{ to: number; w: number }>;
    const existing = list.find((e) => e.to === b);
    if (existing) {
      if (w < existing.w) {
        existing.w = w;
        const back = (adj[b] as Array<{ to: number; w: number }>).find((e) => e.to === a);
        if (back) {
          back.w = w;
        }
      }
      return;
    }
    list.push({ to: b, w });
    (adj[b] as Array<{ to: number; w: number }>).push({ to: a, w });
  };
  const removeEdge = (a: number, b: number): void => {
    adj[a] = (adj[a] as Array<{ to: number; w: number }>).filter((e) => e.to !== b);
    adj[b] = (adj[b] as Array<{ to: number; w: number }>).filter((e) => e.to !== a);
  };
  for (const [s, list] of bySeg) {
    const a = segA[s] as number;
    const b = segB[s] as number;
    const ax = px[a] as number;
    const ay = py[a] as number;
    const len = Math.hypot((px[b] as number) - ax, (py[b] as number) - ay);
    list.sort((x, y) => x.t - y.t);
    // 분할점 노드 결정.
    const stops: Array<{ t: number; node: number }> = [{ t: 0, node: a }];
    const targetOf = new Map<Bridge, number>();
    for (const br of list) {
      const last = stops[stops.length - 1] as { t: number; node: number };
      if ((br.t - last.t) * len < BRIDGE_MERGE_M) {
        targetOf.set(br, last.node);
        continue;
      }
      if ((1 - br.t) * len < BRIDGE_MERGE_M) {
        targetOf.set(br, b);
        continue;
      }
      const lon = (repCoords[a * 2] as number) + ((repCoords[b * 2] as number) - (repCoords[a * 2] as number)) * br.t;
      const lat = (repCoords[a * 2 + 1] as number) + ((repCoords[b * 2 + 1] as number) - (repCoords[a * 2 + 1] as number)) * br.t;
      const node = repCoords.length / 2;
      repCoords.push(lon, lat);
      adj.push([]);
      stops.push({ t: br.t, node });
      targetOf.set(br, node);
    }
    if (stops.length > 1) {
      // 원 선분 a–b를 a–p1–…–b로 교체한다.
      removeEdge(a, b);
      stops.push({ t: 1, node: b });
      for (let k = 1; k < stops.length; k += 1) {
        const p = stops[k - 1] as { t: number; node: number };
        const q = stops[k] as { t: number; node: number };
        addEdge(p.node, q.node, (q.t - p.t) * len);
      }
    }
    for (const br of list) {
      addEdge(br.v, targetOf.get(br) as number, br.d * BRIDGE_PENALTY);
    }
  }
};

/**
 * 로드된 그래프들을 합쳐 A* 탐색한다. 실패 시 null (호출자가 격자 A*로 폴백).
 * snapMaxM: 출발/도착 스냅 허용 거리.
 */
/** 로드된 그래프들을 스티칭해 탐색 구조로 만든다 (무거움, 캐시 대상). */
const buildStitchedGraph = (loaded: GraphData[], isWalkable?: WalkableCheck): StitchedGraph | null => {
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
    // 보라색(도로 15m 버퍼) 연결 반영: 화면에서 이어져 보이는 곳을 그래프도 잇는다.
    // 노드 v에서 BRIDGE_M 이내의 다른 도로 구간(선분 위 최근접점 p)이 있는데
    // 그래프로는 가까이 닿지 않으면(우회 > 2d+15m) v–p 다리 간선을 추가한다.
    // d ≤ 28m 다리는 모든 점이 양끝 중 하나에서 14m 이내 → 15m 버퍼(보라색) 안에 있다.
    // p가 선분 중간이면 그 선분을 분할해 새 노드를 만든다.
    addPurpleBridges(repCoords, adj, kx, KY, isWalkable);
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
  isWalkable?: WalkableCheck,
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
    const built = buildStitchedGraph(loaded, isWalkable);
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
