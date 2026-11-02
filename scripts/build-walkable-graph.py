#!/usr/bin/env python3
"""동별 도로망 그래프 빌드 (길찾기 전용 간략 데이터).

입력 : public/walkable/roads/{dongId}.json  {"v":1,"roads":[[[lon,lat],...]]}
출력 : public/walkable/graph/{dongId}.json {"v":1,"n":[[x,y],...],"p":[[i,j,...],...]}
  - n: 노드 좌표 (정수, deg*1e7)
  - p: 체인(연속된 노드 id). 체인 내 인접 노드 = 간선, 가중치 = 실제 구간 길이.

연결성 확보:
  - 좌표 1e-6도(약 0.11m) 양자화로 노드 키를 만들고,
  - 다른 폴리라인의 끝점과 겹치는 내부 정점에서 체인을 분할한다 (T자 교차 연결).
"""
import json
import os
import sys

ROADS_DIR = os.path.join("public", "walkable", "roads")
GRAPH_DIR = os.path.join("public", "walkable", "graph")
QUANT = 1_000_000
STORE = 1_000_000  # 저장 정밀도 (0.11m)


def qkey(lon: float, lat: float) -> tuple:
    return (round(lon * QUANT), round(lat * QUANT))


def morton(x: int, y: int) -> int:
    """16비트 인터리브 (동 bbox 정규화 좌표용)."""
    m = 0
    for i in range(16):
        m |= ((x >> i) & 1) << (2 * i)
        m |= ((y >> i) & 1) << (2 * i + 1)
    return m


def seg_cross(p1, p2, p3, p4):
    """엄격한 내부 교차만 반환한다 (끝점 접촉은 이미 노드). -> (t, u, x, y) | None"""
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if abs(d) < 1e-15:
        return None
    t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 0.0 < t < 1.0 and 0.0 < u < 1.0:
        return (t, u, p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))
    return None


def split_crossings(polys):
    """내부-내부 교차에서 폴리라인을 분할한다. -> 분할된 점열 리스트"""
    segs = []
    for ci, poly in enumerate(polys):
        for si in range(len(poly) - 1):
            segs.append((poly[si][0], poly[si][1], poly[si + 1][0], poly[si + 1][1], ci, si))
    CELL = 0.0003
    cells: dict = {}
    for idx, (x1, y1, x2, y2, _ci, _si) in enumerate(segs):
        cx0 = int(min(x1, x2) / CELL)
        cx1 = int(max(x1, x2) / CELL)
        cy0 = int(min(y1, y2) / CELL)
        cy1 = int(max(y1, y2) / CELL)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                cells.setdefault((cx, cy), []).append(idx)
    splits: dict = {}  # ci -> list of (si, t, x, y)
    done_pairs: set = set()
    for bucket in cells.values():
        n = len(bucket)
        if n < 2:
            continue
        for a in range(n):
            for b in range(a + 1, n):
                ia, ib = bucket[a], bucket[b]
                s1, s2 = segs[ia], segs[ib]
                if s1[4] == s2[4]:
                    if abs(s1[5] - s2[5]) <= 1:
                        continue
                key = (ia, ib) if ia < ib else (ib, ia)
                if key in done_pairs:
                    continue
                done_pairs.add(key)
                if max(min(s1[0], s1[2]), min(s2[0], s2[2])) > min(max(s1[0], s1[2]), max(s2[0], s2[2])):
                    continue
                if max(min(s1[1], s1[3]), min(s2[1], s2[3])) > min(max(s1[1], s1[3]), max(s2[1], s2[3])):
                    continue
                hit = seg_cross((s1[0], s1[1]), (s1[2], s1[3]), (s2[0], s2[1]), (s2[2], s2[3]))
                if not hit:
                    continue
                t, u, x, y = hit
                splits.setdefault(s1[4], []).append((s1[5], t, x, y))
                splits.setdefault(s2[4], []).append((s2[5], u, x, y))
    out = []
    for ci, poly in enumerate(polys):
        sp = splits.get(ci)
        if not sp:
            out.append(poly)
            continue
        by_seg: dict = {}
        for si, t, x, y in sp:
            by_seg.setdefault(si, []).append((t, x, y))
        for v in by_seg.values():
            v.sort(key=lambda r: r[0])
        piece = [poly[0]]
        for si in range(len(poly) - 1):
            for _t, x, y in by_seg.get(si, []):
                piece.append([x, y])
                out.append(piece)
                piece = [[x, y]]
            piece.append(poly[si + 1])
        out.append(piece)
    return out


def main() -> None:
    files = sorted(f for f in os.listdir(ROADS_DIR) if f.endswith(".json"))
    os.makedirs(GRAPH_DIR, exist_ok=True)
    total_nodes = 0
    total_chains = 0
    for fi, name in enumerate(files):
        with open(os.path.join(ROADS_DIR, name), encoding="utf-8") as f:
            data = json.load(f)
        roads = data.get("roads", data) if isinstance(data, dict) else data
        roads = split_crossings(roads)
        endpoints: set = set()
        for line in roads:
            if len(line) >= 2:
                endpoints.add(qkey(line[0][0], line[0][1]))
                endpoints.add(qkey(line[-1][0], line[-1][1]))
        node_id: dict = {}
        nodes: list = []

        def nid(lon: float, lat: float) -> int:
            key = qkey(lon, lat)
            i = node_id.get(key)
            if i is None:
                i = len(nodes)
                node_id[key] = i
                nodes.append([round(lon * STORE), round(lat * STORE)])
            return i

        chains: list = []
        seen_chains: set = set()
        for line in roads:
            if len(line) < 2:
                continue
            cuts = [0]
            for k in range(1, len(line) - 1):
                if qkey(line[k][0], line[k][1]) in endpoints:
                    cuts.append(k)
            cuts.append(len(line) - 1)
            for a, b in zip(cuts, cuts[1:]):
                if b <= a:
                    continue
                chain = tuple(nid(line[k][0], line[k][1]) for k in range(a, b + 1))
                if len(chain) >= 2 and chain not in seen_chains and chain[::-1] not in seen_chains:
                    seen_chains.add(chain)
                    chains.append(list(chain))
        # 노드를 Morton 순서로 재배열하고 좌표를 델타 인코딩한다.
        xs = [p[0] for p in nodes]
        ys = [p[1] for p in nodes]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        span_x = max(1, max_x - min_x)
        span_y = max(1, max_y - min_y)
        order = sorted(
            range(len(nodes)),
            key=lambda i: morton(
                ((nodes[i][0] - min_x) * 65535) // span_x,
                ((nodes[i][1] - min_y) * 65535) // span_y,
            ),
        )
        remap = [0] * len(nodes)
        for new_i, old_i in enumerate(order):
            remap[old_i] = new_i
        packed: list = []
        px, py = 0, 0
        for old_i in order:
            x, y = nodes[old_i]
            packed.append(x - px)
            packed.append(y - py)
            px, py = x, y
        remapped_chains = [[remap[i] for i in chain] for chain in chains]
        out = {"v": 2, "n": packed, "p": remapped_chains}
        with open(os.path.join(GRAPH_DIR, name), "w", encoding="utf-8") as f:
            json.dump(out, f, separators=(",", ":"))
        total_nodes += len(nodes)
        total_chains += len(chains)
        if (fi + 1) % 500 == 0:
            print(f"  {fi + 1}/{len(files)} dongs", flush=True)
    print(f"done: {len(files)} dongs, nodes={total_nodes}, chains={total_chains}")


if __name__ == "__main__":
    sys.exit(main())
