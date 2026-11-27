// 성 안 3D 장면 모델 (조선 건축 양식, 절차적 저폴리).
// 기와지붕(처마 곡선·추녀 솟음)·초가지붕·기단·주칠 기둥·단청 띠·문살을 조합해 건물을 만든다.
// 정적인 부분은 재질별로 합쳐(bake) 그리기 호출을 줄이고, 깃발·불빛 같은 움직이는 부분만 따로 둔다.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { BuildingKey } from "@/lib/city";

// ───────── 재질 ─────────

const MAT_COLORS = {
  tile: 0x56616b,
  tileUnder: 0x2f7d6a,
  ridge: 0xd8d2c4,
  plaster: 0xf1eadb,
  mud: 0xc9ae7c,
  wood: 0x7a4a2a,
  woodDark: 0x4d2d18,
  plank: 0x9a6a3e,
  pillar: 0x9a3322,
  lintel: 0x2f7d6a,
  bracket: 0x3f6f8f,
  stone: 0xb3aa98,
  stoneLight: 0xd3cbb8,
  stoneDark: 0x857d6e,
  wallStone: 0xbfb49d,
  thatch: 0xcfa75a,
  thatchDark: 0x9c7a3a,
  earth: 0xb99a6a,
  dirt: 0xcdb084,
  road: 0xd9c49a,
  grass: 0x86b553,
  pine: 0x3d6e3c,
  leaf: 0x6da64a,
  trunk: 0x6b4a32,
  gold: 0xe0b23c,
  iron: 0x55585e,
  charcoal: 0x2a2624,
  ore: 0x8a5a44,
  rock: 0x9c968c,
  water: 0x5aa6c4,
  hay: 0xdcc072,
  horse: 0x7b4f30,
  horseDark: 0x3a2618,
  jar: 0x5a3422,
  dark: 0x1e1a17,
  lattice: 0xffffff,
  target: 0xffffff,
  mountain: 0x6f8f62,
  lotus: 0x4f8f45,
  red: 0xb8322a,
} as const;

export type MatKey = keyof typeof MAT_COLORS | "flagRed" | "flagBlue" | "flagYellow" | "flagGreen" | "flagWhite" | "fire" | "orb";
export type Mats = Record<MatKey, THREE.Material>;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  if (g) draw(g);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 4;
  return t;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseTex(base: string, spots: string[], n: number, size = 128): THREE.CanvasTexture {
  const r = rng(n);
  return canvasTex(size, size, (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < n; i++) {
      g.fillStyle = spots[i % spots.length];
      g.globalAlpha = 0.35 + r() * 0.4;
      const x = r() * size;
      const y = r() * size;
      const s = 1 + r() * 3;
      g.fillRect(x, y, s, s * (0.5 + r()));
    }
    g.globalAlpha = 1;
  });
}

export interface SceneTextures {
  grass: THREE.CanvasTexture;
  road: THREE.CanvasTexture;
  smoke: THREE.CanvasTexture;
  all: THREE.Texture[];
}

export function createMaterials(): { mats: Mats; tex: SceneTextures } {
  const all: THREE.Texture[] = [];
  const keep = <T extends THREE.Texture>(t: T): T => {
    all.push(t);
    return t;
  };
  // 기와: 골이 진 세로줄
  const tileTex = keep(
    canvasTex(32, 32, (g) => {
      g.fillStyle = "#65717b";
      g.fillRect(0, 0, 32, 32);
      g.fillStyle = "#3b444c";
      g.fillRect(0, 0, 5, 32);
      g.fillStyle = "#7c8892";
      g.fillRect(14, 0, 4, 32);
      g.fillStyle = "#4c565f";
      for (let y = 0; y < 32; y += 8) g.fillRect(0, y, 32, 1);
    }),
  );
  // 문살: 창호지 + 살
  const latticeTex = keep(
    canvasTex(
      64,
      96,
      (g) => {
        g.fillStyle = "#f4ead0";
        g.fillRect(0, 0, 64, 96);
        g.fillStyle = "#7a4626";
        for (let x = 0; x <= 64; x += 10.6) g.fillRect(Math.round(x) - 1, 0, 3, 96);
        for (let y = 0; y <= 96; y += 12) g.fillRect(0, y - 1, 64, 3);
        g.lineWidth = 6;
        g.strokeStyle = "#5a321a";
        g.strokeRect(0, 0, 64, 96);
      },
      false,
    ),
  );
  // 과녁: 흰 바탕 + 붉은 원 + 검은 테
  const targetTex = keep(
    canvasTex(
      64,
      80,
      (g) => {
        g.fillStyle = "#f3efe4";
        g.fillRect(0, 0, 64, 80);
        g.strokeStyle = "#1f1b18";
        g.lineWidth = 6;
        g.strokeRect(3, 3, 58, 74);
        g.fillStyle = "#c33a2b";
        g.beginPath();
        g.arc(32, 40, 15, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#1f1b18";
        g.fillRect(4, 14, 56, 4);
        g.fillRect(4, 62, 56, 4);
      },
      false,
    ),
  );
  const wallTex = keep(
    canvasTex(64, 64, (g) => {
      g.fillStyle = "#c2b7a0";
      g.fillRect(0, 0, 64, 64);
      const r = rng(7);
      g.strokeStyle = "#8f8572";
      g.lineWidth = 2;
      for (let row = 0; row < 4; row++) {
        const y = row * 16;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(64, y);
        g.stroke();
        let x = row % 2 === 0 ? 0 : -10;
        while (x < 64) {
          const w = 16 + r() * 12;
          g.fillStyle = r() < 0.5 ? "#cbc1aa" : "#b5aa92";
          g.fillRect(x + 1, y + 1, w - 2, 14);
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x, y + 16);
          g.stroke();
          x += w;
        }
      }
    }),
  );
  const plankTex = keep(
    canvasTex(64, 64, (g) => {
      g.fillStyle = "#9a6a3e";
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = "#6e4526";
      for (let x = 0; x < 64; x += 11) g.fillRect(x, 0, 2, 64);
      g.fillStyle = "#b07c4a";
      for (let x = 5; x < 64; x += 11) g.fillRect(x, 0, 1, 64);
    }),
  );
  const thatchTex = keep(
    canvasTex(64, 64, (g) => {
      g.fillStyle = "#cfa75a";
      g.fillRect(0, 0, 64, 64);
      const r = rng(3);
      for (let i = 0; i < 220; i++) {
        g.strokeStyle = r() < 0.5 ? "#b28a44" : "#e2c07a";
        g.lineWidth = 1;
        const x = r() * 64;
        const y = r() * 64;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (r() - 0.5) * 3, y + 6 + r() * 6);
        g.stroke();
      }
    }),
  );
  const grass = keep(noiseTex("#86b553", ["#79a849", "#93c160", "#6f9c42", "#a0c96a"], 900));
  grass.repeat.set(80, 80);
  const road = keep(noiseTex("#d9c49a", ["#c9b184", "#e6d3ac", "#bfa678"], 700));
  const smoke = keep(
    canvasTex(
      64,
      64,
      (g) => {
        const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
        grd.addColorStop(0, "rgba(255,255,255,0.95)");
        grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd;
        g.fillRect(0, 0, 64, 64);
      },
      false,
    ),
  );

  const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial =>
    new THREE.MeshLambertMaterial({ color, ...extra });
  const base = Object.fromEntries(Object.entries(MAT_COLORS).map(([k, c]) => [k, lam(c)])) as Record<keyof typeof MAT_COLORS, THREE.MeshLambertMaterial>;
  base.tile.map = tileTex;
  base.tile.color.set(0xffffff);
  base.tileUnder.side = THREE.BackSide;
  base.lattice.map = latticeTex;
  base.target.map = targetTex;
  base.wallStone.map = wallTex;
  base.wallStone.color.set(0xffffff);
  base.plank.map = plankTex;
  base.plank.color.set(0xffffff);
  base.thatch.map = thatchTex;
  base.thatch.color.set(0xffffff);
  base.grass.map = grass;
  base.grass.color.set(0xffffff);
  base.road.map = road;
  base.road.color.set(0xffffff);
  base.water.transparent = true;
  base.water.opacity = 0.9;
  base.water.emissive = new THREE.Color(0x1d4f66);

  const flag = (c: number): THREE.MeshLambertMaterial => lam(c, { side: THREE.DoubleSide });
  const mats: Mats = {
    ...base,
    flagRed: flag(0xc8352b),
    flagBlue: flag(0x2f5ea8),
    flagYellow: flag(0xe6b631),
    flagGreen: flag(0x3d8b4f),
    flagWhite: flag(0xf3efe2),
    fire: new THREE.MeshBasicMaterial({ color: 0xff8a2a }),
    orb: new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.9 }),
  };
  return { mats, tex: { grass, road, smoke, all } };
}

// ───────── 기본 도형 ─────────

export interface Ctx {
  /** 합쳐질 정적 도형 */
  s: THREE.Group;
  /** 움직이는 도형 (깃발 userData.wave, 빛 userData.pulse) */
  d: THREE.Group;
  m: Mats;
  /** 연기 나는 곳 */
  smoke: THREE.Vector3[];
  /** 모양 단계 1~4 (높을수록 화려) */
  tier: number;
}

