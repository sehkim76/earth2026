#!/usr/bin/env node
/**
 * 고해상도 동 경계 교체 후 기존 성의 소속 동(meta.dong)이 새 경계와 맞는지 점검 (읽기 전용).
 *
 * 입력 : 성 목록 JSON 파일 — [{ "EventKey", "location", "string_param1" }, ...]
 *   예) psql "$DATABASE_URL" -At -c "
 *         SELECT json_agg(t) FROM (
 *           SELECT e.\"EventKey\", g.location, e.string_param1
 *           FROM \"ARMissionEvent\" e
 *           JOIN \"ARMissionGPS\" g ON g.\"EventKey\" = e.\"EventKey\" AND g.\"ARMissionKey\" = e.\"ARMissionKey\"
 *           WHERE e.\"EventKey\" LIKE 'castle-%') t" > castles.json
 * 사용 : node scripts/check-castle-dongs.mjs castles.json
 * 출력 : 새 경계 기준으로 다른 동(또는 어느 동에도 없음)에 놓인 성 목록과 구/신 경계 판정 비교.
 */
import { readFileSync } from "node:fs";
import { feature } from "topojson-client";

const loadDongs = (file) => {
  const topo = JSON.parse(readFileSync(file, "utf-8"));
  return feature(topo, topo.objects.collection).features.map((f) => ({
    id: f.properties.shapeID,
    name: f.properties.shapeName,
    polys: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
  }));
};

const inRing = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

const dongAt = (dongs, lon, lat) => {
  for (const d of dongs) {
    let inside = false;
    for (const poly of d.polys) {
      if (inRing(poly[0], lon, lat)) {
        inside = !inside;
      }
    }
    if (inside) {
      return d;
    }
  }
  return null;
};

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/check-castle-dongs.mjs <castles.json>");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(input, "utf-8")) ?? [];
const oldDongs = loadDongs("public/boundaries/kor_dong.topojson");
const newDongs = loadDongs("public/boundaries/kor_dong_hd.topojson");

let checked = 0;
const mismatches = [];
for (const row of rows) {
  let meta = null;
  try {
    meta = JSON.parse(row.string_param1 ?? "");
  } catch {}
  const nums = String(row.location ?? "").match(/-?\d+(?:\.\d+)?/g);
  if (!meta || typeof meta.dong !== "string" || !nums || nums.length < 2) {
    continue;
  }
  const lat = Number(nums[0]);
  const lon = Number(nums[1]);
  checked += 1;
  const hd = dongAt(newDongs, lon, lat);
  if (hd?.id === meta.dong) {
    continue;
  }
  const old = dongAt(oldDongs, lon, lat);
  mismatches.push({
    castle: row.EventKey,
    lat,
    lon,
    metaDong: meta.dong,
    oldBoundary: old ? `${old.id} (${old.name})` : null,
    newBoundary: hd ? `${hd.id} (${hd.name})` : null,
  });
}

console.log(`checked=${checked} mismatches=${mismatches.length}`);
for (const m of mismatches) {
  console.log(JSON.stringify(m));
}
