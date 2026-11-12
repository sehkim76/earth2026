/**
 * 동시성 상한을 둔 비동기 map. 결과는 입력 순서를 그대로 유지한다.
 * 하나라도 실패하면 첫 실패로 reject된다 (Promise.all과 동일한 의미).
 */
export const mapConcurrent = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx] as T, idx);
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
};
