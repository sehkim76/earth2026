import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import { playerTitles } from "@/lib/nations";
import { acquirePgLock } from "@/lib/pg-advisory-lock";
import {
  CASTLE_MEMBER_CAP,
  LORD_CASTLE_COST,
  LORD_CASTLE_HP,
  NOBLE_CASTLE_MAX_HP,
  NOBLE_CASTLE_MIN_HP,
  NOBLE_CASTLE_PER_USER,
  NOBLE_DIST_MAX_M,
  OWN_CASTLE_CAP,
  classAtLeast,
  countOwnedCastles,
  currentSeasonId,
  ensureCastleSeason,
  getSiegeCooldownRemainingSecTx,
  getUserClass,
  getUserStats,
  PROMOTION_RULES,
  haversineM,
  parseCastleMeta,
  parseLatLon,
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  serializeCastleMeta,
  spendInfluence,
  territoryDisabledResponse,
  withNamedLock,
  type CastleClass,
  type CastleKind,
  type Tx,
} from "@/lib/territory";

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type BuildBody = {
  dongCode?: unknown;
  kind?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  accuracy?: unknown;
  hp?: unknown;
  home?: unknown;
};

export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: BuildBody;
  try {
    body = (await request.json()) as BuildBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const kind: CastleKind | null = body.kind === "lord" || body.kind === "noble" ? body.kind : null;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 30) : "";
  const dongCode = typeof body.dongCode === "string" ? body.dongCode.trim().slice(0, 64) : "";
  const lat = parseNumber(body.lat);
  const lon = parseNumber(body.lon);
  const hpParam = parseNumber(body.hp);

  if (!kind || !name || !dongCode || lat === null || lon === null) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return NextResponse.json({ ok: false, code: "invalid_coordinates" }, { status: 400 });
  }
  // 축성 위치는 지도에서 직접 지정하므로 GPS 정확도를 검증하지 않는다.
  const hp =
    kind === "lord"
      ? LORD_CASTLE_HP
      : Math.max(
          NOBLE_CASTLE_MIN_HP,
          Math.min(NOBLE_CASTLE_MAX_HP, hpParam === null ? NOBLE_CASTLE_MIN_HP : Math.trunc(hpParam)),
        );

  // GPS 신선도는 검사하지 않는다 (위치는 지도 지정 + 동 영역 제한으로 통제).

  const klass: CastleClass = await refreshUserClass(prisma, userId, ctx.missionKey);
  try {
    const result = await withNamedLock(
      `castle-create:${ctx.missionKey}:${dongCode}`,
      async (tx: Tx) => {
        await acquirePgLock(tx, `castle-builder:${ctx.missionKey}:${userId}`);
        const seasonId = currentSeasonId();
        const events = await tx.aRMissionEvent.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { EventKey: true, string_param1: true },
        });
        const current = events.map(e => ({ key: e.EventKey ?? "", meta: parseCastleMeta(e.string_param1) }))
          .filter(c => c.meta?.seasonId === seasonId);
        const dongCastles = current.filter(c => c.meta?.dong === dongCode);
        const lords = dongCastles.filter(c => c.meta?.kind === "lord");
        const homeFounding = kind === "lord" && !current.some(c => c.meta?.owner === userId && c.meta.kind === "lord");
        if (body.home === true && !homeFounding) throw new Error("already_home");
        if (kind === "lord" && !homeFounding) {
          if (lords.length === 0) {
            const stats = await getUserStats(tx, userId, ctx.missionKey);
            if (!classAtLeast(klass, "commoner") || stats.wins < PROMOTION_RULES.foundLordCastle.wins) {
              throw new Error("founder_ineligible");
            }
          } else if (!classAtLeast(klass, "knight")) {
            throw new Error("class_ineligible");
          }
          if (lords.length > 0 && await countOwnedCastles(tx, userId, ctx.missionKey) >= OWN_CASTLE_CAP[klass]) {
            throw new Error("limit");
          }
        }
        if (kind === "noble") {
          if (!classAtLeast(klass, "noble")) throw new Error("class_ineligible");
          if (dongCastles.filter(c => c.meta?.kind === "noble" && c.meta.owner === userId).length >= NOBLE_CASTLE_PER_USER) {
            throw new Error("limit");
          }
          const owned = await countOwnedCastles(tx, userId, ctx.missionKey);
          if (owned >= OWN_CASTLE_CAP[klass]) {
            throw new Error("limit");
          }
        }

        if (kind === "noble") {
          if (lords.length === 0) throw new Error("no_lord");
          const positions = await tx.aRMissionGPS.findMany({
            where: { ARMissionKey: ctx.missionKey, EventKey: { in: lords.map(c => c.key) } },
            select: { location: true },
          });
          if (!positions.some(row => {
            const pos = parseLatLon(row.location);
            return pos && haversineM(lat, lon, pos.lat, pos.lon) <= NOBLE_DIST_MAX_M;
          })) throw new Error("distance");
        }

        const cost = kind === "lord" ? (homeFounding || lords.length === 0 ? 0 : LORD_CASTLE_COST) : hp * 200;
        const paid = await spendInfluence(tx, userId, cost);
        if (!paid) {
          throw new Error("funds");
        }

        const prefix = `castle-${dongCode}-`;
        let seq = 0;
        for (const e of events) {
          const key = e.EventKey ?? "";
          if (key.startsWith(prefix)) {
            const n = Number(key.slice(prefix.length));
            if (Number.isFinite(n) && Math.trunc(n) > seq) {
              seq = Math.trunc(n);
            }
          }
        }
        const castleKey = `${prefix}${seq + 1}`;

        const meta = {
          owner: userId,
          kind,
          dong: dongCode,
          hp,
          maxHp: hp,
          garrison: 0,
          siegeWins: 0,
          seasonId,
          status: kind === "noble" ? ("pending" as const) : ("active" as const),
          createdAt: new Date().toISOString(),
        };

        await tx.aRMissionGPS.create({
          data: {
            EventKey: castleKey,
            ARMissionKey: ctx.missionKey,
            location: `${lat.toFixed(6)},${lon.toFixed(6)}`,
            locationname: name,
            SpotPrefab: "castle",
            SpotVisitedPrefab: "castle-visited",
            MinimapMarkerPrefab: "castle-mini",
          },
        });
        await tx.aRMissionEvent.create({
          data: {
            EventKey: castleKey,
            ARMissionKey: ctx.missionKey,
            // 성은 EventKey의 castle- prefix로 식별한다 (EventType은 표시용 "castle").
            EventType: "castle",
            EventURI: "",
            QuizCount: 0,
            int_param1: hp,
            string_param1: serializeCastleMeta(meta),
            string_param2: JSON.stringify({ joinMode: "auto" }).slice(0, 1200),
            string_param3: dongCode,
            string_param4: "",
            string_param5: "",
            string_param6: "",
          },
        });

        // 동 최초 영주성 창시자는 영주로 (창시 경로)
        const becameLord = kind === "lord" && klass !== "lord";
        const newClass: CastleClass = becameLord ? "lord" : klass;
        const existing = await tx.missionTeam.findFirst({
          where: { userId },
          select: { id: true },
        });
        if (existing) {
          await tx.missionTeam.updateMany({
            where: { userId },
            data: { teamId: castleKey, classId: newClass },
          });
        } else {
          await tx.missionTeam.create({
            data: {
              ARMissionKey: ctx.missionKey,
              userId,
              teamId: castleKey,
              classId: newClass,
              Features: "",
            },
          });
        }

        return { castleKey, hp, pending: meta.status === "pending", becameLord };
      },
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      ["already_home", "limit", "distance", "funds", "no_lord", "class_ineligible", "founder_ineligible"].includes(
        error.message
      )
        ? error.message
        : "build_failed";
    const status =
      code === "funds"
        ? 402
        : code === "limit" || code === "no_lord" || code === "class_ineligible"
          ? 403
          : 400;
    if (code === "build_failed") {
      console.error("[castles] build failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}

/**
 * 성 상세 (W2 팝업용).
 * GET /api/castles?castleKey=castle-...-01
 */
export async function GET(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  const { searchParams } = new URL(request.url);
  const castleKey = (searchParams.get("castleKey") ?? "").trim();
  if (!castleKey) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withNamedLock(`castle-read:${castleKey}`, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      const [members, klass, cooldownSec] = await Promise.all([
        tx.missionTeam.findMany({
          where: { teamId: castleKey },
          select: { userId: true, teamId: true, classId: true, Features: true },
        }),
        getUserClass(tx, userId),
        getSiegeCooldownRemainingSecTx(tx, userId, castleKey, ctx.missionKey),
      ]);
      const activeMembers = members.filter(
        (m) => !(typeof m.Features === "string" && m.Features.startsWith("join-pending:")),
      );
      const nicknames = await tx.missionUser.findMany({
        where: { userId: { in: activeMembers.map((m) => m.userId ?? "").filter(Boolean) } },
        select: { userId: true, nickname: true },
      });
      const titles = await playerTitles(tx, ctx.missionKey, nicknames.map(n => n.userId));
      const nicknameById = new Map(nicknames.map((n) => [n.userId, n.nickname]));
      const myRow = members.find((m) => m.userId === userId);
      const myPending =
        typeof myRow?.Features === "string" && myRow.Features.startsWith("join-pending:");

      return {
        castleKey,
        name: castle.name,
        lat: castle.lat,
        lon: castle.lon,
        kind: castle.meta.kind,
        hp: castle.meta.hp,
        maxHp: castle.meta.maxHp,
        owner: castle.meta.owner,
        status: castle.meta.status,
        garrison: castle.meta.garrison,
        joinMode: castle.settings.joinMode,
        members: activeMembers.map((m) => ({
          userId: m.userId,
          nickname: nicknameById.get(m.userId ?? "") ?? (m.userId ?? ""),
          classId: m.classId,
          title: titles.get(m.userId ?? "") ?? "부족장",
          isOwner: m.userId === castle.meta.owner,
        })),
        capacity: CASTLE_MEMBER_CAP[castle.meta.kind],
        isOwner: castle.meta.owner === userId,
        myMemberCastle:
          !myPending && myRow?.teamId && myRow.teamId !== castleKey ? myRow.teamId : null,
        myPending,
        myClass: klass,
        cooldownSec,
      };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code =
      error instanceof Error && error.message === "castle_not_found"
        ? "castle_not_found"
        : "detail_failed";
    if (code === "detail_failed") {
      console.error("[castles] detail failed", error);
    }
    return NextResponse.json(
      { ok: false, code },
      { status: code === "castle_not_found" ? 404 : 500 },
    );
  }
}
