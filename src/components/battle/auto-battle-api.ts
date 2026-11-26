// 오토배틀 서버 API 호출 (POST /api/auto-battle/start).

import type { AutoFormation, AutoSkillEvent, AutoTickEvent, AutoUnitKind } from "@/lib/auto-battle";
import { battleErrorMessage } from "@/components/battle/battle-api";

export interface AutoBattleProgress {
  id: string;
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  wins: number;
  battles: number;
}

export interface AutoBattleStartResult {
  victory: boolean;
  winner: 0 | 1 | "draw";
  progress: AutoBattleProgress[];
  injuredUntil: number | null;
  events: AutoTickEvent[];
  /** 스킬 발동 기록 (구버전 응답엔 없을 수 있음) */
  skills?: AutoSkillEvent[];
  attacker: AutoFormation;
  skillTick: number;
  skillKind: AutoUnitKind;
  defender: AutoFormation;
  defenderName: string;
  defenderTier: number | null;
  defenderSkill: { tick: number; kind: AutoUnitKind } | null;
  siege: { gauge: number; conquered: boolean; prevOwner?: string | null } | null;
  influence: number;
  battleId: string;
  seed: number;
  reinforced: Array<{ lenderUserId: string; unitId: string }>;
}

export interface AutoBattleCallResult {
  ok: boolean;
  code: string;
  message: string;
  result: AutoBattleStartResult | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function startAutoBattle(req: {
  slots: Array<string | null>;
  target:
    | { type: "outlaw"; wildId: number }
    | { type: "unit"; targetId: string; targetOwnerId: string }
    | { type: "lord"; targetId: string; targetOwnerId: string }
    | { type: "castle"; castleKey: string };
  skillTick: number;
  skillKind: AutoUnitKind;
}): Promise<AutoBattleCallResult> {
  let res: Response;
  try {
    res = await fetch("/api/auto-battle/start", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch {
    return { ok: false, code: "network", message: battleErrorMessage("network"), result: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (isRecord(body) && body.ok === true) {
    const { ok: _ok, ...rest } = body as { ok: boolean } & Omit<AutoBattleStartResult, "ok">;
    void _ok;
    return { ok: true, code: "", message: "", result: rest as AutoBattleStartResult };
  }
  const code = isRecord(body) && typeof body.code === "string" ? body.code : `http_${res.status}`;
  const serverMsg = isRecord(body) && typeof body.message === "string" ? body.message : undefined;
  return { ok: false, code, message: battleErrorMessage(code, serverMsg), result: null };
}
