import { NextResponse } from "next/server";

import { isBuildingKey, isTechKey, TROOP_KINDS, type TroopCounts, type TroopKind } from "@/lib/city";
import { CityError, planGatherRoute, runCity, type CityAction } from "@/lib/city-server";
import { setGraphBaseUrl } from "@/lib/server-graph";
import { setRasterBaseUrl } from "@/lib/server-walkable";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

export const dynamic = "force-dynamic";

const isTroopKind = (v: unknown): v is TroopKind => typeof v === "string" && (TROOP_KINDS as readonly string[]).includes(v);

function parseAction(body: unknown): CityAction | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  switch (b.type) {
    case "upgrade":
      return isBuildingKey(b.building) ? { type: "upgrade", building: b.building } : null;
    case "research":
      return isTechKey(b.tech) ? { type: "research", tech: b.tech } : null;
    case "train":
      return isTroopKind(b.troop) && typeof b.count === "number" ? { type: "train", troop: b.troop, count: b.count } : null;
    case "assign": {
      if (typeof b.commanderId !== "string" || typeof b.troops !== "object" || b.troops === null) return null;
      const t = b.troops as Record<string, unknown>;
      const troops = Object.fromEntries(
        TROOP_KINDS.map((k) => [k, typeof t[k] === "number" && Number.isFinite(t[k]) ? Math.max(0, Math.floor(t[k] as number)) : 0]),
      ) as TroopCounts;
      return { type: "assign", commanderId: b.commanderId.slice(0, 64), troops };
    }
    case "gather":
      return typeof b.nodeId === "string" ? { type: "gather", nodeId: b.nodeId.slice(0, 64) } : null;
    case "workerMove":
      if (typeof b.slot !== "number" || !Number.isSafeInteger(b.slot) || b.slot < 0 ||
          !(b.gatherId === null || typeof b.gatherId === "string" && b.gatherId.length > 0 && b.gatherId.length <= 64) ||
          typeof b.lat !== "number" || !Number.isFinite(b.lat) || Math.abs(b.lat) > 90 ||
          typeof b.lon !== "number" || !Number.isFinite(b.lon) || Math.abs(b.lon) > 180) return null;
      return { type: "workerMove", slot: b.slot, gatherId: b.gatherId, lat: b.lat, lon: b.lon };
    case "recall":
      return typeof b.gatherId === "string" ? { type: "recall", gatherId: b.gatherId.slice(0, 64) } : null;
    default:
      return null;
  }
}

/** POST /api/city/action — 건설·연구·훈련·병력 배치·일꾼 파견·회수. */
export async function POST(request: Request): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const action = parseAction(body);
  if (!action) return NextResponse.json({ ok: false, code: "invalid", message: "잘못된 요청입니다." }, { status: 400 });
  try {
    if (action.type === "gather" || action.type === "workerMove") {
      // 일꾼은 도로로만 다닌다 — 잠금 밖에서 경로를 먼저 찾는다 (클라이언트가 보낸 경로는 받지 않는다)
      const origin = new URL(request.url).origin;
      setGraphBaseUrl(origin);
      setRasterBaseUrl(origin);
      if (action.type === "gather") action.route = await planGatherRoute(userId, ctx.missionKey, action.nodeId);
    }
    const v = await runCity(userId, ctx.missionKey, action);
    return NextResponse.json({ ok: true, ...v });
  } catch (error) {
    if (error instanceof CityError) {
      return NextResponse.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
    }
    console.error("[city] action failed", error);
    return NextResponse.json({ ok: false, code: "city_failed" }, { status: 500 });
  }
}
