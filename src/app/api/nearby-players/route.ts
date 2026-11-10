import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { extractMapUserSettingsFromData } from "@/lib/map-settings";
import prisma from "@/lib/prismadb";

type NearbyPlayerResponse = {
  userId: string;
  nickname: string;
  lat: number;
  lon: number;
  updatedAt: string;
  selectedCharacter: "walking" | "fallenAngel";
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (value && typeof value === "object" && "toNumber" in value) {
    const candidate = (value as { toNumber: () => unknown }).toNumber();
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  }

  const fallback = Number(value);
  return Number.isFinite(fallback) ? fallback : null;
};

const parseFiniteNumber = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const north = parseFiniteNumber(url.searchParams.get("north"));
  const south = parseFiniteNumber(url.searchParams.get("south"));
  const east = parseFiniteNumber(url.searchParams.get("east"));
  const west = parseFiniteNumber(url.searchParams.get("west"));

  const sinceSecRaw = parseFiniteNumber(url.searchParams.get("sinceSec"));
  const limitRaw = parseFiniteNumber(url.searchParams.get("limit"));

  if (north === null || south === null || east === null || west === null) {
    return NextResponse.json({ error: "invalid_bounds" }, { status: 400 });
  }

  const sinceSec = clamp(sinceSecRaw ?? 30, 5, 600);
  const limit = clamp(Math.floor(limitRaw ?? 60), 1, 200);
  const sinceTime = new Date(Date.now() - sinceSec * 1000);

  const me = await prisma.missionUser.findUnique({
    where: { userId },
    select: { ARMissionKey: true },
  });

  const missionKey = me?.ARMissionKey?.trim();
  if (!missionKey) {
    return NextResponse.json({ players: [] satisfies NearbyPlayerResponse[] });
  }

  const rows = (await prisma.$queryRaw`
    SELECT "userId",
           nickname,
           lat,
           lon,
           location_updated_at AS "updatedAt",
           data
    FROM "MissionUser"
    WHERE "userId" <> ${userId}
      AND "ARMissionKey" = ${missionKey}
      AND location_updated_at >= ${sinceTime}
      AND lat IS NOT NULL
      AND lon IS NOT NULL
      AND lat BETWEEN ${south} AND ${north}
      AND lon BETWEEN ${west} AND ${east}
    ORDER BY location_updated_at DESC
    LIMIT ${limit}
  `) as {
    userId: string;
    nickname: string;
    lat: unknown;
    lon: unknown;
    updatedAt: Date;
    data: unknown;
  }[];

  const players: NearbyPlayerResponse[] = rows
    .map((row) => {
      const latValue = toNumber(row.lat);
      const lonValue = toNumber(row.lon);
      if (latValue === null || lonValue === null || !(row.updatedAt instanceof Date)) {
        return null;
      }

      return {
        userId: row.userId,
        nickname: row.nickname,
        lat: latValue,
        lon: lonValue,
        updatedAt: row.updatedAt.toISOString(),
        selectedCharacter: extractMapUserSettingsFromData(row.data).selectedCharacter,
      };
    })
    .filter((player): player is NearbyPlayerResponse => player !== null);

  return NextResponse.json({ players });
}
