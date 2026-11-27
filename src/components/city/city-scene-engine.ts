// 성 안 3D 장면 엔진: 렌더러·카메라(비스듬한 내려다보기)·끌기/집기 확대·건물 고르기·이름표 위치·백성·연기.

import * as THREE from "three";

import type { BuildingKey } from "@/lib/city";
import { LOTS, WALK_PATHS, WALL, buildLot, buildStaticWorld, createMaterials, type Mats } from "@/components/city/city-scene-models";
import { createCityInterface } from "@/components/city/city-scene-interface";
import { createSiegeScene } from "@/components/city/city-scene-siege";

export interface SceneLotState {
  key: BuildingKey;
  level: number;
  building: boolean;
}

export interface CityWorldOptions {
  onPick: (key: BuildingKey) => void;
  /** 건물 이름표 요소 (엔진이 매 프레임 위치를 옮긴다) */
  labelFor: (key: BuildingKey) => HTMLElement | null;
}

export type CityDistrict = "buildings" | "research" | "troops" | "workers";

const DISTRICT_LOTS = {
  research: "academy",
  troops: "barracks",
  workers: "camp",
} satisfies Record<Exclude<CityDistrict, "buildings">, BuildingKey>;

export interface CityWorld {
  setDistrict: (district: CityDistrict) => void;
  setSiege: (active: boolean, wallLevel: number) => void;
  setLots: (lots: SceneLotState[]) => void;
  setSelected: (key: BuildingKey | null) => void;
  /** 그 건물로 카메라를 옮긴다 */
  focus: (key: BuildingKey) => void;
  dispose: () => void;
}

interface LotEntry {
  sig: string;
  group: THREE.Group;
  top: number;
  smoke: SmokePuff[];
  animated: THREE.Object3D[];
}

interface SmokePuff {
  sprite: THREE.Sprite;
  origin: THREE.Vector3;
  phase: number;
}

interface Walker {
  obj: THREE.Group;
  arms: THREE.Group[];
  legs: THREE.Group[];
  path: Array<[number, number]>;
  lens: number[];
  total: number;
  s: number;
  dir: 1 | -1;
  speed: number;
  offset: number;
}

const YAW = Math.PI / 4;
const PITCH = 0.9;
const FOV = 32;
const MIN_DIST = 30;
const MAX_DIST = 165;

function disposeTree(root: THREE.Object3D, keepMats: Set<THREE.Material>): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mt of mats) if (!keepMats.has(mt)) mt.dispose();
    }
  });
}

function makeWalker(m: Mats, rnd: () => number): Pick<Walker, "obj" | "arms" | "legs"> {
  const obj = new THREE.Group();
  const robes = [0xe9ddbf, 0xd6dfe3, 0xb3c1a3, 0xc9a297, 0xd6bc8c];
  const robe = new THREE.MeshLambertMaterial({ color: robes[Math.floor(rnd() * robes.length)] });
  const skin = new THREE.MeshLambertMaterial({ color: 0xdcae83 });
  const part = (
    parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const body = part(obj, new THREE.CylinderGeometry(0.24, 0.30, 0.58, 8), robe, 0, 0.86, 0);
  body.scale.z = 0.77;
  body.castShadow = true;
  part(obj, new THREE.CylinderGeometry(0.277, 0.29, 0.06, 8), m.woodDark, 0, 0.66, 0).scale.z = 0.81;
  part(obj, new THREE.SphereGeometry(0.19, 9, 6), skin, 0, 1.28, 0.03).castShadow = true;
  part(obj, new THREE.CylinderGeometry(0.34, 0.35, 0.047, 12), m.dark, 0, 1.39, 0).castShadow = true;
  part(obj, new THREE.CylinderGeometry(0.11, 0.145, 0.22, 10), m.dark, 0, 1.5, 0);

  const arms: THREE.Group[] = [];
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.27, 1.05, 0);
    arm.rotation.z = side * 0.12;
    part(arm, new THREE.CylinderGeometry(0.095, 0.08, 0.34, 7), robe, 0, -0.15, 0);
    part(arm, new THREE.SphereGeometry(0.057, 6, 5), skin, 0, -0.34, 0);
    obj.add(arm);
    arms.push(arm);
    const leg = new THREE.Group();
    leg.position.set(side * 0.13, 0.65, 0);
    part(leg, new THREE.CylinderGeometry(0.102, 0.071, 0.50, 7), robe, 0, -0.24, 0);
    part(leg, new THREE.BoxGeometry(0.14, 0.11, 0.23), m.woodDark, 0, -0.56, 0.06);
    obj.add(leg);
    legs.push(leg);
  }
  if (rnd() < 0.45) {
    for (const side of [-1, 1]) {
      part(obj, new THREE.BoxGeometry(0.075, 0.85, 0.09), m.wood, side * 0.19, 0.88, -0.29).rotation.x = 0.12;
    }
    part(obj, new THREE.BoxGeometry(0.45, 0.1, 0.39), m.wood, 0, 1.02, -0.37);
    part(obj, new THREE.SphereGeometry(0.24, 8, 6), m.hay, 0, 1.21, -0.4).scale.set(1.05, 0.85, 0.85);
  }
  obj.scale.setScalar(1.28);
  return { obj, arms, legs };
}

