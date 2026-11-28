"""Intersect baked road shoulders with South Korea OSM woodland areas.

Run after bake-resource-roadsides.py with a Geofabrik South Korea .osm.pbf.
Requires pyosmium and Shapely 2. The output records exact quantised sites, so
changing a roadside candidate can never transfer woodland status to a new point.
"""
import base64
import json
import sys
from collections import defaultdict
from pathlib import Path

import osmium
import shapely

ROOT = Path(__file__).resolve().parents[1]
ROADSIDES = ROOT / "src/lib/resource-roadsides"
BLOCK = 32
CELL_LON, CELL_LAT = 0.0125, 0.01


def roadside_sites():
    for row in json.loads((ROADSIDES / "bands.json").read_text()):
        for col, encoded in json.loads((ROADSIDES / f"{row}.json").read_text()).items():
            data = memoryview(base64.b64decode(encoded))
            offset = 0
            while offset < len(data):
                cell = int.from_bytes(data[offset:offset + 2], "little")
                count = data[offset + 2]
                offset += 3
                for _ in range(count):
                    x, y = data[offset:offset + 2]
                    offset += 2
                    lon = (int(col) * BLOCK + cell % BLOCK + (x + 0.5) / 256) * CELL_LON
                    lat = (row * BLOCK + cell // BLOCK + (y + 0.5) / 256) * CELL_LAT
                    yield (lon, lat), (f"{col}:{row}", (cell << 16) | (y << 8) | x)


def main(pbf):
    coords, sites = zip(*roadside_sites())
    index = shapely.STRtree(shapely.points(coords))
    woodland = set()
    tags = osmium.filter.TagFilter(("natural", "wood"), ("landuse", "forest"))
    processor = osmium.FileProcessor(pbf).with_locations().with_areas(tags)
    factory = osmium.geom.WKBFactory()
    for area in processor.with_filter(osmium.filter.EntityFilter(osmium.osm.AREA)).with_filter(tags):
        try:
            geometry = factory.create_multipolygon(area)
        except RuntimeError as error:
            if "invalid area" not in str(error):
                raise
            print(f"Skipping OSM area {area.id} without a usable outline", file=sys.stderr)
            continue
        polygon = shapely.from_wkb(geometry)
        if not polygon.is_valid:
            polygon = shapely.make_valid(polygon, method="structure", keep_collapsed=False)
        woodland.update(index.query(polygon, predicate="contains"))
    if not woodland:
        raise ValueError("No wooded roadside sites found")

    blocks = defaultdict(bytearray)
    for i in sorted(woodland):
        block, site = sites[i]
        blocks[block].extend(site.to_bytes(4, "little"))
    output = {
        "source": "© OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "attributionUrl": "https://www.openstreetmap.org/copyright",
        "timestamp": processor.header.get("osmosis_replication_timestamp"),
        "blocks": {key: base64.b64encode(data).decode("ascii") for key, data in blocks.items()},
    }
    (ROOT / "public/map-assets/wooded-roadsides.json").write_text(json.dumps(output, indent=1) + "\n")
    print(f"{len(woodland):,} of {len(sites):,} roadside sites inside woodland")


if __name__ == "__main__":
    main(sys.argv[1])
