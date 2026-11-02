// Cube Rush 60 — 복셀 아트 정의 (층별 문자열 맵, 독자적 도트)
// 문자: 'R'=빨강(1) 'Y'=노랑(3) 'B'=파랑(0) 'G'=초록(2) 'P'=보라(4)
//   'N'=갈색(5, brown) 'S'=회색(6, gray, silver) — AMMO_COLORS 7색 사용.
// 그 외 문자('.', ' ' 등)는 빈칸.
// 각 아트는 최종 해상도로 직접 설계한다 (expand 없음). 3종 모두 묵직한 입체
// (가로≈세로≈깊이, 깊이가 가로·세로의 60~100%): 16×16×10, 16×17×12,
// 16×16×12, 1200~1600셀, 색상별 8개 이상 (손패 20칸 분할 시 칸당 8~80발
// 보장, 색당 ceil(개수/80)칸 합계는 puzzle 분할 로직이 20칸에 맞춘다).
// 레이어는 buildArt가 paint 함수로 z축마다 2D 문자열 맵을 만든다 —
// layers[z][y] = 행 문자열 (y=0이 맨 위 행, 파서가 뒤집어 y=0을 바닥으로 둔다).

import type { CubeColorIndex } from "./puzzle";

export interface VoxelArt {
  /** 사람이 알아볼 수 있는 이름 (디버그·로그용) */
  name: string;
  /** layers[z][y] = 행 문자열 (y=0이 맨 위 행, 파서가 뒤집어 y=0을 바닥으로 둔다) */
  layers: string[][];
}

export interface ArtCell {
  x: number;
  y: number;
  z: number;
  color: CubeColorIndex;
}

function charToColor(ch: string): CubeColorIndex | null {
  if (ch === "R") return 1;
  if (ch === "Y") return 3;
  if (ch === "B") return 0;
  if (ch === "G") return 2;
  if (ch === "P") return 4;
  if (ch === "N") return 5;
  if (ch === "S") return 6;
  return null;
}

type VoxelChar = "R" | "Y" | "B" | "G" | "P" | "N" | "S" | ".";

/** w×h×d 복셀을 paint(x, y, z)로 채워 z축 레이어별 문자열 맵으로 만든다. */
function buildArt(
  w: number,
  h: number,
  d: number,
  paint: (x: number, y: number, z: number) => VoxelChar,
): string[][] {
  const layers: string[][] = [];
  for (let z = 0; z < d; z++) {
    const rows: string[] = [];
    for (let ry = 0; ry < h; ry++) {
      const y = h - 1 - ry;
      let row = "";
      for (let x = 0; x < w; x++) row += paint(x, y, z);
      rows.push(row);
    }
    layers.push(rows);
  }
  return layers;
}

function inBox(x: number, y: number, z: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
}

