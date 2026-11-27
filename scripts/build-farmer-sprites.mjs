// 일꾼(조선 농부) 8프레임 스프라이트 시트를 만든다. 병사·무법자 시트와 같은 규격(프레임 156px, 표시 52px).
// 그림은 SVG로 직접 그리고(독자 디자인) 크롬으로 래스터화한다. 수정 후 다시 실행:
//
//   node scripts/build-farmer-sprites.mjs
//
// 출력: public/markers/farmer_{walk_pick,walk_axe,mine,chop,carry_ore,carry_wood}_sheet.png

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "markers");
const FRAME = 156;
const FRAMES = 8;

const INK = "#2a1a10";
const SKIN = "#f3c393";
const SKIN_D = "#d99a68";
const CLOTH = "#f4eedf"; // 흰 무명
const CLOTH_D = "#d6cbb0";
const PANTS = "#ebe3cf";
const PANTS_D = "#c9bc9c";
const WRAP = "#b9a582"; // 행전
const STRAW = "#d6b25e"; // 짚
const STRAW_D = "#a9853a";
const WOOD = "#8a5a2b";
const WOOD_D = "#5e3a18";
const IRON = "#9aa6b0";
const IRON_D = "#5d6973";
const SW = 4; // 외곽선 굵기

const rad = (d) => (d * Math.PI) / 180;
const rot = (x, y, cx, cy, a) => {
  const c = Math.cos(rad(a));
  const s = Math.sin(rad(a));
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
};

/** 다리 (엉덩이 기준 각도 a). 바지 → 행전 → 짚신 */
function leg(hx, hy, a, back) {
  const pants = back ? PANTS_D : PANTS;
  return `<g transform="rotate(${a} ${hx} ${hy})">
    <path d="M${hx - 11} ${hy - 4} Q${hx - 13} ${hy + 14} ${hx - 8} ${hy + 22} L${hx + 8} ${hy + 22} Q${hx + 13} ${hy + 12} ${hx + 11} ${hy - 4}Z" fill="${pants}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <rect x="${hx - 6.5}" y="${hy + 20}" width="13" height="13" rx="3" fill="${back ? "#a08e6c" : WRAP}" stroke="${INK}" stroke-width="${SW}"/>
    <path d="M${hx - 6} ${hy + 25} L${hx + 6} ${hy + 23} M${hx - 6} ${hy + 30} L${hx + 6} ${hy + 28}" stroke="${INK}" stroke-width="1.6" opacity="0.45"/>
    <path d="M${hx - 9} ${hy + 34} Q${hx - 9} ${hy + 40} ${hx - 2} ${hy + 40} L${hx + 14} ${hy + 40} Q${hx + 17} ${hy + 35} ${hx + 9} ${hy + 32} L${hx - 6} ${hy + 32}Z" fill="${back ? STRAW_D : STRAW}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <path d="M${hx - 3} ${hy + 33} L${hx + 1} ${hy + 39} M${hx + 4} ${hy + 33} L${hx + 8} ${hy + 39}" stroke="${STRAW_D}" stroke-width="1.6"/>
  </g>`;
}

/** 팔 (어깨 기준 각도 a, 0 = 아래). 넓은 소매 + 손. 손 위치를 돌려준다 */
function arm(sx, sy, a, back) {
  const [hx, hy] = rot(sx, sy + 30, sx, sy, a);
  const svg = `<g transform="rotate(${a} ${sx} ${sy})">
    <path d="M${sx - 9} ${sy - 4} Q${sx - 12} ${sy + 14} ${sx - 9} ${sy + 25} L${sx + 9} ${sy + 25} Q${sx + 12} ${sy + 12} ${sx + 9} ${sy - 4}Z" fill="${back ? CLOTH_D : CLOTH}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <path d="M${sx - 9} ${sy + 21} L${sx + 9} ${sy + 21}" stroke="${CLOTH_D}" stroke-width="2.5"/>
  </g>`;
  const hand = `<circle cx="${hx}" cy="${hy}" r="7" fill="${back ? SKIN_D : SKIN}" stroke="${INK}" stroke-width="${SW}"/>`;
  return { svg, hand, hx, hy };
}

