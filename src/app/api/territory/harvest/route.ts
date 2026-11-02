import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  CLASS_HARVEST_MULT,
  DONG_BUFFS,
  HARVEST_BASE,
  HARVEST_SHARE,
  getUserClass,
  grantInfluence,
  loadCastle,
  parseCastleMeta,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  type CastleClass,
} from "@/lib/territory";

type HarvestBody = {
  castleKey?: unknown;
};

const dayString = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const readHarvestBook = (
  data: unknown,
): { days: Record<string, string>; streaks: Record<string, { lastDay: string; streak: number }> } => {
  const days: Record<string, string> = {};
  const streaks: Record<string, { lastDay: string; streak: number }> = {};
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (typeof record.harvestDays === "object" && record.harvestDays !== null) {
      for (const [k, v] of Object.entries(record.harvestDays as Record<string, unknown>)) {
        if (typeof v === "string") {
          days[k] = v;
        }
      }
    }
    if (typeof record.harvestStreaks === "object" && record.harvestStreaks !== null) {
      for (const [k, v] of Object.entries(record.harvestStreaks as Record<string, unknown>)) {
        if (typeof v === "object" && v !== null) {
          const r = v as Record<string, unknown>;
          if (typeof r.lastDay === "string" && typeof r.streak === "number") {
            streaks[k] = { lastDay: r.lastDay, streak: Math.max(0, Math.trunc(r.streak)) };
          }
        }
      }
    }
  }
  return { days, streaks };
};

/**
 * 일일 수확 (lazy). 보유 성마다 1일 1회.
 * - 조건: 해당 주 1회 이상 GPS 체크인 (location_updated_at 7일 이내)
 * - 수확량 = 100 × 동버프 × 계급배율 × 연속보유 (3일 +10%, 7일 +25%)
 * - 30%는 소속원 균등 분배, 나머지는 영주
 */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: HarvestBody;
  try {
    body = (await request.json()) as HarvestBody;
  } catch {
    body = {};
  }
  const onlyCastle = typeof body.castleKey === "string" ? body.castleKey.trim() : "";

  const me = await prisma.missionUser.findUnique({
    where: { userId },
    select: { location_updated_at: true, data: true },
  });
  if (
    !(me?.location_updated_at instanceof Date) ||
    Date.now() - me.location_updated_at.getTime() > 7 * 24 * 3600 * 1000
  ) {
    // 방치 계정 자동 수확 방지: 주 1회 GPS 체크인 필요
    return NextResponse.json({ ok: false, code: "checkin_required" }, { status: 403 });
  }

  const klass: CastleClass = await getUserClass(prisma, userId);
  const today = dayString(new Date());
  const yesterday = dayString(new Date(Date.now() - 24 * 3600 * 1000));
  const book = readHarvestBook(me?.data);

  const events = await prisma.aRMissionEvent.findMany({
    where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
    select: { EventKey: true, string_param1: true },
  });
  const targets = events.filter((e) => {
    const meta = parseCastleMeta(e.string_param1);
    return (
      meta &&
      meta.owner === userId &&
      meta.status === "active" &&
      (!onlyCastle || (e.EventKey ?? "") === onlyCastle)
    );
  });

  const harvested: Array<{
    castleKey: string;
    yield: number;
    ownerShare: number;
    memberShare: number;
    members: number;
  }> = [];
  const skipped: string[] = [];

  for (const target of targets) {
    const castleKey = target.EventKey ?? "";
    if (book.days[castleKey] === today) {
      skipped.push(castleKey);
      continue;
    }
    const castle = await loadCastle(prisma, castleKey, ctx.missionKey);
    if (!castle) {
      skipped.push(castleKey);
      continue;
    }

    const prev = book.streaks[castleKey];
    const streak = prev && prev.lastDay === yesterday ? Math.min(7, prev.streak + 1) : 1;
    const streakMult = streak >= 7 ? 1.25 : streak >= 3 ? 1.1 : 1;
    const buff = DONG_BUFFS[castle.meta.dong] ?? 1.0;
    const mult = CLASS_HARVEST_MULT[klass] ?? 1.0;
    const total = Math.floor(HARVEST_BASE * buff * mult * streakMult);

    const members = await prisma.missionTeam.findMany({
      where: { teamId: castleKey },
      select: { userId: true, Features: true },
    });
    const activeMembers = members.filter(
      (m) =>
        m.userId &&
        m.userId !== userId &&
        !(typeof m.Features === "string" && m.Features.startsWith("join-pending:")),
    );

    const each = activeMembers.length > 0 ? Math.floor((total * HARVEST_SHARE) / activeMembers.length) : 0;
    const ownerShare = total - each * activeMembers.length;

    await grantInfluence(prisma, userId, ownerShare);
    for (const m of activeMembers) {
      if (m.userId && each > 0) {
        await grantInfluence(prisma, m.userId, each);
      }
    }

    book.days[castleKey] = today;
    book.streaks[castleKey] = { lastDay: today, streak };
    harvested.push({
      castleKey,
      yield: total,
      ownerShare,
      memberShare: each,
      members: activeMembers.length,
    });
  }

  const current = await prisma.missionUser.findUnique({
    where: { userId },
    select: { data: true },
  });
  const base =
    typeof current?.data === "object" && current.data !== null && !Array.isArray(current.data)
      ? { ...(current.data as Record<string, unknown>) }
      : {};
  (base as Record<string, unknown>).harvestDays = book.days;
  (base as Record<string, unknown>).harvestStreaks = book.streaks;
  await prisma.missionUser.update({
    where: { userId },
    data: { data: JSON.parse(JSON.stringify(base)) },
  });

  return NextResponse.json({ ok: true, harvested, skipped });
}
