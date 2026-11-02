import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  parseCastleMeta,
  parseLatLon,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
} from "@/lib/territory";

interface LocationCorrection {
  castleKey: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
}

const isCorrection = (value: unknown): value is LocationCorrection => {
  if (typeof value !== "object" || value === null) return false;
  const correction = value as Record<string, unknown>;
  return typeof correction.castleKey === "string" && correction.castleKey.startsWith("castle-") &&
    [correction.fromLat, correction.fromLon, correction.toLat, correction.toLon].every(
      (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate),
    ) && Math.abs(correction.fromLat as number) <= 90 && Math.abs(correction.toLat as number) <= 90 &&
    Math.abs(correction.fromLon as number) <= 180 && Math.abs(correction.toLon as number) <= 180;
};

const distanceM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540);
};

export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) return territoryDisabledResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  const rawCorrections = typeof body === "object" && body !== null
    ? (body as { corrections?: unknown }).corrections
    : null;
  if (!Array.isArray(rawCorrections) || rawCorrections.length > 100 || !rawCorrections.every(isCorrection)) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      let updated = 0;
      for (const correction of rawCorrections) {
        const { castleKey, fromLat, fromLon, toLat, toLon } = correction;
        if (distanceM(fromLat, fromLon, toLat, toLon) > 5000) continue;
        const [event, gps] = await Promise.all([
          tx.aRMissionEvent.findFirst({
            where: { ARMissionKey: ctx.missionKey, EventKey: castleKey },
            select: { string_param1: true },
          }),
          tx.aRMissionGPS.findFirst({
            where: { ARMissionKey: ctx.missionKey, EventKey: castleKey },
            select: { id: true, location: true },
          }),
        ]);
        const meta = parseCastleMeta(event?.string_param1);
        const stored = parseLatLon(gps?.location ?? "");
        if (
          !meta || meta.owner !== userId || !gps || !stored ||
          distanceM(stored.lat, stored.lon, fromLat, fromLon) > 1
        ) continue;
        await tx.aRMissionGPS.update({
          where: { id: gps.id },
          data: { location: `${toLat.toFixed(8)},${toLon.toFixed(8)}` },
        });
        updated += 1;
      }
      return updated;
    });
    return NextResponse.json({ ok: true, updated });
  } catch {
    return NextResponse.json({ ok: false, code: "failed" }, { status: 500 });
  }
}
