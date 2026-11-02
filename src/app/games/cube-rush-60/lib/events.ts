// Cube Rush 60 — 교육 확장 이벤트 훅 (1차는 연결만, 퀴즈 UI 없음)
// 게임 엔진 경계에 노출되는 콜백 객체

export interface CubeRushEvents {
  onCubeRemoved: (info: { count: number; color: number; score: number }) => void;
  onCombo: (info: { streak: number; bonus: number }) => void;
  onGameOver: (info: { score: number; removed: number; maxCombo: number }) => void;
  onLevelComplete: (info: { level: number }) => void;
}

const noop = (): void => undefined;

const events: CubeRushEvents = {
  onCubeRemoved: noop,
  onCombo: noop,
  onGameOver: noop,
  onLevelComplete: noop,
};

export function getGameEvents(): CubeRushEvents {
  return events;
}

export function setGameEvents(next: Partial<CubeRushEvents>): void {
  if (next.onCubeRemoved) events.onCubeRemoved = next.onCubeRemoved;
  if (next.onCombo) events.onCombo = next.onCombo;
  if (next.onGameOver) events.onGameOver = next.onGameOver;
  if (next.onLevelComplete) events.onLevelComplete = next.onLevelComplete;
}
