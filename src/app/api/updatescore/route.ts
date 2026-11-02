import { createHash } from "node:crypto";

import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prismadb";
import { isValidNickname } from "@/lib/auth-claim";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");
  
  if (action !== "getscore") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;

  if (!userId) {
    return NextResponse.json({ score: 0 }, { status: 401 });
  }

  const user = await prisma.missionUser.findUnique({
    where: { userId },
    select: { ARMissionKey: true },
  });

  if (!user?.ARMissionKey) {
    return NextResponse.json({ score: 0 });
  }

  const missionKey = user.ARMissionKey.trim();

  const result = await prisma.$queryRaw<Array<{ totalScore: number | bigint }>>`
    SELECT COALESCE(SUM(s.score), 0) AS totalScore
    FROM ARMissionUserScore s
    WHERE TRIM(COALESCE(s.ARMissionKey, '')) = ${missionKey}
      AND COALESCE(s.islastscore, 0) = 1
      AND s.UserId = ${userId}
  `;

  const rawScore = result[0]?.totalScore;
  const score = typeof rawScore === "bigint" ? Number(rawScore) : Number(rawScore ?? 0);

  return NextResponse.json({ score });
}

type UpdateScoreRequestBody = {
  score?: unknown;
  eventKey?: unknown;
  eventkey?: unknown;
  answer?: unknown;
  userId?: unknown;
  userid?: unknown;
  nickname?: unknown;
  deviceId?: unknown;
  source?: unknown;
};

const parseScore = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }

  return null;
};

const parseEventKey = (body: UpdateScoreRequestBody): string | null => {
  const raw = typeof body.eventKey === "string"
    ? body.eventKey
    : typeof body.eventkey === "string"
      ? body.eventkey
      : "";
  const trimmed = raw.trim();

  return trimmed.length > 0 ? trimmed : null;
};

const parseTrimmedString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

const getPrismaErrorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const withCode = error as { code?: unknown };
  return typeof withCode.code === "string" ? withCode.code : null;
};

const toLockStatus = (value: unknown): number => {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
};

