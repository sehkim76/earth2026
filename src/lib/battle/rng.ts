// 시드 고정 난수 (mulberry32). 상태는 BattleState.rng 에 uint32 로 저장된다.

/** 시드 정수를 초기 난수 상태로 정규화 */
export function seedToRng(seed: number): number {
  // 0 시드도 무난하게 섞이도록 한 번 뒤섞는다
  let h = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** 다음 난수 [0, 1) 와 새 상태를 돌려준다 */
export function nextRandom(rng: number): { value: number; rng: number } {
  const next = (rng + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, rng: next };
}