/** 연장 (손 위치 기준, 절대 각도 a: 0이면 자루가 위로) */
function drawTool(kind, hx, hy, a) {
  const handle = `<path d="M0 12 L0 -66" stroke="${INK}" stroke-width="${8 + SW}" stroke-linecap="round"/>
    <path d="M0 12 L0 -66" stroke="${WOOD}" stroke-width="8" stroke-linecap="round"/>
    <path d="M-1.5 8 L-1.5 -62" stroke="#b07a42" stroke-width="2" stroke-linecap="round"/>`;
  const head =
    kind === "pick"
      ? `<path d="M-30 -56 Q-14 -76 0 -70 Q14 -76 32 -58 Q16 -68 0 -62 Q-14 -68 -30 -56Z" fill="${IRON}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
         <rect x="-6" y="-74" width="12" height="12" rx="2" fill="${IRON_D}" stroke="${INK}" stroke-width="${SW}"/>`
      : `<path d="M-2 -72 L22 -82 Q30 -64 22 -46 L-2 -56Z" fill="${IRON}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
         <path d="M18 -78 Q25 -64 18 -50" fill="none" stroke="#e3e8ec" stroke-width="2.5" stroke-linecap="round"/>
         <rect x="-7" y="-76" width="10" height="24" rx="2" fill="${IRON_D}" stroke="${INK}" stroke-width="${SW}"/>`;
  return `<g transform="translate(${hx} ${hy}) rotate(${a})">${handle}${head}</g>`;
}

/** 머리: 큰 얼굴 + 상투 + 흰 머리수건(뒤로 매듭 꼬리) */
function head(cx, cy, tailWave) {
  return `
    <path d="M${cx - 33} ${cy - 6} Q${cx - 46} ${cy - 4 + tailWave} ${cx - 54} ${cy + 6 + tailWave} L${cx - 47} ${cy + 12 + tailWave} Q${cx - 40} ${cy + 4} ${cx - 31} ${cy + 4}Z" fill="${CLOTH}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <path d="M${cx - 32} ${cy - 2} Q${cx - 42} ${cy + 10 + tailWave} ${cx - 44} ${cy + 22 + tailWave} L${cx - 36} ${cy + 22 + tailWave} Q${cx - 34} ${cy + 10} ${cx - 28} ${cy + 4}Z" fill="${CLOTH_D}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <ellipse cx="${cx + 1}" cy="${cy - 37}" rx="9" ry="10" fill="#2b2522" stroke="${INK}" stroke-width="${SW}"/>
    <path d="M${cx - 4} ${cy - 40} Q${cx + 1} ${cy - 45} ${cx + 6} ${cy - 40}" stroke="#5b524c" stroke-width="2" fill="none"/>
    <path d="M${cx - 3} ${cy - 28} L${cx + 5} ${cy - 28}" stroke="${INK}" stroke-width="${SW}"/>
    <circle cx="${cx}" cy="${cy}" r="33" fill="${SKIN}" stroke="${INK}" stroke-width="${SW}"/>
    <path d="M${cx - 33} ${cy + 2} Q${cx - 32} ${cy + 26} ${cx - 8} ${cy + 33} Q${cx - 26} ${cy + 22} ${cx - 27} ${cy + 2}Z" fill="${SKIN_D}" opacity="0.55"/>
    <path d="M${cx - 33} ${cy - 2} Q${cx - 30} ${cy - 34} ${cx} ${cy - 34} Q${cx + 30} ${cy - 34} ${cx + 33} ${cy - 4} Q${cx + 20} ${cy - 16} ${cx + 4} ${cy - 15} Q${cx - 18} ${cy - 15} ${cx - 33} ${cy - 2}Z" fill="#2b2522" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <path d="M${cx - 34} ${cy - 8} Q${cx} ${cy - 24} ${cx + 34} ${cy - 10} L${cx + 34} ${cy - 1} Q${cx} ${cy - 15} ${cx - 34} ${cy + 1}Z" fill="${CLOTH}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <path d="M${cx - 20} ${cy - 10} Q${cx} ${cy - 19} ${cx + 22} ${cy - 10}" stroke="${CLOTH_D}" stroke-width="2.5" fill="none"/>
    <path d="M${cx + 4} ${cy + 1} L${cx + 14} ${cy - 1}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M${cx + 20} ${cy - 1} L${cx + 28} ${cy + 1}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
    <ellipse cx="${cx + 10}" cy="${cy + 8}" rx="3.2" ry="4.6" fill="${INK}"/>
    <ellipse cx="${cx + 24}" cy="${cy + 8}" rx="3" ry="4.4" fill="${INK}"/>
    <circle cx="${cx + 11}" cy="${cy + 6.5}" r="1.2" fill="#fff"/>
    <circle cx="${cx + 25}" cy="${cy + 6.5}" r="1.1" fill="#fff"/>
    <ellipse cx="${cx + 4}" cy="${cy + 17}" rx="5" ry="3" fill="#e98f7a" opacity="0.6"/>
    <path d="M${cx + 14} ${cy + 20} Q${cx + 18} ${cy + 23} ${cx + 22} ${cy + 20}" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M${cx + 31} ${cy + 6} Q${cx + 37} ${cy + 11} ${cx + 31} ${cy + 15}" fill="${SKIN}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M${cx - 18} ${cy + 6} Q${cx - 24} ${cy + 12} ${cx - 17} ${cy + 17}" fill="${SKIN_D}" stroke="${INK}" stroke-width="3"/>`;
}

