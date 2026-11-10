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

type RankingItemData = {
  nickname: string;
  score: number;
};

type TotalScoreRow = {
  totalScore: number | bigint | null;
};

type DebugEventTypeRow = {
  eventKey: string | null;
  eventType: string | null;
};

type RankingRow = {
  userId: string;
  nickname: string;
  totalScore: number | bigint | null;
};

type VisitedScoreRow = {
  eventKey: string | null;
  score: number | bigint | null;
};

type MapPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const getSingleParam = (value: string | string[] | undefined): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }

  return undefined;
};

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

export default async function MapPage({ searchParams }: MapPageProps) {
  const params = (await searchParams) ?? {};
  const panelParam = getSingleParam(params.panel);
  const rankingParam = getSingleParam(params.ranking);
  const initialShowRanking =
    panelParam === "ranking" ||
    rankingParam === "1" ||
    rankingParam === "true";

  const session = await getSafeServerSession({ returnTo: "/map" });

  if (!session?.user?.id) {
    redirect("/");
  }

  const eventRevisitedParam = getSingleParam(params.eventRevisited);
  const showEventRevisitedDialog = eventRevisitedParam === "1" || eventRevisitedParam === "true";
  const attackDeniedParam = getSingleParam(params.attackDenied);
  const attackDeniedReason =
    attackDeniedParam === "range" || attackDeniedParam === "gone"
      ? attackDeniedParam
      : null;

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
  let rankingItems: RankingItemData[] = [];
  let myTotalScore = 0;
  let visitedEventKeys: string[] = [];
  let visitedScores: Record<string, number> = {};
  let territoryEnabled = false;
  const debugEventTypes: Record<string, string | null> = {};
  territoryEnabled = effectiveMissionKey ? await isTerritoryEnabled(effectiveMissionKey) : false;

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

    // 디버그 마커 EventType 조회
    const debugEventKeys = [
      "ac8f767a-efa1-445e-a3c2-7c12a53c18da",
      "BUSANCITIZEN_BUTTERFLY",
    ];
    
    const debugEventTypeRows = await prisma.$queryRaw<DebugEventTypeRow[]>`
      SELECT "EventKey" AS "eventKey", "EventType" AS "eventType"
      FROM "ARMissionEvent"
      WHERE "ARMissionKey" = ${effectiveMissionKey}
        AND "EventKey" IN (${debugEventKeys[0]}, ${debugEventKeys[1]})
    `;

    for (const row of debugEventTypeRows) {
      if (row.eventType && row.eventKey) {
        debugEventTypes[row.eventKey] = row.eventType;
      }
    }

    const scoreRows = await prisma.$queryRaw<TotalScoreRow[]>`
      SELECT COALESCE(SUM(s.score), 0) AS "totalScore"
      FROM "ARMissionUserScore" s
      WHERE TRIM(COALESCE(s."ARMissionKey", '')) = ${missionKey}
        AND COALESCE(s.islastscore, 0) = 1
        AND s."UserId" = ${session.user.id}
    `;

    const rawTotalScore = scoreRows[0]?.totalScore;
    myTotalScore = typeof rawTotalScore === "bigint"
      ? Number(rawTotalScore)
      : Number(rawTotalScore ?? 0);

    console.log("[/map] my total score", {
      missionKey,
      userId: session.user.id,
      myTotalScore,
    });

    if (myTotalScore === 0) {
      console.warn("[/map] Warning: User score is zero. Check if data exists in ARMissionUserScore.");
    }

    const rankingRows = await prisma.$queryRaw<RankingRow[]>`
      SELECT
        u."userId" AS "userId",
        COALESCE(u.nickname, u."userId") AS nickname,
        COALESCE(SUM(s.score), 0) AS "totalScore"
      FROM "MissionUser" u
      LEFT JOIN "ARMissionUserScore" s ON s."UserId" = u."userId"
        AND TRIM(COALESCE(s."ARMissionKey", '')) = ${missionKey}
        AND COALESCE(s.islastscore, 0) = 1
      WHERE u.code = 'W'
        AND TRIM(COALESCE(u."ARMissionKey", '')) = ${missionKey ?? ""}
      GROUP BY u."userId", u.nickname
      ORDER BY "totalScore" DESC
    `;

    rankingItems = rankingRows.map((row) => ({
      nickname: row.nickname,
      score: typeof row.totalScore === "bigint" ? Number(row.totalScore) : Number(row.totalScore ?? 0),
    }));

    const visitedRows = await prisma.$queryRaw<VisitedScoreRow[]>`
      SELECT TRIM(s."EventKey") AS "eventKey", s.score AS score
      FROM "ARMissionUserScore" s
      WHERE s."UserId" = ${session.user.id}
        AND TRIM(COALESCE(s."ARMissionKey", '')) = ${missionKey}
        AND COALESCE(s.islastscore, 0) = 1
        AND COALESCE(s.score, 0) >= 1
    `;

    visitedEventKeys = visitedRows
      .map((row) => row.eventKey?.trim() ?? "")
      .filter((eventKey) => eventKey.length > 0);

    visitedScores = {};
    for (const row of visitedRows) {
      const eventKey = row.eventKey?.trim() ?? "";
      if (!eventKey) {
        continue;
      }
      const score = typeof row.score === "bigint" ? Number(row.score) : Number(row.score ?? 0);
      visitedScores[eventKey] = Number.isFinite(score) ? score : 0;
    }

    console.log("[/map] visited event keys", {
      missionKey,
      userId: session.user.id,
      count: visitedEventKeys.length,
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
        playerScore={myTotalScore}
        rankingItems={rankingItems}
        rankingNickname={session.user.nickname || session.user.name || "PLAYER"}
        initialShowRanking={initialShowRanking}
        debugEventTypes={debugEventTypes}
        initialSettings={initialSettings}
        visitedEventKeys={visitedEventKeys}
        visitedScores={visitedScores}
        showEventRevisitedDialog={showEventRevisitedDialog}
        attackDeniedReason={attackDeniedReason}
        territoryEnabled={territoryEnabled}
        missionKey={effectiveMissionKey}
      />
    </div>
  );
}
