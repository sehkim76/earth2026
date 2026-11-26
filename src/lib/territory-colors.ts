// 영토 색 (지도 동 채우기·범례·랭킹이 같은 색을 쓴다).

/** 국가 id(없으면 영주 id) 해시 → 색 */
export function territoryOwnerColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 70%, 45%)`;
}
