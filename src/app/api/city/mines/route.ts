import { NextResponse } from "next/server";

import { bankMinesInBounds } from "@/lib/bank-mines";
import { requireSessionUserId, resolveTerritoryContext, territoryDisabledResponse } from "@/lib/territory";

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();
  const params = new URL(request.url).searchParams;
  const [south, west, north, east] = ["south", "west", "north", "east"].map(k => Number(params.get(k)?.trim() || NaN));
  if (![south, west, north, east].every(Number.isFinite) || south > north || west > east || south < -90 || north > 90 || west < -180 || east > 180) {
    return NextResponse.json({ ok: false, code: "invalid_bounds" }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, mines: await bankMinesInBounds(ctx.missionKey, south, west, north, east) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[city/mines]", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
