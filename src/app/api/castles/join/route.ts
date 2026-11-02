import { NextResponse } from "next/server";

import prisma from "@/lib/prismadb";
import {
  JOIN_RADIUS_M,
  ensureCastleSeason,
  haversineM,
  performJoin,
  refreshUserClass,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withCastleLock,
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

type JoinBody = {
  castleKey?: unknown;
  lat?: unknown;
  lon?: unknown;
  transfer?: unknown;
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

  let body: JoinBody;
  try {
    body = (await request.json()) as JoinBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const lat = parseNumber(body.lat);
  const lon = parseNumber(body.lon);
  const transfer = body.transfer === true;
  if (!castleKey || lat === null || lon === null) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  const klass = await refreshUserClass(prisma, userId, ctx.missionKey);
  if (klass === "slave") {
    // 노예는 입성 불가. 용병(고용) 루트는 시즌2.
    return NextResponse.json({ ok: false, code: "class_ineligible" }, { status: 403 });
  }

  try {
    const result = await withCastleLock(castleKey, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.status !== "active") {
        throw new Error("castle_pending");
      }
      if (haversineM(lat, lon, castle.lat, castle.lon) > JOIN_RADIUS_M) {
        throw new Error("out_of_range");
      }

      const existing = await tx.missionTeam.findFirst({
        where: { userId },
        select: { teamId: true, Features: true },
      });
      if (existing?.teamId === castleKey) {
        throw new Error(
          typeof existing.Features === "string" && existing.Features.startsWith("join-pending:")
            ? "join_pending"
            : "already_member",
        );
      }
      if (existing?.teamId && !transfer) {
        throw new Error("already_member");
      }

      return performJoin(tx, ctx.missionKey, userId, klass, castle, {
        transfer,
        fromCastle: existing?.teamId ?? null,
      });
    });

    if (result.pending) {
      return NextResponse.json({ ok: true, pending: true });
    }
    return NextResponse.json({ ok: true, castleKey });
  } catch (error) {
    const code =
      error instanceof Error &&
      [
        "castle_not_found",
        "castle_pending",
        "out_of_range",
        "already_member",
        "join_pending",
        "transfer_cooldown",
        "funds",
        "capacity",
      ].includes(error.message)
        ? error.message
        : "join_failed";
    const status =
      code === "castle_not_found"
        ? 404
        : code === "funds"
          ? 402
          : code === "already_member" || code === "join_pending" || code === "transfer_cooldown"
            ? 409
            : 400;
    if (code === "join_failed") {
      console.error("[castles/join] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