export function newCtx(m: Mats, tier = 3): Ctx {
  return { s: new THREE.Group(), d: new THREE.Group(), m, smoke: [], tier };
}

function put(c: Ctx, g: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const me = new THREE.Mesh(g, mat);
  me.position.set(x, y, z);
  me.rotation.y = ry;
  c.s.add(me);
  return me;
}

/** 상자 (y는 바닥 높이) */
export function box(c: Ctx, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return put(c, g, mat, x, y, z, ry);
}

export function cyl(c: Ctx, rt: number, rb: number, h: number, mat: THREE.Material, x: number, y: number, z: number, seg = 10): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(0, h / 2, 0);
  return put(c, g, mat, x, y, z);
}

function cone(c: Ctx, r: number, h: number, mat: THREE.Material, x: number, y: number, z: number, seg = 8): THREE.Mesh {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, h / 2, 0);
  return put(c, g, mat, x, y, z);
}

function ball(c: Ctx, r: number, mat: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, seg = 10): THREE.Mesh {
  const g = new THREE.SphereGeometry(r, seg, Math.max(5, Math.round(seg * 0.6)));
  g.scale(sx, sy, sz);
  return put(c, g, mat, x, y, z);
}

/** 누운 통나무 (ry=0이면 x축 방향) */
function logPiece(c: Ctx, r: number, len: number, mat: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  g.rotateZ(Math.PI / 2);
  g.translate(0, r, 0);
  return put(c, g, mat, x, y, z, ry);
}

function rock(c: Ctx, r: number, mat: THREE.Material, x: number, y: number, z: number, sy = 0.7, seed = 1): THREE.Mesh {
  const g = new THREE.DodecahedronGeometry(r, 0);
  g.scale(1, sy, 1);
  const me = put(c, g, mat, x, y + r * sy * 0.6, z);
  me.rotation.set(seed * 0.7, seed * 1.3, seed * 0.4);
  return me;
}

// ───────── 지붕 ─────────

/** 우진각(팔작 느낌) 기와지붕 면: 처마 오목 곡선 + 추녀 솟음 */
function roofGeo(hw: number, hd: number, H: number, lift: number): THREE.BufferGeometry {
  const swap = hd > hw;
  const W = swap ? hd : hw;
  const D = swap ? hw : hd;
  const g = new THREE.PlaneGeometry(W * 2, D * 2, Math.max(10, Math.round(W * 3)), Math.max(6, Math.round(D * 3)));
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const ridge = W - D;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const ax = Math.abs(x) / W;
    const az = Math.abs(z) / D;
    const t = Math.max(0, Math.min(1 - az, 1 - Math.max(0, Math.abs(x) - ridge) / D));
    let y = H * Math.pow(t, 1.45);
    y += lift * Math.pow(1 - t, 2.2) * (Math.pow(ax * az, 1.6) + 0.15 * ax * ax);
    p.setY(i, y);
    uv.setXY(i, x * 0.9, z * 0.6);
  }
  if (swap) g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** 기와지붕 (y = 처마 높이). 반환: 용마루 높이 */
export function giwa(c: Ctx, x: number, y: number, z: number, hw: number, hd: number, H: number, lift: number, gold = false): number {
  const top = roofGeo(hw, hd, H, lift);
  put(c, top, c.m.tile, x, y, z);
  const under = roofGeo(hw, hd, H, lift);
  put(c, under, c.m.tileUnder, x, y - 0.14, z);
  // 처마 두께 (서까래 끝)
  const long = Math.max(hw, hd);
  const short = Math.min(hw, hd);
  const ridgeLen = Math.max(0.2, (long - short) * 2);
  const alongX = hw >= hd;
  const rw = alongX ? ridgeLen + 0.5 : 0.55;
  const rd = alongX ? 0.55 : ridgeLen + 0.5;
  box(c, rw, 0.42, rd, c.m.ridge, x, y + H - 0.12, z);
  box(c, rw + 0.1, 0.12, rd + 0.1, c.m.tile, x, y + H + 0.3, z);
  // 취두 (용마루 양 끝 장식)
  const ends: Array<[number, number]> = alongX
    ? [
        [x - ridgeLen / 2 - 0.2, z],
        [x + ridgeLen / 2 + 0.2, z],
      ]
    : [
        [x, z - ridgeLen / 2 - 0.2],
        [x, z + ridgeLen / 2 + 0.2],
      ];
  for (const [ex, ez] of ends) {
    box(c, 0.45, 0.75, 0.45, gold ? c.m.gold : c.m.tile, ex, y + H - 0.1, ez);
  }
  return y + H + 0.42;
}

/** 초가지붕 (y = 처마 높이) */
export function thatchRoof(c: Ctx, x: number, y: number, z: number, hw: number, hd: number, H: number): number {
  const g = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(hw, H, hd);
  put(c, g, c.m.thatch, x, y, z);
  const rim = new THREE.CylinderGeometry(1, 1.02, 0.28, 16);
  rim.scale(hw, 1, hd);
  put(c, rim, c.m.thatchDark, x, y - 0.26, z);
  // 용마름
  box(c, Math.max(0.4, (hw - hd) * 1.4), 0.35, 0.7, c.m.thatchDark, x, y + H - 0.25, z);
  return y + H;
}

// ───────── 건물 몸체 ─────────

export interface HallOpts {
  x: number;
  z: number;
  y?: number;
  w: number;
  d: number;
  h: number;
  base?: number;
  roof?: "giwa" | "thatch" | "none";
  roofH?: number;
  over?: number;
  lift?: number;
  open?: boolean;
  wall?: THREE.Material;
  doors?: boolean;
  gold?: boolean;
  /** 단청 띠 없이 소박하게 (초가·곳간) */
  plain?: boolean;
  /** 1단계에서도 초가로 바꾸지 않음 */
  keepGiwa?: boolean;
}

/** 기단 + 주칠 기둥 + 벽·문살 + 단청 띠 + 지붕. 반환: { ry: 지붕 처마 높이, top: 꼭대기 } */
export function hall(c: Ctx, o: HallOpts): { ry: number; top: number } {
  const m = c.m;
  const tier = c.tier;
  // 단계별 양식: 1 초가·흙벽, 2 기와·백골(단청 없음), 3 단청, 4 단청+금빛 장식. 초가 건물은 3단계부터 기와로.
  let roof = o.roof ?? "giwa";
  let plain = o.plain ?? tier <= 2;
  if (roof === "giwa" && tier <= 1 && !o.keepGiwa) roof = "thatch";
  else if (roof === "thatch" && tier >= 3) roof = "giwa";
  if (tier >= 4) plain = false;
  if (tier <= 2) plain = true;
  const gold = o.gold ?? tier >= 4;
  const wallMat = o.wall ?? (tier <= 1 ? m.mud : m.plaster);
  const y0 = o.y ?? 0;
  const base = o.base ?? 0.6;
  const { x, z, w, d, h } = o;
  if (base > 0) {
    box(c, w + 1.4, base, d + 1.4, m.stone, x, y0, z);
    box(c, 2.2, base * 0.5, 0.8, m.stoneLight, x, y0, z + d / 2 + 0.7 + 0.4);
  }
  const yb = y0 + base;
  const nx = Math.max(2, Math.round(w / 2.3) + 1);
  const nz = Math.max(2, Math.round(d / 2.3) + 1);
  const pillarMat = plain ? m.wood : m.pillar;
  for (let i = 0; i < nx; i++) {
    const px = x - w / 2 + (w * i) / (nx - 1);
    cyl(c, 0.2, 0.24, h, pillarMat, px, yb, z - d / 2, 8);
    cyl(c, 0.2, 0.24, h, pillarMat, px, yb, z + d / 2, 8);
  }
  for (let j = 1; j < nz - 1; j++) {
    const pz = z - d / 2 + (d * j) / (nz - 1);
    cyl(c, 0.2, 0.24, h, pillarMat, x - w / 2, yb, pz, 8);
    cyl(c, 0.2, 0.24, h, pillarMat, x + w / 2, yb, pz, 8);
  }
  if (!o.open) {
    box(c, w - 0.15, h, d - 0.15, wallMat, x, yb, z);
    box(c, w + 0.05, 0.32, d + 0.05, m.wood, x, yb, z);
    if (o.doors !== false) {
      const bay = w / (nx - 1);
      for (let i = 0; i < nx - 1; i++) {
        const cx = x - w / 2 + bay * (i + 0.5);
        box(c, bay * 0.74, h * 0.72, 0.1, m.lattice, cx, yb + 0.35, z + d / 2 - 0.02);
      }
    }
  }
  const band = plain ? m.wood : m.lintel;
  box(c, w + 0.5, 0.42, d + 0.5, band, x, yb + h, z);
  if (!plain) box(c, w + 1.0, 0.38, d + 1.0, m.bracket, x, yb + h + 0.42, z);
  const ry = yb + h + (plain ? 0.42 : 0.8);
  const over = o.over ?? 1.3;
  const roofH = o.roofH ?? Math.max(1.4, Math.min(w, d) * 0.42);
  let top = ry;
  if (roof === "thatch") top = thatchRoof(c, x, ry, z, w / 2 + over * 0.9, d / 2 + over * 0.9, roofH);
  else if (roof !== "none") top = giwa(c, x, ry, z, w / 2 + over, d / 2 + over, roofH, o.lift ?? 0.8, gold);
  return { ry, top };
}

