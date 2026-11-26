import { NextResponse } from "next/server";

import { resolveAutoBattle, validateFormation } from "@/lib/auto-battle";
import { requireSessionUserId } from "@/lib/territory";

/** POST /api/auto-battle/resolve — 편성 2개 받아 결정적 시뮬레이션 (60초 오토배틀 검증용). */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  let body: { attacker?: unknown; defender?: unknown; seed?: unknown; attackerSkillTick?: unknown; attackerSkillKind?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const attacker = validateFormation(body.attacker);
  const defender = validateFormation(body.defender);
  if (!attacker || !defender) {
    return NextResponse.json({ ok: false, code: "invalid_formation" }, { status: 400 });
  }
  const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? Math.floor(body.seed) : Date.now() % 2147483647;
  const skillKinds = ["lord", "infantry", "archer", "cavalry", "mage"] as const;
  const skillKind = skillKinds.includes(body.attackerSkillKind as (typeof skillKinds)[number])
    ? (body.attackerSkillKind as (typeof skillKinds)[number])
    : undefined;
  const skillTick =
    typeof body.attackerSkillTick === "number" && Number.isInteger(body.attackerSkillTick)
      ? Math.max(0, Math.min(39, body.attackerSkillTick))
      : undefined;
  const result = resolveAutoBattle({ seed, attacker, defender, attackerSkillTick: skillTick, attackerSkillKind: skillKind });
  return NextResponse.json({ ok: true, seed, ...result });
}