const isRetryablePrismaError = (error: unknown): boolean => {
  const code = getPrismaErrorCode(error);
  return code === "P1017" || code === "P2028";
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const withRetry = async <T>(params: {
  label: string;
  requestId: string;
  fn: () => Promise<T>;
  attempts?: number;
}): Promise<T> => {
  const attempts = params.attempts ?? 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await params.fn();
    } catch (error) {
      lastError = error;
      const retryable = isRetryablePrismaError(error);

      console.warn(`[updatescore:${params.requestId}] ${params.label} failed`, {
        attempt,
        attempts,
        prismaCode: getPrismaErrorCode(error),
        retryable,
      });

      if (!retryable || attempt >= attempts) {
        throw error;
      }

      await wait(150);
    }
  }

  throw lastError;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  console.log(`[updatescore:${requestId}] start`);

  const session = await getServerSession(authOptions);
  const sessionUserId = session?.user?.id || null;
  console.log(`[updatescore:${requestId}] session resolved`, {
    hasSession: Boolean(session),
    sessionUserId,
  });

  let body: UpdateScoreRequestBody;
  try {
    body = (await request.json()) as UpdateScoreRequestBody;
  } catch (error) {
    console.error(`[updatescore:${requestId}] invalid json body`, error);
    return NextResponse.json({ result: "invalid_json" }, { status: 400 });
  }

  const source = typeof body.source === "string" ? body.source : "unknown";
  const bodyUserId = parseTrimmedString(
    typeof body.userId === "string" ? body.userId : body.userid
  );
  const nickname = parseTrimmedString(body.nickname);
  const deviceId = parseTrimmedString(body.deviceId);

  let userId = sessionUserId || (bodyUserId.length > 0 ? bodyUserId : null);
  const score = parseScore(body.score);
  const eventKey = parseEventKey(body);
  const answer = parseTrimmedString(body.answer).slice(0, 255);
  console.log(`[updatescore:${requestId}] payload parsed`, {
    source,
    bodyUserId,
    nickname,
    deviceId,
    resolvedUserId: userId,
    score,
    eventKey,
    answer,
  });

  if (!userId && isValidNickname(nickname)) {
    const fallbackUser = await withRetry({
      label: "nickname fallback query",
      requestId,
      fn: () => prisma.missionUser.findFirst({
        where: {
          nickname,
        },
        select: {
          userId: true,
          device_id: true,
        },
      }),
    });

    if (fallbackUser) {
      const hasDeviceBinding =
        typeof fallbackUser.device_id === "string" && fallbackUser.device_id.trim().length > 0;
      const matchesDevice = hasDeviceBinding ? fallbackUser.device_id === deviceId : true;

      if (matchesDevice) {
        userId = fallbackUser.userId;
      }

      console.log(`[updatescore:${requestId}] nickname fallback`, {
        fallbackUserId: fallbackUser.userId,
        hasDeviceBinding,
        matchesDevice,
        resolvedUserId: userId,
      });
    }
  }

  if (!userId) {
    console.warn(`[updatescore:${requestId}] unauthorized - no userId`);
    return NextResponse.json({ result: "unauthorized" }, { status: 401 });
  }

  if (score === null || !eventKey) {
    console.warn(`[updatescore:${requestId}] invalid payload`, {
      score,
      eventKey,
    });
    return NextResponse.json({ result: "invalid" }, { status: 400 });
  }

  const user = await withRetry({
    label: "user verify query",
    requestId,
    fn: () => prisma.missionUser.findUnique({
      where: {
        userId,
      },
      select: {
        userId: true,
        ARMissionKey: true,
      },
    }),
  });

  if (!user) {
    console.warn(`[updatescore:${requestId}] user not found`, { userId });
    return NextResponse.json({ result: "user_not_found" }, { status: 404 });
  }

  const userMissionKey = typeof user.ARMissionKey === "string" ? user.ARMissionKey.trim() : "";

  console.log(`[updatescore:${requestId}] user verified`, {
    userId,
    userMissionKey: userMissionKey || null,
  });

  const event = await withRetry({
    label: "event resolve query",
    requestId,
    fn: () => prisma.aRMissionEvent.findFirst({
      where: userMissionKey
        ? {
            EventKey: eventKey,
            ARMissionKey: userMissionKey,
          }
        : {
            EventKey: eventKey,
          },
      select: {
        ARMissionKey: true,
      },
    }),
  });

  if (!event?.ARMissionKey) {
    // 중립성 랜덤 퀴즈: DB 행 없이 사용자 미션으로 귀속한다.
    if (eventKey.startsWith("neutral:") && userMissionKey) {
      console.log(`[updatescore:${requestId}] neutral quiz resolved to user mission`, {
        eventKey,
        missionKey: userMissionKey,
      });
      const lockKey = createHash("sha1")
        .update(`${userId}|${eventKey}|${userMissionKey}`)
        .digest("hex");
      try {
        const created = await withRetry({
          label: "neutral score transaction",
          requestId,
          fn: () => prisma.$transaction(async (tx) => {
            const lockResult = await tx.$queryRaw<Array<{ locked: number | null }>>`
              SELECT GET_LOCK(${lockKey}, 5) AS locked
            `;
            if (toLockStatus(lockResult[0]?.locked) !== 1) {
              throw new Error("score lock acquire failed");
            }
            try {
              await tx.aRMissionUserScore.updateMany({
                where: {
                  UserId: userId,
                  EventKey: eventKey,
                  ARMissionKey: userMissionKey,
                },
                data: {
                  islastscore: 0,
                },
              });
              return tx.aRMissionUserScore.create({
                data: {
                  UserId: userId,
                  EventKey: eventKey,
                  ARMissionKey: userMissionKey,
                  answer: answer.length > 0 ? answer : null,
                  score,
                  scoredate: new Date(),
                  islastscore: 1,
                },
                select: {
                  ScoreId: true,
                },
              });
            } finally {
              await tx.$queryRaw`SELECT RELEASE_LOCK(${lockKey})`;
            }
          }, {
            maxWait: 10000,
            timeout: 20000,
          }),
        });
        return NextResponse.json({
          result: "success",
          scoreId: created.ScoreId,
        });
      } catch (error) {
        console.error(`[updatescore:${requestId}] neutral score failed`, { error });
        return NextResponse.json({ result: "score_update_failed" }, { status: 409 });
      }
    }
    console.warn(`[updatescore:${requestId}] event not found`, {
      eventKey,
      userMissionKey: userMissionKey || null,
    });
    return NextResponse.json({ result: "event_not_found" }, { status: 404 });
  }

  const resolvedMissionKey = event.ARMissionKey.trim();

  console.log(`[updatescore:${requestId}] event resolved`, {
    eventKey,
    missionKey: resolvedMissionKey,
    constrainedByUserMission: Boolean(userMissionKey),
  });

  const lockKey = createHash("sha1")
    .update(`${userId}|${eventKey}|${resolvedMissionKey}`)
    .digest("hex");

  try {
    const createdScore = await withRetry({
      label: "score transaction",
      requestId,
      fn: () => prisma.$transaction(async (tx) => {
      console.log(`[updatescore:${requestId}] acquiring lock`, { lockKey });
      const lockResult = await tx.$queryRaw<Array<{ locked: number | null }>>`
        SELECT GET_LOCK(${lockKey}, 5) AS locked
      `;
      const locked = toLockStatus(lockResult[0]?.locked);

      if (locked !== 1) {
        console.warn(`[updatescore:${requestId}] lock acquire failed`, {
          lockResult,
          locked,
        });
        throw new Error("score lock acquire failed");
      }

      console.log(`[updatescore:${requestId}] lock acquired`);

      try {
        const resetResult = await tx.aRMissionUserScore.updateMany({
          where: {
            UserId: userId,
            EventKey: eventKey,
            ARMissionKey: resolvedMissionKey,
          },
          data: {
            islastscore: 0,
          },
        });

        console.log(`[updatescore:${requestId}] previous rows reset`, {
          count: resetResult.count,
        });

        const created = await tx.aRMissionUserScore.create({
          data: {
            UserId: userId,
            EventKey: eventKey,
            ARMissionKey: resolvedMissionKey,
            answer: answer.length > 0 ? answer : null,
            score,
            scoredate: new Date(),
            islastscore: 1,
          },
          select: {
            ScoreId: true,
          },
        });

        console.log(`[updatescore:${requestId}] score row created`, {
          scoreId: created.ScoreId,
        });

        return created;
      } finally {
        await tx.$queryRaw`
          SELECT RELEASE_LOCK(${lockKey}) AS released
        `;
        console.log(`[updatescore:${requestId}] lock released`);
      }
    }, {
      maxWait: 10000,
      timeout: 20000,
      }),
    });

    console.log(`[updatescore:${requestId}] success`, {
      scoreId: createdScore.ScoreId,
      elapsedMs: Date.now() - startedAt,
      source,
    });

    return NextResponse.json({
      result: "success",
      scoreId: createdScore.ScoreId,
    });
  } catch (error) {
    const prismaCode = getPrismaErrorCode(error);
    console.error(`[updatescore:${requestId}] failed`, {
      elapsedMs: Date.now() - startedAt,
      source,
      prismaCode,
      error,
    });

    if (prismaCode === "P1017") {
      return NextResponse.json({ result: "db_connection_closed" }, { status: 503 });
    }

    if (prismaCode === "P2028") {
      return NextResponse.json({ result: "transaction_timeout" }, { status: 503 });
    }

    return NextResponse.json({ result: "score_update_failed" }, { status: 409 });
  }
}