/** 담장 (기와 얹은 흙돌담) */
function damjang(c: Ctx, x1: number, z1: number, x2: number, z2: number, h = 1.3): void {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const ry = -Math.atan2(z2 - z1, x2 - x1);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  box(c, len, h, 0.5, c.m.mud, cx, 0, cz, ry);
  box(c, len + 0.2, 0.22, 0.95, c.m.tile, cx, h, cz, ry);
  box(c, len + 0.1, 0.16, 0.35, c.m.ridge, cx, h + 0.2, cz, ry);
}

/** 깃발 (깃대는 정적, 천은 움직임) */
export function flag(c: Ctx, x: number, z: number, h: number, mat: THREE.Material, phase: number, y = 0, size = 1): void {
  cyl(c, 0.07, 0.09, h, c.m.woodDark, x, y, z, 6);
  ball(c, 0.14, c.m.gold, x, y + h + 0.05, z, 1, 1, 1, 6);
  const g = new THREE.PlaneGeometry(1.7 * size, 1.1 * size, 6, 1);
  g.translate(0.85 * size, -0.55 * size, 0);
  const me = new THREE.Mesh(g, mat);
  me.position.set(x, y + h - 0.05, z);
  me.userData.wave = phase;
  me.castShadow = true;
  c.d.add(me);
}

function glow(c: Ctx, r: number, mat: THREE.Material, x: number, y: number, z: number, phase: number): void {
  const me = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat);
  me.position.set(x, y, z);
  me.userData.pulse = phase;
  c.d.add(me);
}

export function pine(c: Ctx, x: number, z: number, s = 1, y = 0): void {
  cyl(c, 0.16 * s, 0.28 * s, 2.0 * s, c.m.trunk, x, y, z, 6);
  for (let i = 0; i < 3; i++) cone(c, (1.85 - i * 0.45) * s, 1.6 * s, c.m.pine, x + (i % 2 === 0 ? 0.12 : -0.12) * s, y + (1.4 + i * 0.95) * s, z, 7);
}

export function roundTree(c: Ctx, x: number, z: number, s = 1): void {
  cyl(c, 0.18 * s, 0.26 * s, 1.8 * s, c.m.trunk, x, 0, z, 6);
  ball(c, 1.25 * s, c.m.leaf, x, 2.6 * s, z, 1, 0.85, 1, 8);
  ball(c, 0.85 * s, c.m.leaf, x + 0.8 * s, 2.2 * s, z + 0.3 * s, 1, 0.85, 1, 7);
  ball(c, 0.8 * s, c.m.leaf, x - 0.6 * s, 2.3 * s, z - 0.5 * s, 1, 0.85, 1, 7);
}

function jar(c: Ctx, x: number, z: number, s: number, y = 0): void {
  ball(c, 0.42 * s, c.m.jar, x, y + 0.38 * s, z, 1, 1.05, 1, 9);
  cyl(c, 0.22 * s, 0.24 * s, 0.16 * s, c.m.jar, x, y + 0.75 * s, z, 8);
}

function fenceLine(c: Ctx, x1: number, z1: number, x2: number, z2: number): void {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const n = Math.max(2, Math.round(len / 1.4));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    cyl(c, 0.07, 0.08, 1.0, c.m.wood, x1 + (x2 - x1) * t, 0, z1 + (z2 - z1) * t, 5);
  }
  const ry = -Math.atan2(z2 - z1, x2 - x1);
  box(c, len, 0.1, 0.08, c.m.wood, (x1 + x2) / 2, 0.45, (z1 + z2) / 2, ry);
  box(c, len, 0.1, 0.08, c.m.wood, (x1 + x2) / 2, 0.8, (z1 + z2) / 2, ry);
}

// ───────── 건물별 모양 ─────────

export interface LotDef {
  x: number;
  z: number;
  w: number;
  d: number;
}

export const WALL = { x0: -36, x1: 36, z0: -34, z1: 38, t: 2.6, h: 3.8, gate: 6 } as const;

/** 성 안 건물 자리 (정문은 +z 쪽) */
export const LOTS: Record<BuildingKey, LotDef> = {
  keep: { x: 0, z: -21, w: 20, d: 14 },
  academy: { x: -21, z: -20, w: 12, d: 12 },
  storehouse: { x: 21, z: -20, w: 12, d: 12 },
  camp: { x: -24, z: -3, w: 11, d: 10 },
  mint: { x: -10, z: -3, w: 11, d: 10 },
  forge: { x: 10, z: -3, w: 11, d: 10 },
  tower: { x: 24, z: -3, w: 10, d: 10 },
  sawmill: { x: -24, z: 13.5, w: 11, d: 10 },
  quarry: { x: -10, z: 13.5, w: 11, d: 10 },
  barracks: { x: 10, z: 13.5, w: 11, d: 10 },
  range: { x: 24, z: 13.5, w: 11, d: 10 },
  stable: { x: 20, z: 29, w: 13, d: 10 },
  // 성벽은 둘레 전체, 이름표·고르기는 정문 자리
  wall: { x: 0, z: WALL.z1, w: 16, d: 7 },
};

type Builder = (c: Ctx, lv: number) => number;

/** 레벨 → 모양 단계 (1: Lv.1~3 소박, 2: Lv.4~6 기와, 3: Lv.7~9 단청, 4: Lv.10 금빛) */
export const tierOf = (lv: number): number => (lv <= 0 ? 0 : lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 9 ? 3 : 4);
const TIER_SCALE = [1, 0.84, 0.93, 1.0, 1.1] as const;

function lantern(c: Ctx, x: number, z: number): void {
  box(c, 0.7, 0.3, 0.7, c.m.stoneLight, x, 0, z);
  cyl(c, 0.12, 0.16, 0.9, c.m.stoneLight, x, 0.3, z, 6);
  box(c, 0.6, 0.55, 0.6, c.m.stoneLight, x, 1.2, z);
  glow(c, 0.16, c.m.fire, x, 1.47, z, x);
  box(c, 0.85, 0.2, 0.85, c.m.stone, x, 1.75, z);
}

