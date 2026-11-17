// 전투 서버 API 호출 (POST /api/battle/start, POST /api/battle/action, GET /api/battle/current).

import type {
  Action,
  BattleActionRequest,
  BattleEvent,
  PublicBattleView,
  StartBattleRequest,
} from "@/lib/battle";
import { serverNow } from "@/lib/server-clock";

import type { BattleCallResult, BattleSource } from "@/components/battle/battle-source";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "대상을 찾을 수 없습니다. 이미 사라졌을 수 있습니다.",
  too_far: "너무 멉니다. 대상에게 더 가까이 가세요.",
  commander_unavailable: "이 지휘관은 지금 출전할 수 없습니다.",
  injured: "부상 중인 지휘관입니다. 회복한 뒤 출전하세요.",
  not_your_turn: "아직 내 턴이 아닙니다.",
  invalid_action: "지금은 할 수 없는 행동입니다.",
  battle_active: "이미 진행 중인 전투가 있습니다.",
  no_battle: "진행 중인 전투가 없습니다.",
  battle_over: "이미 끝난 전투입니다.",
  outlaw_busy: "다른 영주가 이 무법자와 싸우고 있습니다.",
  target_injured: "상대가 부상 중이라 공격할 수 없습니다.",
  target_unavailable: "지금은 이 상대를 공격할 수 없습니다 (성에 주둔 중이거나 위치 확인 불가).",
  location_stale: "위치 확인 중입니다. 잠시 뒤 다시 시도하세요.",
  invalid: "잘못된 요청입니다.",
  battle_failed: "전투 처리 중 오류가 발생했습니다.",
  login: "로그인이 필요합니다.",
  network: "서버에 연결할 수 없습니다. 연결을 확인하세요.",
};

/** 오류 코드 → 한국어 안내 */
export function battleErrorMessage(code: string, fallback?: string): string {
  return ERROR_MESSAGES[code] ?? fallback ?? "오류가 발생했습니다.";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function call(url: string, init?: RequestInit): Promise<BattleCallResult> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  } catch {
    return { ok: false, code: "network", message: battleErrorMessage("network") };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (isRecord(body) && body.ok === true) {
    const battle = (body.battle ?? null) as PublicBattleView | null;
    const events = Array.isArray(body.events) ? (body.events as BattleEvent[]) : [];
    return { ok: true, battle, events };
  }
  const code = isRecord(body) && typeof body.code === "string" ? body.code : res.ok ? "battle_failed" : `http_${res.status}`;
  const serverMsg = isRecord(body) && typeof body.message === "string" ? body.message : undefined;
  return { ok: false, code, message: battleErrorMessage(code, serverMsg) };
}

export function startBattle(req: StartBattleRequest): Promise<BattleCallResult> {
  return call("/api/battle/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

export function sendBattleAction(req: BattleActionRequest): Promise<BattleCallResult> {
  return call("/api/battle/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

export function fetchCurrentBattle(): Promise<BattleCallResult> {
  return call("/api/battle/current");
}

/** 서버 권위 공급원 */
export function createServerBattleSource(): BattleSource {
  return {
    act: (battleId: string, action: Action) => sendBattleAction({ battleId, action }),
    refresh: () => fetchCurrentBattle(),
    now: () => serverNow(),
  };
}