export function createCityWorld(host: HTMLElement, opts: CityWorldOptions): CityWorld {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  host.appendChild(canvas);

  const interfaceRoot = host.closest<HTMLElement>("[data-city-interface]");
  const cityInterface = interfaceRoot ? createCityInterface(host, interfaceRoot) : null;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9d3c6);
  scene.fog = new THREE.Fog(0xb9d3c6, 150, 330);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 900);

  const hemi = new THREE.HemisphereLight(0xe9f1ee, 0x697858, 1.48);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe5be, 2.7);
  sun.position.set(52, 75, 40);
  sun.shadow.radius = 2;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -62;
  sc.right = 62;
  sc.top = 62;
  sc.bottom = -62;
  sc.near = 10;
  sc.far = 220;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.target.position.set(0, 0, 2);
  scene.add(sun, sun.target);

  const { mats, tex } = createMaterials();
  const sharedMats = new Set<THREE.Material>(Object.values(mats));

  const world = buildStaticWorld(mats);
  scene.add(world.group, world.flags);
  const flagMeshes: THREE.Object3D[] = [...world.flags.children];

  // ── 건물 자리 ──
  const lotRoot = new THREE.Group();
  scene.add(lotRoot);
  const lots = new Map<BuildingKey, LotEntry>();
  const pickRoot = new THREE.Group();
  scene.add(pickRoot);
  const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
  for (const [key, lot] of Object.entries(LOTS) as Array<[BuildingKey, (typeof LOTS)[BuildingKey]]>) {
    const pb = new THREE.Mesh(new THREE.BoxGeometry(lot.w * 0.9, 9, lot.d * 0.9), pickMat);
    pb.position.set(lot.x, 4.5, lot.z);
    pb.userData.key = key;
    pickRoot.add(pb);
  }

  const smokeMatBase = new THREE.SpriteMaterial({ map: tex.smoke, color: 0xdedad2, transparent: true, depthWrite: false, opacity: 0.6 });
  const makeSmoke = (origin: THREE.Vector3): SmokePuff[] => {
    const out: SmokePuff[] = [];
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Sprite(smokeMatBase.clone());
      sp.scale.setScalar(1);
      scene.add(sp);
      out.push({ sprite: sp, origin: origin.clone(), phase: i / 6 });
    }
    return out;
  };

  // 선택 고리
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  ring.visible = false;
  scene.add(ring);
  let selected: BuildingKey | null = null;

  // ── 백성 ──
  const rnd = (() => {
    let a = 99;
    return () => {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      return a / 0x7fffffff;
    };
  })();
  const walkers: Walker[] = [];
  const walkerRoot = new THREE.Group();
  scene.add(walkerRoot);
  for (let i = 0; i < 16; i++) {
    const path = WALK_PATHS[i % WALK_PATHS.length];
    const lens: number[] = [];
    let total = 0;
    for (let j = 1; j < path.length; j++) {
      const l = Math.hypot(path[j][0] - path[j - 1][0], path[j][1] - path[j - 1][1]);
      lens.push(l);
      total += l;
    }
    const body = makeWalker(mats, rnd);
    walkerRoot.add(body.obj);
    walkers.push({ ...body, path, lens, total, s: rnd() * total, dir: rnd() < 0.5 ? 1 : -1, speed: 1.3 + rnd() * 0.9, offset: (rnd() - 0.5) * 2.2 });
  }

  // ── 카메라 조작 ──
  const cam = { tx: 0, tz: 4, dist: 92 };
  let district: CityDistrict = "buildings";
  let framing: { x: number; z: number; distance: number } | null = null;
  let overview = { ...cam };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const fitDist = (): number => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    return w / h < 0.75 ? 135 : 100;
  };
  cam.dist = fitDist();
  const placeCamera = (): void => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    const narrow = w < 768;
    const panelOpen = district !== "buildings" || selected !== null;
    camera.setViewOffset(w, h, panelOpen && !narrow ? w * 0.17 : 0, panelOpen && narrow ? h * 0.16 : -h * 0.075, w, h);
    cam.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, cam.dist));
    cam.tx = Math.max(WALL.x0 - 4, Math.min(WALL.x1 + 4, cam.tx));
    cam.tz = Math.max(WALL.z0 - 4, Math.min(WALL.z1 + 10, cam.tz));
    const hor = Math.cos(PITCH) * cam.dist;
    camera.position.set(cam.tx + Math.sin(YAW) * hor, Math.sin(PITCH) * cam.dist, cam.tz + Math.cos(YAW) * hor);
    camera.lookAt(cam.tx, 0, cam.tz);
  };

  const resize = (): void => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    placeCamera();
  };
  resize();
  placeCamera();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const pointers = new Map<number, { x: number; y: number }>();
  let moved = 0;
  let pinchDist = 0;
  let vel = { x: 0, z: 0 };
  let lastMoveAt = 0;

  const worldPerPx = (): number => (2 * cam.dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / Math.max(1, host.clientHeight);
  const panBy = (dx: number, dy: number): { x: number; z: number } => {
    const k = worldPerPx();
    // 화면 오른쪽 = (cos, -sin), 화면 위 = (-sin, -cos) (땅 위)
    const rx = Math.cos(YAW);
    const rz = -Math.sin(YAW);
    const fx = -Math.sin(YAW);
    const fz = -Math.cos(YAW);
    const ddx = -dx * k * rx + (dy * k * fx) / Math.sin(PITCH);
    const ddz = -dx * k * rz + (dy * k * fz) / Math.sin(PITCH);
    cam.tx += ddx;
    cam.tz += ddz;
    placeCamera();
    return { x: ddx, z: ddz };
  };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickAt = (clientX: number, clientY: number): void => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickRoot.children, false)[0];
    const key = hit?.object.userData.key as BuildingKey | undefined;
    if (key && district === "buildings") opts.onPick(key);
  };

  const onDown = (e: PointerEvent): void => {
    framing = null;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      moved = 999;
    }
    vel = { x: 0, z: 0 };
  };
  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      const d = panBy(dx, dy);
      const now = performance.now();
      const dt = Math.max(8, now - lastMoveAt);
      lastMoveAt = now;
      vel = { x: (d.x / dt) * 16, z: (d.z / dt) * 16 };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const nd = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && nd > 0) {
        cam.dist *= pinchDist / nd;
        placeCamera();
      }
      pinchDist = nd;
    }
  };
  const onUp = (e: PointerEvent): void => {
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (wasSingle && moved < 8) {
      vel = { x: 0, z: 0 };
      pickAt(e.clientX, e.clientY);
    }
    if (performance.now() - lastMoveAt > 80) vel = { x: 0, z: 0 };
    if (pointers.size < 2) pinchDist = 0;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    framing = null;
    cam.dist *= Math.exp(e.deltaY * 0.0012);
    placeCamera();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // ── 이름표 ──
  const tmp = new THREE.Vector3();
  const placeLabels = (): void => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    const hideAll = cam.dist > 150;
    const districtLot = district === "buildings" ? null : DISTRICT_LOTS[district];
    for (const key of Object.keys(LOTS) as BuildingKey[]) {
      const el = opts.labelFor(key);
      if (!el) continue;
      const lot = LOTS[key];
      const entry = lots.get(key);
      tmp.set(lot.x, (entry?.top ?? 3) + 0.8, lot.z).project(camera);
      if (hideAll || (districtLot && key !== districtLot) || tmp.z > 1 || tmp.x < -1.3 || tmp.x > 1.3 || tmp.y < -1.3 || tmp.y > 1.3) {
        el.style.visibility = "hidden";
        continue;
      }
      const sx = ((tmp.x + 1) / 2) * w;
      const sy = ((1 - tmp.y) / 2) * h;
      const blocked = cityInterface?.overlapsLabel(sx, sy, el.offsetWidth, el.offsetHeight);
      el.style.visibility = blocked ? "hidden" : "visible";
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
    }
  };

  // ── 매 프레임 ──
  let siege: ReturnType<typeof createSiegeScene> | null = null;
  let raf = 0;
  let last = performance.now();
  const clock0 = last;
  const animate = (): void => {
    raf = requestAnimationFrame(animate);
    const now = performance.now();
    const frameTime = Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.05, frameTime);
    last = now;
    const t = (now - clock0) / 1000;
    siege?.animate(t);

    if (framing) {
      const weight = reducedMotion.matches ? 1 : 1 - Math.exp(-frameTime * 8);
      cam.tx = THREE.MathUtils.lerp(cam.tx, framing.x, weight);
      cam.tz = THREE.MathUtils.lerp(cam.tz, framing.z, weight);
      cam.dist = THREE.MathUtils.lerp(cam.dist, framing.distance, weight);
      if (Math.abs(cam.tx - framing.x) + Math.abs(cam.tz - framing.z) + Math.abs(cam.dist - framing.distance) < 0.1) framing = null;
      placeCamera();
    }

    if (pointers.size === 0 && (Math.abs(vel.x) > 0.002 || Math.abs(vel.z) > 0.002)) {
      cam.tx += vel.x;
      cam.tz += vel.z;
      vel.x *= 0.9;
      vel.z *= 0.9;
      placeCamera();
    }

    for (const f of flagMeshes) {
      const ph = f.userData.wave as number;
      f.rotation.y = Math.sin(t * 2.2 + ph) * 0.35 + 0.2;
      f.rotation.z = Math.sin(t * 3.1 + ph) * 0.05;
    }
    for (const entry of lots.values()) {
      for (const o of entry.animated) {
        if (typeof o.userData.wave === "number") {
          const ph = o.userData.wave as number;
          o.rotation.y = Math.sin(t * 2.2 + ph) * 0.35 + 0.2;
        } else if (typeof o.userData.pulse === "number") {
          const ph = o.userData.pulse as number;
          o.scale.setScalar(0.88 + Math.sin(t * 3 + ph * 5) * 0.12);
        }
      }
      for (const p of entry.smoke) {
        const a = (t * 0.22 + p.phase) % 1;
        p.sprite.position.set(p.origin.x + Math.sin(a * 3 + p.phase * 9) * 0.5 + a * 1.4, p.origin.y + a * 5.5, p.origin.z - a * 0.8);
        p.sprite.scale.setScalar(0.8 + a * 2.6);
        (p.sprite.material as THREE.SpriteMaterial).opacity = 0.55 * (1 - a) * Math.min(1, a * 6);
      }
    }

    for (const wk of walkers) {
      wk.s += wk.dir * wk.speed * dt;
      if (wk.s > wk.total) {
        wk.s = wk.total;
        wk.dir = -1;
      } else if (wk.s < 0) {
        wk.s = 0;
        wk.dir = 1;
      }
      let rem = wk.s;
      let j = 0;
      while (j < wk.lens.length - 1 && rem > wk.lens[j]) {
        rem -= wk.lens[j];
        j++;
      }
      const [ax, az] = wk.path[j];
      const [bx, bz] = wk.path[j + 1];
      const f = wk.lens[j] > 0 ? rem / wk.lens[j] : 0;
      const dx = (bx - ax) / (wk.lens[j] || 1);
      const dz = (bz - az) / (wk.lens[j] || 1);
      // 길 한쪽으로 비켜 걷기
      const px = ax + (bx - ax) * f + -dz * wk.offset;
      const pz = az + (bz - az) * f + dx * wk.offset;
      const stride = reducedMotion.matches ? 0 : Math.sin(t * 7 + wk.offset * 5) * 0.42;
      wk.arms[0].rotation.x = stride;
      wk.arms[1].rotation.x = -stride;
      wk.legs[0].rotation.x = -stride;
      wk.legs[1].rotation.x = stride;
      wk.obj.position.set(px, Math.abs(stride) * 0.11, pz);
      wk.obj.rotation.y = Math.atan2(dx * wk.dir, dz * wk.dir);
    }

    if (selected && ring.visible) {
      const k = 1 + Math.sin(t * 4) * 0.04;
      const lot = LOTS[selected];
      ring.scale.set(Math.max(lot.w, lot.d) * 0.62 * k, Math.max(lot.w, lot.d) * 0.62 * k, 1);
      ringMat.opacity = 0.6 + Math.sin(t * 4) * 0.25;
    }

    if (!renderer.getContext().isContextLost()) {
      renderer.render(scene, camera);
      cityInterface?.render(renderer);
      placeLabels();
    } else if (interfaceRoot) {
      delete interfaceRoot.dataset.cityWebgl;
    }
  };
  raf = requestAnimationFrame(animate);

  const clearLot = (entry: LotEntry): void => {
    lotRoot.remove(entry.group);
    disposeTree(entry.group, sharedMats);
    for (const p of entry.smoke) {
      scene.remove(p.sprite);
      p.sprite.material.dispose();
    }
  };

  return {
    setDistrict(next) {
      if (district === next) return;
      if (district === "buildings" && !selected) overview = { ...cam };
      district = next;
      vel = { x: 0, z: 0 };
      if (next === "buildings") {
        framing = { x: overview.tx, z: overview.tz, distance: overview.dist };
      } else {
        const lot = LOTS[DISTRICT_LOTS[next]];
        framing = { x: lot.x, z: lot.z, distance: host.clientWidth < 768 ? 55 : 58 };
      }
      placeCamera();
    },
    setSiege(active, wallLevel) {
      const wasActive = siege !== null;
      siege?.dispose();
      siege = active ? createSiegeScene(wallLevel, tex.smoke) : null;
      if (!siege) return;
      scene.add(siege.group);
      if (!wasActive && district === "buildings") {
        const narrow = host.clientWidth / Math.max(1, host.clientHeight) < 0.75;
        cam.tx = narrow ? 15 : 0;
        cam.tz = WALL.z1 + (narrow ? 2 : 0);
        cam.dist = Math.min(cam.dist, 76);
        placeCamera();
      }
    },
    setLots(next) {
      for (const l of next) {
        const sig = `${l.level}|${l.building ? 1 : 0}`;
        const cur = lots.get(l.key);
        if (cur && cur.sig === sig) continue;
        if (cur) clearLot(cur);
        const built = buildLot(l.key, l.level, l.building, mats);
        const lot = LOTS[l.key];
        built.group.position.set(lot.x, 0, lot.z);
        lotRoot.add(built.group);
        const animated: THREE.Object3D[] = [];
        built.group.traverse((o) => {
          if (typeof o.userData.wave === "number" || typeof o.userData.pulse === "number") animated.push(o);
        });
        const smoke = built.smoke.flatMap((v) => makeSmoke(v.clone().add(new THREE.Vector3(lot.x, 0, lot.z))));
        lots.set(l.key, { sig, group: built.group, top: built.top, smoke, animated });
      }
    },
    setSelected(key) {
      const previous = selected;
      selected = key;
      if (district === "buildings" && key !== previous) {
        if (key) {
          if (!previous) overview = { ...cam };
          const lot = LOTS[key];
          framing = { x: lot.x, z: lot.z, distance: Math.min(cam.dist, 68) };
        } else {
          framing = { x: overview.tx, z: overview.tz, distance: overview.dist };
        }
        vel = { x: 0, z: 0 };
        placeCamera();
      }
      if (key) {
        const lot = LOTS[key];
        ring.position.set(lot.x, 0.12, lot.z);
        ring.visible = true;
      } else {
        ring.visible = false;
      }
    },
    focus(key) {
      const lot = LOTS[key];
      cam.tx = lot.x;
      cam.tz = lot.z + 6;
      cam.dist = Math.min(cam.dist, 70);
      placeCamera();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      for (const entry of lots.values()) clearLot(entry);
      lots.clear();
      siege?.dispose();
      cityInterface?.dispose();
      disposeTree(scene, new Set());
      smokeMatBase.dispose();
      for (const tx of tex.all) tx.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