const BUILDERS: Record<BuildingKey, Builder> = {
  // 본관: 초가 관아 → 월대 위 기와 정전 → 중층 정전 → 행각 두른 금빛 정전
  keep: (c) => {
    const m = c.m;
    const t = c.tier;
    if (t === 1) {
      box(c, 14, 0.5, 10, m.stone, 0, 0, 0);
      const h1 = hall(c, { x: 0, z: -0.5, y: 0.5, w: 10, d: 6, h: 2.8, base: 0.3, roofH: 2.0, over: 1.2, lift: 0.6 });
      flag(c, 6, 4.4, 4.6, m.flagRed, 0.4);
      fenceLine(c, -7, 5, -2, 5);
      fenceLine(c, 2, 5, 7, 5);
      return h1.top;
    }
    box(c, 20, 0.8, 14, m.stone, 0, 0, 0);
    box(c, 4, 0.4, 1.4, m.stoneLight, 0, 0, 7.6);
    box(c, 4, 0.8, 1.2, m.stoneLight, 0, 0, 6.6);
    if (t === 2) {
      const h2 = hall(c, { x: 0, z: -0.8, y: 0.8, w: 12, d: 7.2, h: 3.2, base: 0.4, roofH: 2.6, over: 1.5, lift: 0.9 });
      flag(c, -9.2, 5.8, 5.4, m.flagRed, 0.1);
      flag(c, 9.2, 5.8, 5.4, m.flagYellow, 1.7);
      return h2.top;
    }
    box(c, 17, 0.7, 11.4, m.stoneLight, 0, 0.8, -0.2);
    box(c, 3, 0.4, 1.3, m.stoneLight, 0, 0.8, 5.9);
    const low = hall(c, { x: 0, z: -0.8, y: 1.5, w: 12.6, d: 7.6, h: 3.2, base: 0.35, roofH: 1.5, over: 1.5, lift: 0.8 });
    const up = hall(c, { x: 0, z: -0.8, y: low.ry + 0.7, w: 9.4, d: 5.0, h: 2.2, base: 0, roofH: 2.9, over: 1.7, lift: 1.15, doors: false });
    for (const sx of [-6.6, 6.6]) cyl(c, 0.55, 0.45, 0.8, m.iron, sx, 1.5, 4.3, 10);
    for (let i = 0; i < 4; i++) {
      box(c, 0.4, 0.6, 0.3, m.stoneLight, -2.6, 0, 8.6 + i * 1.6);
      box(c, 0.4, 0.6, 0.3, m.stoneLight, 2.6, 0, 8.6 + i * 1.6);
    }
    flag(c, -9.2, 5.8, 6, m.flagRed, 0.1);
    flag(c, 9.2, 5.8, 6, m.flagYellow, 1.7);
    flag(c, -9.2, -6.4, 6, m.flagBlue, 2.4);
    flag(c, 9.2, -6.4, 6, m.flagGreen, 3.3);
    if (t >= 4) {
      // 행각 (좌우 긴 회랑)
      hall(c, { x: -11.2, z: -0.5, w: 2.2, d: 12, h: 2.2, base: 0.3, open: true, roofH: 1.0, over: 0.8, lift: 0.4 });
      hall(c, { x: 11.2, z: -0.5, w: 2.2, d: 12, h: 2.2, base: 0.3, open: true, roofH: 1.0, over: 0.8, lift: 0.4 });
      lantern(c, -4.4, 8.6);
      lantern(c, 4.4, 8.6);
    }
    return up.top;
  },
  // 학당: 초가 서당 → 기와 강당+홍살문 → +누각 → +장판각·석등
  academy: (c) => {
    const m = c.m;
    const t = c.tier;
    const main = hall(c, { x: 0, z: -2.2, w: t === 1 ? 6.4 : 8.4, d: t === 1 ? 3.8 : 4.6, h: 2.6, roofH: 2.0, lift: 0.85 });
    if (t >= 2) {
      for (const px of [1.6, 4.6]) cyl(c, 0.14, 0.16, 4.4, m.red, px, 0, 4.6, 6);
      box(c, 3.4, 0.22, 0.22, m.red, 3.1, 3.9, 4.6);
      box(c, 3.4, 0.22, 0.22, m.red, 3.1, 3.2, 4.6);
      for (let i = 0; i < 7; i++) box(c, 0.08, 0.9, 0.08, m.red, 1.85 + i * 0.42, 3.4, 4.6);
      flag(c, 5.2, 1.2, 4.4, m.flagBlue, 0.8);
    }
    if (t >= 3) {
      for (const [px, pz] of [
        [-4.6, 1.6],
        [-1.2, 1.6],
        [-4.6, 4.2],
        [-1.2, 4.2],
      ] as const)
        cyl(c, 0.26, 0.3, 1.7, m.stone, px, 0, pz, 8);
      box(c, 4.2, 0.3, 3.2, m.wood, -2.9, 1.7, 2.9);
      hall(c, { x: -2.9, z: 2.9, y: 2.0, w: 3.4, d: 2.6, h: 1.7, base: 0, open: true, roofH: 1.4, over: 1.1, lift: 0.75 });
    }
    if (t >= 4) {
      hall(c, { x: 4.4, z: -1.0, w: 2.6, d: 2.4, h: 1.8, base: 0.4, roofH: 1.2, over: 0.8, lift: 0.6 });
      lantern(c, 0, 1.2);
    }
    pine(c, 4.3, -4.2, 0.9);
    if (t >= 2) pine(c, -4.9, -4.6, 0.8);
    else fenceLine(c, -4, 2, 4, 2);
    return main.top;
  },
  // 창고: 작은 곳간 → 두 채 → 가마니·궤짝 가득 → 담장 두른 세 채
  storehouse: (c) => {
    const m = c.m;
    const t = c.tier;
    const a = hall(c, { x: -1.6, z: -2.4, w: 6.4, d: 3.6, h: 2.4, base: 0.9, wall: m.plank, doors: false, roofH: 1.6, lift: 0.6, plain: true });
    box(c, 1.3, 1.8, 0.1, m.woodDark, -1.6, 1.0, -0.55);
    if (t >= 2) {
      hall(c, { x: 3.2, z: 2.2, w: 3.6, d: 3.0, h: 2.0, base: 0.7, wall: m.plank, doors: false, roofH: 1.3, lift: 0.5, plain: true });
      box(c, 1.0, 1.4, 0.1, m.woodDark, 3.2, 0.75, 3.75);
    }
    const sacks = t === 1 ? 2 : 4;
    for (let i = 0; i < sacks; i++) ball(c, 0.5, m.hay, -3.6 + i * 1.05, 0.45, 2.4, 1.1, 0.8, 0.75, 7);
    if (t >= 3) {
      for (let i = 0; i < 3; i++) ball(c, 0.5, m.hay, -3.1 + i * 1.05, 1.15, 2.4, 1.1, 0.8, 0.75, 7);
      box(c, 1.0, 0.9, 1.0, m.plank, 0.6, 0, 3.6);
      box(c, 0.9, 0.8, 0.9, m.plank, 0.7, 0.9, 3.6);
      flag(c, -5.4, 3.6, 3.8, m.flagYellow, 2.1);
    }
    if (t >= 4) {
      hall(c, { x: -4.0, z: 2.8, w: 2.4, d: 2.2, h: 1.6, base: 0.6, wall: m.plank, doors: false, roofH: 1.0, lift: 0.4, plain: true });
      damjang(c, -5.6, 5, 5.6, 5);
    }
    return a.top;
  },
  // 일꾼 막사: 움막 한 채 → 초가 두 채+장독대 → 기와집 → 세 채+우물
  camp: (c) => {
    const m = c.m;
    const t = c.tier;
    const a = hall(c, { x: -1.4, z: -2.2, w: t === 1 ? 4.6 : 6, d: 3.4, h: 2.1, base: 0.35, wall: m.mud, roof: "thatch", roofH: 1.6, over: 1.1, plain: true });
    cyl(c, 0.25, 0.3, 1.3, m.stoneDark, 1.0, a.ry + 0.6, -3.6, 6);
    c.smoke.push(new THREE.Vector3(1.0, a.ry + 2.2, -3.6));
    if (t >= 2) {
      hall(c, { x: 2.6, z: 2.2, w: 3.6, d: 3, h: 1.9, base: 0.3, wall: m.mud, roof: "thatch", roofH: 1.3, over: 0.9, plain: true });
      box(c, 2.6, 0.35, 1.8, m.stone, -3.0, 0, 2.6);
      jar(c, -3.7, 2.2, 1, 0.35);
      jar(c, -2.8, 2.2, 0.85, 0.35);
      jar(c, -3.6, 3.1, 0.75, 0.35);
      jar(c, -2.5, 3.0, 0.65, 0.35);
      flag(c, 4.8, 4.4, 3.4, m.flagGreen, 1.1);
    }
    fenceLine(c, -5.2, 4.6, 0.4, 4.6);
    fenceLine(c, -5.2, -4.6, -5.2, 4.6);
    cone(c, 0.9, 1.6, m.thatch, 4.4, 0, -2.6, 9);
    if (t >= 4) {
      hall(c, { x: -2.4, z: 2.6, w: 2.6, d: 2.2, h: 1.7, base: 0.3, wall: m.mud, roofH: 1.0, over: 0.7, lift: 0.4, plain: true });
      cyl(c, 0.7, 0.8, 0.7, m.stone, 3.6, 0, -0.2, 10);
    }
    return a.top;
  },
  // 벌목장: 통나무 더미+모탕 → 헛간 → 큰 헛간+더미 두 곳 → 물레방아
  sawmill: (c) => {
    const m = c.m;
    const t = c.tier;
    let top = 3;
    if (t >= 2) top = hall(c, { x: -1.2, z: -2.2, w: t >= 3 ? 6 : 5, d: 3.4, h: 2.4, base: 0.2, open: true, roof: "thatch", roofH: 1.4, over: 1, plain: true }).top;
    const piles: Array<[number, number]> = t >= 3 ? [[2.6, 2.4], [-2.6, 2.6]] : [[1.8, 2.2]];
    for (const [bx, bz] of piles) {
      for (let row = 0; row < 3; row++)
        for (let i = 0; i < 3 - row; i++) logPiece(c, 0.32, 3.2, m.trunk, bx, row * 0.55, bz - 0.68 + i * 0.68 + row * 0.34, Math.PI / 2);
    }
    cyl(c, 0.55, 0.6, 0.6, m.trunk, 0.2, 0, 3.8, 9);
    cyl(c, 0.45, 0.5, 0.5, m.trunk, 4.4, 0, -1.0, 9);
    box(c, 0.2, 0.9, 0.2, m.wood, -1.6, 0, -2.0);
    box(c, 0.2, 0.9, 0.2, m.wood, -0.4, 0, -2.0);
    logPiece(c, 0.3, 3, m.trunk, -1.0, 0.9, -2.0);
    pine(c, 4.2, -3.6, 0.95);
    pine(c, -4.6, -4.0, 0.85);
    if (t >= 2) flag(c, -4.8, 4.4, 3.4, m.flagGreen, 2.6);
    if (t >= 4) {
      // 물레방아
      box(c, 1.6, 0.1, 5, m.water, 4.6, 0.02, 1.5);
      const wg = new THREE.TorusGeometry(1.4, 0.18, 6, 16);
      wg.rotateY(Math.PI / 2);
      put(c, wg, m.wood, 4.6, 1.5, 1.6);
      for (let i = 0; i < 8; i++) {
        const sp = box(c, 0.12, 2.8, 0.12, m.wood, 4.6, 1.5, 1.6);
        sp.geometry.translate(0, -1.4, 0);
        sp.rotation.x = (i / 8) * Math.PI;
      }
      top = Math.max(top, 3.5);
    }
    return top;
  },
  // 채석장: 바위+돌 몇 개 → 들틀 → 수레·돌 더미 → 헛간
  quarry: (c) => {
    const m = c.m;
    const t = c.tier;
    rock(c, 2.8, m.rock, -2.0, 0, -2.4, 0.8, 1);
    rock(c, 2.1, m.stone, 1.6, 0, -2.8, 0.85, 2);
    if (t >= 2) rock(c, 1.6, m.rock, -4.0, 0, 0.4, 0.7, 3);
    rock(c, 1.2, m.stoneDark, 3.6, 0, -0.4, 0.8, 4);
    const n = t === 1 ? 2 : 3;
    for (let i = 0; i < n; i++) box(c, 1.2, 0.7, 0.8, m.stoneLight, -1.2 + i * 1.3, 0, 2.6);
    if (t >= 3) {
      for (let i = 0; i < 2; i++) box(c, 1.2, 0.7, 0.8, m.stoneLight, -0.55 + i * 1.3, 0.7, 2.6);
      box(c, 1.2, 0.7, 0.8, m.stoneLight, 0.1, 1.4, 2.6);
      box(c, 1.6, 0.5, 1.1, m.plank, -3.6, 0.5, 3.4);
      for (const wz of [2.75, 4.05]) {
        const wg = new THREE.CylinderGeometry(0.5, 0.5, 0.12, 12);
        wg.rotateX(Math.PI / 2);
        put(c, wg, m.woodDark, -3.6, 0.5, wz);
      }
    }
    if (t >= 2) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = cyl(c, 0.08, 0.1, 4.6, m.wood, 2.8 + Math.cos(a) * 0.9, 0, 1.6 + Math.sin(a) * 0.9, 5);
        leg.rotation.set(Math.sin(a) * 0.22, 0, -Math.cos(a) * 0.22);
      }
      box(c, 0.6, 0.6, 0.6, m.stoneLight, 2.8, 2.0, 1.6);
      flag(c, 4.6, 4.2, 3.4, m.flagWhite, 0.4);
    }
    if (t >= 4) hall(c, { x: -3.8, z: -3.6, w: 2.8, d: 2.0, h: 1.8, base: 0.2, open: true, roofH: 1.0, over: 0.7, lift: 0.4, plain: true });
    return 4.8;
  },
  // 제철소: 작은 가마+모루 → 대장간 → 큰 가마 → 가마 두 개
  forge: (c) => {
    const m = c.m;
    const t = c.tier;
    let top = 4;
    if (t >= 2) top = hall(c, { x: -1.4, z: -2.0, w: 5, d: 3.4, h: 2.3, base: 0.25, open: true, roof: "thatch", roofH: 1.3, over: 0.9, plain: true }).top;
    box(c, 0.6, 0.5, 0.4, m.iron, -1.4, 0.25, -1.8);
    box(c, 0.35, 0.5, 0.35, m.woodDark, -1.4, 0.25, -1.8);
    const fh = t === 1 ? 1.8 : 3.0;
    const fr = t === 1 ? 0.7 : 0.9;
    cyl(c, fr, fr + 0.6, fh, m.stoneDark, 2.6, 0, 1.0, 10);
    cyl(c, fr + 0.05, fr + 0.05, 0.3, m.stone, 2.6, fh, 1.0, 10);
    glow(c, fr * 0.72, m.fire, 2.6, fh + 0.2, 1.0, 0.5);
    box(c, 0.8, 0.8, 0.3, m.dark, 2.6, 0.2, 2.4);
    glow(c, 0.25, m.fire, 2.6, 0.55, 2.55, 1.4);
    c.smoke.push(new THREE.Vector3(2.6, fh + 0.8, 1.0));
    rock(c, 0.8, m.ore, -3.4, 0, 2.6, 0.7, 5);
    rock(c, 0.7, m.charcoal, 0.0, 0, 3.6, 0.6, 7);
    if (t >= 3) {
      rock(c, 0.6, m.ore, -2.4, 0, 3.4, 0.7, 6);
      box(c, 1.8, 1.1, 0.9, m.stoneDark, -2.6, 0.25, -3.0);
      box(c, 0.6, 0.12, 2.0, m.iron, 4.4, 0, -2.6);
      box(c, 0.6, 0.12, 2.0, m.iron, 4.4, 0.12, -2.6);
      flag(c, 4.8, 4.2, 3.6, m.flagRed, 1.9);
    }
    if (t >= 4) {
      cyl(c, 0.7, 1.2, 2.4, m.stoneDark, 4.2, 0, 3.4, 10);
      glow(c, 0.5, m.fire, 4.2, 2.55, 3.4, 2.1);
      c.smoke.push(new THREE.Vector3(4.2, 3.1, 3.4));
    }
    return Math.max(top, fh + 1);
  },
  // 주조소: 작은 관청 → +도가니 → +담장·엽전 더미 → 금빛
  mint: (c) => {
    const m = c.m;
    const t = c.tier;
    const a = hall(c, { x: 0, z: -2.0, w: t === 1 ? 5.4 : 7, d: 4, h: 2.5, base: 0.55, roofH: 1.8, lift: 0.75 });
    if (t >= 2) {
      cyl(c, 0.7, 0.9, 1.3, m.stoneDark, 3.2, 0, 1.6, 10);
      glow(c, 0.45, m.fire, 3.2, 1.35, 1.6, 0.9);
      c.smoke.push(new THREE.Vector3(3.2, 1.9, 1.6));
      flag(c, 4.6, -4.2, 3.8, m.flagYellow, 0.6);
    }
    const stacks = t === 1 ? 2 : t === 2 ? 4 : 6;
    for (let i = 0; i < stacks; i++) cyl(c, 0.5, 0.5, 0.12, m.gold, -2.4, i * 0.13, 1.6, 12);
    if (t >= 3) {
      damjang(c, -5.2, -4.6, -5.2, 4.4);
      damjang(c, -5.2, 4.4, -1.4, 4.4);
      damjang(c, 1.4, 4.4, 5.2, 4.4);
      for (let i = 0; i < 3; i++) cyl(c, 0.5, 0.5, 0.12, m.gold, -1.2, i * 0.13, 2.4, 12);
      box(c, 0.9, 0.3, 0.45, m.gold, -3.0, 0, 2.8);
      box(c, 0.9, 0.3, 0.45, m.gold, -2.9, 0.3, 2.8);
    }
    if (t >= 4) {
      for (let i = 0; i < 4; i++) box(c, 0.9, 0.3, 0.45, m.gold, -0.4 + (i % 2) * 1.0, Math.floor(i / 2) * 0.3, 3.2);
      lantern(c, 1.8, 3.2);
    }
    return a.top;
  },
  // 병영: 군막 → 기와 막사 → +연무장·창 걸이·허수아비 → 막사 두 채+큰 수자기
  barracks: (c) => {
    const m = c.m;
    const t = c.tier;
    let top = 3;
    if (t === 1) {
      for (const [tx, tz] of [
        [-2.4, -1.6],
        [1.8, -2.2],
        [-0.4, 2.0],
      ] as const) {
        cone(c, 1.8, 2.6, m.flagWhite, tx, 0, tz, 8);
        cyl(c, 0.05, 0.05, 3.2, m.woodDark, tx, 0, tz, 4);
      }
      flag(c, 3.6, 2.4, 4, m.flagRed, 0.3);
      return 3.4;
    }
    top = hall(c, { x: -0.5, z: -2.4, w: 8, d: 3.8, h: 2.5, roofH: 1.8, lift: 0.8 }).top;
    box(c, 9, 0.05, 4.4, m.dirt, 0, 0, 2.4);
    for (const dx of [-1.2, 1.2]) {
      cyl(c, 0.07, 0.07, 1.6, m.wood, dx, 0, 1.8, 5);
      box(c, 1.0, 0.1, 0.1, m.wood, dx, 1.2, 1.8);
      ball(c, 0.32, m.hay, dx, 1.35, 1.8, 0.9, 1.2, 0.9, 7);
    }
    flag(c, 4.8, -0.2, t >= 4 ? 7 : 5.6, m.flagRed, 0.3, 0, t >= 4 ? 1.8 : 1.4);
    if (t >= 3) {
      for (const rx of [-3.6, 3.4]) {
        box(c, 0.15, 1.6, 0.15, m.wood, rx - 0.8, 0, 3.9);
        box(c, 0.15, 1.6, 0.15, m.wood, rx + 0.8, 0, 3.9);
        box(c, 1.8, 0.12, 0.15, m.wood, rx, 1.3, 3.9);
        for (let i = 0; i < 4; i++) {
          cyl(c, 0.04, 0.04, 2.3, m.woodDark, rx - 0.6 + i * 0.4, 0, 4.05, 4);
          cone(c, 0.08, 0.3, m.iron, rx - 0.6 + i * 0.4, 2.3, 4.05, 4);
        }
      }
      flag(c, -4.8, -0.2, 5.0, m.flagYellow, 2.2);
    }
    if (t >= 4) hall(c, { x: -4.4, z: 1.6, w: 1.8, d: 3.6, h: 2.0, base: 0.3, roofH: 1.0, over: 0.7, lift: 0.5 });
    return top;
  },
  // 궁술장: 과녁+사대 → 활터 정자 → 깃발·과녁 셋 → 큰 정자
  range: (c) => {
    const m = c.m;
    const t = c.tier;
    let top = 3;
    if (t >= 2) {
      const big = t >= 4;
      top = hall(c, { x: -2.4, z: 2.2, w: big ? 5 : 4.2, d: big ? 3.8 : 3.2, h: 2.1, base: 0.7, open: true, roofH: 1.5, over: 1.1, lift: 0.95 }).top;
    } else {
      box(c, 3, 0.3, 2.4, m.plank, -2.4, 0, 2.2);
    }
    box(c, 4.4, 0.04, 8.4, m.dirt, 2.2, 0, -0.2);
    const n = t >= 3 ? 3 : t === 2 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      box(c, 1.3, 1.7, 0.18, m.target, 0.8 + i * 1.6, 0.35, -3.6);
      box(c, 0.12, 0.4, 0.12, m.wood, 0.4 + i * 1.6, 0, -3.6);
      box(c, 0.12, 0.4, 0.12, m.wood, 1.2 + i * 1.6, 0, -3.6);
    }
    if (t >= 3) {
      flag(c, -0.4, -4.4, 2.8, m.flagRed, 0.7, 0, 0.7);
      flag(c, 5.0, -4.4, 2.8, m.flagBlue, 2.4, 0, 0.7);
    }
    if (t >= 2) flag(c, -4.8, 4.4, 3.6, m.flagGreen, 1.3);
    return top;
  },
  // 마구간: 울타리+말 한 필 → 마구간 → 말 넷 → 기와 마구간+구유
  stable: (c) => {
    const m = c.m;
    const t = c.tier;
    let top = 3;
    if (t >= 2) {
      top = hall(c, { x: 0, z: -2.6, w: t >= 3 ? 9.6 : 7, d: 3.4, h: 2.3, base: 0.25, open: true, roof: "thatch", roofH: 1.5, over: 1, lift: 0.6, plain: true }).top;
      box(c, t >= 3 ? 9.6 : 7, 2.3, 0.15, m.plank, 0, 0.25, -4.25);
    } else {
      box(c, 3, 0.15, 2.4, m.thatch, -3.0, 2.0, -2.6);
      for (const [px, pz] of [
        [-4.4, -1.6],
        [-1.6, -1.6],
        [-4.4, -3.6],
        [-1.6, -3.6],
      ] as const)
        cyl(c, 0.08, 0.08, 2.0, m.wood, px, 0, pz, 5);
    }
    const horse = (hx: number, hz: number, ry: number, mat: THREE.Material): void => {
      const grp = new THREE.Group();
      const part = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): void => {
        const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        me.position.set(x, y, z);
        me.rotation.x = rx;
        grp.add(me);
      };
      part(0.7, 0.75, 1.9, 0, 1.25, 0);
      for (const [lx, lz] of [
        [-0.22, 0.7],
        [0.22, 0.7],
        [-0.22, -0.7],
        [0.22, -0.7],
      ] as const)
        part(0.18, 0.95, 0.18, lx, 0.47, lz);
      part(0.4, 0.95, 0.45, 0, 1.85, 1.0, -0.55);
      part(0.36, 0.36, 0.8, 0, 2.15, 1.45, 0.4);
      part(0.12, 0.7, 0.12, 0, 1.2, -1.0, 0.4);
      grp.position.set(hx, 0, hz);
      grp.rotation.y = ry;
      c.s.add(grp);
    };
    horse(-1.2, 2.8, 1.2, m.horse);
    if (t >= 2) horse(-3.6, -2.4, 0, m.horse);
    if (t >= 3) {
      horse(1.2, -2.4, 0, m.horseDark);
      horse(2.6, 2.2, -0.6, m.horseDark);
      for (let i = 0; i < 5; i++) box(c, 0.12, 1.3, 3.0, m.plank, -4.8 + i * 2.4, 0.25, -2.6);
    }
    fenceLine(c, -5.8, 0.4, -5.8, 4.8);
    fenceLine(c, -5.8, 4.8, 5.8, 4.8);
    fenceLine(c, 5.8, 0.4, 5.8, 4.8);
    logPiece(c, 0.45, 1.1, m.hay, 4.6, 0, -0.6);
    if (t >= 2) {
      logPiece(c, 0.45, 1.1, m.hay, 4.6, 0.85, -0.6);
      flag(c, 6.2, -0.4, 3.6, m.flagWhite, 2.9);
    }
    if (t >= 4) {
      box(c, 1.6, 0.5, 0.6, m.plank, -3.8, 0, 1.4);
      box(c, 1.4, 0.05, 0.4, m.water, -3.8, 0.47, 1.4);
    }
    return top;
  },
  // 마탑: 층수가 단계마다 늘어나는 목탑 (2→3→4→5층) + 상륜부 + 빛 구슬
  tower: (c) => {
    const m = c.m;
    const t = c.tier;
    box(c, 7.4, 0.8, 7.4, m.stone, 0, 0, 0);
    box(c, 2.4, 0.4, 1.0, m.stoneLight, 0, 0, 4.2);
    const floors = t + 1;
    let y = 0.8;
    let top = 0;
    for (let i = 0; i < floors; i++) {
      const s = 5.0 - i * 0.72;
      const h = i === 0 ? 2.4 : 1.55;
      const r = hall(c, { x: 0, z: 0, y, w: s, d: s, h, base: 0, roofH: 0.95, over: 1.15, lift: 0.7, doors: i === 0, roof: t === 1 ? "giwa" : undefined, keepGiwa: true });
      y = r.ry + 0.5;
      top = r.top;
    }
    cyl(c, 0.1, 0.14, 2.6, m.gold, 0, top - 0.2, 0, 6);
    for (let i = 0; i < 5; i++) {
      const tg = new THREE.TorusGeometry(0.32 - i * 0.03, 0.06, 5, 12);
      tg.rotateX(Math.PI / 2);
      put(c, tg, m.gold, 0, top + 0.5 + i * 0.32, 0);
    }
    glow(c, 0.3 + t * 0.07, m.orb, 0, top + 2.6, 0, 0.2);
    if (t >= 2) {
      flag(c, -3.4, 3.4, 3.4, m.flagBlue, 0.9);
      flag(c, 3.4, 3.4, 3.4, m.flagBlue, 2.0);
    }
    if (t >= 4) {
      lantern(c, -3.0, -3.0);
      lantern(c, 3.0, -3.0);
    }
    return top + 3.0;
  },
  // 성벽: buildWall에서 따로 만든다
  wall: () => 0,
};

