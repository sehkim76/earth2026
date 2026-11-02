// 구움 윤곽 Bake (빌드타임 1회).
// 입력: public/walkable/raster/*.json (구움 래스터)
// 출력: 같은 파일에 타일별 윤곽("o") 추가 — {"col,row": base64(varint runs)}
//  - 인접 타일 halo를 포함한 전체 데이터 기준으로 trace하므로 타일 경계에 이음매가 없다.
//  - 런타임은 멤버 run을 이어붙이기만 하면 된다 (윤곽 빌드 0ms).
//  - 증분 갱신: "o"가 있고 raster 본문(mtime 기준)이 변하지 않았으면 건너뛴다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildWalkableContours } = require("/tmp/routetest/wc-contours.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RASTER_DIR = join(ROOT, "public", "walkable", "raster");
const TILE = 800;

const only = new Set(process.argv.slice(2));

const files = (await import("node:fs")).readdirSync(RASTER_DIR).filter((f) => f.endsWith(".json"));
const targets = only.size > 0 ? files.filter((f) => only.has(f.slice(0, -5))) : files;

// 1단계: 전역 타일 -> 보유 동 목록 (halo 조회용).
const tileOwners = new Map();
for (const f of files) {
  const dongId = f.slice(0, -5);
  const data = JSON.parse(readFileSync(join(RASTER_DIR, f), "utf8"));
  for (const t of data.tiles ?? []) {
    const key = `${t.c[0]},${t.c[1]}`;
    let owners = tileOwners.get(key);
    if (!owners) {
      owners = [];
      tileOwners.set(key, owners);
    }
    owners.push(dongId);
  }
}

const rasterCache = new Map();
const getRaster = (dongId) => {
  let hit = rasterCache.get(dongId);
  if (!hit) {
    const p = join(RASTER_DIR, `${dongId}.json`);
    if (!existsSync(p)) return null;
    hit = JSON.parse(readFileSync(p, "utf8"));
    rasterCache.set(dongId, hit);
    if (rasterCache.size > 120) {
      const oldest = rasterCache.keys().next();
      if (!oldest.done) rasterCache.delete(oldest.value);
    }
  }
  return hit;
};

const decodeFilled = (b64) => {
  const raw = inflateSync(Buffer.from(b64, "base64"));
  const filled = new Uint8Array(TILE * TILE);
  for (let i = 0; i < raw.length; i += 1) {
    const b = raw[i];
    if (!b) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if (b & (1 << (7 - bit))) {
        const idx = i * 8 + bit;
        if (idx < filled.length) filled[idx] = 1;
      }
    }
  }
  return filled;
};

const tileMapOf = (data) => {
  const m = new Map();
  for (const t of data.tiles ?? []) m.set(`${t.c[0]},${t.c[1]}`, t);
  return m;
};

// zigzag varint encode
const encodeVarints = (nums) => {
  const bytes = [];
  for (const n of nums) {
    let v = (n << 1) ^ (n >> 31);
    v >>>= 0;
    while (v >= 128) {
      bytes.push((v & 127) | 128);
      v = Math.floor(v / 128);
    }
    bytes.push(v);
  }
  return Buffer.from(bytes).toString("base64");
};

let done = 0, skipped = 0;
for (const f of targets) {
  const dongId = f.slice(0, -5);
  const data = getRaster(dongId);
  if (!data || !Array.isArray(data.tiles) || data.tiles.length === 0) {
    skipped += 1;
    continue;
  }
  if (data.oBaked === 1 && data.tiles.every((t) => t.o !== undefined)) {
    skipped += 1;
    continue;
  }
  const ownMap = tileMapOf(data);
  // halo 포함 입력 타일 수집 (자신 + 주변 8칸).
  const inputByKey = new Map();
  const need = new Set();
  for (const t of data.tiles) {
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        need.add(`${t.c[0] + dc},${t.c[1] + dr}`);
      }
    }
  }
  for (const key of need) {
    if (inputByKey.has(key)) continue;
    const [col, row] = key.split(",").map(Number);
    const owners = tileOwners.get(key) ?? [];
    let filled = null;
    for (const owner of owners) {
      const r = getRaster(owner);
      const entry = r ? tileMapOf(r).get(key) : undefined;
      if (entry) {
        const cur = decodeFilled(entry.f);
        if (!filled) {
          filled = cur;
        } else {
          for (let i = 0; i < filled.length; i += 1) filled[i] |= cur[i];
        }
      }
    }
    if (filled) {
      inputByKey.set(key, { tileColumn: col, tileRow: row, nx: TILE, ny: TILE, filled });
    }
  }
  const contours = buildWalkableContours([...inputByKey.values()], TILE);
  // 타일별 run으로 분할 (1셀 겹침 — 이음매 seamless).
  const runsByTile = new Map();
  for (const t of data.tiles) {
    const key = `${t.c[0]},${t.c[1]}`;
    const x0 = t.c[0] * TILE, y0 = t.c[1] * TILE;
    runsByTile.set(key, []);
  }
  for (const c of contours) {
    const pts = c.points;
    // 어느 타일에 닿는지 먼저 판정.
    const touched = new Set();
    for (const [x, y] of pts) {
      const tc = Math.floor(x / TILE), tr = Math.floor(y / TILE);
      touched.add(`${tc},${tr}`);
    }
    for (const key of touched) {
      const runs = runsByTile.get(key);
      if (!runs) continue;
      const [tc, tr] = key.split(",").map(Number);
      const x0 = tc * TILE, y0 = tr * TILE;
      let run = [];
      const flush = () => {
        if (run.length >= 2) runs.push(run);
        run = [];
      };
      const n = pts.length;
      for (let i = 0; i <= n; i += 1) {
        const p = pts[i % n];
        const inside = p[0] >= x0 - 1 && p[0] <= x0 + TILE + 1 && p[1] >= y0 - 1 && p[1] <= y0 + TILE + 1;
        if (inside) run.push(p);
        else flush();
      }
      flush();
    }
  }
  for (const t of data.tiles) {
    const key = `${t.c[0]},${t.c[1]}`;
    const runs = runsByTile.get(key) ?? [];
    if (runs.length === 0) {
      t.o = "";
      continue;
    }
    const nums = [runs.length];
    for (const run of runs) {
      nums.push(run.length);
      let px = 0, py = 0;
      for (const [x, y] of run) {
        nums.push(x - px, y - py);
        px = x; py = y;
      }
    }
    t.o = encodeVarints(nums);
  }
  data.oBaked = 1;
  // 원본과 동일한 compact 포맷 (base64에는 공백·콜론이 없어 안전).
  const compact = JSON.stringify(data).replace(/": /g, '":').replace(/, /g, ",");
  writeFileSync(join(RASTER_DIR, f), compact);
  rasterCache.delete(dongId);
  done += 1;
  if (done % 200 === 0) console.log(`  ${done}/${targets.length} dongs`);
}
console.log(`done: baked=${done} skipped=${skipped}`);
