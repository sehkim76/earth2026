#!/usr/bin/env python3
"""동별 이동가능 래스터 베이크 (빌드타임 1회, 평소 빌드와 무관).

입력 : public/walkable/roads/{dongId}.json + public/walkable/index.json
출력 : public/walkable/raster/{dongId}.json
  {"v":1,"tiles":[{"c":[col,row],"b":[w,s,e,n],"f":"base64(zlib bitpack)"}]}
  - 타일 배치·스탬프는 walkable-client.ts rasterizeToGrid/rasterizeTile과 동일해야 한다.
  - 비트팩: 셀(y*nx+x) 순서 MSB-first, zlib 래퍼 압축 (DecompressionStream "deflate" 규격).
  - 증분 갱신: 출력이 입력보다 새로우면 건너뛴다. roads 데이터 변경 시에만 실행.
"""
import base64
import json
import math
import os
import sys
import zlib

GRID_CELL_M = 5
GRID_TILE_CELLS = 800
GRID_REFERENCE_LAT = 36
WALKABLE_BUFFER_M = 15

ROADS_DIR = os.path.join("public", "walkable", "roads")
INDEX_PATH = os.path.join("public", "walkable", "index.json")
RASTER_DIR = os.path.join("public", "walkable", "raster")


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


def js_floor(x: float) -> int:
    return math.floor(x)


def js_ceil(x: float) -> int:
    return math.ceil(x)


def rasterize(lines, west, south, east, north, ref_lat):
    kx = 111320 * math.cos(ref_lat * math.pi / 180)
    cell_lon = GRID_CELL_M / kx
    cell_lat = GRID_CELL_M / 110540
    # TS와 동일한 결합 순서 ((x * 800) * cell) 를 유지한다 (1ulp 오차 방지).
    tile_span_lon = GRID_TILE_CELLS * cell_lon
    tile_span_lat = GRID_TILE_CELLS * cell_lat
    first_column = js_floor(west / tile_span_lon)
    first_row = js_floor(south / tile_span_lat)
    west = (first_column * GRID_TILE_CELLS) * cell_lon
    south = (first_row * GRID_TILE_CELLS) * cell_lat
    nx = max(1, js_ceil((east - west) / cell_lon))
    ny = max(1, js_ceil((north - south) / cell_lat))
    tile_columns = js_ceil(nx / GRID_TILE_CELLS)
    tile_rows = js_ceil(ny / GRID_TILE_CELLS)
    radius = js_ceil(WALKABLE_BUFFER_M / GRID_CELL_M)
    radius_cells = radius
    occupied = set()
    for line in lines:
        for i in range(1, len(line)):
            x1 = js_floor((line[i - 1][0] - west) / cell_lon)
            y1 = js_floor((line[i - 1][1] - south) / cell_lat)
            x2 = js_floor((line[i][0] - west) / cell_lon)
            y2 = js_floor((line[i][1] - south) / cell_lat)
            min_column = max(0, js_floor((min(x1, x2) - radius) / GRID_TILE_CELLS))
            max_column = min(tile_columns - 1, js_floor((max(x1, x2) + radius) / GRID_TILE_CELLS))
            min_row = max(0, js_floor((min(y1, y2) - radius) / GRID_TILE_CELLS))
            max_row = min(tile_rows - 1, js_floor((max(y1, y2) + radius) / GRID_TILE_CELLS))
            for column in range(min_column, max_column + 1):
                for row in range(min_row, max_row + 1):
                    occupied.add((column, row))
    tiles = []
    for column, row in sorted(occupied):
        global_column = first_column + column
        global_row = first_row + row
        tile_west = (global_column * GRID_TILE_CELLS) * cell_lon
        tile_south = (global_row * GRID_TILE_CELLS) * cell_lat
        tile_east = tile_west + tile_span_lon
        tile_north = tile_south + tile_span_lat
        filled = bytearray(GRID_TILE_CELLS * GRID_TILE_CELLS)
        for line in lines:
            for i in range(1, len(line)):
                lon1, lat1 = line[i - 1]
                lon2, lat2 = line[i]
                if (
                    max(lon1, lon2) < tile_west - WALKABLE_BUFFER_M / kx
                    or min(lon1, lon2) > tile_east + WALKABLE_BUFFER_M / kx
                    or max(lat1, lat2) < tile_south - WALKABLE_BUFFER_M / 110540
                    or min(lat1, lat2) > tile_north + WALKABLE_BUFFER_M / 110540
                ):
                    continue
                ix1 = js_floor((lon1 - tile_west) / cell_lon)
                iy1 = js_floor((lat1 - tile_south) / cell_lat)
                ix2 = js_floor((lon2 - tile_west) / cell_lon)
                iy2 = js_floor((lat2 - tile_south) / cell_lat)
                steps = max(abs(ix2 - ix1), abs(iy2 - iy1), 1)
                for s in range(steps + 1):
                    cx = js_round(ix1 + (ix2 - ix1) * s / steps)
                    cy = js_round(iy1 + (iy2 - iy1) * s / steps)
                    for dx in range(-radius_cells, radius_cells + 1):
                        for dy in range(-radius_cells, radius_cells + 1):
                            if dx * dx + dy * dy > radius_cells * radius_cells:
                                continue
                            ix = cx + dx
                            iy = cy + dy
                            if 0 <= ix < GRID_TILE_CELLS and 0 <= iy < GRID_TILE_CELLS:
                                filled[iy * GRID_TILE_CELLS + ix] = 1
        tiles.append(((global_column, global_row), (tile_west, tile_south, tile_east, tile_north), filled))
    return tiles, (cell_lon, cell_lat)