/** 성벽 단계: 목책(Lv.1~3) → 토성(4~6) → 석성(7~9) → 치·옹성 두른 대성곽(10) */
function buildWall(c: Ctx, lv: number): number {
  const m = c.m;
  const { x0, x1, z0, z1, gate } = WALL;
  const stage = lv <= 3 ? 1 : lv <= 6 ? 2 : lv <= 9 ? 3 : 4;
  const sides: Array<[number, number, number, number]> = [
    [x0, z0, x1, z0],
    [x0, z0, x0, z1],
    [x1, z0, x1, z1],
    [x0, z1, -gate - 1, z1],
    [gate + 1, z1, x1, z1],
  ];
  const flagMats = [m.flagRed, m.flagYellow, m.flagBlue, m.flagWhite, m.flagGreen];
  const along = (ax: number, az: number, bx: number, bz: number, step: number, fn: (x: number, z: number, i: number) => void): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) fn(ax + ((bx - ax) * (i + 0.5)) / n, az + ((bz - az) * (i + 0.5)) / n, i);
  };
  if (stage === 1) {
    // 목책: 끝을 깎은 통나무 말뚝
    for (const [ax, az, bx, bz] of sides) {
      along(ax, az, bx, bz, 0.75, (x, z, i) => {
        const h = 2.6 + (i % 3) * 0.25;
        cyl(c, 0.26, 0.3, h, m.trunk, x, 0, z, 6);
        cone(c, 0.27, 0.6, m.trunk, x, h, z, 6);
      });
      const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
      box(c, alongX ? Math.abs(bx - ax) : 0.2, 0.2, alongX ? 0.2 : Math.abs(bz - az), m.wood, (ax + bx) / 2, 1.6, (az + bz) / 2);
    }
    // 나무 망루 (정문 양쪽·모서리)
    const watch = (x: number, z: number): void => {
      for (const [dx, dz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const)
        cyl(c, 0.14, 0.16, 5, m.wood, x + dx * 1.1, 0, z + dz * 1.1, 5);
      box(c, 2.8, 0.25, 2.8, m.plank, x, 4.4, z);
      box(c, 2.8, 0.8, 0.12, m.plank, x, 4.65, z + 1.35);
      thatchRoof(c, x, 5.6, z, 1.9, 1.9, 1.2);
    };
    watch(-gate - 1.4, z1);
    watch(gate + 1.4, z1);
    watch(x0, z0);
    watch(x1, z0);
    box(c, 2.4, 2.6, 0.25, m.plank, -2.4, 0, z1 + 1.6, -0.7);
    box(c, 2.4, 2.6, 0.25, m.plank, 2.4, 0, z1 + 1.6, 0.7);
    flag(c, gate + 1.4, z1, 6.8, m.flagRed, 0.4, 0, 1.1);
    return 7.4;
  }
  if (stage === 2) {
    // 토성: 흙 둔덕 + 위에 목책, 정문은 돌 기단 위 기와 문루
    for (const [ax, az, bx, bz] of sides) {
      const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
      const len = alongX ? Math.abs(bx - ax) : Math.abs(bz - az);
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;
      box(c, alongX ? len : 4.2, 1.4, alongX ? 4.2 : len, m.earth, cx, 0, cz);
      box(c, alongX ? len : 3.0, 1.4, alongX ? 3.0 : len, m.mud, cx, 1.4, cz);
      along(ax, az, bx, bz, 1.1, (x, z) => cyl(c, 0.16, 0.18, 1.5, m.trunk, x, 2.8, z, 5));
    }
    for (const [cx, cz] of [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
    ] as const) {
      box(c, 5, 3.0, 5, m.mud, cx, 0, cz);
      hall(c, { x: cx, z: cz, y: 3.0, w: 3.0, d: 3.0, h: 1.6, base: 0, open: true, roof: "thatch", roofH: 1.1, over: 0.8, plain: true });
    }
    box(c, 13, 3.6, 5, m.stone, 0, 0, z1);
    box(c, 4.6, 3.0, 5.2, m.dark, 0, 0, z1);
    const g = hall(c, { x: 0, z: z1, y: 3.6, w: 9, d: 4, h: 2.2, base: 0, open: true, roofH: 2.0, over: 1.4, lift: 0.9, plain: true });
    let fi = 0;
    along(x0, z1, -gate - 1, z1, 12, (x, z) => flag(c, x, z + 1.5, 2.4, flagMats[fi++ % 5], fi * 0.9, 2.8));
    along(gate + 1, z1, x1, z1, 12, (x, z) => flag(c, x, z + 1.5, 2.4, flagMats[fi++ % 5], fi * 0.9, 2.8));
    return g.top;
  }
  // 석성
  const h = stage === 4 ? 4.8 : 3.8;
  const t = stage === 4 ? 3.0 : 2.6;
  for (const [ax, az, bx, bz] of sides) {
    along(ax, az, bx, bz, 6, (cx, cz) => {
      const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
      const l = Math.hypot(bx - ax, bz - az) / Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 6)) + 0.02;
      box(c, alongX ? l : t, h, alongX ? t : l, m.wallStone, cx, 0, cz);
      const k = Math.max(2, Math.round(l / 1.9));
      for (let j = 0; j < k; j++) {
        const ox = alongX ? cx - l / 2 + (l * (j + 0.5)) / k : cx;
        const oz = alongX ? cz : cz - l / 2 + (l * (j + 0.5)) / k;
        const outX = alongX ? 0 : Math.sign(cx) * (t / 2 - 0.25);
        const outZ = alongX ? Math.sign(cz) * (t / 2 - 0.25) : 0;
        box(c, alongX ? 1.3 : 0.5, 0.95, alongX ? 0.5 : 1.3, m.stoneLight, ox + outX, h, oz + outZ);
      }
    });
  }
  if (stage === 4) {
    // 치 (성벽에서 튀어나온 네모 돌출부)
    for (const zz of [-14, 10]) {
      for (const sx of [x0, x1]) box(c, 6, h + 0.4, 5, m.wallStone, sx + Math.sign(sx) * 2.4, 0, zz);
    }
    for (const xx of [-20, 20]) box(c, 5, h + 0.4, 6, m.wallStone, xx, 0, z0 - 2.4);
    // 옹성 (정문 앞 반달 성벽)
    const og = new THREE.CylinderGeometry(9, 9, h - 0.6, 24, 1, true, -Math.PI / 2, Math.PI);
    og.translate(0, (h - 0.6) / 2, 0);
    put(c, og, m.wallStone, 0, 0, z1 + 2.4);
    const ogIn = new THREE.CylinderGeometry(7.6, 7.6, h - 0.6, 24, 1, true, -Math.PI / 2, Math.PI);
    ogIn.translate(0, (h - 0.6) / 2, 0);
    put(c, ogIn, m.stoneDark, 0, 0, z1 + 2.4);
    const cap = new THREE.RingGeometry(7.6, 9, 24, 1, -Math.PI / 2, Math.PI);
    cap.rotateX(-Math.PI / 2);
    put(c, cap, m.stoneLight, 0, h - 0.6, z1 + 2.4);
  }
  // 정문: 홍예 석축 + 2층 문루
  const gh = stage === 4 ? 6.2 : 5.4;
  box(c, 14, gh, 4.4, m.wallStone, 0, 0, z1);
  box(c, 4.6, 3.4, 4.6, m.dark, 0, 0, z1);
  const arch = new THREE.CylinderGeometry(2.3, 2.3, 4.6, 14, 1, false, 0, Math.PI);
  arch.rotateX(Math.PI / 2);
  arch.rotateZ(Math.PI / 2);
  put(c, arch, m.dark, 0, 3.4, z1);
  box(c, 1.2, 3.3, 0.2, m.woodDark, -2.9, 0, z1 + 2.6, -0.9);
  box(c, 1.2, 3.3, 0.2, m.woodDark, 2.9, 0, z1 + 2.6, 0.9);
  const gl = hall(c, { x: 0, z: z1, y: gh, w: 10, d: 4.2, h: 2.3, base: 0, open: true, roofH: 2.2, over: 1.6, lift: 1.1 });
  const g2 = hall(c, { x: 0, z: z1, y: gl.ry + 0.6, w: 7.2, d: 2.8, h: 1.4, base: 0, roofH: 1.8, over: 1.3, lift: 1.0, doors: false });
  for (const [cx, cz] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ] as const) {
    box(c, 5, h + 0.4, 5, m.wallStone, cx, 0, cz);
    hall(c, { x: cx, z: cz, y: h + 0.4, w: 3.4, d: 3.4, h: 1.7, base: 0, open: true, roofH: 1.3, over: 1.0, lift: 0.8 });
  }
  let fi = 0;
  for (let xx = x0 + 10; xx < x1 - 4; xx += 12) {
    if (Math.abs(xx) < 8) continue;
    flag(c, xx, z1 + 0.4, 2.4, flagMats[fi % 5], fi * 0.9, h);
    fi++;
  }
  for (let zz = z0 + 10; zz < z1 - 4; zz += 14) {
    flag(c, x1 - 0.4, zz, 2.4, flagMats[fi % 5], fi * 0.9, h);
    flag(c, x0 + 0.4, zz, 2.4, flagMats[(fi + 2) % 5], fi * 0.7, h);
    fi++;
  }
  flag(c, -4.2, z1 + 1.6, 3.0, m.flagRed, 0.2, gh, 1.3);
  flag(c, 4.2, z1 + 1.6, 3.0, m.flagYellow, 1.2, gh, 1.3);
  return g2.top;
}

