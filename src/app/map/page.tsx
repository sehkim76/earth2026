import { redirect } from "next/navigation";

import CurrentLocationMap from "@/components/CurrentLocationMap";
import { getSafeServerSession } from "@/lib/auth-session";
import { extractMapUserSettingsFromData } from "@/lib/map-settings";
import prisma from "@/lib/prismadb";
import { isTerritoryEnabled } from "@/lib/territory-gate";

type MapPoint = {
  id: number;
  lat: number;
  lon: number;
  label?: string;
  eventType?: string;
  eventKey?: string;
}

const parseLocation = (raw: string | null | undefined): { lat: number; lon: number } | null => {
  if (!raw) {
    return null;
  }

  const matches = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length < 2) {
    return null;
  }

  let first = Number(matches[0]);
  let second = Number(matches[1]);
  if (Number.isNaN(first) || Number.isNaN(second)) {
    return null;
  }

  if (Math.abs(first) > 90 && Math.abs(second) <= 90) {
    [first, second] = [second, first];
  }

  return { lat: first, lon: second };
}

const FALLBACK_MISSION_KEY = "test-mission-2024";

export default async function MapPage() {
  const session = await getSafeServerSession({ returnTo: "/map" });

  if (!session?.user?.id) {
    redirect("/");
  }

  const userRecord = await prisma.missionUser.findUnique({
    where: {
      userId: session.user.id,
    },
    select: {
      ARMissionKey: true,
      data: true,
    },
  });

  const missionKey = userRecord?.ARMissionKey?.trim();

  const effectiveMissionKey = missionKey || FALLBACK_MISSION_KEY;
  const initialSettings = extractMapUserSettingsFromData(userRecord?.data);

  let mapPoints: MapPoint[] = [];
  const territoryEnabled = effectiveMissionKey ? await isTerritoryEnabled(effectiveMissionKey) : false;

  console.log("[/map] checking mission key", {
    userId: session.user.id,
    userRecord,
    missionKey,
    effectiveMissionKey,
    usingFallback: !missionKey,
  });

  if (!effectiveMissionKey) {
    console.warn("[/map] Warning: User does not have a mission key. Data loading skipped.");
  }

  if (effectiveMissionKey) {
    const rows: {
      id: number;
      location: string | null;
      locationname: string | null;
      EventKey: string | null;
      eventType: string | null;
    }[] = await prisma.$queryRaw`
      SELECT gps.id,
             gps.location,
             gps.locationname,
             gps."EventKey",
             evt."EventType" AS "eventType"
      FROM "ARMissionGPS" AS gps
      LEFT JOIN "ARMissionEvent" AS evt
        ON evt."ARMissionKey" = ${missionKey} AND evt."EventKey" = gps."EventKey"
      WHERE gps."ARMissionKey" = ${missionKey}
    `;

    console.log("[/map] fetched ARMissionGPS rows", {
      missionKey,
      count: rows.length,
      sample: rows.slice(0, 5).map((row) => ({
        id: row.id,
        location: row.location,
        name: row.locationname,
        eventType: row.eventType,
      })),
    });

    mapPoints = rows.reduce<MapPoint[]>((acc, row) => {
      // 퀴즈 마커(성이 아닌 GPS 지점 — 지도에 병사 모양으로 표시되던 것)는 표시하지 않는다.
      // 이벤트 종류(퀴즈형·URL형)와 상관없이 성(castle- 키)만 남긴다.
      if (!(row.EventKey ?? "").trim().startsWith("castle-")) {
        return acc;
      }
      const coords = parseLocation(row.location);
      if (!coords) {
        console.warn("[/map] skip gps row due to invalid coords", {
          id: row.id,
          location: row.location,
        });
        return acc;
      }

      acc.push({
        id: row.id,
        lat: coords.lat,
        lon: coords.lon,
        label: row.locationname ?? undefined,
        eventType: row.eventType ?? undefined,
        eventKey: row.EventKey?.trim(),
      });

      return acc;
    }, []);

    console.log("[/map] parsed map points", {
      missionKey,
      count: mapPoints.length,
      sample: mapPoints.slice(0, 5),
    });
  }

  return (
    <div className="min-h-dvh w-full">
      <CurrentLocationMap
        key={session.user.id}
        locationCacheKey={session.user.id}
        className="h-full min-h-dvh w-full"
        points={mapPoints}
        playerNickname={session.user.nickname || session.user.name || "PLAYER"}
        initialSettings={initialSettings}
        territoryEnabled={territoryEnabled}
        missionKey={effectiveMissionKey}
      />
    </div>
  );
}
