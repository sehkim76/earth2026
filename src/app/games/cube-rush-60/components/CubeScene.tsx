"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { CUBE_COLORS, cellKey, type CubeCell, type CubeColorIndex } from "../lib/puzzle";
import { FIRE_PER_SEC, MAX_BULLETS, SLOT_COUNT } from "../lib/engine";

export interface RemovalBurst {
  key: number;
  positions: Array<{ x: number; y: number; z: number }>;
  colorHex: string;
}

export interface BulletHit {
  x: number;
  y: number;
  z: number;
  slot: number;
}

export interface VolleyBatch {
  hits: BulletHit[];
  spawned: number;
  spawnedBySlot: number[];
  remainingBySlot: number[];
}

export interface SceneDebug {
  slots: Array<{ active: boolean; toSpawn: number; alive: number }>;
  vis: { checks: number; front: number; ndc: number; face: number; buried: number; back: number };
  alive: number;
  sample: string;
  cam: string;
  frames: number;
  maxMs: number;
}

export interface SceneEngine {
  startVolley: (slot: number, count: number, color: CubeColorIndex) => number;
  resetVolleys: () => void;
  getDebug: () => SceneDebug;
}

interface CubeSceneProps {
  cells: CubeCell[];
  burst: RemovalBurst | null;
  engineRef: { current: SceneEngine | null };
  paused: boolean;
  onBatch: (batch: VolleyBatch) => void;
  onVolleyDone: (slot: number) => void;
}

// 작은 큐브 규격 — 월드 변환(cellWorld·충돌 역함수·조준·파티클)은 모두 이 상수만 쓴다.
// 1/4 크기: SPACING 0.036, 박스·탄환·파티클·지터·등장 높이·발사점 하강·killY·
// 카메라 사거리·fog 모두 비례 축소. 핏 공식은 바운딩 기반이라 그대로 동작한다.
// 터널링 방지: 탄환 이동은 프레임당 SPACING 절반 이하씩 나눠 다단계 충돌 검사한다.
const SPACING = 0.036;
const Y_OFF = SPACING / 2; // 큐브 중심 높이 오프셋 (바닥 y=0 → 중심)
const BOX_SIZE = SPACING; // 빈틈없이 딱 맞게 (이웃과 면 공유)
const BULLET_R = 0.0094;
const PARTICLE_SIZE = 0.012;
const AIM_JITTER = 0.01; // 조준 지터 ±0.005
const SPAWN_LIFT = 0.175; // 신규 셀 등장 높이
const MIN_DIST = 1.6;
const MAX_DIST = 6.5;
const DEFAULT_DIST = 3;
const MAX_INSTANCES = 4096;
const MAX_PARTICLES = 1024;
const BURST_PARTICLES = 72;
const GHOST_LIFE = 0.28;
// 한 물리 스텝에서 탄환이 이동해도 되는 최대 거리 = 셀 절반 (터널링 방지 상한)
const MAX_STEP = SPACING / 2;

const BULLET_LIFE = 3;
const IDLE_MS = 2500;
const AUTO_THETA = 0.15;

function cellWorld(c: { x: number; y: number; z: number }, centerY: number): THREE.Vector3 {
  return new THREE.Vector3(c.x * SPACING, c.y * SPACING + Y_OFF, c.z * SPACING - centerY);
}