/** 빈 터: 다진 흙 + 모서리 돌 + 팻말 */
function emptyLot(c: Ctx, lot: LotDef): number {
  const m = c.m;
  const w = lot.w * 0.7;
  const d = lot.d * 0.7;
  box(c, w, 0.08, d, m.earth, 0, 0, 0);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const)
    box(c, 0.6, 0.35, 0.6, m.stoneLight, (sx * w) / 2, 0, (sz * d) / 2);
  cyl(c, 0.08, 0.08, 1.6, m.wood, 0, 0, d / 2 - 0.6, 5);
  box(c, 1.4, 0.7, 0.1, m.plank, 0, 1.1, d / 2 - 0.55);
  return 2;
}

/** 공사 중: 비계 + 자재 */
function scaffold(c: Ctx, lot: LotDef, h: number): void {
  const m = c.m;
  const w = lot.w * 0.78;
  const d = lot.d * 0.72;
  const nx = 4;
  const nz = 3;
  for (let i = 0; i <= nx; i++) {
    for (const sz of [-1, 1]) cyl(c, 0.07, 0.07, h, m.wood, -w / 2 + (w * i) / nx, 0, (sz * d) / 2, 4);
  }
  for (let j = 1; j < nz; j++) {
    for (const sx of [-1, 1]) cyl(c, 0.07, 0.07, h, m.wood, (sx * w) / 2, 0, -d / 2 + (d * j) / nz, 4);
  }
  for (const ly of [h * 0.35, h * 0.7]) {
    box(c, w, 0.12, 0.5, m.plank, 0, ly, d / 2);
    box(c, w, 0.12, 0.5, m.plank, 0, ly, -d / 2);
    box(c, 0.5, 0.12, d, m.plank, w / 2, ly, 0);
    box(c, 0.5, 0.12, d, m.plank, -w / 2, ly, 0);
  }
  for (let i = 0; i < 3; i++) logPiece(c, 0.2, 2.4, m.plank, w / 2 + 1.0, i * 0.36, d / 2 - 0.4 - i * 0.05, Math.PI / 2);
  box(c, 1.0, 0.5, 0.7, m.stoneLight, -w / 2 - 0.9, 0, d / 2 - 0.6);
}