/** 몸통: 저고리(동정·고름) + 새끼줄 허리띠 */
function body(bx, by) {
  return `
    <path d="M${bx - 22} ${by} Q${bx} ${by - 7} ${bx + 22} ${by} Q${bx + 27} ${by + 22} ${bx + 25} ${by + 40} L${bx - 25} ${by + 40} Q${bx - 27} ${by + 22} ${bx - 22} ${by}Z" fill="${CLOTH}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
    <path d="M${bx - 25} ${by + 40} Q${bx - 27} ${by + 22} ${bx - 22} ${by} Q${bx - 14} ${by + 22} ${bx - 13} ${by + 40}Z" fill="${CLOTH_D}"/>
    <path d="M${bx - 8} ${by - 3} L${bx + 12} ${by + 18} L${bx + 16} ${by + 14} L${bx - 1} ${by - 4}" fill="#fffdf6" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M${bx + 12} ${by + 18} q6 6 3 16 M${bx + 12} ${by + 18} q10 3 12 12" stroke="#b5452f" stroke-width="3.6" fill="none" stroke-linecap="round"/>
    <path d="M${bx - 26} ${by + 34} Q${bx} ${by + 38} ${bx + 26} ${by + 33}" stroke="${INK}" stroke-width="${7 + SW}" fill="none" stroke-linecap="round"/>
    <path d="M${bx - 26} ${by + 34} Q${bx} ${by + 38} ${bx + 26} ${by + 33}" stroke="${STRAW}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M${bx - 18} ${by + 32} l3 5 M${bx - 8} ${by + 33} l3 5 M${bx + 2} ${by + 33} l3 5 M${bx + 12} ${by + 32} l3 5" stroke="${STRAW_D}" stroke-width="1.8"/>`;
}

