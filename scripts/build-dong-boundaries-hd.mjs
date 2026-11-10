#!/usr/bin/env node
/**
 * 한국 읍면동 고해상도 경계 베이크 (빌드타임 1회, 평소 빌드와 무관).
 *
 * 입력 : geoBoundaries gbOpen KOR ADM3 고해상도 GeoJSON (릴리스 KOR-ADM3-71637012)
 *        https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/KOR/ADM3/geoBoundaries-KOR-ADM3.geojson
 *        기존 kor_dong.topojson(단순화본)과 shapeID가 동일하므로 DB·walkable 데이터 키가 그대로 유지된다.
 * 출력 : public/boundaries/kor_dong_hd.topojson          (전국 단일 파일, 서버 동 판정용)
 *        public/boundaries/kor_dong_hd/{tileId}.topojson (그리드 타일, 클라이언트 뷰포트 로딩용)
 *        public/boundaries/kor_dong_hd/index.json        ({ v, tileDeg, tiles: { [tileId]: { b: [w,s,e,n], n } } })
 *
 * 사용 : node scripts/build-dong-boundaries-hd.mjs <input.geojson> [minWeight] [--dry]
 *   minWeight : Visvalingam 유효면적 임계값 (deg², 기본 1e-8 ≈ 100m² ≈ 오차 수 m)
 *   --dry     : 파일을 쓰지 않고 통계만 출력
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { topology } from "topojson-server";
import { presimplify, simplify } from "topojson-simplify";
import { feature } from "topojson-client";

const QUANTIZATION = 1e6;
/** 타일 한 변 (도). 동은 bbox 중심이 속한 타일 하나에만 들어간다. */
const TILE_DEG = 0.2;
const KEEP_PROPS = ["shapeName", "shapeISO", "shapeID", "shapeGroup", "shapeType"];

const OUT_DIR = path.join("public", "boundaries");
const HD_FILE = path.join(OUT_DIR, "kor_dong_hd.topojson");
const TILE_DIR = path.join(OUT_DIR, "kor_dong_hd");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const positional = args.filter((a) => !a.startsWith("--"));
const inputPath = positional[0];
const minWeight = positional[1] !== undefined ? Number(positional[1]) : 1e-8;
if (!inputPath || !Number.isFinite(minWeight)) {
  console.error("usage: node scripts/build-dong-boundaries-hd.mjs <input.geojson> [minWeight] [--dry]");
  process.exit(1);
}

const countPoints = (geometry) => {
  if (!geometry) return 0;
  if (geometry.type === "Polygon") return geometry.coordinates.reduce((s, r) => s + r.length, 0);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
  }
  return 0;
};

const bboxOf = (geometry) => {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
    }
  }
  return [w, s, e, n];
};

const round6 = (v) => Math.round(v * 1e6) / 1e6;

const source = JSON.parse(readFileSync(inputPath, "utf-8"));
const inputFeatures = source.features.map((f) => {
  const props = {};
  for (const key of KEEP_PROPS) {
    if (f.properties && f.properties[key] !== undefined) props[key] = f.properties[key];
  }
  return { type: "Feature", properties: props, geometry: f.geometry };
});
const inputPts = inputFeatures.reduce((s, f) => s + countPoints(f.geometry), 0);

// 전국을 한 위상으로 묶어 단순화 → 이웃 동의 공유 경계가 똑같이 줄어 틈/겹침이 없다.
const whole = simplify(
  presimplify(topology({ collection: { type: "FeatureCollection", features: inputFeatures } }, QUANTIZATION)),
  minWeight,
);
const simplifiedFc = feature(whole, whole.objects.collection);
const outPts = simplifiedFc.features.reduce((s, f) => s + countPoints(f.geometry), 0);

// 서버용 단일 파일은 기존 kor_dong.topojson과 같은 형식(object "collection", transform, delta arcs).
const wholeOut = topology({ collection: simplifiedFc }, QUANTIZATION);
const wholeJson = JSON.stringify(wholeOut);

// 타일 분할
const tiles = new Map();
for (const f of simplifiedFc.features) {
  if (!f.geometry) continue;
  const b = bboxOf(f.geometry);
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const id = `${Math.floor(cx / TILE_DEG)}_${Math.floor(cy / TILE_DEG)}`;
  let tile = tiles.get(id);
  if (!tile) {
    tile = { features: [], b: [Infinity, Infinity, -Infinity, -Infinity] };
    tiles.set(id, tile);
  }
  tile.features.push(f);
  tile.b = [Math.min(tile.b[0], b[0]), Math.min(tile.b[1], b[1]), Math.max(tile.b[2], b[2]), Math.max(tile.b[3], b[3])];
}

const index = { v: 1, tileDeg: TILE_DEG, minWeight, tiles: {} };
const tileOutputs = [];
let tileBytes = 0;
let tileGzBytes = 0;
let maxTileGz = 0;
for (const [id, tile] of [...tiles.entries()].sort()) {
  const json = JSON.stringify(topology({ collection: { type: "FeatureCollection", features: tile.features } }, QUANTIZATION));
  const gz = gzipSync(json, { level: 9 }).length;
  tileBytes += json.length;
  tileGzBytes += gz;
  maxTileGz = Math.max(maxTileGz, gz);
  index.tiles[id] = { b: tile.b.map(round6), n: tile.features.length };
  tileOutputs.push([id, json]);
}

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(`minWeight=${minWeight}`);
console.log(`features=${simplifiedFc.features.length} points ${inputPts} -> ${outPts} (${((outPts / inputPts) * 100).toFixed(1)}%)`);
console.log(`whole: ${kb(wholeJson.length)} (gzip ${kb(gzipSync(wholeJson, { level: 9 }).length)})`);
console.log(`tiles=${tiles.size} total ${kb(tileBytes)} (gzip ${kb(tileGzBytes)}), max tile gzip ${kb(maxTileGz)}`);

if (!dry) {
  writeFileSync(HD_FILE, wholeJson);
  rmSync(TILE_DIR, { recursive: true, force: true });
  mkdirSync(TILE_DIR, { recursive: true });
  for (const [id, json] of tileOutputs) {
    writeFileSync(path.join(TILE_DIR, `${id}.topojson`), json);
  }
  writeFileSync(path.join(TILE_DIR, "index.json"), JSON.stringify(index));
  console.log(`wrote ${HD_FILE}, ${TILE_DIR}/ (${tileOutputs.length} tiles + index.json)`);
}