// ───────── 합치기 ─────────

/** 그룹 안 메시를 재질별로 하나로 합친다 (원본 도형은 정리) */
export function bake(src: THREE.Group, shadows = true): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const used = new Set<THREE.BufferGeometry>();
  src.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.Material;
    const srcGeo = o.geometry as THREE.BufferGeometry;
    used.add(srcGeo);
    const g = srcGeo.index ? srcGeo.toNonIndexed() : srcGeo.clone();
    g.applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    const list = buckets.get(mat);
    if (list) list.push(g);
    else buckets.set(mat, [g]);
  });
  for (const g of used) g.dispose();
  const out = new THREE.Group();
  for (const [mat, list] of buckets) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    const me = new THREE.Mesh(merged, mat);
    me.castShadow = shadows;
    me.receiveShadow = true;
    out.add(me);
  }
  return out;
}

export interface BuiltLot {
  group: THREE.Group;
  smoke: THREE.Vector3[];
  /** 이름표를 띄울 높이 */
  top: number;
}

/** 건물 한 자리 만들기 (자리 중심이 원점, 성벽만 성 중심이 원점) */
export function buildLot(key: BuildingKey, level: number, building: boolean, m: Mats): BuiltLot {
  const tier = tierOf(level);
  const c = newCtx(m, Math.max(1, tier));
  const lot = LOTS[key];
  let top: number;
  let scale = 1;
  if (key === "wall") {
    top = level > 0 ? buildWall(c, level) : 0;
    // 정문 자리 기준으로 옮겨 둔다 (엔진이 자리 위치에 놓는다)
    c.s.position.set(-lot.x, 0, -lot.z);
    c.d.position.set(-lot.x, 0, -lot.z);
    if (building) {
      const sc = newCtx(m);
      scaffold(sc, { x: 0, z: 0, w: 14, d: 6 }, 7);
      c.s.add(sc.s);
      sc.s.position.set(lot.x, 0, lot.z);
    }
    top = Math.max(top, 4);
  } else if (level <= 0) {
    top = emptyLot(c, lot);
    if (building) {
      scaffold(c, lot, 4);
      top = 4.5;
    }
  } else {
    top = BUILDERS[key](c, level);
    scale = TIER_SCALE[tier];
    if (building) scaffold(c, lot, Math.min(top * 0.8, 6));
  }
  const group = new THREE.Group();
  group.add(bake(c.s));
  group.add(c.d);
  group.scale.setScalar(scale);
  const offset = key === "wall" ? new THREE.Vector3(-lot.x, 0, -lot.z) : new THREE.Vector3();
  return { group, smoke: c.smoke.map((v) => v.clone().add(offset).multiplyScalar(scale)), top: top * scale };
}

