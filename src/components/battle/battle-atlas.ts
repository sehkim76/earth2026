// scripts/build-battle-art.py 가 생성한 파일 — 직접 수정하지 말 것.
// 전투 픽셀 아트 아틀라스 좌표표.

export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const BATTLE_ATLAS_URL = "/battle/battle-atlas.png";
export const BATTLE_ATLAS_WIDTH = 256;
export const BATTLE_ATLAS_HEIGHT = 208;

export const BATTLE_ATLAS: Readonly<Record<string, AtlasRect>> = {
  "banner-ally": { x: 231, y: 132, w: 14, h: 30 },
  "banner-enemy": { x: 0, y: 165, w: 14, h: 30 },
  "card-back": { x: 64, y: 165, w: 16, h: 22 },
  "cmd-archer": { x: 0, y: 0, w: 32, h: 32 },
  "cmd-cavalry": { x: 33, y: 0, w: 32, h: 32 },
  "cmd-garrison": { x: 66, y: 0, w: 32, h: 32 },
  "cmd-infantry": { x: 99, y: 0, w: 32, h: 32 },
  "cmd-lord": { x: 132, y: 0, w: 32, h: 32 },
  "cmd-mage": { x: 165, y: 0, w: 32, h: 32 },
  "cmd-outlaw": { x: 198, y: 0, w: 32, h: 32 },
  "equip-battle-axe": { x: 0, y: 33, w: 32, h: 32 },
  "equip-cavalry-lance": { x: 33, y: 33, w: 32, h: 32 },
  "grass": { x: 66, y: 33, w: 32, h: 32 },
  "ic-armor": { x: 81, y: 165, w: 12, h: 12 },
  "ic-attack": { x: 94, y: 165, w: 12, h: 12 },
  "ic-deck": { x: 107, y: 165, w: 12, h: 12 },
  "ic-durability": { x: 120, y: 165, w: 12, h: 12 },
  "ic-fatigue": { x: 133, y: 165, w: 12, h: 12 },
  "ic-guard": { x: 146, y: 165, w: 12, h: 12 },
  "ic-health": { x: 159, y: 165, w: 12, h: 12 },
  "ic-mana": { x: 172, y: 165, w: 12, h: 12 },
  "ic-ondeath": { x: 185, y: 165, w: 12, h: 12 },
  "ic-onplay": { x: 198, y: 165, w: 12, h: 12 },
  "ic-power": { x: 211, y: 165, w: 12, h: 12 },
  "ic-ranged": { x: 224, y: 165, w: 12, h: 12 },
  "ic-rush": { x: 237, y: 165, w: 12, h: 12 },
  "ic-shield": { x: 0, y: 196, w: 12, h: 12 },
  "soldier-beacon-runner": { x: 99, y: 33, w: 32, h: 32 },
  "soldier-charge-knight": { x: 132, y: 33, w: 32, h: 32 },
  "soldier-conscriptor": { x: 165, y: 33, w: 32, h: 32 },
  "soldier-elder-sorcerer": { x: 198, y: 33, w: 32, h: 32 },
  "soldier-fort-captain": { x: 0, y: 66, w: 32, h: 32 },
  "soldier-marksman": { x: 33, y: 66, w: 32, h: 32 },
  "soldier-militia": { x: 66, y: 66, w: 32, h: 32 },
  "soldier-novice-archer": { x: 99, y: 66, w: 32, h: 32 },
  "soldier-old-veteran": { x: 132, y: 66, w: 32, h: 32 },
  "soldier-outlaw-thug": { x: 165, y: 66, w: 32, h: 32 },
  "soldier-recruit-spear": { x: 198, y: 66, w: 32, h: 32 },
  "soldier-royal-guardian": { x: 0, y: 99, w: 32, h: 32 },
  "soldier-scout-rider": { x: 33, y: 99, w: 32, h: 32 },
  "soldier-shield-bearer": { x: 66, y: 99, w: 32, h: 32 },
  "soldier-veteran-centurion": { x: 99, y: 99, w: 32, h: 32 },
  "soldier-ward-weaver": { x: 132, y: 99, w: 32, h: 32 },
  "tactic-arrow-storm": { x: 165, y: 99, w: 32, h: 32 },
  "tactic-field-medic": { x: 198, y: 99, w: 32, h: 32 },
  "tactic-fire-arrow": { x: 0, y: 132, w: 32, h: 32 },
  "tactic-mana-bolt": { x: 33, y: 132, w: 32, h: 32 },
  "tactic-pike-wall": { x: 66, y: 132, w: 32, h: 32 },
  "tactic-spare-mana": { x: 99, y: 132, w: 32, h: 32 },
  "tactic-spur-on": { x: 132, y: 132, w: 32, h: 32 },
  "tactic-thunder-net": { x: 165, y: 132, w: 32, h: 32 },
  "tactic-war-council": { x: 198, y: 132, w: 32, h: 32 },
  "wall": { x: 15, y: 165, w: 48, h: 24 },
};