// 곰인형 (16×16×10 — 다리+몸통+팔+머리+귀+코돌출+꼬리 합집합, 속이 찬 입체)
// 갈색 몸통·머리·다리, 회색 주둥이·발바닥, 파랑 눈·벨트·발가락,
// 빨강 귀·코·입·나비넥타이, 노랑 단추·귀경계·볼터치·팔무늬,
// 보라 배·귀안쪽·손바닥·꼬리, 초록 팔.
const BEAR_W = 16;
const BEAR_H = 16;
const BEAR_D = 10;
function inEar(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 1, 4, 13, 15, 1, 8) || inBox(x, y, z, 11, 14, 13, 15, 1, 8);
}
function inHead(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 3, 12, 9, 13, 1, 8);
}
function inBody(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 4, 11, 4, 9, 1, 8);
}
function inArm(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 1, 3, 4, 8, 2, 7) || inBox(x, y, z, 12, 14, 4, 8, 2, 7);
}
function inLeg(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 2, 5, 0, 4, 1, 8) || inBox(x, y, z, 10, 13, 0, 4, 1, 8);
}
function paintBear(x: number, y: number, z: number): VoxelChar {
  // 코끝 돌출 (z=9): 주둥이 회색판 + 코 빨강 — 깊이 확보용
  if (z === 9 && y >= 9 && y <= 12 && x >= 5 && x <= 10) {
    if (y === 10 && (x === 7 || x === 8)) return "R";
    if (y === 9 && x >= 6 && x <= 9) return "R";
    return "S";
  }
  // 꼬리 (z=0): 몸통 뒤에 붙는 보라 뭉치 — 깊이 확보용
  if (z === 0 && y >= 5 && y <= 6 && x >= 7 && x <= 8) return "P";
  if (inEar(x, y, z)) {
    if (y === 15 && ((x >= 2 && x <= 3) || (x >= 12 && x <= 13))) return "P"; // 귀 안쪽
    if (y === 13) return "Y"; // 귀-머리 경계 털
    if (z >= 4 && z <= 5 && y === 14) return "Y"; // 귀 장식띠
    return "R";
  }
  if (inHead(x, y, z)) {
    if (z === 8) {
      if (y === 12 && (x === 5 || x === 10)) return "B"; // 눈
      if (y === 12 && (x === 4 || x === 11)) return "S"; // 눈가 그림자
      if (y === 11 && x >= 6 && x <= 9) return "S"; // 주둥이 회색판
      if (y === 11 && (x === 7 || x === 8)) return "R"; // 코
      if (y === 11 && (x === 5 || x === 10)) return "Y"; // 볼터치
      if (y === 10 && x >= 6 && x <= 9) return "S"; // 주둥이 아래판
      if (y === 9 && x >= 6 && x <= 9) return "R"; // 입 가로선
    }
    if (z === 7 && y === 12 && (x === 5 || x === 10)) return "B"; // 눈 깊이감
    return "N";
  }
  if (inBody(x, y, z)) {
    if (z === 8) {
      if (y === 9 && (x === 7 || x === 8)) return "R"; // 나비넥타이
      if (y === 8 && x >= 5 && x <= 10) return "Y"; // 가슴 털띠
      if (y >= 5 && y <= 7 && x >= 5 && x <= 10) {
        if (y === 6 && (x === 7 || x === 8)) return "Y"; // 단추
        return "P"; // 배 앞판
      }
      if (y === 4) return "B"; // 벨트 파랑줄
    }
    if (z === 7 && y >= 5 && y <= 7 && x >= 6 && x <= 9) return "P"; // 배 옆면
    return "N";
  }
  if (inArm(x, y, z)) {
    if (z === 7 && y === 4) return "P"; // 손바닥
    if ((y === 6 || y === 7) && (x + z) % 3 === 0) return "Y"; // 팔 무늬줄
    if (y === 8 && z >= 4 && z <= 5) return "Y"; // 어깨 털
    return "G";
  }
  if (inLeg(x, y, z)) {
    if (z === 8 && y <= 1) {
      if (y === 0) return "B"; // 발가락 파랑줄
      return "S"; // 발바닥 회색
    }
    if (z === 8 && y === 2 && (x === 3 || x === 4 || x === 11 || x === 12)) return "S"; // 발등 무늬
    return "N";
  }
  return ".";
}

