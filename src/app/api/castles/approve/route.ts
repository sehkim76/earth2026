import { NextResponse } from "next/server";

import {
  CASTLE_MEMBER_CAP,
  JOIN_APPROVAL_EXPIRE_HOURS,
  ensureCastleSeason,
  requireSessionUserId,
  resolveTerritoryContext,
  territoryDisabledResponse,
  withCastleLock,
  type Tx,
} from "@/lib/territory";

type ApproveBody = {
  castleKey?: unknown;
  targetUserId?: unknown;
  action?: unknown;
};

/**
 * 가입 승인대기 목록 (W6용). 성 주인만 조회 가능.
 * GET /api/castles/approve?castleKey=castle-...-01
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
    const result = await withCastleLock(castleKey, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.owner !== userId) {
        throw new Error("not_owner");
      }
      const rows = await tx.missionTeam.findMany({
        where: { teamId: castleKey },
        select: { userId: true, Features: true },
      });
      const pendingRows = rows.filter(
        (r): r is { userId: string; Features: string } =>
          typeof r.userId === "string" &&
          typeof r.Features === "string" &&
          r.Features.startsWith("join-pending:"),
      );
      const nicknames = await tx.missionUser.findMany({
        where: { userId: { in: pendingRows.map((r) => r.userId) } },
        select: { userId: true, nickname: true },
      });
      const nicknameById = new Map(nicknames.map((n) => [n.userId, n.nickname]));
      return {
        pending: pendingRows.map((r) => ({
          userId: r.userId,
          nickname: nicknameById.get(r.userId) ?? r.userId,
          requestedAt: Number(r.Features.slice("join-pending:".length)) || 0,
        })),
      };
    });
    return NextResponse.json({ ok: true, castleKey, ...result });
  } catch (error) {
    const code =
      error instanceof Error && ["castle_not_found", "not_owner"].includes(error.message)
        ? error.message
        : "list_failed";
    const status = code === "castle_not_found" ? 404 : code === "not_owner" ? 403 : 500;
    if (code === "list_failed") {
      console.error("[castles/approve] list failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}

/** 주인승인제(joinMode=manual) 가입 승인/거절. 성 주인만 가능. */
export async function POST(request: Request) {
  const userId = await requireSessionUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, code: "login" }, { status: 401 });
  }
  const ctx = await resolveTerritoryContext(userId);
  if (!ctx) {
    return territoryDisabledResponse();
  }

  let body: ApproveBody;
  try {
    body = (await request.json()) as ApproveBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const castleKey = typeof body.castleKey === "string" ? body.castleKey.trim() : "";
  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
  const action = body.action === "approve" || body.action === "reject" ? body.action : null;
  if (!castleKey || !targetUserId || !action || targetUserId === userId) {
    return NextResponse.json({ ok: false, code: "invalid" }, { status: 400 });
  }

  try {
    const result = await withCastleLock(castleKey, async (tx: Tx) => {
      const castle = await ensureCastleSeason(tx, castleKey, ctx.missionKey);
      if (!castle) {
        throw new Error("castle_not_found");
      }
      if (castle.meta.owner !== userId) {
        throw new Error("not_owner");
      }
      const pending = await tx.missionTeam.findFirst({
        where: { userId: targetUserId, teamId: castleKey },
        select: { id: true, Features: true, classId: true },
      });
      const stamp =
        typeof pending?.Features === "string" && pending.Features.startsWith("join-pending:")
          ? Number(pending.Features.slice("join-pending:".length))
          : NaN;
      if (!pending || !Number.isFinite(stamp)) {
        throw new Error("no_pending");
      }
      if (Date.now() - stamp > JOIN_APPROVAL_EXPIRE_HOURS * 3600 * 1000) {
        await tx.missionTeam.deleteMany({ where: { userId: targetUserId, teamId: castleKey } });
        throw new Error("approval_expired");
      }
      if (action === "reject") {
        await tx.missionTeam.deleteMany({ where: { userId: targetUserId, teamId: castleKey } });
        return { approved: false as const };
      }
      const members = await tx.missionTeam.findMany({
        where: { teamId: castleKey },
        select: { userId: true, Features: true },
      });
      const active = members.filter(
        (m) =>
          m.userId !== targetUserId &&
          !(typeof m.Features === "string" && m.Features.startsWith("join-pending:")),
      ).length;
      if (active >= CASTLE_MEMBER_CAP[castle.meta.kind]) {
        throw new Error("capacity");
      }
      await tx.missionTeam.updateMany({
        where: { userId: targetUserId, teamId: castleKey },
        data: { Features: "" },
      });
      return { approved: true as const };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code =
      error instanceof Error &&
      ["castle_not_found", "not_owner", "no_pending", "approval_expired", "capacity"].includes(
        error.message,
      )
        ? error.message
        : "approve_failed";
    const status = code === "castle_not_found" ? 404 : code === "not_owner" ? 403 : 400;
    if (code === "approve_failed") {
      console.error("[castles/approve] failed", error);
    }
    return NextResponse.json({ ok: false, code }, { status });
  }
}
