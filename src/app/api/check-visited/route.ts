import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prismadb";
import {
  getUserMissionKey,
  isCastleEventKey,
  isTerritoryEnabled,
} from "@/lib/territory-gate";
import {
  SIEGE_DAILY_CAP,
  getSiegeAttemptsLast24h,
  getSiegeCooldownRemainingSecTx,
} from "@/lib/territory";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const eventKey = (
    searchParams.get("eventkey") ||
    searchParams.get("eventKey") ||
    ""
  ).trim();

  const empty = { visited: false, expectedGame: null as string | null };

  if (!eventKey) {
    return NextResponse.json(empty);
  }

  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;

  if (!userId) {
    return NextResponse.json(empty, { status: 401 });
  }

  const isCastle = isCastleEventKey(eventKey);
  // 중립성 랜덤 퀴즈는 재방문 가드 대상이 아니다 (매번 다른 문제).
  const isNeutral = eventKey.startsWith("neutral:");
  let missionKey = "";

  // 성은 재방문 가드 대상이 아니다 (다회 공성 전제). 대신 영토 게이트 + 쿨다운으로 통제한다.
  if (isCastle) {
    missionKey = await getUserMissionKey(userId);
    if (!(await isTerritoryEnabled(missionKey))) {
      return NextResponse.json({
        visited: false,
        expectedGame: null,
        territoryDisabled: true,
      });
    }
  }

  const [scoreRow, event] = await Promise.all([
    isCastle || isNeutral
      ? Promise.resolve(null)
      : prisma.aRMissionUserScore.findFirst({
          where: {
            UserId: userId,
            EventKey: eventKey,
            islastscore: 1,
            score: { gte: 1 },
          },
          select: {
            ScoreId: true,
          },
        }),
    prisma.aRMissionEvent.findFirst({
      where: {
        EventKey: eventKey,
      },
      select: {
        EventType: true,
        EventURI: true,
      },
    }),
  ]);

  let expectedGame: string | null = null;
  const eventType = event?.EventType?.trim().toLowerCase() ?? "";
  if (eventType === "quiztype") {
    // QuizType의 EventURI는 S3 문제지 JSON이므로 게임 경로가 아니다.
    // /event가 quiztype을 /quiz/[eventKey]로 라우팅하는 것과 일치시킨다.
    expectedGame = "/quiz";
  } else {
    const eventUri = event?.EventURI?.trim() ?? "";
    if (eventUri.length > 0) {
      const parsed = /^https?:\/\//i.test(eventUri)
        ? new URL(eventUri)
        : new URL(eventUri, "https://local.event");
      expectedGame = parsed.pathname;
    }
  }

  if (isCastle) {
    const [cooldownSec, attempts] = await Promise.all([
      getSiegeCooldownRemainingSecTx(prisma, userId, eventKey, missionKey),
      getSiegeAttemptsLast24h(prisma, userId, eventKey),
    ]);
    const dailyCapped = attempts >= SIEGE_DAILY_CAP;
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    return NextResponse.json({
      visited: false,
      expectedGame,
      cooldownUntil:
        cooldownSec > 0
          ? Date.now() + cooldownSec * 1000
          : dailyCapped
            ? midnight.getTime()
            : null,
      dailyCapped,
    });
  }

  return NextResponse.json({
    visited: Boolean(scoreRow),
    expectedGame,
  });
}