/** 지게 + 짐 (등 뒤, 몸보다 먼저 그린다) */
function jige(bx, by, load) {
  const x0 = bx - 34;
  const top = by - 64;
  const poles = `
    <path d="M${x0 - 2} ${by + 56} L${x0 + 2} ${top}" stroke="${INK}" stroke-width="${7 + SW}" stroke-linecap="round"/>
    <path d="M${x0 - 2} ${by + 56} L${x0 + 2} ${top}" stroke="${WOOD}" stroke-width="7" stroke-linecap="round"/>
    <path d="M${x0 + 14} ${by + 54} L${x0 + 14} ${top + 6}" stroke="${INK}" stroke-width="${6 + SW}" stroke-linecap="round"/>
    <path d="M${x0 + 14} ${by + 54} L${x0 + 14} ${top + 6}" stroke="${WOOD_D}" stroke-width="6" stroke-linecap="round"/>
    <path d="M${x0 - 4} ${by + 18} L${x0 + 16} ${by + 18} M${x0 - 2} ${by - 6} L${x0 + 16} ${by - 6}" stroke="${INK}" stroke-width="${4 + SW}" stroke-linecap="round"/>
    <path d="M${x0 - 4} ${by + 18} L${x0 + 16} ${by + 18} M${x0 - 2} ${by - 6} L${x0 + 16} ${by - 6}" stroke="${WOOD}" stroke-width="4" stroke-linecap="round"/>
    <path d="M${x0 + 2} ${by + 8} L${x0 + 34} ${by + 2}" stroke="${INK}" stroke-width="${5 + SW}" stroke-linecap="round"/>
    <path d="M${x0 + 2} ${by + 8} L${x0 + 34} ${by + 2}" stroke="${WOOD}" stroke-width="5" stroke-linecap="round"/>`;
  const pack =
    load === "wood"
      ? [0, 1, 2, 3]
          .map(
            (i) => `<rect x="${x0 - 22}" y="${top - 6 + i * 15}" width="46" height="14" rx="7" fill="#a0703c" stroke="${INK}" stroke-width="${SW}"/>
          <circle cx="${x0 - 15}" cy="${top + 1 + i * 15}" r="5" fill="#e3c08f" stroke="${INK}" stroke-width="2.5"/>
          <circle cx="${x0 - 15}" cy="${top + 1 + i * 15}" r="1.8" fill="#a0703c"/>`,
          )
          .join("") +
        `<path d="M${x0 + 2} ${top - 8} L${x0 + 4} ${top + 54}" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
         <path d="M${x0 + 2} ${top - 8} L${x0 + 4} ${top + 54}" stroke="${STRAW}" stroke-width="2.5" stroke-linecap="round"/>`
      : `<path d="M${x0 - 22} ${top + 52} Q${x0 - 30} ${top + 6} ${x0 - 2} ${top} Q${x0 + 26} ${top + 4} ${x0 + 20} ${top + 52} Q${x0 - 2} ${top + 60} ${x0 - 22} ${top + 52}Z" fill="${STRAW}" stroke="${INK}" stroke-width="${SW}" stroke-linejoin="round"/>
         <path d="M${x0 - 20} ${top + 20} Q${x0 - 2} ${top + 25} ${x0 + 18} ${top + 20} M${x0 - 22} ${top + 38} Q${x0 - 2} ${top + 43} ${x0 + 20} ${top + 38}" stroke="${STRAW_D}" stroke-width="2.6" fill="none"/>
         <path d="M${x0 - 14} ${top + 4} L${x0 - 8} ${top - 9} L${x0 - 1} ${top - 3} L${x0 + 6} ${top - 13} L${x0 + 13} ${top + 3}Z" fill="${IRON}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
         <path d="M${x0 - 6} ${top - 3} l3 -3" stroke="#e8eef2" stroke-width="2" stroke-linecap="round"/>`;
  return poles + pack;
}

