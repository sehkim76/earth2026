import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  CASTLE_MEMBER_CAP,
  CASTLE_MIN_SEPARATION_M,
  LORD_CASTLE_CAP_PER_DONG,
  LORD_CASTLE_COST,
  LORD_CASTLE_HP,
  NOBLE_CASTLE_CAP_PER_DONG,
  NOBLE_CASTLE_MAX_HP,
  NOBLE_CASTLE_MIN_HP,
  NOBLE_CASTLE_PER_USER,
  NOBLE_DIST_MAX_M,
  NOBLE_DIST_MIN_M,
  OWN_CASTLE_CAP,
  classAtLeast,
  countOwnedCastles,
  currentSeasonId,
  ensureCastleSeason,
  getSiegeCooldownRemainingSecTx,
  getUserClass,
  getUserStats,
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

const S3_STORAGE_BASE =
  process.env.NEXT_PUBLIC_XRART_S3_STORAGE ||
  "https://armissionchallenge.s3.ap-northeast-2.amazonaws.com";

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

/** 운영 CSV 풀 최소 검증 (S3 URL). */
async function validatePool(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^https:\/\//i.test(url) || url.length > 500) {
    return { ok: false, error: "pool_url" };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: "pool_fetch" };
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > 512 * 1024) {
      return { ok: false, error: "pool_too_large" };
    }
    const text = (await res.text()).slice(0, 512 * 1024);
    const rows = parseCsvLite(text);
    if (rows.length < 21) {
      return { ok: false, error: "pool_too_small" };
    }
    const header = rows[0].map((c) => c.trim().toLowerCase());
    const answerIdx = header.indexOf("answer");
    const difficultyIdx = header.indexOf("difficulty");
    if (answerIdx < 0 || difficultyIdx < 0) {
      return { ok: false, error: "pool_columns" };
    }
    let valid = 0;
    for (const row of rows.slice(1)) {
      const answer = (row[answerIdx] ?? "").trim();
      const difficulty = Number((row[difficultyIdx] ?? "").trim());
      if (answer && Number.isFinite(difficulty) && difficulty >= 1 && difficulty <= 5) {
        valid += 1;
      }
    }
    if (valid < 20) {
      return { ok: false, error: "pool_too_small" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "pool_fetch" };
  }
}