export default function CubeScene({
  cells,
  burst,
  engineRef,
  paused,
  onBatch,
  onVolleyDone,
}: CubeSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cellsRef = useRef(cells);
  const burstRef = useRef(burst);
  const pausedRef = useRef(paused);
  const batchRef = useRef(onBatch);
  const doneRef = useRef(onVolleyDone);
  const apiRef = useRef<SceneEngine | null>(null);
  const seenBurstKey = useRef<number>(-1);

  useEffect(() => {
    cellsRef.current = cells;
    burstRef.current = burst;
    pausedRef.current = paused;
    batchRef.current = onBatch;
    doneRef.current = onVolleyDone;
    if (apiRef.current) engineRef.current = apiRef.current;
  });

  useEffect(() => {
    const hostEl = hostRef.current;
    if (hostEl === null) return;
    const host: HTMLDivElement = hostEl;

    // ---------- renderer / scene ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setClearColor(new THREE.Color("#1A2340"));
    const pixelRatio = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      1.75,
    );
    renderer.setPixelRatio(pixelRatio);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.touchAction = "none";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#1A2340");
    scene.fog = new THREE.Fog(new THREE.Color("#1A2340"), 4.5, 7.5);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const target = new THREE.Vector3(0, 0.8, 0);
    // 구조물이 교체될 때마다 fitCamera가 바운딩에 맞춰 거리·타겟을 다시 잡는다.
    const orbit = { theta: 0.7, phi: 1.02, radius: DEFAULT_DIST };
    let autoFit = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xf3d9c2, 1.05);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(6, 10, 7);
    scene.add(dir);

    const board = new THREE.Group();
    scene.add(board);

    // ---------- InstancedMesh (단일 draw call) ----------
    const boxGeo = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
    const boxMat = new THREE.MeshLambertMaterial({ color: new THREE.Color("#ffffff") });
    const mesh = new THREE.InstancedMesh(boxGeo, boxMat, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    board.add(mesh);

    // ---------- 카툰 외곽선 (검은 반전헐, 1 draw call) ----------
    const OUTLINE_SCALE = 1.07;
    const outlineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#1f1b16"), side: THREE.BackSide });
    const outlineMesh = new THREE.InstancedMesh(boxGeo, outlineMat, MAX_INSTANCES);
    outlineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    outlineMesh.count = 0;
    outlineMesh.frustumCulled = false;
    outlineMesh.renderOrder = -1;
    board.add(outlineMesh);

    // ---------- 탄환 InstancedMesh (발사칸 색을 입힌 작은 구, 동시 256발 제한) ----------
    const bulletGeo = new THREE.SphereGeometry(BULLET_R, 8, 8);
    const bulletMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffffff") });
    const bullets = new THREE.InstancedMesh(bulletGeo, bulletMat, MAX_BULLETS);
    bullets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bullets.count = 0;
    bullets.frustumCulled = false;
    board.add(bullets);

    // ---------- 탄환 외곽선 (검은 반전헐, 시인성용) ----------
    const BULLET_OUTLINE_SCALE = 1.35;
    const bulletOutlineMesh = new THREE.InstancedMesh(bulletGeo, outlineMat, MAX_BULLETS);
    bulletOutlineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bulletOutlineMesh.count = 0;
    bulletOutlineMesh.frustumCulled = false;
    bulletOutlineMesh.renderOrder = -1;
    board.add(bulletOutlineMesh);

    // ---------- 제거 고스트 풀 (0.15초 스케일 축소 연출) ----------
    const ghostGeo = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
    const ghosts: Array<{ m: THREE.Mesh; life: number }> = [];
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color("#ffffff"),
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      const m = new THREE.Mesh(ghostGeo, mat);
      m.visible = false;
      board.add(m);
      ghosts.push({ m, life: 0 });
    }

    // ---------- 파티클 풀 (단일 Points draw call) ----------
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(MAX_PARTICLES * 3);
    const pCol = new Float32Array(MAX_PARTICLES * 3);
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
    const pMat = new THREE.PointsMaterial({
      size: PARTICLE_SIZE,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      sizeAttenuation: true,
      depthWrite: false,
    });
    const points = new THREE.Points(pGeo, pMat);
    points.frustumCulled = false;
    board.add(points);
    const pVel = new Float32Array(MAX_PARTICLES * 3);
    const pLife = new Float32Array(MAX_PARTICLES);
    let pCursor = 0;

    // ---------- 인스턴스 상태 (ref 전용, setState 없음) ----------
    const order: number[] = []; // instance index -> cell id
    const idMap = new Map<number, CubeCell>();
    let stableOff = 0;
    let prevIds = new Set<number>();
    const cur = new Float32Array(MAX_INSTANCES * 3);
    const dst = new Float32Array(MAX_INSTANCES * 3);
    const syncedIds = new Set<number>();

    // ---------- 탄환·Volley 엔진 상태 (ref 소유, 매 프레임 시뮬) ----------
    const bPos = new Float32Array(MAX_BULLETS * 3);
    const bVel = new Float32Array(MAX_BULLETS * 3);
    const bSlot = new Int8Array(MAX_BULLETS);
    const bColor = new Int8Array(MAX_BULLETS);
    const bTarget: string[] = new Array<string>(MAX_BULLETS).fill("");
    const bActive = new Uint8Array(MAX_BULLETS);
    const bLife = new Float32Array(MAX_BULLETS);
    let bCursor = 0;
    const volleys = Array.from({ length: SLOT_COUNT }, () => ({
      toSpawn: 0,
      alive: 0,
      acc: 0,
      active: false,
      color: 0 as CubeColorIndex,
      lastSpawnAt: 0,
    }));
    const aliveKeys = new Set<string>();
    const aliveColor = new Map<string, CubeColorIndex>();
    // 발사 전 확정 배정된 목표 집합. 탄환마다 고유 목표를 가져 중복 조준이 없다.
    const reserved = new Set<string>();
    const visStats = { checks: 0, front: 0, ndc: 0, face: 0, buried: 0, back: 0 };
    let killY = 2;

    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();
    const _vpv = new THREE.Vector3();
    const dbgLook = new THREE.Vector3(0, 0, -1);

    function centerOffset(list: CubeCell[]): number {
      if (list.length === 0) return 0;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const c of list) {
        minZ = Math.min(minZ, c.z);
        maxZ = Math.max(maxZ, c.z);
      }
      return ((minZ + maxZ) / 2) * SPACING;
    }

    function fitCamera(): void {
      const list = cellsRef.current;
      if (list.length === 0) return;
      let maxGX = 0;
      let maxGY = 0;
      let maxGZ = 0;
      for (const c of list) {
        maxGX = Math.max(maxGX, Math.abs(c.x));
        maxGY = Math.max(maxGY, c.y);
        maxGZ = Math.max(maxGZ, Math.abs(c.z));
      }
      const wx = (maxGX * 2 + 1) * SPACING;
      const wy = (maxGY + 1) * SPACING;
      const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const fitV = wy / 2 / Math.max(0.001, halfTan);
      const fitH = wx / 2 / Math.max(0.001, halfTan * Math.min(1, camera.aspect));
      const need = Math.max(fitV, fitH);
      target.y = wy / 2;
      orbit.radius = Math.max(MIN_DIST, Math.min(MAX_DIST, need * 1.35 + 0.19));
      scene.fog = new THREE.Fog(new THREE.Color("#1A2340"), orbit.radius + 1.25, orbit.radius + 3.75);
    }

    function repaint(): void {
      for (let i = 0; i < order.length; i++) {
        const cell = idMap.get(order[i]);
        if (!cell) continue;
        tmpColor.set(CUBE_COLORS[cell.color] ?? "#cccccc");
        mesh.setColorAt(i, tmpColor);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    function syncCells(animateDrop: boolean): void {
      const list = cellsRef.current;
      // 중앙 정렬은 구조물이 교체될 때만 다시 계산한다.
      // 제거 때마다 다시 계산하면 전체가 옆으로 밀려 어지러우므로 고정 유지.
      const curIds = new Set<number>();
      let overlap = false;
      for (const c of list) {
        curIds.add(c.id);
        if (prevIds.has(c.id)) overlap = true;
      }
      if (list.length > prevIds.size || !overlap) {
        stableOff = centerOffset(list);
        if (autoFit) fitCamera();
      }
      prevIds = curIds;
      const off = stableOff;
      // 충돌용 alive 좌표·색상 집합 갱신 + 사라진 셀의 reserved 정리
      aliveKeys.clear();
      aliveColor.clear();
      let maxWY = 0;
      for (const c of list) {
        const k = cellKey(c.x, c.y, c.z);
        aliveKeys.add(k);
        aliveColor.set(k, c.color);
        const wy = c.y * SPACING + Y_OFF;
        if (wy > maxWY) maxWY = wy;
      }
      for (const k of [...reserved]) {
        if (!aliveKeys.has(k)) reserved.delete(k);
      }
      if (list.length > 0) {
        killY = maxWY + 0.2;
      }
      // 애니메이션 시작점은 슬롯이 아니라 각 큐브 자신의 이전 위치에서 가져온다.
      // 슬롯 기준(cur[i] 유지)으로 두면 제거된 큐브 자리에 들어온 큐브가
      // 엉뚱한 곳에서 날아오는 것처럼 보인다. 읽기·쓰기 겹침 방지로 스냅샷 사용.
      const oldCur = cur.slice();
      const prevById = new Map<number, number>();
      for (let i = 0; i < order.length; i++) prevById.set(order[i], i);
      order.length = 0;
      idMap.clear();
      const n = Math.min(list.length, MAX_INSTANCES);
      for (let i = 0; i < n; i++) {
        const c = list[i];
        order.push(c.id);
        idMap.set(c.id, c);
        const w = cellWorld(c, off);
        dst[i * 3] = w.x;
        dst[i * 3 + 1] = w.y;
        dst[i * 3 + 2] = w.z;
        const prevIdx = prevById.get(c.id);
        if (prevIdx !== undefined && syncedIds.has(c.id)) {
          if (!animateDrop) {
            cur[i * 3] = dst[i * 3];
            cur[i * 3 + 1] = dst[i * 3 + 1];
            cur[i * 3 + 2] = dst[i * 3 + 2];
          } else {
            cur[i * 3] = oldCur[prevIdx * 3];
            cur[i * 3 + 1] = oldCur[prevIdx * 3 + 1];
            cur[i * 3 + 2] = oldCur[prevIdx * 3 + 2];
          }
          // animateDrop이면 자신의 이전 위치에서 시작 → lerp로 수직 낙하 연출
        } else {
          // 신규 셀: 위에서 떨어지며 등장
          cur[i * 3] = dst[i * 3];
          cur[i * 3 + 1] = dst[i * 3 + 1] + SPAWN_LIFT;
          cur[i * 3 + 2] = dst[i * 3 + 2];
        }
        syncedIds.add(c.id);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      // 외곽선 개수도 함께 맞춘다. 안 맞추면 지워진 자리에 검은 박스가 남는다.
      outlineMesh.count = n;
      outlineMesh.instanceMatrix.needsUpdate = true;
      // 인스턴스가 이동·추가될 때마다 바운딩 스피어를 갱신해야
      // 컬링 영역이 낡은 상태로 그려지지 않는다
      mesh.computeBoundingSphere();
      repaint();
    }

    function emitParticles(
      wx: number,
      wy: number,
      wz: number,
      col: THREE.Color,
      count: number,
      speed: number,
      life: number,
    ): void {
      for (let i = 0; i < count; i++) {
        const k = pCursor;
        pCursor = (pCursor + 1) % MAX_PARTICLES;
        pPos[k * 3] = wx;
        pPos[k * 3 + 1] = wy;
        pPos[k * 3 + 2] = wz;
        const shade = 0.75 + Math.random() * 0.45;
        pCol[k * 3] = Math.min(1, col.r * shade + 0.15);
        pCol[k * 3 + 1] = Math.min(1, col.g * shade + 0.15);
        pCol[k * 3 + 2] = Math.min(1, col.b * shade + 0.15);
        const a = Math.random() * Math.PI * 2;
        const up = speed * (0.6 + Math.random() * 0.8);
        const spread = speed * 0.5;
        pVel[k * 3] = Math.cos(a) * (0.5 + Math.random() * spread);
        pVel[k * 3 + 1] = up;
        pVel[k * 3 + 2] = Math.sin(a) * (0.5 + Math.random() * spread);
        pLife[k] = life * (0.8 + Math.random() * 0.4);
      }
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.color.needsUpdate = true;
    }

    function spawnBurst(b: RemovalBurst): void {
      const off = stableOff;
      const col = new THREE.Color(b.colorHex);
      const shown = b.positions.slice(0, 24);
      // 고스트 연출
      let gi = 0;
      for (const p of shown) {
        const g = ghosts[gi % ghosts.length];
        gi++;
        const w = cellWorld(p, off);
        g.m.position.copy(w);
        (g.m.material as THREE.MeshLambertMaterial).color.copy(col);
        (g.m.material as THREE.MeshLambertMaterial).opacity = 0.95;
        g.m.scale.setScalar(1.25);
        g.m.visible = true;
        g.life = GHOST_LIFE;
      }
      // 파티클 연출 (수 제한)
      const count = Math.min(BURST_PARTICLES, MAX_PARTICLES);
      for (let i = 0; i < count; i++) {
        const src = shown[i % Math.max(shown.length, 1)] ?? { x: 0, y: 1, z: 0 };
        const w = cellWorld(src, off);
        emitParticles(w.x, w.y, w.z, col, 1, 0.35, 0.9);
      }
    }

    // 마주봄 강도: 앞쪽·화면 안을 통과한 뒤 빈 이웃 방향 중 최대 내적.
    // -1이면 발사 불가(뒤·화면밖·완전매립). 진단 카운터는 기존 의미 유지.
    function faceDot(key: string): number {
      visStats.checks += 1;
      const parts = key.split(",");
      const gx = Number(parts[0]);
      const gy = Number(parts[1]);
      const gz = Number(parts[2]);
      const wx = gx * SPACING;
      const wy = gy * SPACING + Y_OFF;
      const wz = gz * SPACING - stableOff;
      // 시선 방향은 행렬이 아니라 궤도에서 직접 구한다 (stale matrix 의혹 제거).
      let lx = target.x - camera.position.x;
      let ly = target.y - camera.position.y;
      let lz = target.z - camera.position.z;
      const ll = Math.max(0.001, Math.sqrt(lx * lx + ly * ly + lz * lz));
      lx /= ll;
      ly /= ll;
      lz /= ll;
      dbgLook.set(lx, ly, lz);
      const dx = wx - camera.position.x;
      const dy = wy - camera.position.y;
      const dz = wz - camera.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.001) return 1;
      if ((dx * lx + dy * ly + dz * lz) / dist <= 0.1) return -1;
      visStats.front += 1;
      _vpv.set(wx, wy, wz).project(camera);
      if (_vpv.x < -1.05 || _vpv.x > 1.05 || _vpv.y < -1.05 || _vpv.y > 1.05) return -1;
      visStats.ndc += 1;
      const dirs: Array<[number, number, number]> = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      let best = -1;
      let hasEmpty = false;
      for (const [ox, oy, oz] of dirs) {
        if (aliveColor.has(`${gx + ox},${gy + oy},${gz + oz}`)) continue;
        hasEmpty = true;
        // 빈 이웃 방향이 카메라 반대(시선 역방향)와 맞으면 마주봄
        const d = ox * -lx + oy * -ly + oz * -lz;
        if (d > best) best = d;
      }
      if (!hasEmpty) {
        visStats.buried += 1;
        return -1;
      }
      if (best > 0.15) {
        visStats.face += 1;
      } else {
        visStats.back += 1;
      }
      return best;
    }

    // 발사 순간에 보이는 것 중 가장 정면인 목표를 하나 잡는다 (독점 예약).
    // 미리 모아두지 않으므로 카메라가 돌아도 항상 최신 정면이다.
    function pickBest(color: CubeColorIndex): string {
      let best = "";
      let bestF = 0.15;
      let bestD = Infinity;
      for (const [k, c] of aliveColor) {
        if (c !== color || reserved.has(k)) continue;
        const f = faceDot(k);
        if (f <= 0.15) continue;
        const parts = k.split(",");
        const dx = Number(parts[0]) * SPACING - camera.position.x;
        const dy = Number(parts[1]) * SPACING + Y_OFF - camera.position.y;
        const dz = Number(parts[2]) * SPACING - stableOff - camera.position.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (f > bestF || (f === bestF && d < bestD)) {
          best = k;
          bestF = f;
          bestD = d;
        }
      }
      return best;
    }

    function targetWorld(key: string): { x: number; y: number; z: number } {
      const parts = key.split(",");
      const gx = Number(parts[0]);
      const gy = Number(parts[1]);
      const gz = Number(parts[2]);
      return {
        x: gx * SPACING + (Math.random() - 0.5) * AIM_JITTER,
        y: gy * SPACING + Y_OFF + (Math.random() - 0.5) * AIM_JITTER,
        z: gz * SPACING - stableOff + (Math.random() - 0.5) * AIM_JITTER,
      };
    }

    function spawnBullet(slot: number, key: string): boolean {
      const v = volleys[slot];
      if (!v) return false;
      const t = targetWorld(key);
      // 발사 원점은 화면 정중앙 아래 한 점으로 고정한다 (슬롯 구분 없이 공유).
      // NDC 기준으로 직접 구하므로 카메라가 돌아도 항상 같은 화면 위치에서 나간다.
      // 화면 아래 살짝 바깥(NDC y=-1.1)에서 시작해 탄환이 화면 밖에서 들어오게 한다.
      let vx = camera.position.x - target.x;
      let vy = camera.position.y - target.y;
      let vz = camera.position.z - target.z;
      const vl = Math.max(0.001, Math.sqrt(vx * vx + vy * vy + vz * vz));
      vx /= vl;
      vy /= vl;
      vz /= vl;
      let rx = -vz;
      let rz = vx;
      const rl = Math.max(0.001, Math.sqrt(rx * rx + rz * rz));
      rx /= rl;
      rz /= rl;
      const ux = -rz * vy;
      const uy = rz * vx - rx * vz;
      const uz = rx * vy;
      // 화면 정중앙 아래(NDC x=0, y=-1.1), 카메라에서 구조물 방향으로 45% 지점
      const fovTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const D = vl * 0.45;
      const H = D * fovTan * 1.1;
      const lx = camera.position.x - vx * D - ux * H;
      const ly = camera.position.y - vy * D - uy * H;
      const lz = camera.position.z - vz * D - uz * H;
      const dx = t.x - lx;
      const dy = t.y - ly;
      const dz = t.z - lz;
      const dist = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      // 구조물까지 1.07초 내외 도달하는 탄속 (50% 증가)
      const speed = dist / 1.07;
      for (let bi = 0; bi < MAX_BULLETS; bi++) {
        const i = (bCursor + bi) % MAX_BULLETS;
        if (bActive[i] === 0) {
          bCursor = (i + 1) % MAX_BULLETS;
          bPos[i * 3] = lx;
          bPos[i * 3 + 1] = ly;
          bPos[i * 3 + 2] = lz;
          bVel[i * 3] = (dx / dist) * speed;
          bVel[i * 3 + 1] = (dy / dist) * speed;
          bVel[i * 3 + 2] = (dz / dist) * speed;
          bSlot[i] = slot;
          bColor[i] = v.color;
          bTarget[i] = key;
          bLife[i] = BULLET_LIFE;
          bActive[i] = 1;
          v.alive += 1;
          return true;
        }
      }
      return false;
    }

    function countAliveColor(color: CubeColorIndex): number {
      let n = 0;
      for (const c of aliveColor.values()) {
        if (c === color) n += 1;
      }
      return n;
    }

    function startVolley(slot: number, count: number, color: CubeColorIndex): number {
      if (slot < 0 || slot >= SLOT_COUNT) return 0;
      const v = volleys[slot];
      if (!v) return 0;
      // 보이는 목표 발사 조건: 같은 색 살아있는 큐브가 없으면 발사 없이 즉시 종료.
      // 미발사분은 버린다(탄약 소진 취급). 구조물에 그 색이 없으므로 밸런스 불변식 유지.
      if (countAliveColor(color) === 0) {
        v.toSpawn = 0;
        v.alive = 0;
        v.acc = 0;
        v.active = false;
        v.color = color;
        doneRef.current(slot);
        return 0;
      }
      // 목표는 발사 순간마다 현재 정면을 다시 잡는다 (미리 모아두지 않음).
      // 카메라가 돌아도 항상 최신 정면이라 뒷면 발사가 없다.
      v.toSpawn = Math.max(0, Math.floor(count));
      v.alive = 0;
      v.acc = 0;
      v.active = true;
      v.color = color;
      v.lastSpawnAt = performance.now();
      if (v.toSpawn === 0) {
        v.active = false;
        doneRef.current(slot);
      }
      return v.toSpawn;
    }

    // 새 게임 시작 시 호출: 진행 중 Volley·탄환·예약·동기화 기억을 전부 초기화.
    // 셀 id가 매치마다 0부터 다시 매겨져서 이전 판 흔적이 남으면 오동작한다.
    function resetVolleys(): void {
      for (const v of volleys) {
        v.toSpawn = 0;
        v.alive = 0;
        v.acc = 0;
        v.active = false;
        v.lastSpawnAt = 0;
      }
      bActive.fill(0);
      bTarget.fill("");
      reserved.clear();
      syncedIds.clear();
      prevIds = new Set<number>();
      // 새 게임은 카메라 정면 고정으로 시작 (이전 판 줌 각도 유지 안 함)
      orbit.theta = 0.7;
      orbit.phi = 1.02;
      autoFit = true;
    }

    function getDebug(): SceneDebug {
      const out: SceneDebug = {
        slots: volleys.map((v) => ({
          active: v?.active ?? false,
          toSpawn: v?.toSpawn ?? 0,
          alive: v?.alive ?? 0,
        })),
        vis: { ...visStats },
        alive: aliveColor.size,
        sample: "",
        cam: "",
        frames: 0,
        maxMs: 0,
      };
      // 첫 번째 활성 Volley 색상의 첫 번째 살아있는 셀을 해부
      for (const v of volleys) {
        if (v && v.active) {
          let key = "";
          for (const [k, c] of aliveColor) {
            if (c === v.color) {
              key = k;
              break;
            }
          }
          if (key === "") break;
          const parts = key.split(",");
          const gx = Number(parts[0]);
          const gy = Number(parts[1]);
          const gz = Number(parts[2]);
          const bits = [1, -1]
            .flatMap((s) => [`${gx + s},${gy},${gz}`, `${gx},${gy + s},${gz}`, `${gx},${gy},${gz + s}`])
            .map((k) => (aliveColor.has(k) ? "1" : "0"))
            .join("");
          out.sample = `${key}[${bits}]`;
          break;
        }
      }
      out.cam = `th${orbit.theta.toFixed(2)} ph${orbit.phi.toFixed(2)} r${orbit.radius.toFixed(1)} vd${dbgLook.x.toFixed(2)},${dbgLook.y.toFixed(2)},${dbgLook.z.toFixed(2)}`;
      out.frames = framesSinceDebug;
      framesSinceDebug = 0;
      out.maxMs = Math.round(frameMaxMs);
      frameMaxMs = 0;
      visStats.checks = 0;
      visStats.front = 0;
      visStats.ndc = 0;
      visStats.face = 0;
      visStats.buried = 0;
      visStats.back = 0;
      return out;
    }

    apiRef.current = { startVolley, resetVolleys, getDebug };

    function stepBullets(dt: number): void {
      const hits: BulletHit[] = [];
      let spawned = 0;
      const spawnedBySlot: number[] = [];
      for (let s = 0; s < volleys.length; s++) {
        const v = volleys[s];
        if (!v || !v.active || v.toSpawn <= 0) continue;
        // 발사 중 같은 색 목표가 0개가 되면 남은 toSpawn은 즉시 중단하고 버린다.
        if (countAliveColor(v.color) === 0) {
          v.toSpawn = 0;
          v.acc = 0;
          continue;
        }
        v.acc += dt * FIRE_PER_SEC;
        let n = Math.floor(v.acc);
        v.acc -= n;
        while (n > 0 && v.toSpawn > 0) {
          const key = pickBest(v.color);
          if (key === "") break;
          reserved.add(key);
          if (!spawnBullet(s, key)) {
            reserved.delete(key);
            break;
          }
          v.toSpawn -= 1;
          spawned += 1;
          spawnedBySlot[s] = (spawnedBySlot[s] ?? 0) + 1;
          n -= 1;
        }
        if (n > 0) v.acc = Math.min(v.acc + n, 1);
      }
      for (let i = 0; i < MAX_BULLETS; i++) {
        if (bActive[i] === 0) continue;
        bLife[i] -= dt;
        // 터널링 방지: 프레임 이동량을 셀 절반 이하 구간으로 나눠 매 구간마다 충돌 검사.
        // 탄속 공식(1.07초 도달)은 그대로 두고 검사만 촘촘히 한다.
        const vx = bVel[i * 3];
        const vy = bVel[i * 3 + 1];
        const vz = bVel[i * 3 + 2];
        const travel = Math.sqrt(vx * vx + vy * vy + vz * vz) * dt;
        const steps = Math.max(1, Math.min(64, Math.ceil(travel / MAX_STEP)));
        const sdt = dt / steps;
        let hit: BulletHit | null = null;
        let lost = false;
        for (let s = 0; s < steps; s++) {
          bPos[i * 3] += vx * sdt;
          bPos[i * 3 + 1] += vy * sdt;
          bPos[i * 3 + 2] += vz * sdt;
          const px = bPos[i * 3];
          const py = bPos[i * 3 + 1];
          const pz = bPos[i * 3 + 2];
          // 월드 좌표 → 그리드 셀 좌표 (cellWorld의 역함수, 동일 오프셋 사용)
          const gx = Math.round(px / SPACING);
          const gy = Math.round((py - Y_OFF) / SPACING);
          const gz = Math.round((pz + stableOff) / SPACING);
          const k = cellKey(gx, gy, gz);
          const slot = bSlot[i];
          const cellColor = aliveColor.get(k);
          // 명중은 자신의 배정 목표에만 인정한다. 목표는 발사 전 독점 배정되므로
          // 도착 시점에 항상 살아있고, 재조준(방향 전환)이 일어나지 않는다.
          if (k === bTarget[i] && cellColor !== undefined && cellColor === bColor[i]) {
            // 같은 색이면 탄당 1큐브 제거, 명중 후 소멸.
            // 다른 색은 그대로 통과한다 — 탄약=구조물 1:1 불변식을 위해 흡수 소멸 없음.
            hit = { x: gx, y: gy, z: gz, slot };
            break;
          } else if (py > killY || bLife[i] <= 0) {
            // 빗나간 탄환은 위로 날아가 소멸
            lost = true;
            break;
          }
        }
        if (hit !== null) {
          bActive[i] = 0;
          const vv = volleys[hit.slot];
          if (vv) vv.alive -= 1;
          hits.push(hit);
        } else if (lost) {
          bActive[i] = 0;
          const vv = volleys[bSlot[i]];
          if (vv) vv.alive -= 1;
        }
      }
      if (hits.length > 0 || spawned > 0) {
        const remainingBySlot: number[] = volleys.map((vv) => (vv ? vv.toSpawn : 0));
        batchRef.current({ hits, spawned, spawnedBySlot, remainingBySlot });
      }
      for (let s = 0; s < volleys.length; s++) {
        const v = volleys[s];
        if (!v || !v.active) continue;
        if (v.toSpawn === 0 && v.alive === 0) {
          v.active = false;
          doneRef.current(s);
        }
      }
    }

    function drawBullets(): void {
      let k = 0;
      for (let i = 0; i < MAX_BULLETS; i++) {
        if (bActive[i] === 0) continue;
        dummy.position.set(bPos[i * 3], bPos[i * 3 + 1], bPos[i * 3 + 2]);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        bullets.setMatrixAt(k, dummy.matrix);
        // 탄환색은 무조건 흰색 (논리 색상 bColor와 무관, 시인성용)
        tmpColor.set("#ffffff");
        bullets.setColorAt(k, tmpColor);
        dummy.scale.setScalar(BULLET_OUTLINE_SCALE);
        dummy.updateMatrix();
        bulletOutlineMesh.setMatrixAt(k, dummy.matrix);
        k++;
      }
      bullets.count = k;
      bullets.instanceMatrix.needsUpdate = true;
      if (bullets.instanceColor) bullets.instanceColor.needsUpdate = true;
      bulletOutlineMesh.count = k;
      bulletOutlineMesh.instanceMatrix.needsUpdate = true;
    }

    syncCells(false);

    // ---------- 조작: 드래그 회전 + 휠/pinch 줌 (구조물 탭은 아무 일도 하지 않음) ----------
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let rotating = false;
    let lastInteract = performance.now();

    const onPointerDown = (e: PointerEvent): void => {
      lastInteract = performance.now();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        rotating = true;
      } else if (pointers.size === 2) {
        rotating = false;
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      renderer.domElement.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent): void => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          lastInteract = performance.now();
          autoFit = false;
          orbit.radius = Math.max(MIN_DIST, Math.min(MAX_DIST, orbit.radius - (d - pinchDist) * 0.008));
        }
        pinchDist = d;
        return;
      }
      if (!rotating) return;
      lastInteract = performance.now();
      orbit.theta -= dx * 0.008;
      // 상하 제한 없음 (극점 뒤집힘만 방지). 아래에서 올려다보면 밑면도 보인다.
      orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbit.phi - dy * 0.006));
    };

    const onPointerUp = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        rotating = false;
      }
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        // 무시
      }
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      lastInteract = performance.now();
      autoFit = false;
      orbit.radius = Math.max(MIN_DIST, Math.min(MAX_DIST, orbit.radius + e.deltaY * 0.0025));
    };

    const el = renderer.domElement;
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    let lastW = 0;
    let lastH = 0;
    function resize(): void {
      const w = host.clientWidth || 320;
      const h = host.clientHeight || 320;
      // 같은 크기면 setSize 스킵 — 호출될 때마다 캔버스가 비워져 깜빡인다
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (autoFit) fitCamera();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ---------- React props 동기화 (재생성 없이 ref 경유 반영) ----------
    const onSync = (): void => {
      syncCells(true);
    };
    host.addEventListener("cube-rush-sync", onSync);

    // ---------- 프레임 루프 (setState 없음) ----------
    let raf = 0;
    let last = performance.now();
    const clock = { t: 0 };
    let framesSinceDebug = 0;
    let prevFrameT = performance.now();
    let frameMaxMs = 0;

    function frame(now: number): void {
      raf = requestAnimationFrame(frame);
      const gap = now - prevFrameT;
      prevFrameT = now;
      if (gap > frameMaxMs && gap < 1000) frameMaxMs = gap;
      framesSinceDebug += 1;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock.t += dt;

      // 외부 props 반영 (버스트 1회 소비)
      const b = burstRef.current;
      if (b && b.key !== seenBurstKey.current) {
        seenBurstKey.current = b.key;
        spawnBurst(b);
      }

      // 탄환 시뮬 + 충돌 (일시정지 중에는 동결)
      if (!pausedRef.current) {
        // 무조작 2.5초 후 Y축 시계방향 자동 회전. 조작 즉시 중단.
        // 일시정지 중에는 pausedRef가 true이므로 자동 회전도 함께 멈춘다.
        // 발사 대기(2초 무발사) 중이면 4배속으로 노출 탐색.
        if (now - lastInteract > IDLE_MS) {
          let starved = false;
          for (const v of volleys) {
            if (v && v.active && v.toSpawn > 0 && now - v.lastSpawnAt > 2000) {
              starved = true;
              break;
            }
          }
          orbit.theta += dt * AUTO_THETA * (starved ? 4 : 1);
        }
        stepBullets(dt);
      }
      drawBullets();

      // 큐브 lerp
      const n = order.length;
      let settling = false;
      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        const dx = dst[ix] - cur[ix];
        const dy = dst[ix + 1] - cur[ix + 1];
        const dz = dst[ix + 2] - cur[ix + 2];
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0.0003) {
          settling = true;
          const k = 1 - Math.pow(0.0001, dt);
          cur[ix] += dx * k;
          cur[ix + 1] += dy * k;
          cur[ix + 2] += dz * k;
        } else {
          cur[ix] = dst[ix];
          cur[ix + 1] = dst[ix + 1];
          cur[ix + 2] = dst[ix + 2];
        }
        dummy.position.set(cur[ix], cur[ix + 1], cur[ix + 2]);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        dummy.scale.setScalar(OUTLINE_SCALE);
        dummy.updateMatrix();
        outlineMesh.setMatrixAt(i, dummy.matrix);
      }
      if (settling || n !== mesh.count) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        outlineMesh.count = n;
        outlineMesh.instanceMatrix.needsUpdate = true;
      }

      // 고스트 축소
      for (const g of ghosts) {
        if (!g.m.visible) continue;
        g.life -= dt;
        const s = Math.max(0.01, (g.life / GHOST_LIFE) * 1.25);
        g.m.scale.setScalar(s);
        if (g.life <= 0) g.m.visible = false;
      }

      // 파티클 물리
      let pDirty = false;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (pLife[i] <= 0) continue;
        pDirty = true;
        pLife[i] -= dt;
        pVel[i * 3 + 1] -= 0.75 * dt;
        pPos[i * 3] += pVel[i * 3] * dt;
        pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
        pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
        if (pLife[i] <= 0) {
          pPos[i * 3 + 1] = -100;
        }
      }
      if (pDirty) pGeo.attributes.position.needsUpdate = true;

      // 카메라 + 살짝 떠 있는 느낌
      board.position.y = Math.sin(clock.t * 1.2) * 0.004;
      // 숨겨진 상태(메뉴·결과 화면)에서는 렌더 스킵
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      camera.position.set(
        target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
        target.y + orbit.radius * Math.cos(orbit.phi),
        target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
      );
      camera.lookAt(target);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("cube-rush-sync", onSync);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      boxGeo.dispose();
      boxMat.dispose();
      outlineMat.dispose();
      outlineMesh.dispose();
      bulletGeo.dispose();
      bulletMat.dispose();
      bulletOutlineMesh.dispose();
      ghostGeo.dispose();
      for (const g of ghosts) (g.m.material as THREE.Material).dispose();
      pGeo.dispose();
      pMat.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
    // 마운트 시 1회 생성. cells 하위 변경은 아래 effect에서 ref 경유로 반영한다.
  }, []);

  // cells 변경 → three 내부 동기화. 별도 effect로 분리해 재생성 없이 반영.
  useEffect(() => {
    // 이 effect는 cells 변경을 three 씬에 전달하기 위한 트리거다.
    // 실제 three 객체는 위 마운트 effect의 클로저가 소유하므로,
    // 여기서는 DOM 커스텀 이벤트로 전달한다.
    const host = hostRef.current;
    if (!host) return;
    host.dispatchEvent(new CustomEvent("cube-rush-sync"));
  }, [cells]);

  return <div ref={hostRef} className="cube-scene-host" aria-label="3D 큐브 구조물" />;
}