/** 튀는 파편 (곡괭이: 돌·불꽃, 도끼: 나뭇조각) */
function fx(kind, x, y, k) {
  if (k <= 0) return "";
  const c = kind === "pick" ? "#ffd75e" : "#c98d4a";
  const s = 6 + k * 8;
  return `<g opacity="${k > 1 ? 0.6 : 1}">
    <path d="M${x} ${y} l${s} ${-s * 0.9}" stroke="${INK}" stroke-width="${4 + SW}" stroke-linecap="round"/>
    <path d="M${x} ${y} l${s} ${-s * 0.9}" stroke="${c}" stroke-width="4" stroke-linecap="round"/>
    <path d="M${x + 4} ${y + 2} l${s * 1.2} ${-s * 0.2}" stroke="${INK}" stroke-width="${4 + SW}" stroke-linecap="round"/>
    <path d="M${x + 4} ${y + 2} l${s * 1.2} ${-s * 0.2}" stroke="${c}" stroke-width="4" stroke-linecap="round"/>
    <path d="M${x - 2} ${y - 4} l${s * 0.3} ${-s * 1.2}" stroke="${INK}" stroke-width="${4 + SW}" stroke-linecap="round"/>
    <path d="M${x - 2} ${y - 4} l${s * 0.3} ${-s * 1.2}" stroke="${c}" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

/**
 * 한 프레임. mode: walk_pick | walk_axe | mine | chop | carry_ore | carry_wood
 * 좌표계 200×200, 오른쪽을 본다. 발바닥 y≈188.
 */
function frame(mode, i) {
  const t = (i / FRAMES) * Math.PI * 2;
  const walking = mode.startsWith("walk") || mode.startsWith("carry");
  const bob = walking ? -Math.abs(Math.sin(t)) * 4 : 0;
  const legA = walking ? Math.sin(t) * 24 : 0;
  // 작업 동작: 들어 올림(천천히) → 내리침(빠르게)
  // 각도는 어깨 기준(0 = 팔이 아래, 180 = 위). 머리 위를 넘어 앞으로 내리친다 (160 → 310)
  const SWING = [140, 150, 158, 160, 200, 238, 302, 304];
  const swing = mode === "mine" || mode === "chop" ? SWING[i] : 0;
  const lean = mode === "mine" || mode === "chop" ? (swing >= 250 ? 8 : swing <= 170 ? -6 : 0) : 0;
  const bx = 98;
  const by = 104 + bob;
  const hipY = 146 + bob;
  const tool = mode === "chop" || mode === "walk_axe" ? "axe" : "pick";

  let parts = "";
  if (mode.startsWith("carry")) parts += jige(bx, by, mode === "carry_wood" ? "wood" : "ore");
  // 뒷다리 → 뒷팔 → 앞다리
  parts += leg(bx - 8, hipY, walking ? -legA : -8, true);
  const backArm = arm(bx - 14, by + 6, walking ? (mode.startsWith("carry") ? -150 : legA * 0.9) : swing - 8, true);
  parts += `<g transform="rotate(${lean} ${bx} ${hipY})">${backArm.svg}${backArm.hand}</g>`;
  parts += leg(bx + 8, hipY, walking ? legA : 10, false);

  let upper = body(bx, by);
  if (mode.startsWith("carry")) {
    // 지게 멜빵
    upper += `<path d="M${bx - 20} ${by - 2} Q${bx - 4} ${by + 10} ${bx - 6} ${by + 30}" stroke="${INK}" stroke-width="${4 + SW}" fill="none" stroke-linecap="round"/>
      <path d="M${bx - 20} ${by - 2} Q${bx - 4} ${by + 10} ${bx - 6} ${by + 30}" stroke="${STRAW_D}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  }
  if (mode.startsWith("walk")) {
    // 연장을 어깨에 메고 걷는다 (자루는 머리 뒤로)
    const a = arm(bx + 12, by + 6, -40, false);
    upper += drawTool(tool, a.hx, a.hy, -58) + head(bx + 2, by - 32, Math.sin(t) * 3) + a.svg + a.hand;
  } else {
    upper += head(bx + 2, by - 32, walking ? Math.sin(t) * 3 : 0);
  }
  if (mode.startsWith("walk")) {
    // 위에서 그렸다
  } else if (mode === "mine" || mode === "chop") {
    const a = arm(bx + 12, by + 6, swing, false);
    upper += drawTool(tool, a.hx, a.hy, swing + 180) + a.svg + a.hand;
  } else {
    // 지게 멜빵을 잡고 걷는다
    const a = arm(bx + 12, by + 6, 20 - legA * 0.4, false);
    upper += a.svg + a.hand;
  }
  parts += `<g transform="rotate(${lean} ${bx} ${hipY})">${upper}</g>`;
  if (mode === "mine" || mode === "chop") {
    const k = i === 6 ? 1 : i === 7 ? 2 : 0;
    parts += fx(tool, 160, 172, k);
  }
  return parts;
}
function svgFrame(mode, i) {
  const inner = frame(mode, i);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME}" height="${FRAME}" viewBox="14 -2 184 196">
    <defs>
      <filter id="sticker" x="-20%" y="-20%" width="140%" height="140%">
        <feMorphology in="SourceAlpha" operator="dilate" radius="5" result="d"/>
        <feFlood flood-color="#ffffff"/>
        <feComposite in2="d" operator="in" result="w"/>
        <feMorphology in="SourceAlpha" operator="dilate" radius="6.5" result="d2"/>
        <feFlood flood-color="#c9c9c9" flood-opacity="0.7"/>
        <feComposite in2="d2" operator="in" result="g"/>
        <feMerge><feMergeNode in="g"/><feMergeNode in="w"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <g filter="url(#sticker)">${inner}</g>
  </svg>`;
}

const SHEETS = [
  ["walk_pick", "farmer_walk_pick_sheet.png"],
  ["walk_axe", "farmer_walk_axe_sheet.png"],
  ["mine", "farmer_mine_sheet.png"],
  ["chop", "farmer_chop_sheet.png"],
  ["carry_ore", "farmer_carry_ore_sheet.png"],
  ["carry_wood", "farmer_carry_wood_sheet.png"],
];

const dir = mkdtempSync(path.join(tmpdir(), "farmer-"));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/google/chrome/chrome",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: FRAME * FRAMES, height: FRAME }, deviceScaleFactor: 1 });
  for (const [mode, file] of SHEETS) {
    const html = `<html><body style="margin:0;background:transparent;display:flex">${Array.from({ length: FRAMES }, (_, i) => svgFrame(mode, i)).join("")}</body></html>`;
    const htmlPath = path.join(dir, `${mode}.html`);
    writeFileSync(htmlPath, html);
    await page.goto(`file://${htmlPath}`);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: true, clip: { x: 0, y: 0, width: FRAME * FRAMES, height: FRAME } });
    console.log("wrote", file);
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