// 지구본 (16×17×12 — 타원 공 + 기둥 + 2단 받침대, 속이 찬 입체)
// 바다 파랑·대륙 초록·극관 보라, 기둥 노랑·기둥홈 초록, 받침대 갈색,
// 받침대 테두리 빨강·서랍 보라, 적도 노랑띠·경선 회색점·북반구 빨강 표식.
const GLOBE_W = 16;
const GLOBE_H = 17;
const GLOBE_D = 12;
const GLOBE_CX = 7.5;
const GLOBE_CY = 11.5;
const GLOBE_RX = 7;
const GLOBE_RY = 5.5;
const GLOBE_CZ = 5.5;
const GLOBE_RZ = 5.5;
function inBall(x: number, y: number, z: number): boolean {
  const dx = (x - GLOBE_CX) / GLOBE_RX;
  const dy = (y - GLOBE_CY) / GLOBE_RY;
  const dz = (z - GLOBE_CZ) / GLOBE_RZ;
  return dx * dx + dy * dy + dz * dz <= 1;
}
function inContinent(nx: number, ny: number, nz: number): boolean {
  const c1x = (nx + 0.42) / 0.4;
  const c1y = (ny - 0.08) / 0.48;
  const c1z = (nz - 0.2) / 0.55;
  if (c1x * c1x + c1y * c1y + c1z * c1z <= 1) return true;
  const c2x = (nx - 0.48) / 0.36;
  const c2y = (ny + 0.22) / 0.44;
  const c2z = (nz + 0.25) / 0.5;
  if (c2x * c2x + c2y * c2y + c2z * c2z <= 1) return true;
  const c3x = (nx - 0.05) / 0.3;
  const c3y = (ny - 0.5) / 0.32;
  const c3z = (nz + 0.55) / 0.4;
  if (c3x * c3x + c3y * c3y + c3z * c3z <= 1) return true;
  return false;
}
function paintGlobe(x: number, y: number, z: number): VoxelChar {
  if (inBox(x, y, z, 2, 13, 0, 2, 2, 9)) {
    if (y === 2 && (x === 2 || x === 13 || z === 2 || z === 9)) return "R"; // 받침대 상단 테두리
    if (z === 9 && y === 1 && x >= 5 && x <= 10) return "P"; // 서랍 앞판
    if (z === 9 && y === 1 && (x === 7 || x === 8)) return "R"; // 서랍 손잡이
    if (y === 0 && (x + z) % 4 === 0) return "R"; // 받침대 하단 장식점
    return "N"; // 받침대 갈색 몸통
  }
  if (inBox(x, y, z, 5, 10, 2, 7, 3, 8)) {
    if (y === 3 || y === 4) return "G"; // 기둥 홈
    if ((y === 5 || y === 6) && (x === 5 || x === 10)) return "R"; // 기둥 측 장식
    return "Y"; // 기둥
  }
  if (!inBall(x, y, z)) return ".";
  if (y >= 15) return "P"; // 북극관
  if (y === 14 && x >= 6 && x <= 9 && z >= 4 && z <= 7) return "R"; // 북반구 빨강 표식
  if (y <= 7) return "S"; // 남극대신 회색 하단부
  const nx = (x - GLOBE_CX) / GLOBE_RX;
  const ny = (y - GLOBE_CY) / GLOBE_RY;
  const nz = (z - GLOBE_CZ) / GLOBE_RZ;
  if (inContinent(nx, ny, nz)) {
    if ((x * 3 + y * 5 + z * 2) % 9 < 1) return "Y"; // 대륙 사막점
    return "G"; // 대륙
  }
  if ((x * 5 + y * 7 + z * 3) % 7 < 1) return "G"; // 해안 반점
  if ((y === 11 || y === 12) && (x + z) % 2 === 0) return "Y"; // 적도띠
  if ((x + z) % 5 === 0) return "S"; // 경선 회색점
  return "B"; // 바다
}

