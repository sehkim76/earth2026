// 영주성 내정 API 호출 + 갱신 알림 (상황판·지도·성 화면이 같은 값을 쓰도록).

import type { CityState, TroopCounts } from "@/lib/city";

export interface CityHome {
  castleKey: string;
  name: string;
  lat: number;
  lon: number;
}

export interface CityCommander {
  id: string;
  name: string;
  kind: string;
  level: number;
  state: string;
  troops: TroopCounts;
  cap: number;
}

export interface CityViewData {
  now: number;
  home: CityHome | null;
  gold: number;
  state: CityState;
  commanders: CityCommander[];
  events: string[];
  /** 받은 시각(내 기기) - 서버 시각 */
  skew: number;
}

export const CITY_EVENT = "tribes:city";

let last: CityViewData | null = null;
export const lastCityView = (): CityViewData | null => last;

function publish(v: CityViewData): void {
  if (last && last.now > v.now) return;
  last = v;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<CityViewData>(CITY_EVENT, { detail: v }));
}

async function call(url: string, init?: RequestInit): Promise<{ ok: true; view: CityViewData } | { ok: false; message: string; code: string }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  } catch {
    return { ok: false, code: "network", message: "네트워크 오류입니다." };
  }
  const body = (await res.json().catch(() => null)) as (Record<string, unknown> & { ok?: boolean }) | null;
  if (!body || body.ok !== true) {
    return {
      ok: false,
      code: typeof body?.code === "string" ? body.code : `http_${res.status}`,
      message: typeof body?.message === "string" ? body.message : "요청을 처리하지 못했습니다.",
    };
  }
  const view = { ...(body as unknown as Omit<CityViewData, "skew">), skew: Date.now() - Number(body.now) } as CityViewData;
  publish(view);
  return { ok: true, view };
}

export const fetchCity = (): ReturnType<typeof call> => call("/api/city");

export type CityActionBody =
  | { type: "upgrade"; building: string }
  | { type: "research"; tech: string }
  | { type: "train"; troop: string; count: number }
  | { type: "assign"; commanderId: string; troops: TroopCounts }
  | { type: "gather"; nodeId: string }
  | { type: "workerMove"; slot: number; gatherId: string | null; lat: number; lon: number }
  | { type: "recall"; gatherId: string };

export const cityAction = (action: CityActionBody): ReturnType<typeof call> =>
  call("/api/city/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });

/** 숫자 줄임 표기 (1.2만) */
export function fmtNum(n: number): string {
  const v = Math.floor(n);
  if (v >= 100_000) return `${(v / 10_000).toFixed(0)}만`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}만`;
  return v.toLocaleString("ko-KR");
}

/** 남은 시간 표기 */
export function fmtRemain(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${sec}초`;
  return `${sec}초`;
}
