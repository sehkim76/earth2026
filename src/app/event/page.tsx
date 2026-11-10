import { redirect } from "next/navigation";

import { getSafeServerSession } from "@/lib/auth-session";
import prisma from "@/lib/prismadb";
import {
  getUserMissionKey,
  isCastleEventKey,
  isTerritoryEnabled,
} from "@/lib/territory-gate";

type EventPageProps = {
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

const buildRedirectWithForwardedParams = (targetUrl: string, params: Record<string, string | string[] | undefined>) => {
  const isAbsolute = /^https?:\/\//i.test(targetUrl);
  const parsed = isAbsolute
    ? new URL(targetUrl)
    : new URL(targetUrl, "https://local.event.redirect");

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        parsed.searchParams.append(key, item);
      }
      continue;
    }

    parsed.searchParams.append(key, value);
  }

  if (isAbsolute) {
    return parsed.toString();
  }

  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query ? `?${query}` : ""}${parsed.hash}`;
};

export default async function EventPage({ searchParams }: EventPageProps) {
  const params = (await searchParams) ?? {};
  const eventKey = (getSingleParam(params.eventkey) || getSingleParam(params.EventKey) || "").trim();
  const exitUrl = getSingleParam(params.exitUrl) ?? "/map";
  const host = getSingleParam(params.host) ?? "web";
  const isDefaultReturn = exitUrl === "/map" && host === "web";
  const explicitMissionKey = (
    getSingleParam(params.armissionkey) ||
    getSingleParam(params.ARMissionKey) ||
    getSingleParam(params.ARMissionKey) ||
    ""
  ).trim();

  const stripDefaultReturnParams = (
    source: Record<string, string | string[] | undefined>,
  ): Record<string, string | string[] | undefined> => {
    const stripped: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(source)) {
      if (/^exiturl$/i.test(key) || /^host$/i.test(key)) {
        continue;
      }
      stripped[key] = value;
    }
    return stripped;
  };

  if (!eventKey) {
    redirect("/");
  }

  const missionKey = (getSingleParam(params.armissionkey) || getSingleParam(params.ARMissionKey) || "").trim();

  const event = await prisma.aRMissionEvent.findFirst({
    where: missionKey
      ? {
          EventKey: eventKey,
          ARMissionKey: missionKey,
        }
      : {
          EventKey: eventKey,
        },
    orderBy: {
      id: "desc",
    },
    select: {
      EventType: true,
      EventURI: true,
      EventKey: true,
      ARMissionKey: true,
      id: true,
    },
  });

  if (!event?.EventType) {
    redirect("/");
  }

  const session = await getSafeServerSession({ returnTo: `/event?eventkey=${encodeURIComponent(eventKey)}` });

  if (!session?.user?.id) {
    const loginCallbackQuery = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          loginCallbackQuery.append(key, item);
        }
        continue;
      }
      loginCallbackQuery.append(key, value);
    }
    const loginCallbackQueryString = loginCallbackQuery.toString();
    const loginCallback = loginCallbackQueryString ? `/event?${loginCallbackQueryString}` : "/event";
    redirect(`/?callbackUrl=${encodeURIComponent(loginCallback)}`);
  }

  // 같은 EventKey가 여러 미션에 있으면 사용자의 미션 행을 우선한다.
  const userMissionKey = await getUserMissionKey(session.user.id);
  let resolvedEvent = event;
  if (userMissionKey && (event.ARMissionKey || "").trim() !== userMissionKey) {
    const ownEvent = await prisma.aRMissionEvent.findFirst({
      where: {
        EventKey: eventKey,
        ARMissionKey: userMissionKey,
      },
      orderBy: {
        id: "desc",
      },
      select: {
        EventType: true,
        EventURI: true,
        EventKey: true,
        ARMissionKey: true,
        id: true,
      },
    });
    if (ownEvent?.EventType) {
      resolvedEvent = ownEvent;
    }
  }
  if (!resolvedEvent?.EventType) {
    redirect("/");
  }

  // 성은 재방문 가드 대상이 아니다 (다회 공성 전제).
  // 영토 미션 소속이 아니면 진입 불가(fail-close). 쿨다운은 진입 후 클라가 통제한다.
  if (isCastleEventKey(eventKey)) {
    if (!(await isTerritoryEnabled(userMissionKey))) {
      redirect("/map");
    }
  } else if (session?.user?.id) {
    const visited = await prisma.aRMissionUserScore.findFirst({
      where: {
        UserId: session.user.id,
        EventKey: eventKey,
        ARMissionKey: resolvedEvent.ARMissionKey,
        islastscore: 1,
      },
      select: {
        score: true,
      },
    });
    const visitedScore =
      typeof visited?.score === "bigint" ? Number(visited.score) : Number(visited?.score ?? 0);
    if (visited && Number.isFinite(visitedScore) && visitedScore >= 1) {
      redirect("/map?eventRevisited=1");
    }
  }

  const eventType = resolvedEvent.EventType.trim().toLowerCase();
  // 하류 URL의 ARMissionKey는 로그인 사용자의 키를 우선한다
  // (DB EventURI에 다른 미션 키가 하드코딩되어 있을 수 있다).
  const armissionkey = userMissionKey || explicitMissionKey || (resolvedEvent.ARMissionKey || "").trim();

  if (eventType === "quiztype") {
    redirect("/map?eventUnsupported=1");
  }

  if (eventType === "urltype") {
    const eventUri = (resolvedEvent.EventURI || "").trim();
    console.log(`[/event] eventUri[${eventUri}]`)
    if (!eventUri || /^javascript:/i.test(eventUri)) {
      redirect("/");
    }

    const baseParams: Record<string, string | string[] | undefined> = isDefaultReturn
      ? stripDefaultReturnParams(params)
      : { ...params };
    const hasMissionKey = ["armissionkey", "ARMissionKey", "ARMissionKey"].some(
      (key) => baseParams[key] !== undefined,
    );
    if (armissionkey && !hasMissionKey) {
      baseParams.armissionkey = armissionkey;
    }
    const redirected = buildRedirectWithForwardedParams(eventUri, baseParams);
    if (userMissionKey) {
      // EventURI에 하드코딩된 armissionkey가 있으면 사용자 키로 교체한다.
      try {
        const parsed = new URL(
          redirected,
          /^https?:\/\//i.test(redirected) ? undefined : "https://local.event.redirect",
        );
        parsed.searchParams.delete("armissionkey");
        parsed.searchParams.delete("ARMissionKey");
        parsed.searchParams.delete("ARMissionKey");
        parsed.searchParams.set("armissionkey", userMissionKey);
        if (/^https?:\/\//i.test(redirected)) {
          redirect(parsed.toString());
        }
        const query = parsed.searchParams.toString();
        redirect(`${parsed.pathname}${query ? `?${query}` : ""}${parsed.hash}`);
      } catch {
        // 파싱 실패 시 원본 리다이렉트를 유지한다.
      }
    }
    redirect(redirected);
  }

  redirect("/");
}