// 컴퓨터와 모니터 (16×16×12 — 책상 + 본체 + 모니터 + 키보드 + 마우스, 속이 찬 입체)
// 책상 갈색판·서랍 보라·다리캡 빨강, 본체 회색·옆줄 빨강·베이 노랑,
// 모니터 테두리 파랑·화면 초록·제목바 파랑·본문 노랑·커서 빨강,
// 키보드 노랑·스페이스바 회색·엔터 빨강, 마우스패드 보라·마우스 회색,
// 케이블 보라·모니터 기둥 보라.
const PC_W = 16;
const PC_H = 16;
const PC_D = 12;
function inTower(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 0, 4, 2, 12, 0, 6);
}
function inFrame(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 6, 15, 6, 13, 1, 4);
}
function inKeyboard(x: number, y: number, z: number): boolean {
  return inBox(x, y, z, 4, 11, 2, 3, 5, 10);
}
function paintComputer(x: number, y: number, z: number): VoxelChar {
  if (y <= 1) {
    if (z === 11 && y === 1 && x >= 6 && x <= 9) return "P"; // 책상 서랍 앞판
    if (z === 11 && y === 0 && (x === 7 || x === 8)) return "R"; // 서랍 손잡이
    if (y === 0 && (x <= 1 || x >= 14) && (z === 0 || z === 11)) return "R"; // 책상다리 끝 빨강캡
    if (y === 1 && (x + z) % 6 === 0) return "Y"; // 책상 상판 나뭇결점
    return "N"; // 책상 갈색판
  }
  if (inTower(x, y, z)) {
    if (x === 0 && z === 6) return "R"; // 본체 옆줄
    if (z === 6) {
      if (y >= 9 && y <= 11 && x >= 1 && x <= 3) return "Y"; // 드라이브 베이
      if (y === 8 && x >= 1 && x <= 2) return "G"; // LED 바
      if (y === 7 && x >= 1 && x <= 3) return "Y"; // 통풍 슬릿 상단
      if (y === 5 && x >= 1 && x <= 3) return "Y"; // 통풍 슬릿 하단
      if (y === 3 && x === 1) return "G"; // 전원 버튼
      if (y === 3 && x === 3) return "R"; // 리셋 버튼
      if (y === 12 && x >= 1 && x <= 3) return "B"; // 상단 장식줄
      return "S"; // 본체 회색 전면
    }
    if (x === 4 && (y === 6 || y === 10)) return "Y"; // 본체 측mux 통풍점
    return "S"; // 본체 회색
  }
  if (inFrame(x, y, z)) {
    if (z === 4 && x >= 7 && x <= 14 && y >= 7 && y <= 12) {
      if (y === 12) return "B"; // 타이틀 바
      if (y === 11 && x <= 12) return "Y"; // 본문 1행
      if (y === 10 && x <= 11) return "Y"; // 본문 2행
      if (y === 9 && x <= 9) return "Y"; // 본문 3행
      if (y === 8 && x <= 8) return "R"; // 커서 줄
      if (y === 7 && (x === 7 || x === 14)) return "B"; // 상태바 양끝
      return "G"; // 화면
    }
    if (z === 4 && y === 6 && x >= 10 && x <= 11) return "Y"; // 로고
    if (y === 13 && (x === 6 || x === 15)) return "R"; // 상단 모서리 장식
    return "B"; // 모니터 테두리
  }
  if (x >= 7 && x <= 8 && y >= 2 && y <= 5 && z >= 0 && z <= 1) return "P"; // 모니터 뒷기둥
  if (inBox(x, y, z, 7, 14, 7, 12, 0, 0)) return "B"; // 모니터 뒷판
  if (inBox(x, y, z, 8, 12, 2, 2, 1, 3)) return "P"; // 모니터 받침
  if (x === 5 && y >= 2 && y <= 6 && z >= 2 && z <= 3) return "P"; // 본체-모니터 케이블
  if (inBox(x, y, z, 11, 15, 2, 2, 5, 10)) {
    if (x >= 12 && x <= 14 && z >= 6 && z <= 9) {
      if (y === 2 && x === 13 && z === 6) return "R"; // 마우스 휠
      return "S"; // 마우스 회색 몸통
    }
    return "P"; // 마우스패드 보라판
  }
  if (inKeyboard(x, y, z)) {
    if (y === 3) {
      if (x >= 6 && x <= 8 && z === 9) return "S"; // 스페이스바 회색
      if (x === 11 && z === 10) return "R"; // 엔터키
      if (z === 5) return "B"; // 기능키줄 파랑
      if ((x + z) % 2 === 0) return "G"; // 키캡
      return "Y";
    }
    return "Y";
  }
  return ".";
}

export const VOXEL_ARTS: VoxelArt[] = [
  { name: "teddy-bear", layers: buildArt(BEAR_W, BEAR_H, BEAR_D, paintBear) },
  { name: "globe", layers: buildArt(GLOBE_W, GLOBE_H, GLOBE_D, paintGlobe) },
  { name: "computer", layers: buildArt(PC_W, PC_H, PC_D, paintComputer) },
];

export const ART_COUNT = VOXEL_ARTS.length;

/** 아트 1종을 월드 좌표 셀 목록으로 펼친다. x/z는 중앙 정렬, y=0이 바닥. */
export function cellsFromArt(index: number): ArtCell[] {
  const art = VOXEL_ARTS[index];
  if (!art) return [];
  const depth = art.layers.length;
  let width = 0;
  let height = 0;
  for (const layer of art.layers) {
    height = Math.max(height, layer.length);
    for (const row of layer) width = Math.max(width, row.length);
  }
  const ox = Math.floor(width / 2);
  const oz = Math.floor(depth / 2);
  const out: ArtCell[] = [];
  for (let z = 0; z < art.layers.length; z++) {
    const layer = art.layers[z];
    if (!layer) continue;
    for (let ry = 0; ry < layer.length; ry++) {
      const row = layer[ry] ?? "";
      const y = height - 1 - ry;
      for (let x = 0; x < row.length; x++) {
        const color = charToColor(row[x] ?? ".");
        if (color === null) continue;
        out.push({ x: x - ox, y, z: z - oz, color });
      }
    }
  }
  return out;
}

/** 아트별 셀 수·색상별 개수 (밸런스 검산용) */
export function artStats(index: number): { total: number; byColor: Record<number, number> } {
  const cells = cellsFromArt(index);
  const byColor: Record<number, number> = {};
  for (const c of cells) byColor[c.color] = (byColor[c.color] ?? 0) + 1;
  return { total: cells.length, byColor };
}
