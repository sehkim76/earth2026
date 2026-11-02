// Cube Rush 60 — 유색 탄약 손패·발사칸 모델 (순수 로직, React/three 의존성 없음)
// 손패 블록 {color, count}: 배경이 곧 포탄 색. 발사칸도 같은 색 칩 + 숫자.
// 리필 없음 — 시작 시 1회 배분, 소진되면 종료.

import type { CubeColorIndex } from "./puzzle";

export interface HandBlock {
  uid: number;
  color: CubeColorIndex;
  count: number;
}

export type SlotStatus = "idle" | "flying" | "firing";

export interface LaunchSlot {
  status: SlotStatus;
  color: CubeColorIndex | null;
  count: number | null;
}

export const SLOT_COUNT = 3;

export const FLY_MS = 300;
export const FIRE_PER_SEC = 30;
export const MAX_BULLETS = 256;

// 하단 손패 5열 스택: 열당 최대 4단, 맨 위(lane[0])만 탭 가능.
// generateMatch가 색상별 합계에 맞춰 20칸을 만들고 셔플한 뒤 4개씩 분배한다.
export const LANE_COUNT = 5;
export const LANE_DEPTH = 4;

export function dealLanes<T>(blocks: T[]): T[][] {
  const lanes: T[][] = Array.from({ length: LANE_COUNT }, () => []);
  blocks.forEach((b, i) => {
    const lane = lanes[i % LANE_COUNT];
    if (lane && lane.length < LANE_DEPTH) lane.push(b);
    else {
      // 깊이 초과분은 빈 자리가 있는 첫 열에 배치 (12칸 고정 시 도달 불가한 안전망)
      const spare = lanes.find((l) => l.length < LANE_DEPTH);
      if (spare) spare.push(b);
    }
  });
  return lanes;
}

export function emptySlots(): LaunchSlot[] {
  return Array.from({ length: SLOT_COUNT }, () => ({
    status: "idle" as SlotStatus,
    color: null,
    count: null,
  }));
}
