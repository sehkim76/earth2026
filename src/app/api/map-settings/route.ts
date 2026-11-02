import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import {
  extractMapUserSettingsFromData,
  mergeMapUserSettingsIntoData,
  sanitizeMapUserSettings,
} from "@/lib/map-settings";
import prisma from "@/lib/prismadb";

type MapSettingsRequestBody = {
  showJoystick?: unknown;
  selectedCharacter?: unknown;
  mapStyle?: unknown;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await prisma.missionUser.findUnique({
    where: { userId },
    select: { data: true },
  });

  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const settings = extractMapUserSettingsFromData(user.data);
  return NextResponse.json({ settings });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: MapSettingsRequestBody;
  try {
    body = (await request.json()) as MapSettingsRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const settings = sanitizeMapUserSettings(body);

  const user = await prisma.missionUser.findUnique({
    where: { userId },
    select: { data: true },
  });

  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const mergedData = mergeMapUserSettingsIntoData({
    existingData: user.data,
    settings,
  });

  await prisma.missionUser.update({
    where: { userId },
    data: {
      data: mergedData,
    },
  });

  return NextResponse.json({ ok: true, settings });
}