function parseCsvLite(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const clean = text.replace(/^﻿/, "");
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch === "\r") {
      continue;
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

type BuildBody = {
  dongCode?: unknown;
  kind?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  accuracy?: unknown;
  poolUrl?: unknown;
  poolId?: unknown;
  gamePath?: unknown;
  hp?: unknown;
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
  const poolUrl = typeof body.poolUrl === "string" ? body.poolUrl.trim() : "";
  const poolIdRaw = body.poolId;
  const poolId =
    typeof poolIdRaw === "string" && poolIdRaw.trim().length > 0
      ? poolIdRaw.trim()
      : typeof poolIdRaw === "number" && Number.isInteger(poolIdRaw) && poolIdRaw > 0
        ? `pool:${poolIdRaw}`
        : null;
  const gamePath = typeof body.gamePath === "string" ? body.gamePath.trim() : "";
  const hpParam = parseNumber(body.hp);

  if (!kind || !name || !dongCode || lat === null || lon === null) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return NextResponse.json({ ok: false, code: "invalid_coordinates" }, { status: 400 });
  }
  // 축성 위치는 지도에서 직접 지정하므로 GPS 정확도를 검증하지 않는다.
  if (gamePath) {
    // 게임성(城)은 시즌2. MVP는 퀴즈성만.
    return NextResponse.json({ ok: false, code: "game_castle_season2" }, { status: 400 });
  }

  // 이벤트 선택(poolId 우선, 없으면 직접 URL 폴백).
  // pool:<id> = 풀 테이블 행, s3:<key> = S3 Quiz/ 문제풀 직접 지정.
  // QuizType 풀은 문제풀 CSV 검증, URLType 풀은 웹이벤트(URL) 그대로 사용한다.
  let resolvedPoolUrl = poolUrl;
  let castleEventType = "quiztype";
  if (poolId !== null) {
    if (poolId.startsWith("s3:")) {
      const s3Key = poolId.slice(3);
      if (!/^Quiz\/[^/]+\.csv$/i.test(s3Key)) {
        return NextResponse.json({ ok: false, code: "pool_invalid" }, { status: 400 });
      }
      castleEventType = "quiztype";
      resolvedPoolUrl = `${S3_STORAGE_BASE}/${s3Key}`;
    } else {
      const tableId = poolId.startsWith("pool:")
        ? Number(poolId.slice(5))
        : Number(poolId);
      if (!Number.isInteger(tableId) || tableId <= 0) {
        return NextResponse.json({ ok: false, code: "pool_invalid" }, { status: 400 });
      }
      const poolRow = await prisma.aRMissionEventPoolTable.findUnique({
        where: { id: tableId },
        select: { EventType: true, EventURI: true },
      });
      const poolType = (poolRow?.EventType ?? "").trim();
      const poolUri = (poolRow?.EventURI ?? "").trim();
      if (!poolRow || !/^https:\/\//i.test(poolUri) || poolUri.length > 500) {
        return NextResponse.json({ ok: false, code: "pool_invalid" }, { status: 400 });
      }
      if (poolType === "URLType") {
        castleEventType = "URLType";
        resolvedPoolUrl = poolUri;
      } else if (poolType === "QuizType") {
        castleEventType = "quiztype";
        resolvedPoolUrl = poolUri;
      } else {
        return NextResponse.json({ ok: false, code: "pool_invalid" }, { status: 400 });
      }
    }
  }
  if (!resolvedPoolUrl) {
    return NextResponse.json({ ok: false, code: "pool_required" }, { status: 400 });
  }

  const hp =
    kind === "lord"
      ? LORD_CASTLE_HP
      : Math.max(
          NOBLE_CASTLE_MIN_HP,
          Math.min(NOBLE_CASTLE_MAX_HP, hpParam === null ? NOBLE_CASTLE_MIN_HP : Math.trunc(hpParam)),
        );

  // GPS 신선도는 검사하지 않는다 (위치는 지도 지정 + 동 영역 제한으로 통제).

  const klass: CastleClass = await refreshUserClass(prisma, userId, ctx.missionKey);

  if (kind === "lord" && !classAtLeast(klass, "commoner")) {
    return NextResponse.json({ ok: false, code: "class_ineligible" }, { status: 403 });
  }
  if (kind === "noble" && klass !== "noble" && klass !== "lord") {
    return NextResponse.json({ ok: false, code: "class_ineligible" }, { status: 403 });
  }

  const ownedTotal = await countOwnedCastles(prisma, userId, ctx.missionKey);
  // 창시(동 최초 영주성)는 보유 상한과 무관하게 허용. 그 외는 상한 적용.
  if (kind !== "lord") {
    if (ownedTotal >= OWN_CASTLE_CAP[klass]) {
      return NextResponse.json({ ok: false, code: "limit" }, { status: 403 });
    }
  }

  const poolCheck =
    castleEventType === "quiztype" ? await validatePool(resolvedPoolUrl) : { ok: true };
  if (!poolCheck.ok) {
    return NextResponse.json({ ok: false, code: poolCheck.error ?? "pool_invalid" }, { status: 400 });
  }

  // 동 폴리곤 포함 검증은 폴리곤 소스(B-1) 확정 후 추가. 현 MVP는 거리 검증만 수행한다.
  try {
    const result = await withNamedLock(
      `castle-create:${ctx.missionKey}:${dongCode}`,
      async (tx: Tx) => {
        const seasonId = currentSeasonId();
        const events = await tx.aRMissionEvent.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { EventKey: true, string_param1: true },
        });
        const dongCastles = events
          .map((e) => ({ key: e.EventKey ?? "", meta: parseCastleMeta(e.string_param1) }))
          .filter((c) => c.meta !== null && c.meta.dong === dongCode && c.meta.seasonId === seasonId);

        const lordCount = dongCastles.filter((c) => c.meta?.kind === "lord").length;
        const nobleCount = dongCastles.filter((c) => c.meta?.kind === "noble").length;
        const myNobleCount = dongCastles.filter(
          (c) => c.meta?.kind === "noble" && c.meta?.owner === userId,
        ).length;

        if (kind === "lord" && lordCount >= LORD_CASTLE_CAP_PER_DONG) {
          throw new Error("limit");
        }
        // 창시 경로: 동 최초 영주성은 commoner+ & 공헌 1000+ 에게 허용.
        // 이후 영주성은 기사 이상만 (창시자가 영주가 되므로 자연 충족).
        if (kind === "lord" && lordCount === 0) {
          const stats = await getUserStats(tx, userId, ctx.missionKey);
          if (!(classAtLeast(klass, "commoner") && stats.contribution >= 1000)) {
            throw new Error("founder_ineligible");
          }
        } else if (kind === "lord" && !classAtLeast(klass, "knight")) {
          throw new Error("class_ineligible");
        }
        if (kind === "lord" && lordCount > 0) {
          const owned = await countOwnedCastles(tx, userId, ctx.missionKey);
          if (owned >= OWN_CASTLE_CAP[klass]) {
            throw new Error("limit");
          }
        }
        if (kind === "noble") {
          if (nobleCount >= NOBLE_CASTLE_CAP_PER_DONG || myNobleCount >= NOBLE_CASTLE_PER_USER) {
            throw new Error("limit");
          }
          const owned = await countOwnedCastles(tx, userId, ctx.missionKey);
          if (owned >= OWN_CASTLE_CAP[klass]) {
            throw new Error("limit");
          }
        }

        const gpsRows = await tx.aRMissionGPS.findMany({
          where: { ARMissionKey: ctx.missionKey, EventKey: { startsWith: "castle-" } },
          select: { EventKey: true, location: true },
        });
        const gpsByKey = new Map(gpsRows.map((g) => [g.EventKey ?? "", g.location ?? ""]));

        let lordCoords: { lat: number; lon: number } | null = null;
        for (const c of dongCastles) {
          const coords = parseLatLon(gpsByKey.get(c.key) ?? "");
          if (!coords) {
            continue;
          }
          if (haversineM(lat, lon, coords.lat, coords.lon) < CASTLE_MIN_SEPARATION_M) {
            throw new Error("distance");
          }
          if (c.meta?.kind === "lord") {
            lordCoords = coords;
          }
        }
        if (kind === "noble") {
          if (!lordCoords) {
            throw new Error("no_lord");
          }
          const dist = haversineM(lat, lon, lordCoords.lat, lordCoords.lon);
          if (dist < NOBLE_DIST_MIN_M || dist > NOBLE_DIST_MAX_M) {
            throw new Error("distance");
          }
        }

        // 비용: 동 최초 영주성은 무료(개척 보너스)
        const isFirstLord = kind === "lord" && lordCount === 0;
        const cost = kind === "lord" ? (isFirstLord ? 0 : LORD_CASTLE_COST) : hp * 200;
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
            EventType: castleEventType,
            EventURI: resolvedPoolUrl,
            QuizCount: 1,
            int_param1: hp,
            string_param1: serializeCastleMeta(meta),
            string_param2: JSON.stringify({
              joinMode: "auto",
              pool: resolvedPoolUrl,
              difficulty: [1, 3],
              pick: 1,
            }).slice(0, 1200),
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
      ["limit", "distance", "funds", "no_lord", "class_ineligible", "founder_ineligible"].includes(
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
        difficulty: castle.settings.difficulty,
        members: activeMembers.map((m) => ({
          userId: m.userId,
          nickname: nicknameById.get(m.userId ?? "") ?? (m.userId ?? ""),
          classId: m.classId,
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
