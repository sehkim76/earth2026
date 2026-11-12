/**
 * 서버 시계 보정 (클라이언트 전용).
 * 무법자 다리 시각(startedAt/endsAt)은 서버 시계 기준이다. 기기 시계가 서버와 어긋나면
 * 화면이 실제보다 앞서거나 뒤처진 위치를 그리고, 일시정지(서버 시각 기준 고정) 때
 * 되돌아가는 순간이동이 생긴다. 응답의 serverNow로 오프셋을 추정해 서버 시각을 쓴다.
 */
let offsetMs = 0;
let hasSample = false;

/** 응답 직전 서버 시각과 응답 수신 시각으로 오프셋을 갱신한다 (네트워크 편도 지연만큼 오차). */
export const noteServerTime = (serverNow: unknown, receivedAt: number): void => {
  if (typeof serverNow !== "number" || !Number.isFinite(serverNow)) {
    return;
  }
  const sample = serverNow - receivedAt;
  // 첫 표본은 그대로, 이후는 완만하게 따라간다 (요청별 지연 흔들림 완화).
  if (!hasSample) {
    // 진단용: 기기 시계가 서버와 1초 이상 어긋나면 한 번 남긴다.
    if (Math.abs(sample) >= 1000) {
      console.info(`[clock] 기기 시계가 서버보다 ${Math.abs(sample / 1000).toFixed(1)}초 ${sample < 0 ? "빠름" : "느림"} — 무법자 위치는 서버 시각으로 보정`);
    }
  }
  offsetMs = hasSample ? offsetMs * 0.7 + sample * 0.3 : sample;
  hasSample = true;
};

/** 서버 기준 현재 시각(ms). */
export const serverNow = (): number => Date.now() + offsetMs;

export const serverClockOffsetMs = (): number => offsetMs;
