import * as THREE from "three";

import type { BuildingKey } from "@/lib/city";
import { bake, type Mats } from "@/components/city/city-scene-models";

export interface CityOperation {
  group: THREE.Group;
  animate: (time: number) => void;
}

/** 각 마당 앞 작업 공간. 좌표는 해당 건물의 원점 기준이다. */
export function createCityOperation(key: Exclude<BuildingKey, "wall">, m: Mats): CityOperation {
  const group = new THREE.Group();
  const fixed = new THREE.Group();
  let animate: (time: number) => void;
  const block = (parent: THREE.Group, mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const body = new THREE.Group();
  const arm = new THREE.Group();
  arm.position.set(0.28, 1.08, 0);
  const scholar = key === "academy" || key === "keep";
  const coat = scholar ? m.lintel : m.bracket;
  block(body, coat, 0, 0.82, 0, 0.5, 0.68, 0.39);
  block(body, m.woodDark, 0, 0.63, 0, 0.51, 0.09, 0.4);
  block(body, m.mud, 0, 1.33, 0, 0.33, 0.35, 0.32);
  block(body, m.dark, 0, 1.56, 0, 0.45, 0.13, 0.41);
  if (scholar) block(body, m.dark, 0, 1.69, 0, 0.29, 0.2, 0.29);
  for (const side of [-1, 1]) block(body, m.plaster, side * 0.14, 0.25, 0, 0.19, 0.5, 0.22);
  block(body, coat, -0.28, 1, 0.17, 0.17, 0.18, 0.45);
  block(arm, coat, 0, 0, 0.18, 0.19, 0.2, 0.41);
  block(arm, m.mud, 0, -0.02, 0.42, 0.14, 0.15, 0.16);
  const actor = new THREE.Group();
  const figure = bake(body);
  actor.add(figure, arm);
  group.add(actor);
  group.scale.setScalar(1.35);
  group.position.set(0, 0.12, 4.7);
  const bench = (): void => {
    block(fixed, m.plank, 0, 0.8, 0.9, 1.65, 0.13, 0.86);
    for (const side of [-1, 1]) block(fixed, m.woodDark, side * 0.62, 0.4, 0.9, 0.14, 0.8, 0.64);
  };
  const strike = (t: number): void => {
    const beat = (t * 0.85) % 1;
    arm.rotation.x = -1.55 * THREE.MathUtils.smoothstep(beat, 0, 0.65) * (1 - THREE.MathUtils.smoothstep(beat, 0.65, 0.82));
  };
  switch (key) {
    case "academy":
    case "keep": {
      group.position.set(key === "keep" ? 3 : -0.75, 0.12, key === "keep" ? 9.8 : 4.2);
      bench();
      block(fixed, m.plaster, 0.15, 0.90, 0.86, 0.92, 0.05, 0.65);
      for (let i = 0; i < 4; i++) block(fixed, m.iron, -0.12 + i * 0.105, 0.932, 0.84, 0.026, 0.01, 0.34);
      block(fixed, m.dark, 0.68, 0.91, 0.95, 0.23, 0.1, 0.2);
      block(arm, m.woodDark, 0, 0.15, 0.48, 0.065, 0.55, 0.065).rotation.x = -0.16;
      block(arm, m.dark, 0, -0.17, 0.52, 0.053, 0.13, 0.053);
      const leaf = new THREE.Group();
      leaf.position.set(0.03, 0.94, 0.86);
      block(leaf, m.plaster, 0.28, 0, 0, 0.56, 0.025, 0.62);
      for (const line of [0.16, 0.27, 0.38]) block(leaf, m.iron, line, 0.017, 0, 0.019, 0.01, 0.35);
      group.add(leaf);
      // 붓을 들어 벼루에 찍고 다시 원고 위에 몇 획을 긋는다.
      animate = (t) => {
        const dip = Math.max(0, Math.sin(t * 1.4)) ** 5;
        arm.position.set(0.16 + 0.4 * dip + 0.10 * Math.sin(t * 5.6), 1.14 + 0.08 * Math.sin(t * 2.8), 0.30 + 0.10 * Math.cos(t * 5.6));
        arm.rotation.z = 0.08 * Math.cos(t * 5.6);
        leaf.rotation.z = Math.PI * THREE.MathUtils.smoothstep((t / 4.5) % 1, 0.65, 0.96);
      };
      break;
    }
    case "sawmill": {
      bench();
      block(fixed, m.trunk, 0, 1.0, 0.86, 1.8, 0.29, 0.31);
      block(arm, m.iron, 0, -0.02, 0.83, 0.08, 0.21, 1.0);
      for (let i = 0; i < 6; i++) block(arm, m.iron, 0, -0.15, 0.56 + i * 0.13, 0.08, 0.12, 0.12).rotation.x = 0.65;
      animate = (t) => { arm.position.z = Math.sin(t * 4) * 0.27; };
      break;
    }
    case "forge":
    case "quarry":
    case "mint": {
      block(fixed, key === "quarry" ? m.rock : m.iron, 0.2, 0.43, 0.8, 0.92, 0.85, 0.65);
      if (key !== "quarry") block(fixed, key === "mint" ? m.gold : m.fire, 0.25, 0.88, 0.79, 0.36, 0.08, 0.25);
      block(arm, m.wood, 0, -0.01, 0.60, 0.09, 0.10, 0.55);
      block(arm, m.iron, 0, -0.06, 0.86, key === "quarry" ? 0.68 : 0.34, 0.21, 0.21);
      if (key === "mint") {
        for (let i = 0; i < 4; i++) block(fixed, m.gold, -0.47, 0.06 + 0.08 * i, 0.86, 0.36, 0.07, 0.32);
      }
      animate = strike;
      break;
    }
    case "storehouse":
    case "camp": {
      block(arm, m.plank, -0.26, -0.09, 0.55, 0.66, 0.45, 0.46);
      block(arm, m.hay, -0.26, -0.09, 0.56, 0.095, 0.47, 0.48);
      animate = (t) => {
        const step = t * 1.1;
        actor.position.set(1.35 * Math.sin(step), Math.abs(Math.sin(t * 5)) * 0.055, 0.32 * Math.cos(step));
        actor.rotation.y = Math.atan2(1.35 * Math.cos(step), -0.32 * Math.sin(step));
      };
      break;
    }
    case "barracks": {
      block(arm, m.woodDark, 0, 0.02, 0.67, 0.08, 0.08, 1.72);
      block(arm, m.iron, 0, 0.02, 1.57, 0.15, 0.11, 0.23);
      animate = (t) => {
        const thrust = Math.max(0, Math.sin(t * 3.6)) ** 2;
        arm.position.z = 0.39 * thrust;
        arm.rotation.x = -0.48 * (1 - thrust);
        actor.position.z = 0.22 * thrust;
      };
      break;
    }
    case "range": {
      group.position.set(0.8, 0.05, 2.7);
      group.rotation.y = Math.PI;
      const bow = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.28, 0.39, 0.43), new THREE.Vector3(-0.28, 0.99, 0.66), new THREE.Vector3(-0.28, 1.64, 0.43)]);
      fixed.add(new THREE.Mesh(new THREE.TubeGeometry(bow, 8, 0.045, 5, false), m.woodDark));
      const arrow = block(group, m.iron, -0.26, 1.02, 0.5, 0.055, 0.055, 0.68);
      animate = (t) => {
        const beat = (t * 0.55) % 1;
        arm.position.z = -0.27 * Math.sin(Math.PI * Math.min(1, beat / 0.7));
        arrow.position.z = 0.68 + 3.65 * THREE.MathUtils.smoothstep(beat, 0.7, 0.91);
        arrow.visible = beat < 0.95;
      };
      break;
    }
    case "stable": {
      group.position.set(0, 0.08, 4.1);
      const horse = new THREE.Group();
      block(horse, m.horse, 0, 0.88, 0, 0.57, 0.57, 1.25);
      block(horse, m.horseDark, 0, 1.25, 0.53, 0.36, 0.7, 0.34).rotation.x = 0.27;
      block(horse, m.horse, 0, 1.55, 0.76, 0.33, 0.31, 0.55);
      for (const x of [-0.2, 0.2]) for (const z of [-0.42, 0.42]) block(horse, m.horseDark, x, 0.36, z, 0.14, 0.72, 0.15);
      actor.add(bake(horse));
      // 말과 기수가 함께 고삐를 잡고 작은 원을 돈다.
      figure.position.y = 0.74;
      arm.position.y += 0.74;
      animate = (t) => {
        actor.position.set(1.5 * Math.sin(t), Math.abs(Math.sin(t * 6)) * 0.10, 0.55 * Math.cos(t));
        actor.rotation.y = Math.atan2(1.5 * Math.cos(t), -0.55 * Math.sin(t));
      };
      break;
    }
    case "tower": {
      block(arm, m.woodDark, 0, 0.16, 0.45, 0.085, 1.15, 0.085);
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26), m.orb);
      group.add(orb);
      animate = (t) => {
        arm.rotation.x = -0.35 - 0.3 * Math.sin(t * 2);
        orb.position.set(0.28 + Math.cos(t * 2) * 0.25, 2.2 + 0.35 * Math.sin(t * 2), 0.64);
        orb.scale.setScalar(1 + 0.2 * Math.sin(t * 4));
      };
      break;
    }
  }
  group.add(bake(fixed));
  return { group, animate };
}
