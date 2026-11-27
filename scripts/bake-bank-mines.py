"""Build the ODbL bank location layer from a Geofabrik South Korea OSM PBF (pyosmium)."""
import json
import sys
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parents[1]
processor = osmium.FileProcessor(sys.argv[1]).with_locations().with_areas()
banks = {}
for obj in processor.with_filter(osmium.filter.TagFilter(("amenity", "bank"))):
    if obj.is_node():
        if not obj.location.valid():
            continue
        key = f"n{obj.id}"
        lon, lat = obj.location.lon, obj.location.lat
    elif obj.is_area():
        key = ("w" if obj.from_way() else "r") + str(obj.orig_id())
        ring = max(obj.outer_rings(), key=len)
        xs = [n.lon for n in ring]
        ys = [n.lat for n in ring]
        lon = (min(xs) + max(xs)) / 2
        lat = (min(ys) + max(ys)) / 2
    else:
        continue
    name = obj.tags.get("name:ko") or obj.tags.get("name") or obj.tags.get("brand") or ""
    if "atm" in name.lower() or "현금자동" in name or ("365" in name and "출장소" not in name):
        continue
    banks[key] = [key, round(lat, 6), round(lon, 6), name]

# Mappers sometimes tag the same branch as both a building and a point.
seen = set()
sites = []
for site in sorted(banks.values()):
    _, lat, lon, name = site
    key = (lat, lon, name)
    if key not in seen:
        sites.append(site)
        seen.add(key)
if not sites:
    raise ValueError("No amenity=bank records found")
output = ROOT / "public/map-assets/bank-mines.json"
with output.open("w") as file:
    file.write('{"source":"© OpenStreetMap contributors","license":"ODbL-1.0","licenseUrl":"https://opendatacommons.org/licenses/odbl/1-0/","attributionUrl":"https://www.openstreetmap.org/copyright",')
    file.write('"timestamp":' + json.dumps(processor.header.get("osmosis_replication_timestamp")) + ',"sites":[\n')
    file.write(",\n".join(json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in sites))
    file.write("\n]}\n")
print(f"{len(sites)} bank locations written to {output}")