// ───────── 성곽·땅·나무 ─────────


/** 길: 정문에서 본관까지 큰길 + 가로길 두 줄 + 성 밖 길 */
export const ROADS: Array<{ x: number; z: number; w: number; d: number; main?: boolean }> = [
  { x: 0, z: 11.5, w: 5, d: 53, main: true },
  { x: 0, z: 6, w: 66, d: 4 },
  { x: 0, z: 21, w: 66, d: 4 },
  { x: 0, z: 80, w: 5.5, d: 84, main: true },
  { x: -10, z: -11.5, w: 26, d: 3 },
  { x: 14, z: -11.5, w: 22, d: 3 },
  { x: -17, z: -11.5, w: 3, d: 35 },
  { x: 17, z: -11.5, w: 3, d: 35 },
];

/** 일꾼·백성이 걷는 길 (꺾은선) */
export const WALK_PATHS: Array<Array<[number, number]>> = [
  [
    [0, 70],
    [0, 36],
    [0, 6],
    [0, -12],
  ],
  [
    [-31, 6],
    [31, 6],
  ],
  [
    [-31, 21],
    [31, 21],
  ],
  [
    [0, 21],
    [-17, 21],
    [-17, -11.5],
    [17, -11.5],
    [17, 21],
  ],
  [
    [-30, 6],
    [-17, 6],
    [-17, -11],
  ],
];

export function buildStaticWorld(m: Mats): { group: THREE.Group; flags: THREE.Group; smoke: THREE.Vector3[] } {
  const out = new THREE.Group();
  // 땅
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), m.grass);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  out.add(ground);

  const c = newCtx(m);
  // 길
  for (const r of ROADS) {
    const g = new THREE.PlaneGeometry(r.w, r.d);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + r.x) / 6, (p.getZ(i) + r.z) / 6);
    put(c, g, r.main ? m.road : m.road, r.x, r.main ? 0.03 : 0.02, r.z);
    if (r.main) {
      for (const sx of [-1, 1]) {
        const eg = new THREE.PlaneGeometry(0.35, r.d);
        eg.rotateX(-Math.PI / 2);
        put(c, eg, m.stoneLight, r.x + (sx * r.w) / 2, 0.04, r.z);
      }
    }
  }

  // 성 안 장식: 연못과 정자
  const pond = new THREE.CircleGeometry(5.2, 28);
  pond.rotateX(-Math.PI / 2);
  pond.scale(1.25, 1, 0.85);
  put(c, pond, m.water, -21, 0.05, 29);
  const rim = new THREE.TorusGeometry(5.2, 0.35, 5, 28);
  rim.rotateX(Math.PI / 2);
  rim.scale(1.25, 1, 0.85);
  put(c, rim, m.stone, -21, 0.08, 29);
  for (const [lx, lz] of [
    [-24, 28],
    [-22.5, 31],
    [-18.5, 27.4],
    [-17.5, 30.4],
    [-25, 30.2],
  ] as const)
    cyl(c, 0.55, 0.55, 0.05, m.lotus, lx, 0.07, lz, 8);
  box(c, 0.8, 0.3, 4.4, m.wood, -15.0, 0.35, 29, 0.2);
  for (const [px, pz] of [
    [-19.6, 28.8],
    [-23.2, 28.8],
  ] as const)
    cyl(c, 0.2, 0.22, 0.6, m.stone, px, 0, pz, 6);
  hall(c, { x: -21.4, z: 28.8, y: 0.5, w: 3, d: 3, h: 1.8, base: 0.2, open: true, roofH: 1.4, over: 1.0, lift: 0.9 });
  // 우물
  cyl(c, 0.9, 1.0, 0.8, m.stone, 6, 0, 27, 10);
  box(c, 0.12, 1.8, 0.12, m.wood, 5.1, 0.8, 27);
  box(c, 0.12, 1.8, 0.12, m.wood, 6.9, 0.8, 27);
  box(c, 2.2, 0.14, 0.14, m.wood, 6, 2.5, 27);
  // 성 안 나무
  for (const [tx, tz, s] of [
    [-31, -29, 1],
    [31, -29, 0.9],
    [-31, 34, 1],
    [31, 34, 1.1],
    [-5, -28.5, 0.8],
    [5, -28.5, 0.8],
    [-31, 22, 0.8],
    [8, 32, 0.9],
    [-6, 31, 0.75],
    [31, 6.8, 0.7],
  ] as const)
    pine(c, tx, tz, s);
  roundTree(c, 30, 21.6, 0.8);
  roundTree(c, -3.5, 26.5, 0.9);

  // 성 밖: 초가 마을 + 숲 + 먼 산
  const r = rng(2026);
  for (const [hx, hz] of [
    [-14, 50],
    [-20, 58],
    [13, 52],
    [20, 61],
    [-11, 66],
  ] as const) {
    const ww = 4 + r() * 1.5;
    hall(c, { x: hx, z: hz, w: ww, d: 3, h: 1.9, base: 0.25, wall: m.mud, roof: "thatch", roofH: 1.3, over: 0.9, plain: true });
  }
  for (let i = 0; i < 150; i++) {
    const a = r() * Math.PI * 2;
    const rad = 46 + r() * 70;
    const tx = Math.cos(a) * rad * 1.05;
    const tz = Math.sin(a) * rad + 2;
    if (Math.abs(tx) < 9 && tz > 36) continue;
    if (Math.abs(tx) < 26 && tz > 44 && tz < 70) continue;
    if (r() < 0.65) pine(c, tx, tz, 0.9 + r() * 0.8);
    else roundTree(c, tx, tz, 0.9 + r() * 0.7);
  }
  const mc = newCtx(m);
  for (let i = 0; i < 14; i++) {
    const a = -Math.PI * 0.95 + (i / 13) * Math.PI * 0.9 + (r() - 0.5) * 0.15;
    const rad = 175 + r() * 60;
    cone(mc, 38 + r() * 30, 28 + r() * 26, m.mountain, Math.cos(a) * rad - 30, -1, Math.sin(a) * rad - 30, 9);
  }
  out.add(bake(c.s));
  out.add(bake(mc.s, false));

  return { group: out, flags: new THREE.Group(), smoke: [] };
}
