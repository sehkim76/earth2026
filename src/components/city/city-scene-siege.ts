import * as THREE from "three";

import { wallStage } from "@/lib/city";
import { WALL } from "@/components/city/city-scene-models";

interface SiegeScene {
  group: THREE.Group;
  animate: (time: number) => void;
  dispose: () => void;
}

export function createSiegeScene(level: number, smokeTexture: THREE.Texture): SiegeScene {
  const group = new THREE.Group();
  const stage = wallStage(level);
  const deck = { palisade: 2.45, earth: 2.8, stone: WALL.h, grand: 4.8 }[stage];
  const boxGeometry = new THREE.BoxGeometry();
  const hatGeometry = new THREE.CylinderGeometry(0.32, 0.48, 0.23, 8);
  const materials: THREE.Material[] = [];
  const paint = (color: number): THREE.MeshStandardMaterial => {
    const material = new THREE.MeshStandardMaterial({ color });
    materials.push(material);
    return material;
  };
  const wood = paint(0x66402c);
  const skin = paint(0xdca87c);
  const dark = paint(0x25232a);
  const blue = paint(0x285984);
  const red = paint(0x9d3022);
  const steel = paint(0xf3e2c3);
  const box = (
    parent: THREE.Object3D, material: THREE.Material,
    x: number, y: number, z: number, w: number, h: number, d: number,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    parent.add(mesh);
    return mesh;
  };
  const soldier = (uniform: THREE.Material): { body: THREE.Group; arm: THREE.Group; legs: THREE.Mesh[] } => {
    const body = new THREE.Group();
    group.add(body);
    box(body, uniform, 0, 1.02, 0, 0.66, 0.86, 0.4);
    box(body, skin, 0, 1.63, 0.02, 0.39, 0.42, 0.35);
    const hat = new THREE.Mesh(hatGeometry, dark);
    hat.position.y = 1.92;
    body.add(hat);
    box(body, dark, 0, 0.83, 0, 0.68, 0.12, 0.44);
    const legs = [-0.19, 0.19].map((x) => box(body, dark, x, 0.31, 0, 0.22, 0.64, 0.25));
    const arm = new THREE.Group();
    arm.position.set(0.43, 1.27, 0);
    body.add(arm);
    box(arm, uniform, 0, 0, 0.22, 0.21, 0.21, 0.57);
    box(arm, wood, 0, 0.03, 0.78, 0.09, 0.09, 2.05);
    box(arm, steel, 0, 0.03, 1.89, 0.16, 0.12, 0.28);
    return { body, arm, legs };
  };

  const wallZ = WALL.z1;
  const positions = [-26, -17, 16, 25];
  const fighters = positions.map((x, i) => {
    const defender = soldier(blue);
    const attacker = soldier(red);
    const climber = soldier(red);
    if (stage === "palisade") {
      box(group, wood, x, deck - 0.12, wallZ - 0.9, 5, 0.24, 1.7);
      for (const offset of [-2, 2]) box(group, wood, x + offset, deck / 2, wallZ - 1.35, 0.22, deck, 0.22);
    }
    const topZ = wallZ + (stage === "palisade" ? 0.3 : 1.45);
    const reach = 3.3;
    const ladder = new THREE.Group();
    ladder.position.set(x + 0.8, 0, topZ + reach);
    ladder.rotation.x = -Math.atan2(reach, deck);
    group.add(ladder);
    const length = Math.hypot(deck, reach);
    for (const rail of [-0.48, 0.48]) box(ladder, wood, rail, length / 2, 0, 0.14, length, 0.14);
    for (let y = 0.36; y < length; y += 0.43) box(ladder, wood, 0, y, 0, 1.05, 0.12, 0.15);

    attacker.body.rotation.y = Math.PI;
    climber.body.rotation.y = Math.PI;
    return { x, phase: i * 1.7, defender, attacker, climber, topZ, reach };
  });
  const arrows = positions.map(() => box(group, steel, 0, 0, 0, 0.07, 0.07, 1.6));

  const fireHeight = deck + (stage === "earth" ? 0.9 : 0.35);
  const fires = [
    [-29, wallZ], [-13, wallZ], [12, wallZ], [29, wallZ], [WALL.x1, 20], [WALL.x0, 27],
  ].map(([x, z], i) => {
    const flames = [0xff4911, 0xffa321, 0xffe59a].map((color, layer) => {
      const material = new THREE.SpriteMaterial({
        map: smokeTexture, color, blending: THREE.AdditiveBlending, opacity: 0.88,
        depthWrite: false, toneMapped: false,
      });
      materials.push(material);
      const sprite = new THREE.Sprite(material);
      sprite.position.z = z + 0.3 + layer * 0.18;
      group.add(sprite);
      return sprite;
    });
    const smoke = Array.from({ length: 5 }, () => {
      const material = new THREE.SpriteMaterial({ map: smokeTexture, color: 0x292123, depthWrite: false, opacity: 0 });
      materials.push(material);
      const sprite = new THREE.Sprite(material);
      group.add(sprite);
      return sprite;
    });
    const light = new THREE.PointLight(0xff6524, 35, 13);
    light.position.set(x, fireHeight + 1.3, z + 1);
    if (i < 4) group.add(light);
    return { x, z, phase: i * 2.1, flames, smoke, light };
  });

  return {
    group,
    animate(time) {
      for (const [i, { x, phase, defender, attacker, climber, topZ, reach }] of fighters.entries()) {
        const t = time + phase;
        const thrust = Math.pow(Math.max(0, Math.sin(t * 4)), 3);
        defender.body.position.set(x + Math.sin(t * 2) * 0.65, deck, wallZ - 0.75 + thrust * 0.55);
        defender.body.rotation.y = Math.sin(t * 2) * 0.22;
        defender.arm.position.z = thrust * 0.65;
        defender.arm.rotation.x = -0.42 + thrust * 0.55;

        const climb = 0.1 + (0.5 - 0.5 * Math.cos(t * 1.4)) * 0.9;
        attacker.body.position.set(x + 0.8 + Math.sin(t * 2.6) * 0.5, deck, topZ - 0.2);
        attacker.arm.position.z = (1 - thrust) * 0.5;
        climber.body.position.set(x + 0.8, deck * climb, topZ + reach * (1 - climb) + 0.27);
        climber.arm.rotation.x = -0.8 + Math.sin(t * 8) * 0.32;
        for (const [side, leg] of climber.legs.entries()) leg.rotation.x = Math.sin(t * 8 + side * Math.PI) * 0.4;

        const flight = (t * 0.7) % 1;
        const direction = i % 2 === 0 ? 1 : -1;
        arrows[i].position.set(x - 1, deck + 1.5 + 16 * flight * (1 - flight), wallZ + (direction > 0 ? flight : 1 - flight) * 14);
        arrows[i].rotation.x = -Math.atan2(16 * (1 - 2 * flight), direction * 14);
      }
      for (const { x, z, phase, flames, smoke, light } of fires) {
        for (const [i, sprite] of flames.entries()) {
          const t = time * (7 + i) + phase;
          const flicker = Math.sin(t) * 0.5 + Math.sin(t * 2.3) * 0.25;
          sprite.position.x = x + Math.sin(t * 0.6) * 0.45;
          sprite.position.y = fireHeight + 0.85 - i * 0.19 + flicker * 0.38;
          sprite.scale.set(3.6 - i * 0.82, (5.1 - i * 1.1) * (1 + flicker * 0.28), 1);
          sprite.material.rotation = Math.sin(t) * 0.18;
        }
        for (const [i, sprite] of smoke.entries()) {
          const p = (time * 0.23 + i / smoke.length + phase) % 1;
          sprite.position.set(x + p * 5 + Math.sin(p * 10 + phase) * p, fireHeight + 2 + p * 13, z - p * 2);
          sprite.scale.setScalar(2.7 + p * 7);
          sprite.material.opacity = Math.sin(p * Math.PI) * 0.54;
        }
        light.intensity = 32 + Math.sin(time * 12 + phase) * 12;
      }
    },
    dispose() {
      group.removeFromParent();
      boxGeometry.dispose();
      hatGeometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