def pack_bits(filled) -> bytes:
    import numpy as np

    packed = np.packbits(np.asarray(filled, dtype=np.uint8))
    # DecompressionStream("deflate") 규격 = zlib 래퍼
    return zlib.compress(packed.tobytes(), 9)


def build_one(dong_id, roads, bbox) -> dict:
    kx = 111320 * math.cos(GRID_REFERENCE_LAT * math.pi / 180)
    tiles, _ = rasterize(
        roads,
        bbox[0] - 30 / kx,
        bbox[1] - 30 / 110540,
        bbox[2] + 30 / kx,
        bbox[3] + 30 / 110540,
        GRID_REFERENCE_LAT,
    )
    packed_tiles = []
    for (col, row), bounds, filled in tiles:
        packed_tiles.append(
            {
                "c": [col, row],
                "b": list(bounds),
                "f": base64.b64encode(pack_bits(filled)).decode("ascii"),
            }
        )
    return {"v": 1, "tiles": packed_tiles}


def build_dong(args) -> tuple:
    """워커: (dong_id, roads, bbox) -> (dong_id, output dict)."""
    dong_id, roads, bbox = args
    return dong_id, build_one(dong_id, roads, bbox)


def main(only=None, workers: int = 12) -> None:
    with open(INDEX_PATH, encoding="utf-8") as f:
        index = json.load(f)
    files = sorted(f for f in os.listdir(ROADS_DIR) if f.endswith(".json"))
    if only:
        files = [f for f in files if f[:-5] in only]
    os.makedirs(RASTER_DIR, exist_ok=True)
    # 증분 갱신: 출력이 입력보다 새로우면 건너뛴다. 평소 빌드에서는 실행하지 않는다.
    tasks: list = []
    skipped = 0
    for name in files:
        dong_id = name[:-5]
        src = os.path.join(ROADS_DIR, name)
        dst = os.path.join(RASTER_DIR, name)
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            skipped += 1
            continue
        with open(src, encoding="utf-8") as f:
            data = json.load(f)
        roads = data.get("roads", data) if isinstance(data, dict) else data
        bbox = index.get(dong_id)
        if not bbox or not roads:
            skipped += 1
            continue
        tasks.append((dong_id, roads, bbox))
    if not tasks:
        print(f"done: built=0 skipped={skipped}")
        return
    from concurrent.futures import ProcessPoolExecutor

    done = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for dong_id, out in pool.map(build_dong, tasks):
            with open(os.path.join(RASTER_DIR, f"{dong_id}.json"), "w", encoding="utf-8") as f:
                json.dump(out, f, separators=(",", ":"))
            done += 1
            if done % 500 == 0:
                print(f"  {done}/{len(tasks)} dongs", flush=True)
    print(f"done: built={done} skipped={skipped}")


if __name__ == "__main__":
    main(set(sys.argv[1:]) or None)
