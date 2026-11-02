import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prismadb";

type PlayerLocationBody = {
  lat?: unknown;
  lon?: unknown;
  // 조이스틱 ON이면 조이스틱 위치를 실제 위치로 기록한다.
  source?: unknown;
  accuracy?: unknown;
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PlayerLocationBody;
  try {
    body = (await request.json()) as PlayerLocationBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const lat = parseNumber(body.lat);
  const lon = parseNumber(body.lon);
  if (lat === null || lon === null) {
    return NextResponse.json({ error: "invalid_coordinates" }, { status: 400 });
  }

  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return NextResponse.json({ error: "invalid_coordinates" }, { status: 400 });
  }

  const source =
    typeof body.source === "string" && body.source.trim() === "joystick"
      ? "joystick"
      : typeof body.source === "string" && body.source.trim() === "start"
        ? "start"
        : "gps";

  const now = new Date();
  const latString = lat.toFixed(6);
  const lonString = lon.toFixed(6);

  await prisma.$executeRaw`
    UPDATE MissionUser
    SET lat = ${latString},
        lon = ${lonString},
        location = ${`${latString},${lonString}`},
        location_updated_at = ${now}
    WHERE userId = ${userId}
  `;

  return NextResponse.json({ ok: true, mode: source });
}
