"""Bake compact roadside resource locations from the same roads used to build worker routes."""
import base64
import json
import math
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[1]
CELL_LON, CELL_LAT = 0.0125, 0.01
SHOULDER_M = 14
BLOCK = 32


def main():
    cells = {}
    for path in sorted((ROOT / "public/walkable/roads").glob("*.json")):
        for line in json.loads(path.read_bytes())["roads"]:
            if len(line) < 2:
                continue
            # A vertex is also a worker graph node. Use its segment normal to step to the verge.
            for i, (lon, lat) in enumerate(line):
                other_lon, other_lat = line[i + 1 if i + 1 < len(line) else i - 1]
                metres_lon = 111320 * math.cos(math.radians(lat))
                dx, dy = (other_lon - lon) * metres_lon, (other_lat - lat) * 110540
                length = math.hypot(dx, dy)
                if length < 1:
                    continue
                x = (lon - SHOULDER_M * dy / length / metres_lon) / CELL_LON
                y = (lat + SHOULDER_M * dx / length / 110540) / CELL_LAT
                cx, cy = math.floor(x), math.floor(y)
                # Store the centre of a 1/256 cell bin (within ~3.3 m of the candidate).
                bx, by = int((x - cx) * 256), int((y - cy) * 256)
                qx, qy = bx // 128, by // 128
                rank = ((bx - (64 + qx * 128)) ** 2 + (by - (64 + qy * 128)) ** 2, bx, by)
                slots = cells.get((cx, cy))
                if slots is None:
                    slots = cells[(cx, cy)] = [None] * 4
                q = qy * 2 + qx
                if slots[q] is None or rank < slots[q]:
                    slots[q] = rank

    blocks = defaultdict(bytearray)
    for (cx, cy), slots in sorted(cells.items(), key=lambda item: (item[0][1], item[0][0])):
        sites = []
        for slot in slots:
            if slot is None:
                continue
            _, x, y = slot
            if all((x - sx) ** 2 + (y - sy) ** 2 >= 20 ** 2 for sx, sy in sites):
                sites.append((x, y))
        row = blocks[f"{cx // BLOCK}:{cy // BLOCK}"]
        row.extend((cy % BLOCK * BLOCK + cx % BLOCK).to_bytes(2, "little"))
        row.append(len(sites))
        for site in sites:
            row.extend(site)

    bands = defaultdict(dict)
    for key, value in sorted(blocks.items()):
        col, row = key.split(":")
        bands[int(row)][col] = base64.b64encode(value).decode("ascii")
    output = ROOT / "src/lib/resource-roadsides"
    output.mkdir(exist_ok=True)
    for band, data in sorted(bands.items()):
        (output / f"{band}.json").write_text(json.dumps(data, indent=1) + "\n")
    (output / "bands.json").write_text(json.dumps(sorted(bands)) + "\n")
    print(f"{len(cells):,} resource cells in {len(blocks):,} blocks")


if __name__ == "__main__":
    main()
