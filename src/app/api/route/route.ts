import { NextResponse } from "next/server";

import { findServerRoute, setGraphBaseUrl } from "@/lib/server-graph";
import { setRasterBaseUrl } from "@/lib/server-walkable";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

type RouteBody = {
  fromLat?: unknown;
  fromLon?: unknown;
  toLat?: unknown;
  toLon?: unknown;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** 서버 통합 그래프 라우팅. POST {fromLat,fromLon,toLat,toLon} → {ok, path, dongs}. */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: RouteBody;
  try {
    body = (await request.json()) as RouteBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }
  const fromLat = num(body.fromLat);
  const fromLon = num(body.fromLon);
  const toLat = num(body.toLat);
  const toLon = num(body.toLon);
  if (fromLat === null || fromLon === null || toLat === null || toLon === null) {
    return NextResponse.json({ ok: false, code: "invalid_coordinates" }, { status: 400 });
  }

  try {
    setGraphBaseUrl(new URL(request.url).origin);
    setRasterBaseUrl(new URL(request.url).origin);
    const result = await findServerRoute(fromLat, fromLon, toLat, toLon);
    if (!result.ok) {
      return NextResponse.json({ ok: false, code: "no_path", reason: result.reason, legs: result.legs, totalMs: result.totalMs });
    }
    // path 상한 5000 (클라이언트가 RDP 솎음 후 주문 등록).
    const path = result.path.length > 5000
      ? result.path.filter((_, i) => i % Math.ceil(result.path.length / 5000) === 0)
      : result.path;
    return NextResponse.json({ ok: true, path, dongs: result.dongs, legs: result.legs, totalMs: result.totalMs });
  } catch (error) {
    console.error("[server-route]", error);
    return NextResponse.json({ ok: false, code: "route_failed" }, { status: 500 });
  }
}
